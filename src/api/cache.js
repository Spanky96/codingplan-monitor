// 用量缓存(5 分钟 TTL,落盘持久化 + 防抖写)+ 去重抓取 + 到期缓存 + /api/usage 响应脱敏。
// setCache 被所有平台适配器调用;ensureUsageFetch 被用量路由复用。
var fs = require('fs');
var path = require('path');
var config = require('../config');
var { readAccounts } = require('./accounts');
var telecomjs = require('../telecomjs');
var weights = require('../weights');

var CACHE_TTL = 5 * 60 * 1000;
var CACHE_FILE = process.env.USAGE_CACHE_FILE
    ? path.resolve(process.env.USAGE_CACHE_FILE)
    : path.join(__dirname, 'usage-cache.json');

var usageCache = {};
var _persistTimer = null;

// 启动加载持久化缓存:让 /api/weights 在重启/冷启动后也能立即返回最近已知权重(耗尽=0),
// 而不是退回默认权重。中转站轮询抓到的永远是「最近一次抓取」的真实评分。
(function loadUsageCache() {
    try {
        if (fs.existsSync(CACHE_FILE)) {
            var raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
            if (raw && typeof raw === 'object' && !Array.isArray(raw)) usageCache = raw;
        }
    } catch (e) { usageCache = {}; }   // 损坏则丢弃,等首次抓取重建
})();

// 去抖持久化:抓取后合并写入,避免高频写盘
function persistUsageCache() {
    if (_persistTimer) return;
    _persistTimer = setTimeout(function () {
        _persistTimer = null;
        try { fs.writeFileSync(CACHE_FILE, JSON.stringify(usageCache)); } catch (e) { /* 忽略写入失败 */ }
    }, 2000);
}

// 新鲜缓存(5 分钟内):供 /api/usage 展示用
function getCached(index) {
    var c = usageCache[index];
    return (c && Date.now() - c.time < CACHE_TTL) ? c.result : null;
}
// 最近已知(任意时效):供 /api/weights 路由用——宁可略旧,也不要把耗尽账号当默认权重
function getCachedLastKnown(index) {
    var c = usageCache[index];
    return c ? c.result : null;
}
function setCache(index, result) {
    usageCache[index] = { result: result, time: Date.now() };
    persistUsageCache();
}
function clearCache() {
    usageCache = {}; expireCache = {};
    usageInflight = {};
    try { fs.writeFileSync(CACHE_FILE, '{}'); } catch (e) { /* 忽略 */ }
}

function clearCacheIndex(index) {
    delete usageCache[index];
    delete expireCache[index];
    delete usageInflight[index];
    try { fs.writeFileSync(CACHE_FILE, JSON.stringify(usageCache)); } catch (e) { /* 忽略 */ }
}

// 同账号并发抓取去重:列表接口触发后台刷新时,单卡补齐可 join 同一 Promise
var usageInflight = {};

// 列表秒开时的轻量占位(不含凭证)。前端按 loading/pending 渲染骨架并逐卡补齐。
function accountUsageShell(account, index) {
    return {
        index: index,
        name: account.name,
        platform: account.platform || 'glm',
        planType: account.planType || undefined,
        responsiblePerson: account.responsiblePerson,
        notes: account.notes,
        keyCount: account.keyCount,
        teamEdition: account.teamEdition || undefined,
        isPublic: account.isPublic,
        risk: account.risk || undefined,
        success: false,
        loading: true,
        pending: true
    };
}

// force=true 时跳过新鲜缓存并重新抓取;已有进行中的抓取则 join,避免智云等慢源被重复打开。
// 优先 join inflight:列表 force 已启动抓取时,单卡补齐即使 force=false 也要等到新结果,不能直接吐旧缓存。
function ensureUsageFetch(account, index, force) {
    if (usageInflight[index]) return usageInflight[index];
    if (!force) {
        var fresh = getCached(index);
        if (fresh) return Promise.resolve(fresh);
    }
    // 平台分派在 platforms/index(与 cache 互相引用,故在调用时惰性 require 打破环)
    var platforms = require('./platforms');
    var p = platforms.fetchAccountUsage(account, index).finally(function() {
        if (usageInflight[index] === p) delete usageInflight[index];
    });
    usageInflight[index] = p;
    return p;
}

// 把补丁合并进某账号的缓存 result(不可变:生成新 result 对象)。
// 供 keys/risk/reset-cards 路由在回写 accounts.json 后同步内存缓存,避免 /api/usage 返回旧值。
function patchCachedResult(index, patch) {
    var c = usageCache[index];
    if (!c || !c.result) return;
    usageCache[index] = { result: Object.assign({}, c.result, patch), time: c.time };
}

function normalizeTelephone(value) {
    var phone = String(value || '').replace(/[\s()-]/g, '');
    if (phone.indexOf('+86') === 0) phone = phone.slice(3);
    else if (phone.indexOf('86') === 0 && phone.length === 13) phone = phone.slice(2);
    return phone;
}

function usageForResponse(result) {
    if (!result) return result;
    if ((result.platform || 'glm') === 'glm' && result.success) {
        return Object.assign({}, result, {
            resetRecommendation: weights.getGLMResetRecommendation(result) || undefined
        });
    }
    if (result.platform !== 'telecomjs') return result;
    var safe = Object.assign({}, result);
    delete safe.phone;
    return safe;
}

// 同一权重请求先计算 CodingPlan，再用其平均基础分修正智云按量账号。
// includePrivate=false 时完全排除私有账号，避免私有池状态影响公开返回。
var EXPIRE_CACHE_TTL = 24 * 60 * 60 * 1000;
var expireCache = {};

function getExpireCached(index) {
    var c = expireCache[index];
    return (c && Date.now() - c.time < EXPIRE_CACHE_TTL) ? c.result : null;
}
function setExpireCache(index, result) {
    expireCache[index] = { result: result, time: Date.now() };
}
// ============ 权重条目构建(供 /api/weights 与容量聚合)============

function buildWeightEntries(accounts, includePrivate, nowMs) {
    var entries = [];
    var codingScores = [];
    for (var i = 0; i < accounts.length; i++) {
        var account = accounts[i];
        if (!account || (!includePrivate && account.isPublic === false)) continue;
        var cached = getCachedLastKnown(i);
        var platform = account.platform || 'glm';
        var score = platform === 'telecomjs' ? null : (cached ? weights.scoreAccount(cached) : null);
        if (score) codingScores.push(score);
        entries.push({ index: i, account: account, platform: platform, cached: cached, score: score });
    }
    entries.forEach(function(entry) {
        if (entry.platform === 'telecomjs') {
            entry.score = entry.cached
                ? weights.scoreTelecomAccount(entry.cached, codingScores, nowMs)
                : null;
        }
    });
    return entries;
}


module.exports = {
    getCached: getCached,
    getCachedLastKnown: getCachedLastKnown,
    setCache: setCache,
    clearCache: clearCache,
    clearCacheIndex: clearCacheIndex,
    ensureUsageFetch: ensureUsageFetch,
    accountUsageShell: accountUsageShell,
    usageForResponse: usageForResponse,
    buildWeightEntries: buildWeightEntries,
    normalizeTelephone: normalizeTelephone,
    patchCachedResult: patchCachedResult,
    getExpireCached: getExpireCached,
    setExpireCache: setExpireCache,
    CACHE_TTL: CACHE_TTL
};

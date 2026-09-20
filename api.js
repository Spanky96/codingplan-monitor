var fs = require('fs');
var path = require('path');
var http = require('http');
var https = require('https');
var crypto = require('crypto');
var express = require('express');
var jsonParser = express.json();

var config = require('./config');
var telecomjs = require('./telecomjs');
var glmAccountsFile = config.accountsFile;
var PASSWORD = config.adminPassword;
var weights = require('./weights');
var SUB2API_BASE = config.sub2apiBaseUrl;
var RELAY_SNAPSHOT_TOKEN = config.relaySnapshotToken;
var CACHE_TTL = 5 * 60 * 1000;
var CACHE_FILE = process.env.USAGE_CACHE_FILE
    ? path.resolve(process.env.USAGE_CACHE_FILE)
    : path.join(__dirname, 'usage-cache.json');

var usageCache = {};
var _persistTimer = null;
var telecomPhoneAttempts = new Map();

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
    var p = fetchAccountUsage(account, index).finally(function() {
        if (usageInflight[index] === p) delete usageInflight[index];
    });
    usageInflight[index] = p;
    return p;
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

var EXPIRE_CACHE_TTL = 24 * 60 * 60 * 1000;
var expireCache = {};

function getExpireCached(index) {
    var c = expireCache[index];
    return (c && Date.now() - c.time < EXPIRE_CACHE_TTL) ? c.result : null;
}
function setExpireCache(index, result) {
    expireCache[index] = { result: result, time: Date.now() };
}

// ============ 账号凭证加密存储（AES-256-GCM）============

// 密文格式: enc:v1:<iv_b64url>:<tag_b64url>:<data_b64url>
// 密钥来源: env ACCOUNT_SECRET(推荐,本地与服务器保持一致);未配置则从 ADMIN_PASSWORD 派生。
// 派生 salt 固定——secret 本身应由用户设为高熵随机串,固定 salt 保证跨进程/跨机器同一 key。
var CREDENTIAL_SECRET_FIELDS = ['glm_password', 'yescode_password', 'sub2api_password', 'cookie', 'authorization', 'satoken'];
var ENC_PREFIX = 'enc:v1:';

// 密钥惰性派生(进程内缓存;切换 secret 仅存在于测试场景)
var _accountKeyCache = { secret: null, key: null };
function accountSecretKey() {
    var secret = config.accountSecret || config.adminPassword;
    if (_accountKeyCache.key && _accountKeyCache.secret === secret) return _accountKeyCache.key;
    var key = crypto.scryptSync(String(secret), 'glm-usage-accounts-v1', 32);
    _accountKeyCache = { secret: secret, key: key };
    return key;
}

function encryptSecret(plaintext) {
    var s = String(plaintext);
    if (!s || s.indexOf(ENC_PREFIX) === 0) return s;   // 空值/已加密不重复加密
    var iv = crypto.randomBytes(12);
    var cipher = crypto.createCipheriv('aes-256-gcm', accountSecretKey(), iv);
    var data = Buffer.concat([cipher.update(s, 'utf8'), cipher.final()]);
    return ENC_PREFIX + iv.toString('base64url') + ':' + cipher.getAuthTag().toString('base64url') + ':' + data.toString('base64url');
}

// 解密失败(密钥不匹配/格式损坏)返回 null,由调用方决定是否按明文兜底
function decryptSecretOrNull(value) {
    if (typeof value !== 'string' || value.indexOf(ENC_PREFIX) !== 0) return null;
    try {
        var parts = value.slice(ENC_PREFIX.length).split(':');
        if (parts.length !== 3) return null;
        var decipher = crypto.createDecipheriv('aes-256-gcm', accountSecretKey(), Buffer.from(parts[0], 'base64url'));
        decipher.setAuthTag(Buffer.from(parts[1], 'base64url'));
        return Buffer.concat([decipher.update(Buffer.from(parts[2], 'base64url')), decipher.final()]).toString('utf8');
    } catch (e) { return null; }
}

function decryptAccounts(accounts) {
    return accounts.map(function(acc) {
        if (!acc || typeof acc !== 'object') return acc;
        var out = Array.isArray(acc) ? acc.slice() : Object.assign({}, acc);
        CREDENTIAL_SECRET_FIELDS.forEach(function(f) {
            if (typeof out[f] !== 'string') return;
            var plain = decryptSecretOrNull(out[f]);
            if (plain !== null) out[f] = plain;
            // 非 enc:v1 前缀视为历史明文,原样保留(下次写盘自动转密文)
        });
        return out;
    });
}

function encryptAccounts(accounts) {
    return accounts.map(function(acc) {
        if (!acc || typeof acc !== 'object') return acc;
        var out = Array.isArray(acc) ? acc.slice() : Object.assign({}, acc);
        CREDENTIAL_SECRET_FIELDS.forEach(function(f) {
            if (typeof out[f] === 'string' && out[f]) out[f] = encryptSecret(out[f]);
        });
        return out;
    });
}

function readAccounts() {
    if (!fs.existsSync(glmAccountsFile)) {
        writeAccounts([]);
        return [];
    }
    var parsed = JSON.parse(fs.readFileSync(glmAccountsFile, 'utf8'));
    return decryptAccounts(parsed.accounts || []);
}
function writeAccounts(accounts) {
    fs.writeFileSync(glmAccountsFile, JSON.stringify({ accounts: encryptAccounts(accounts) }, null, 2));
}

function httpsGet(url, headers) {
    return new Promise(function(resolve, reject) {
        https.get(url, { headers: headers }, function(res) {
            var body = '';
            res.on('data', function(c) { body += c; });
            res.on('end', function() {
                if (res.statusCode < 200 || res.statusCode >= 300)
                    return reject(new Error('HTTP ' + res.statusCode + ': ' + body.slice(0, 200)));
                try { resolve(JSON.parse(body)); }
                catch (e) { reject(new Error('Invalid JSON: ' + body.slice(0, 200))); }
            });
        }).on('error', reject);
    });
}

// http/https 通用的 JSON GET（带超时），用于拉取 sub2api 容量快照。
function httpGetJSON(url, timeoutMs) {
    return new Promise(function(resolve, reject) {
        var mod = /^https:/.test(url) ? https : http;
        var req = mod.get(url, function(res) {
            var body = '';
            res.on('data', function(c) { body += c; });
            res.on('end', function() {
                if (res.statusCode < 200 || res.statusCode >= 300)
                    return reject(new Error('HTTP ' + res.statusCode + ': ' + body.slice(0, 200)));
                try { resolve(JSON.parse(body)); }
                catch (e) { reject(new Error('Invalid JSON: ' + body.slice(0, 200))); }
            });
        });
        req.on('error', reject);
        req.setTimeout(timeoutMs || 5000, function() { req.destroy(new Error('timeout')); });
    });
}

function httpsRequest(method, url, headers, body) {
    return new Promise(function(resolve, reject) {
        var m = url.match(/^https:\/\/([^\/]+)(\/.*)$/);
        if (!m) return reject(new Error('Invalid URL'));
        var bodyStr = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : '';
        var opts = {
            hostname: m[1], path: m[2], method: method,
            headers: Object.assign({}, headers, bodyStr ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) } : {})
        };
        var req = https.request(opts, function(res) {
            var data = '';
            res.on('data', function(c) { data += c; });
            res.on('end', function() {
                if (res.statusCode < 200 || res.statusCode >= 300)
                    return reject(new Error('HTTP ' + res.statusCode + ': ' + data.slice(0, 200)));
                try { resolve(JSON.parse(data)); }
                catch (e) { reject(new Error('Invalid JSON: ' + data.slice(0, 200))); }
            });
        });
        req.on('error', reject);
        if (bodyStr) req.write(bodyStr);
        req.end();
    });
}

// application/x-www-form-urlencoded 的 POST(千问等接口用 form 表单传参,含 params=<URL编码JSON> 字段)。
// httpsRequest 强制 JSON content-type 且 JSON.stringify,无法发送 form body,故单独实现。
function httpsPostForm(url, headers, formBody) {
    return new Promise(function(resolve, reject) {
        var m = url.match(/^https:\/\/([^\/]+)(\/.*)$/);
        if (!m) return reject(new Error('Invalid URL'));
        var opts = {
            hostname: m[1], path: m[2], method: 'POST',
            headers: Object.assign({}, headers, {
                'content-type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(formBody)
            })
        };
        var req = https.request(opts, function(res) {
            var data = '';
            res.on('data', function(c) { data += c; });
            res.on('end', function() {
                if (res.statusCode < 200 || res.statusCode >= 300)
                    return reject(new Error('HTTP ' + res.statusCode + ': ' + data.slice(0, 200)));
                try { resolve(JSON.parse(data)); }
                catch (e) { reject(new Error('Invalid JSON: ' + data.slice(0, 200))); }
            });
        });
        req.on('error', reject);
        req.write(formBody);
        req.end();
    });
}

// ============ 管理密码防爆破（连续失败 3 次封 IP 15 分钟）============

var AUTH_FAIL_LIMIT = 3;
var AUTH_BAN_MS = 15 * 60 * 1000;

// 内存封禁表 { ip: { fails, bannedUntil } }；重启清空（防爆破不需持久化）
var authBanTable = {};

// 客户端 IP：反代场景取 x-forwarded-for 首段，否则取 socket 地址（Docker 直连可用）
function clientIp(req) {
    var fwd = req.headers && req.headers['x-forwarded-for'];
    if (fwd) return String(fwd).split(',')[0].trim();
    return (req.socket && req.socket.remoteAddress) || (req.connection && req.connection.remoteAddress) || 'unknown';
}

// 惰性清理：过期封禁项清零计数，避免内存表无限增长（IP 量级很小，全扫可接受）
function authBanGc(now) {
    Object.keys(authBanTable).forEach(function(ip) {
        var e = authBanTable[ip];
        if (!e) return;
        if (e.bannedUntil && e.bannedUntil <= now) delete authBanTable[ip];
        else if (e.bannedUntil && now - e.bannedUntil > AUTH_BAN_MS) delete authBanTable[ip];
    });
}

// 查询某 IP 封禁状态：{ banned, retryAfterSec, fails }
function authBanState(ip, now) {
    authBanGc(now);
    var e = authBanTable[ip];
    if (!e || !e.bannedUntil || e.bannedUntil <= now) {
        return { banned: false, retryAfterSec: 0, fails: e ? e.fails : 0 };
    }
    return { banned: true, retryAfterSec: Math.ceil((e.bannedUntil - now) / 1000), fails: e.fails };
}

// 记录一次密码失败；达到上限时写入封禁截止时间。返回新的封禁状态
function authBanRecordFailure(ip, now) {
    authBanGc(now);
    var e = authBanTable[ip] || (authBanTable[ip] = { fails: 0, bannedUntil: 0 });
    if (e.bannedUntil && e.bannedUntil > now) return authBanState(ip, now);
    e.fails += 1;
    if (e.fails >= AUTH_FAIL_LIMIT) {
        e.bannedUntil = now + AUTH_BAN_MS;
    }
    return authBanState(ip, now);
}

// 密码正确后清零该 IP 的失败计数与封禁
function authBanReset(ip) {
    delete authBanTable[ip];
}

function checkAuth(req, res, next) {
    var ip = clientIp(req);
    var st = authBanState(ip, Date.now());
    if (st.banned) {
        return res.status(429).json({ error: '密码连续错误次数过多，已封禁 ' + Math.ceil(st.retryAfterSec / 60) + ' 分钟，请稍后再试', retryAfterSec: st.retryAfterSec });
    }
    if (req.headers['x-auth-password'] !== PASSWORD) {
        var after = authBanRecordFailure(ip, Date.now());
        if (after.banned) {
            return res.status(429).json({ error: '密码连续错误 ' + AUTH_FAIL_LIMIT + ' 次，已封禁 15 分钟', retryAfterSec: after.retryAfterSec });
        }
        return res.status(401).json({ error: '密码错误' });
    }
    authBanReset(ip);
    next();
}

// 是否已登录管理员(用于区分游客与管理员,决定 isPublic===false 账号是否可见)
function isAuthed(req) {
    return req.headers['x-auth-password'] === PASSWORD;
}

// 游客(未登录管理员)不可见 isPublic===false 的账号
function isHiddenFromGuest(req, account) {
    return !isAuthed(req) && account.isPublic === false;
}

function makeHeaders(account) {
    return {
        'accept': 'application/json, text/plain, */*',
        'authorization': account.authorization,
        'bigmodel-organization': account.organization,
        'bigmodel-project': account.project,
    };
}

function keysUrl(account, suffix) {
    return 'https://bigmodel.cn/api/biz/v1/organization/' + account.organization
        + '/projects/' + account.project + '/api_keys' + (suffix || '');
}

// 智谱账号 IP 白名单接口(用户中心 / 安全管理)
function ipWhitelistUrl(account, suffix) {
    return 'https://bigmodel.cn/api/paas/userIpWhiteList' + (suffix || '');
}

// 智谱账号(个人版)风控/异常提示接口
function riskInfoUrl() {
    return 'https://bigmodel.cn/api/biz/customer/risk/info';
}

// 智谱账号(个人版)重置卡列表接口(Coding Plan 用量页)
function resetCardsUrl() {
    return 'https://bigmodel.cn/api/biz/customer-package-reset/list?targetType=PERSONAL';
}

// 智谱账号(个人版)重置卡使用接口(官方请求体需 targetType/resetType/recordId/requestId)
function resetCardUseUrl() {
    return 'https://bigmodel.cn/api/biz/customer-package-reset/use';
}

// 本地卡类型 → 官方 use 接口 resetType 取值(week 有官方抓包佐证;fiveHour 按列表字段 fiveHourResets 的命名惯例推断)
var RESET_CARD_USE_TYPES = { fiveHour: 'FIVE_HOUR', week: 'WEEK' };

// 风控等级 → 提示文案映射(data 值 1~8)
var RISK_TIPS = {
    1: '检测到当前支付方式短期内多次购买套餐，存在异常使用风险，部分权益已被限制。详情参阅《订阅服务协议》',
    2: '检测到账号存在多人使用行为，部分订阅权益已被限制。恢复正常使用后，系统将在2天内自动解除。详情参阅《订阅服务协议》',
    3: '检测到账号存在多人使用行为，部分订阅权益已被限制。恢复正常使用后，系统将在2天内自动解除。详情参阅《订阅服务协议》',
    4: '检测到账号存在多人使用行为，违规使用已导致套餐权益冻结（为期30天）。详情参阅《订阅服务协议》',
    5: '检测到账号在非官方许可范围内使用订阅服务，违规使用已导致套餐权益冻结（为期30天）。详情参阅《订阅服务协议》',
    6: '检测到账号短时间内发起大量重复请求，存在异常调用风险，违规使用已导致套餐权益冻结（为期30天）。详情参阅《订阅服务协议》',
    7: '检测到账号存在多人使用行为，且多次违反平台规则。当前套餐权益已被封禁，无法恢复使用。详情参阅《订阅服务协议》',
    8: '检测到账号多次违反平台规则。当前套餐权益已被封禁，无法恢复使用。详情参阅《订阅服务协议》'
};
// 未知风控等级的兜底文案
var RISK_TIPS_FALLBACK = '检测到账号存在异常使用风险，部分权益可能已被限制。详情参阅《订阅服务协议》';

// 解码智谱 JWT(authorization) 取 user_type:PERSONAL=个人版(非团队)、ENTERPRISE=团队版
function decodeJwtUserType(authorization) {
    try {
        var token = String(authorization || '').replace(/^Bearer\s+/, '');
        var parts = token.split('.');
        if (parts.length < 2) return null;
        var payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
        while (payload.length % 4) payload += '=';
        var json = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
        return json.user_type || null;
    } catch (e) { return null; }
}

// 解析重置卡列表:合并 5小时/周两类卡,仅保留 available 的有效卡
// recordId 供 use 接口定位具体卡片,必须透传
function parseGlmResetCards(data) {
    var cards = [];
    var groups = [['fiveHourResets', 'fiveHour'], ['weekResets', 'week']];
    groups.forEach(function(g) {
        var list = (data && data[g[0]]) || [];
        if (!Array.isArray(list)) return;
        list.forEach(function(c) {
            if (c && c.available) {
                cards.push({ type: g[1], recordId: c.recordId != null ? c.recordId : null, expireTime: c.expireTime || null });
            }
        });
    });
    return cards;
}

// 官方 use 接口要求 requestId 为 UUID v4(幂等键),示例 2a867e62-849e-4d90-87f3-f094ef0687d2
function uuidV4() {
    return crypto.randomUUID();
}

// 把最新重置卡列表落到 accounts.json 与内存用量缓存(列表接口与使用接口共用)
function persistGlmResetCards(i, cards) {
    var accounts = readAccounts();
    if (!accounts[i]) return null;
    if (cards.length) {
        accounts[i].resetCards = { count: cards.length, cards: cards, checkedAt: Date.now() };
    } else {
        delete accounts[i].resetCards;
    }
    writeAccounts(accounts);
    // 同步刷新内存用量缓存里的 resetCards,避免 /api/usage 仍返回旧值
    var c = usageCache[i];
    if (c && c.result) c.result.resetCards = cards.length ? accounts[i].resetCards : undefined;
    return accounts[i].resetCards;
}

// 校验 IP 地址格式:支持 IPv4 或 IPv4/CIDR(如 1.2.3.4 / 10.0.0.0/8)
function isValidIp(ip) {
    var m = String(ip).match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(\/(\d{1,2}))?$/);
    if (!m) return false;
    for (var i = 1; i <= 4; i++) {
        var n = parseInt(m[i], 10);
        if (n < 0 || n > 255) return false;
    }
    if (m[6] != null) {
        var cidr = parseInt(m[6], 10);
        if (cidr < 0 || cidr > 32) return false;
    }
    return true;
}

// ============ GLM 账号 ============

function genAnonymousId() {
    function hex(n) {
        var s = '';
        for (var i = 0; i < n; i++) s += Math.floor(Math.random() * 16).toString(16);
        return s;
    }
    return hex(12) + '-' + hex(13) + '-' + hex(8) + '-' + hex(6) + '-' + hex(12);
}

function isGlmAuthError(err) {
    var msg = String((err && err.message) || err || '');
    // 参考抢号脚本：preview 失效常见 401/405；用量接口也可能 401/403
    return /\bHTTP\s+(401|403|405)\b/.test(msg)
        || /认证失败|token.*(?:失效|过期)|未登录|登录已过期|unauthorized/i.test(msg);
}

function hasGlmLoginCredentials(account) {
    return !!(account && String(account.glm_username || '').trim() && String(account.glm_password || '') !== '');
}

// 参考 glm-coding-grabber/index-v3.js：POST /api/auth/login 刷新 access_token
async function loginGlm(username, password) {
    var body = {
        phoneNumber: '',
        countryCode: '',
        username: String(username || '').trim(),
        smsCode: '',
        password: String(password || ''),
        loginType: 'password',
        grantType: 'customer',
        userType: 'PERSONAL',
        userCode: '',
        appId: '',
        anonymousId: genAnonymousId()
    };
    var json = await httpsRequest('POST', 'https://bigmodel.cn/api/auth/login', {
        'accept': 'application/json, text/plain, */*',
        'content-type': 'application/json;charset=UTF-8'
    }, body);
    var token = json && json.data && json.data.access_token;
    if (!(json && (json.code === 200 || json.code === 0) && token)) {
        throw new Error('智谱登录失败: ' + ((json && (json.msg || json.message)) || '未知错误'));
    }
    // 面板存的是裸 JWT；请求头 makeHeaders 直接塞 authorization
    return String(token).replace(/^Bearer\s+/i, '');
}

function saveGlmToken(index, newAuth) {
    try {
        var accounts = readAccounts();
        if (!accounts[index]) return;
        var platform = accounts[index].platform || 'glm';
        if (platform !== 'glm') return;
        accounts[index].authorization = newAuth;
        writeAccounts(accounts);
    } catch (e) { /* ignore write errors */ }
}

async function withGlmAuthRetry(account, index, requestFn) {
    try {
        return await requestFn(account);
    } catch (authErr) {
        if (!isGlmAuthError(authErr) || !hasGlmLoginCredentials(account)) throw authErr;
        var newAuth = await loginGlm(account.glm_username, account.glm_password);
        saveGlmToken(index, newAuth);
        // 本进程内后续请求立即用新 token（accounts.json 也可能被其他写覆盖，以内存更新为准）
        account.authorization = newAuth;
        return await requestFn(account);
    }
}

async function fetchGLMUsage(account, index) {
    try {
        var json = await withGlmAuthRetry(account, index, async function(acc) {
            var url = 'https://bigmodel.cn/api/monitor/usage/quota/limit';
            if (acc.teamEdition) url += '?type=2';
            return httpsGet(url, makeHeaders(acc));
        });
        var userType = decodeJwtUserType(account.authorization);
        var personalEdition = userType ? userType === 'PERSONAL' : !account.teamEdition;
        var result = { index: index, name: account.name, platform: 'glm', responsiblePerson: account.responsiblePerson, phone: account.phone, notes: account.notes, keyCount: account.keyCount, teamEdition: account.teamEdition || undefined, personalEdition: personalEdition, isPublic: account.isPublic, risk: account.risk || undefined, resetCards: account.resetCards || undefined, data: json.data, success: true, cachedAt: Date.now() };
        setCache(index, result);
        return result;
    } catch (err) {
        return { index: index, name: account.name, platform: 'glm', responsiblePerson: account.responsiblePerson, phone: account.phone, notes: account.notes, keyCount: account.keyCount, teamEdition: account.teamEdition || undefined, isPublic: account.isPublic, risk: account.risk || undefined, resetCards: account.resetCards || undefined, error: err.message, success: false };
    }
}

// 从订阅对象中提取「当前周期到期时间」。
// valid 形如 "2026-10-28 10:00:00-2027-01-28 10:00:00"，起始即当前周期结束（= nextRenewTime）。
function glmSubscriptionExpireTime(sub) {
    if (!sub) return null;
    if (typeof sub.valid === 'string') {
        var m = sub.valid.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/);
        if (m) return m[1] + ' ' + m[2];
    }
    if (sub.nextRenewTime) return String(sub.nextRenewTime);
    return null;
}

// 积分制(新版)套餐无体验卡，到期时间改从订阅列表接口获取；软失败返回 null。
async function glmSubscriptionExpire(account, index) {
    try {
        var json = await withGlmAuthRetry(account, index, async function(acc) {
            return httpsGet('https://bigmodel.cn/api/biz/subscription/list', makeHeaders(acc));
        });
        var list = (json && json.data) || [];
        if (!Array.isArray(list) || !list.length) return null;
        var active = list.find(function(s) { return s && s.status === 'VALID'; }) || list[0];
        return glmSubscriptionExpireTime(active);
    } catch (err) {
        return null;
    }
}

async function fetchGLMExpire(account, index) {
    try {
        var json = await withGlmAuthRetry(account, index, async function(acc) {
            return httpsGet('https://bigmodel.cn/api/biz/trial-cards/current-user', makeHeaders(acc));
        });
        var expireTime = json.data && json.data.expireTime;
        var inviteCode = json.data && json.data.inviteCode;
        // 体验卡接口对积分制套餐返回「暂不支持体验卡」→ 回退到订阅列表取到期时间
        if (!expireTime) {
            expireTime = await glmSubscriptionExpire(account, index);
        }
        var result = { expireTime: expireTime, inviteCode: inviteCode, success: true, cachedAt: Date.now() };
        setExpireCache(index, result);
        return result;
    } catch (err) {
        return { error: err.message, success: false, cachedAt: Date.now() };
    }
}

// ============ YesCode 账号 ============

// 官方登录态有效期已缩短为 24h（set-cookie Max-Age=86400），
// 记录了账密的账号在 Cookie 失效(401)时自动重新登录并回写 Cookie。
// httpsRequest 不暴露响应头，这里单独实现以收集 set-cookie 中的 yescode_auth / yescode_csrf。
function yescodeLogin(username, password) {
    return new Promise(function(resolve, reject) {
        var bodyStr = JSON.stringify({ username: username, password: password });
        var req = https.request({
            hostname: 'co.yes.vg', path: '/api/v1/auth/login', method: 'POST',
            headers: {
                'accept': 'application/json, text/plain, */*',
                'content-type': 'application/json',
                'origin': 'https://co.yes.vg',
                'referer': 'https://co.yes.vg/login',
                'content-length': Buffer.byteLength(bodyStr)
            }
        }, function(res) {
            var data = '';
            res.on('data', function(c) { data += c; });
            res.on('end', function() {
                if (res.statusCode < 200 || res.statusCode >= 300)
                    return reject(new Error('YesCode 登录失败 HTTP ' + res.statusCode + ': ' + data.slice(0, 200)));
                var json;
                try { json = JSON.parse(data); } catch (e) { return reject(new Error('YesCode 登录返回异常: ' + data.slice(0, 200))); }
                if (!json.token) return reject(new Error('YesCode 登录失败: ' + (json.error || json.message || '未返回 token')));
                // 优先用 set-cookie 组装完整 Cookie（profile 等接口按 cookie 鉴权）；拿不到响应头时退回 body token
                var auth = null, csrf = null;
                (res.headers['set-cookie'] || []).forEach(function(c) {
                    var m = c.match(/^(yescode_auth|yescode_csrf)=([^;]*)/);
                    if (!m) return;
                    if (m[1] === 'yescode_auth') auth = m[2];
                    if (m[1] === 'yescode_csrf') csrf = m[2];
                });
                var cookie = auth
                    ? ('yescode_auth=' + auth + (csrf ? '; yescode_csrf=' + csrf : ''))
                    : ('yescode_auth=' + json.token);
                resolve(cookie);
            });
        });
        req.on('error', reject);
        req.write(bodyStr);
        req.end();
    });
}

function saveYescodeCookie(index, newCookie) {
    try {
        var accounts = readAccounts();
        if (accounts[index] && accounts[index].platform === 'yescode') {
            accounts[index].cookie = newCookie;
            writeAccounts(accounts);
        }
    } catch (e) { /* ignore write errors */ }
}

function hasYescodeLoginCredentials(account) {
    return !!(account.yescode_username && account.yescode_password);
}

function yescodeProfileRequest(account) {
    return httpsGet('https://co.yes.vg/api/v1/auth/profile', {
        'accept': 'application/json, text/plain, */*',
        'cookie': account.cookie || ''
    });
}

// profile 失效(401)且配置了账密 → 自动重登；无 Cookie 且有账密时也直接登录获取
async function withYescodeAuthRetry(account, index, requestFn) {
    try {
        return await requestFn(account);
    } catch (authErr) {
        var isAuthErr = authErr.message && authErr.message.indexOf('HTTP 401') >= 0;
        if ((!isAuthErr && account.cookie) || !hasYescodeLoginCredentials(account)) throw authErr;
        var newCookie = await yescodeLogin(account.yescode_username, account.yescode_password);
        saveYescodeCookie(index, newCookie);
        // 本进程内后续请求立即用新 Cookie（accounts.json 也可能被其他写覆盖，以内存更新为准）
        account.cookie = newCookie;
        return await requestFn(account);
    }
}

async function fetchYesCodeUsage(account, index) {
    try {
        var json = await withYescodeAuthRetry(account, index, yescodeProfileRequest);
        var result = {
            index: index,
            name: account.name,
            platform: 'yescode',
            responsiblePerson: account.responsiblePerson,
            phone: account.phone,
            notes: account.notes,
            teamEdition: account.teamEdition || undefined,
            isPublic: account.isPublic,
            data: json.data || json,
            success: true,
            cachedAt: Date.now()
        };
        setCache(index, result);
        return result;
    } catch (err) {
        return {
            index: index,
            name: account.name,
            platform: 'yescode',
            responsiblePerson: account.responsiblePerson,
            phone: account.phone,
            notes: account.notes,
            teamEdition: account.teamEdition || undefined,
            isPublic: account.isPublic,
            error: err.message,
            success: false
        };
    }
}

// ============ Sub2API 中转站 账号 ============
// 火狸(huolilink.com) 本质是 sub2api 部署,泛化为任意 sub2api 站点:
// 账号配 base_url + 登录账密,access_token 24h 过期后自动重登续期(旧 huoli 账号无 base_url 时回退 huolilink)。

function sub2apiBaseUrl(account) {
    return (account.base_url || 'https://huolilink.com').replace(/\/+$/, '');
}

// 账密字段:sub2api 账号用 sub2api_email/password,旧 huoli 账号回退 huoli_email/password
function sub2apiCreds(account) {
    var email = account.sub2api_email || account.huoli_email || '';
    var password = account.sub2api_password || account.huoli_password || '';
    return (email && password) ? { email: email, password: password } : null;
}

async function loginSub2api(baseUrl, email, password) {
    var json = await httpsRequest('POST', baseUrl + '/api/v1/auth/login', {
        'accept': 'application/json, text/plain, */*',
        'accept-language': 'zh',
        'content-type': 'application/json'
    }, { email: email, password: password });
    if (json.code !== 0 || !json.data || !json.data.access_token) {
        throw new Error('Sub2API 登录失败: ' + (json.message || '未知错误'));
    }
    return 'Bearer ' + json.data.access_token;
}

function saveSub2apiToken(index, newAuth) {
    try {
        var accounts = readAccounts();
        if (accounts[index] && (accounts[index].platform === 'sub2api' || accounts[index].platform === 'huoli')) {
            accounts[index].authorization = newAuth;
            writeAccounts(accounts);
        }
    } catch (e) { /* ignore write errors */ }
}

// sub2api GET,401(或无 token)且有账密时自动重登后重试。
// 每次调用都从 account 取最新 token(前一次调用重登后已回写 account.authorization),避免携带过期 token 重复登录。
async function sub2apiGet(account, index, baseUrl, path, headers) {
    var h = Object.assign({}, headers, { authorization: account.authorization || (headers && headers.authorization) || '' });
    try {
        return await httpsGet(baseUrl + path, h);
    } catch (authErr) {
        var creds = sub2apiCreds(account);
        var isAuthErr = authErr.message && authErr.message.indexOf('HTTP 401') >= 0;
        if (!creds || (!isAuthErr && account.authorization)) throw authErr;
        var newAuth = await loginSub2api(baseUrl, creds.email, creds.password);
        saveSub2apiToken(index, newAuth);
        // 本进程内后续请求立即用新 token（accounts.json 也可能被其他写覆盖，以内存更新为准）
        account.authorization = newAuth;
        return await httpsGet(baseUrl + path, Object.assign({}, h, { authorization: newAuth }));
    }
}

async function fetchSub2apiUsage(account, index) {
    try {
        var baseUrl = sub2apiBaseUrl(account);
        var headers = {
            'accept': 'application/json, text/plain, */*',
            'authorization': account.authorization || ''
        };
        // auth/me = 余额/账户信息;subscriptions = 订阅与窗口用量
        var meJson = await sub2apiGet(account, index, baseUrl, '/api/v1/auth/me?timezone=Asia%2FShanghai', headers);
        var subsJson = await sub2apiGet(account, index, baseUrl, '/api/v1/subscriptions?timezone=Asia%2FShanghai', headers);
        // usage/dashboard/stats = 今日/累计 token 与费用;旧版部署可能无此接口,软失败不影响主数据
        var stats = null;
        try {
            var statsJson = await sub2apiGet(account, index, baseUrl, '/api/v1/usage/dashboard/stats?timezone=Asia%2FShanghai', headers);
            stats = (statsJson && statsJson.data) || null;
        } catch (statsErr) { /* 无用量统计接口时忽略 */ }
        var subs = (subsJson && Array.isArray(subsJson.data)) ? subsJson.data : [];
        // 当前订阅:active 优先;已过期的仅 3 天内保留展示,超过则视为无订阅(卡片以余额用量为主)
        var current = subs.filter(function(s) { return s && s.status === 'active'; })[0] || null;
        if (!current) {
            current = subs.filter(function(s) {
                if (!s || !s.expires_at) return false;
                return (Date.now() - new Date(s.expires_at).getTime()) <= 3 * 86400000;
            }).sort(function(a, b) {
                return new Date(b.expires_at) - new Date(a.expires_at);
            })[0] || null;
        }
        var result = {
            index: index,
            name: account.name,
            platform: account.platform || 'sub2api',
            responsiblePerson: account.responsiblePerson,
            phone: account.phone,
            notes: account.notes,
            teamEdition: account.teamEdition || undefined,
            isPublic: account.isPublic,
            alias: account.alias || undefined,
            baseUrl: baseUrl,
            data: { me: (meJson && meJson.data) || null, subscriptions: subs, current: current, stats: stats },
            success: true,
            cachedAt: Date.now()
        };
        setCache(index, result);
        return result;
    } catch (err) {
        return {
            index: index,
            name: account.name,
            platform: account.platform || 'sub2api',
            responsiblePerson: account.responsiblePerson,
            phone: account.phone,
            notes: account.notes,
            teamEdition: account.teamEdition || undefined,
            isPublic: account.isPublic,
            alias: account.alias || undefined,
            baseUrl: sub2apiBaseUrl(account),
            error: err.message,
            success: false
        };
    }
}

// ============ 火山账号（AgentPlan=火山A / CodingPlan=火山C，同一登录会话）============

// AgentPlan（火山A）请求头
function volcHeaders(account) {
    var h = {
        'accept': 'application/json, text/plain, */*',
        'accept-language': 'zh',
        'cache-control': 'no-cache',
        'content-type': 'application/json',
        'pragma': 'no-cache',
        'cookie': account.cookie || '',
        'x-csrf-token': account.csrf || '',
        'referer': 'https://console.volcengine.com/ark/region:ark+cn-beijing/openManagement?LLM=%7B%7D&advancedActiveKey=agentPlan'
    };
    if (account.web_id) h['x-web-id'] = account.web_id;
    return h;
}

// CodingPlan（火山C）请求头
function volcCodingHeaders(account) {
    var h = {
        'accept': 'application/json, text/plain, */*',
        'accept-language': 'zh',
        'cache-control': 'no-cache',
        'content-type': 'application/json',
        'pragma': 'no-cache',
        'cookie': account.cookie || '',
        'x-csrf-token': account.csrf || '',
        'referer': 'https://console.volcengine.com/ark/region:cn-beijing/subscription/coding-plan'
    };
    if (account.web_id) h['x-web-id'] = account.web_id;
    return h;
}

// 统一抓取：按 account.planType 分派到 AgentPlan 或 CodingPlan 接口
async function fetchVolcUsage(account, index) {
    var isCoding = account.planType === 'coding';
    var planType = isCoding ? 'coding' : 'agent';
    try {
        var headers = isCoding ? volcCodingHeaders(account) : volcHeaders(account);
        var usageUrl = isCoding
            ? 'https://console.volcengine.com/api/top/ark/cn-beijing/2024-01-01/GetCodingPlanUsage'
            : 'https://console.volcengine.com/api/top/ark/cn-beijing/2024-01-01/GetAgentPlanAFPUsage';
        var subUrl = 'https://console.volcengine.com/api/top/ark/cn-beijing/2024-01-01/ListSubscribeTrade';
        var subBody = isCoding
            ? { ResourceTypes: ['CodingPlan'], ResourceNames: [''], BizInfos: ['lite', 'pro'] }
            : { ResourceTypes: ['AgentPlan'], ResourceNames: ['RealAgentPlanPersonal'], BizInfos: ['small', 'medium', 'large', 'max'] };

        var usagePromise = httpsRequest('POST', usageUrl, headers, {}).then(function(j) { return j && j.Result ? j.Result : null; });
        var subPromise = httpsRequest('POST', subUrl, headers, subBody).then(function(j) {
            return (j && j.Result && j.Result.InfoList && j.Result.InfoList[0]) || null;
        }).catch(function() { return null; });

        var usage = await usagePromise;
        var subscription = await subPromise;

        if (!usage) throw new Error('未获取到用量数据（可能是 Cookie/CSRF 已失效）');

        var result = {
            index: index,
            name: account.name,
            platform: 'volc',
            planType: planType,
            responsiblePerson: account.responsiblePerson,
            phone: account.phone,
            notes: account.notes,
            teamEdition: account.teamEdition || undefined,
            isPublic: account.isPublic,
            data: { usage: usage, subscription: subscription },
            success: true,
            cachedAt: Date.now()
        };
        setCache(index, result);
        return result;
    } catch (err) {
        return {
            index: index,
            name: account.name,
            platform: 'volc',
            planType: planType,
            responsiblePerson: account.responsiblePerson,
            phone: account.phone,
            notes: account.notes,
            teamEdition: account.teamEdition || undefined,
            isPublic: account.isPublic,
            error: err.message,
            success: false
        };
    }
}

// ============ 千问 token plan 账号（Token Plan 个人版）============

function qwenHeaders(account) {
    return {
        'accept': 'application/json, text/plain, */*',
        'accept-language': 'zh-CN,zh;q=0.9',
        'cache-control': 'no-cache',
        'pragma': 'no-cache',
        'cookie': account.cookie || '',
        'referer': 'https://platform.qianwenai.com/home/billing/subscription/token-plan-individual'
    };
}

// 把 {k:v} 编码成 application/x-www-form-urlencoded 字符串
function formEncode(fields) {
    return Object.keys(fields).map(function(k) {
        return encodeURIComponent(k) + '=' + encodeURIComponent(fields[k]);
    }).join('&');
}

// 千问用量接口 params（静态）
var QWEN_USAGE_PARAMS = {
    Api: 'zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage',
    Data: {
        cornerstoneParam: {
            domain: 'platform.qianwenai.com',
            consoleSite: 'QIANWENAI',
            console: 'ONE_CONSOLE',
            xsp_lang: 'zh-CN',
            protocol: 'V2',
            productCode: 'p_efm'
        }
    },
    V: '1.0'
};

// 千问订阅信息接口 params（静态）
var QWEN_SUB_PARAMS = {
    Api: 'zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/subscription',
    Data: {
        commodityCode: 'sfm_tokenplansolo_public_cn',
        cornerstoneParam: {
            domain: 'platform.qianwenai.com',
            consoleSite: 'QIANWENAI',
            console: 'ONE_CONSOLE',
            xsp_lang: 'zh-CN',
            protocol: 'V2',
            productCode: 'p_efm'
        }
    },
    V: '1.0'
};

// 千问 BroadScopeAspnGateway 网关请求体（usage / subscription 共用同一网关，仅 params 不同）
function qwenGatewayForm(apiPath, secToken) {
    return formEncode({
        product: 'sfm_bailian',
        action: 'BroadScopeAspnGateway',
        sec_token: secToken,
        region: 'cn-beijing',
        params: JSON.stringify(apiPath === 'subscription' ? QWEN_SUB_PARAMS : QWEN_USAGE_PARAMS)
    });
}

// 统一抓取：并行调用用量接口（5h/7d 百分比 + 重置时间）+ 订阅接口（真实到期/剩余天数/状态），订阅接口软失败
async function fetchQwenUsage(account, index) {
    try {
        var headers = qwenHeaders(account);
        var secToken = account.sec_token || '';
        var gatewayBase = 'https://cs-data.qianwenai.com/data/api.json?product=sfm_bailian&action=BroadScopeAspnGateway&api=';

        // 用量接口：百分比是 0~1 小数，需 ×100；同时取重置时间（毫秒时间戳）用于理论水位线与权重速率评分
        var usageUrl = gatewayBase + 'zeldaHttp.apikeyMgr.%2Ftokenplan%2Fpersonal%2Fapi%2Fv2%2Fusage';
        var usagePromise = httpsPostForm(usageUrl, headers, qwenGatewayForm('usage', secToken)).then(function(j) {
            var inner = j && j.data && j.data.DataV2 && j.data.DataV2.data && j.data.DataV2.data.data;
            if (!inner) return null;
            return {
                per5HourPercentage: typeof inner.per5HourPercentage === 'number' ? inner.per5HourPercentage * 100 : 0,
                per1WeekPercentage: typeof inner.per1WeekPercentage === 'number' ? inner.per1WeekPercentage * 100 : 0,
                per5HourResetTime: inner.per5HourResetTime || null,
                per1WeekResetTime: inner.per1WeekResetTime || null
            };
        });

        // 订阅接口：真实到期时间 endTime / 剩余天数 / 状态 / 自动续费 / 套餐规格
        var subUrl = gatewayBase + 'zeldaHttp.apikeyMgr.%2Ftokenplan%2Fpersonal%2Fapi%2Fv2%2Fsubscription';
        var subPromise = httpsPostForm(subUrl, headers, qwenGatewayForm('subscription', secToken)).then(function(j) {
            var inner = j && j.data && j.data.DataV2 && j.data.DataV2.data && j.data.DataV2.data.data;
            if (!inner) return null;
            return {
                instanceCode: inner.instanceCode || null,
                specCode: inner.specCode || null,
                remainingDays: typeof inner.remainingDays === 'number' ? inner.remainingDays : null,
                startTime: inner.startTime || null,
                endTime: inner.endTime || null,
                autoRenewFlag: !!inner.autoRenewFlag,
                status: inner.status || null
            };
        }).catch(function() { return null; });

        var usage = await usagePromise;
        var subscription = await subPromise;

        if (!usage) throw new Error('未获取到用量数据（Cookie / sec_token 可能已失效）');

        var result = {
            index: index,
            name: account.name,
            platform: 'qwen',
            responsiblePerson: account.responsiblePerson,
            phone: account.phone,
            notes: account.notes,
            isPublic: account.isPublic,
            data: { usage: usage, subscription: subscription },
            success: true,
            cachedAt: Date.now()
        };
        setCache(index, result);
        return result;
    } catch (err) {
        return {
            index: index,
            name: account.name,
            platform: 'qwen',
            responsiblePerson: account.responsiblePerson,
            phone: account.phone,
            notes: account.notes,
            isPublic: account.isPublic,
            error: err.message,
            success: false
        };
    }
}

// 千问用量曲线 usage_type -> 展示名
var QWEN_USAGE_TYPE_LABELS = {
    total_tokens: '总Token',
    input_tokens: '输入Token',
    output_tokens: '输出Token',
    cached_tokens: '缓存Token',
    web_search_count: '联网搜索'
};

// 解析千问用量曲线网关响应。两种「无数据」场景区分:
//   1) 登录失效:j.data.success=false(errorCode=BailianGateway.Login.NotLogined)、无 DataV2 → 抛错提示 Cookie
//   2) 时段内无调用:DataV2 结构正常但 originData 为空数组 → 返回空数据集,由前端展示友好空态
// 同时过滤 cumsum 聚合序列(points 长度与 x 轴不一致):它会让图例出现重复的「总Token」,
// 且其单点值会被总用量二次累加导致汇总翻倍。
function parseQwenModelUsageJson(j) {
    var dataV2 = j && j.data && j.data.DataV2;
    var dataWrap = dataV2 && dataV2.data;
    if (!dataWrap || dataWrap.success === false) {
        throw new Error('未获取到用量曲线数据（Cookie / sec_token 可能已失效）');
    }
    var originData = dataWrap.data && dataWrap.data.originData;
    if (!Array.isArray(originData) || !originData.length) {
        return { x_time: [], modelDataList: [], totalUsage: { totalTokensUsage: 0 } };
    }

    function pad(n) { return n < 10 ? '0' + n : '' + n; }
    function fmtTs(ts) {
        var dd = new Date(ts);
        return dd.getFullYear() + '-' + pad(dd.getMonth() + 1) + '-' + pad(dd.getDate()) + ' ' + pad(dd.getHours()) + ':' + pad(dd.getMinutes());
    }

    var x_time = (originData[0].points || []).map(function(p) { return fmtTs(p.timestamp); });
    var modelDataList = originData
        .filter(function(series) { return (series.points || []).length === x_time.length; })
        .map(function(series) {
            var ut = series.labels && series.labels.usage_type;
            return {
                modelName: QWEN_USAGE_TYPE_LABELS[ut] || ut || 'unknown',
                tokensUsage: (series.points || []).map(function(p) { return p.value || 0; })
            };
        });

    // totalUsage:取 total_tokens 系列求和(千问无调用次数,totalModelCallCount 留空由前端隐藏)
    var totalTokens = 0;
    modelDataList.forEach(function(m) {
        if (m.modelName === '总Token') {
            totalTokens = (m.tokensUsage || []).reduce(function(a, b) { return a + (b || 0); }, 0);
        }
    });

    return {
        x_time: x_time,
        modelDataList: modelDataList,
        totalUsage: { totalTokensUsage: totalTokens }
    };
}

// 千问用量曲线：按 period 取当日(每小时)/近7天/近30天(每日)的 model_usage,
// 转换为与智谱一致的图表格式 {x_time, modelDataList, totalUsage} 供前端 renderUsageChart 复用
async function fetchQwenModelUsage(account, period) {
    var secToken = account.sec_token || '';
    var headers = qwenHeaders(account);
    var now = Date.now();
    var d = new Date();
    var startOfToday = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    var step, startTime;
    if (period === 'today') {
        step = 3600;            // 每小时
        startTime = startOfToday;
    } else {
        step = 86400;           // 每天
        var days = period === '30d' ? 30 : 7;
        startTime = new Date(d.getFullYear(), d.getMonth(), d.getDate() - (days - 1)).getTime();
    }
    var params = {
        Api: 'zeldaEasy.bailian-telemetry.platform-model.getModelMonitorDataWithOss',
        Data: {
            reqDTO: {
                productMode: 'TokenPlanPersonal',
                startTime: startTime,
                endTime: now,
                step: step,
                metricFilters: [{ aggMethod: 'sum', metricName: 'model_usage' }]
            },
            cornerstoneParam: {
                domain: 'platform.qianwenai.com',
                consoleSite: 'QIANWENAI',
                console: 'ONE_CONSOLE',
                xsp_lang: 'zh-CN',
                protocol: 'V2',
                productCode: 'p_efm'
            }
        },
        V: '1.0'
    };
    var form = formEncode({
        product: 'sfm_bailian',
        action: 'BroadScopeAspnGateway',
        sec_token: secToken,
        region: 'cn-beijing',
        params: JSON.stringify(params)
    });
    var url = 'https://cs-data.qianwenai.com/data/api.json?product=sfm_bailian&action=BroadScopeAspnGateway&api=zeldaEasy.bailian-telemetry.platform-model.getModelMonitorDataWithOss';
    var j = await httpsPostForm(url, headers, form);
    return parseQwenModelUsageJson(j);
}

// ============ MiniMax Token Plan 账号（platform.minimaxi.com）============

// group_id 优先取账号字段;未填时从 Cookie 的 minimax_group_id_v2 兜底解析
function minimaxGroupId(account) {
    if (account.group_id) return String(account.group_id);
    var m = String(account.cookie || '').match(/minimax_group_id_v2=(\d+)/);
    return m ? m[1] : '';
}

function minimaxHeaders(account) {
    return {
        'accept': 'application/json, text/plain, */*',
        'accept-language': 'zh-CN,zh;q=0.9',
        'cache-control': 'no-cache',
        'pragma': 'no-cache',
        'cookie': account.cookie || '',
        'origin': 'https://platform.minimaxi.com',
        'referer': 'https://platform.minimaxi.com/',
        'x-group-id': minimaxGroupId(account),
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36'
    };
}

function minimaxPad2(n) { return n.length < 2 ? '0' + n : n; }

// 从消息盒子(message_category=4)的权益发放通知解析订阅(兜底数据源,官方订阅接口无数据时使用):
// content 形如「您已成功获得 <b>Token Plan Max (1个月)</b> 权益。当前权益有效期截止至 <b>2026年08月30日</b>。」
// 取首个 <b> 内容为套餐名,\d{4}年\d{1,2}月\d{1,2}日 为到期日;多条通知时取 send_time 最新的一条。
// 注意:续费后盒子通知可能仍停留在上一周期,导致到期日滞后误标已过期,故仅作兜底。
// 解析不到返回 null(账号可能从未购买过 Token Plan)。
function parseMinimaxSubscription(json) {
    var infos = (json && Array.isArray(json.template_infos)) ? json.template_infos : [];
    var best = null;
    for (var i = 0; i < infos.length; i++) {
        var info = infos[i] || {};
        var tpl = info.template_info || {};
        var text = tpl.content || tpl.title || '';
        if (!text) continue;
        var dateMatch = text.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
        if (!dateMatch) continue;
        var sendTime = Number(info.send_time) || 0;
        if (best && sendTime <= best.notifiedAt) continue;
        var nameMatch = text.match(/<b>([\s\S]*?)<\/b>/);
        var planName = nameMatch ? nameMatch[1].replace(/<[^>]+>/g, '').trim() : null;
        var expireMs = new Date(+dateMatch[1], +dateMatch[2] - 1, +dateMatch[3], 23, 59, 59).getTime();
        best = {
            planName: planName,
            expireDate: dateMatch[1] + '-' + minimaxPad2(dateMatch[2]) + '-' + minimaxPad2(dateMatch[3]),
            expireMs: expireMs,
            notifiedAt: sendTime
        };
    }
    return best;
}

// 解析官方订阅接口(charge/combo/cycle_audio_resource_package)的 current_subscribe(权威到期来源):
// current_subscribe_end_time_ts 为北京时间次日零点(如 1788019200000 = 2026-08-30 00:00 CST,即 08-29 24 点到期),
// 加 8 小时后取 UTC 日期,保证服务器任意时区下格式化结果一致;无 current_subscribe 或缺 ts 返回 null。
function parseMinimaxSubscribeInfo(json) {
    var sub = json && json.current_subscribe;
    var endTs = Number(sub && sub.current_subscribe_end_time_ts) || 0;
    if (!endTs) return null;
    var d = new Date(endTs + 8 * 3600 * 1000);
    return {
        planName: sub.current_subscribe_title || null,
        expireDate: d.getUTCFullYear() + '-' + minimaxPad2(String(d.getUTCMonth() + 1)) + '-' + minimaxPad2(String(d.getUTCDate())),
        expireMs: endTs
    };
}

// 订阅到期合成:官方订阅接口优先,消息盒子权益通知兜底;官方套餐名缺失时借用通知中的套餐名。
function minimaxMergeSubscription(subJson, boxJson) {
    var official = parseMinimaxSubscribeInfo(subJson);
    var noticed = parseMinimaxSubscription(boxJson);
    if (!official) return noticed;
    if (official.planName || !noticed) return official;
    return Object.assign({}, official, { planName: noticed.planName });
}

// 「%」字符串 → 数字(保留 1 位小数);解析失败返回 null
function minimaxParsePercent(s) {
    if (s == null) return null;
    var m = String(s).match(/^(-?\d+(?:\.\d+)?)\s*%?$/);
    return m ? parseFloat(m[1]) : null;
}

// 模型名 + 周期 → 中文展示名;与官方 i18n 一致(5h 限额 / 周限额 / 视频赠送)
function minimaxWindowLabel(modelName, kind) {
    if (modelName === 'general') return kind === 'weekly' ? '周限额' : '5h 限额';
    if (modelName === 'video') return kind === 'weekly' ? '视频周赠' : '视频赠送';
    return modelName + (kind === 'weekly' ? ' 周用量' : ' 限额');
}

// 把单个模型行的 current_interval / current_weekly 字段归一化为窗口对象;
// 计数可用(>=0 且 quota>0)走 used/quota 路径,否则退回 usedPct 路径(quota 为 -1 表示无限额,按百分比展示)。
// 对齐 GLM:百分比窗口(general)渲染 5 等分进度条;计数窗口(video 每日)保持单条不带段。
function minimaxMakeWindow(modelName, kind, usedCount, totalCount, usedPct, startMs, endMs) {
    var label = minimaxWindowLabel(modelName, kind);
    var resetMs = Number(endMs) || null;
    var periodMs = (Number(endMs) || 0) > (Number(startMs) || 0) ? (Number(endMs) - Number(startMs)) : null;
    if (Number(usedCount) >= 0 && Number(totalCount) > 0) {
        return { label: label, used: Number(usedCount), quota: Number(totalCount), resetMs: resetMs, periodMs: periodMs };
    }
    var pct = minimaxParsePercent(usedPct);
    if (pct == null) return null;
    // 仅 general 文本模型返回周期窗口(5 等分),其他模型在周窗不入显示
    var segments = (modelName === 'general') ? 5 : 0;
    return { label: label, usedPct: pct, resetMs: resetMs, periodMs: periodMs, segments: segments };
}

// 解析 MiniMax 用量接口(remains_percent):
// 返回 windows 数组(可能为空);base_resp.status_code != 0 或 model_remains 缺失时返回 null。
// 只对外暴露 general(5h 限额 + 周限额,5 等分)与 video(每日赠送,计数);video 周窗不再展示。
// video 每日赠送打 weightExcluded=true:仅展示,不参与权重/紧张度(耗尽也不影响账号可用性)。
function parseMinimaxUsage(json) {
    if (!json || !json.base_resp || json.base_resp.status_code !== 0) return null;
    var models = Array.isArray(json.model_remains) ? json.model_remains : [];
    var windows = [];
    for (var i = 0; i < models.length; i++) {
        var m = models[i] || {};
        if (!m.model_name) continue;
        // video 仅暴露每日赠送(0/3),周窗不展示;赠送额度不参与权重/紧张度
        if (m.model_name === 'video') {
            var dailyW = minimaxMakeWindow('video', 'interval',
                m.current_interval_used_count, m.current_interval_total_count, m.current_interval_used_percent,
                m.start_time, m.end_time);
            if (dailyW) windows.push(Object.assign({}, dailyW, { weightExcluded: true }));
            continue;
        }
        var intervalW = minimaxMakeWindow(m.model_name, 'interval',
            m.current_interval_used_count, m.current_interval_total_count, m.current_interval_used_percent,
            m.start_time, m.end_time);
        if (intervalW) windows.push(intervalW);
        var weeklyW = minimaxMakeWindow(m.model_name, 'weekly',
            m.current_weekly_used_count, m.current_weekly_total_count, m.current_weekly_used_percent,
            m.weekly_start_time, m.weekly_end_time);
        if (weeklyW) windows.push(weeklyW);
    }
    return windows;
}

// 解析 MiniMax 用量曲线接口(token_plan/usage_summary):
// 官方按天返回 date_model_usage(含每日逐模型 token 明细),无参时覆盖较长历史,这里截取最近 N 天(7/30)。
// 归一化为前端通用图表契约(与智谱/千问一致):{ x_time, modelDataList:[{modelName,tokensUsage}], totalUsage }。
// 不同日期出现的模型取并集(保留首次出现顺序),缺失日补 0;base_resp.status_code != 0 或无数据返回 null。
// 逐模型取 input_token + output_token(净消耗);模型 total_token 含 cache_read 会重复计数,
// 各模型 input+output 之和恰等于当日 total_token,与官方 total_token_consumed 口径一致。
function parseMinimaxModelUsage(json, period) {
    if (!json || !json.base_resp || json.base_resp.status_code !== 0) return null;
    var days = period === '30d' ? 30 : 7;
    var all = Array.isArray(json.date_model_usage) ? json.date_model_usage : [];
    if (!all.length) return null;
    var win = all.slice(-days);
    var x_time = win.map(function(d) { return d && d.date ? d.date : ''; });
    var modelMap = {};
    var order = [];
    win.forEach(function(d, idx) {
        var models = (d && Array.isArray(d.models)) ? d.models : [];
        models.forEach(function(m) {
            if (!m || !m.model) return;
            if (!Object.prototype.hasOwnProperty.call(modelMap, m.model)) {
                modelMap[m.model] = new Array(win.length).fill(0);
                order.push(m.model);
            }
            modelMap[m.model][idx] = (Number(m.input_token) || 0) + (Number(m.output_token) || 0);
        });
    });
    var modelDataList = order.map(function(name) {
        return { modelName: name, tokensUsage: modelMap[name] };
    });
    var totalTokens = win.reduce(function(a, d) { return a + (Number(d && d.total_token) || 0); }, 0);
    return {
        x_time: x_time,
        modelDataList: modelDataList,
        totalUsage: { totalTokensUsage: totalTokens }
    };
}

// MiniMax 用量曲线抓取:调 usage_summary(官方支持 7/30 天口径,无参返回较长历史,由解析层截取)。
// 复用 /api/model-usage 契约;Cookie 失效或无数据时抛错交由前端提示。
async function fetchMiniMaxModelUsage(account, period) {
    var json = await httpsGet('https://www.minimaxi.com/backend/account/token_plan/usage_summary', minimaxHeaders(account));
    var chart = parseMinimaxModelUsage(json, period);
    if (!chart) throw new Error('未获取到用量曲线数据（Cookie 可能已失效）');
    return chart;
}

// MiniMax 抓取:并行调套餐消息盒子 + 用量接口(remains_percent) + 官方订阅接口(charge/combo)。
// 用量契约: data.usage.windows = [{ label, usedPct 或 used+quota, resetMs, periodMs, segments? }]
// 到期以官方订阅接口的 current_subscribe 为准,消息盒子通知兜底(续费后通知可能停留在上一周期)。
// 用量/订阅接口软失败(返回 null)→ 用量显示「待接入」占位、到期退回通知兜底;消息盒子失败则整体抛错(凭据失效)
async function fetchMiniMaxUsage(account, index) {
    try {
        var headers = minimaxHeaders(account);
        var boxPromise = httpsGet('https://www.minimaxi.com/backend/message/box?message_category=4&not_read=false', headers);
        var usagePromise = httpsGet('https://www.minimaxi.com/backend/account/token_plan/remains_percent', headers)
            .catch(function() { return null; });
        var subPromise = httpsGet('https://www.minimaxi.com/v1/api/openplatform/charge/combo/cycle_audio_resource_package?biz_line=2&cycle_type=3&resource_package_type=7', headers)
            .catch(function() { return null; });
        var boxJson = await boxPromise;
        if (!boxJson || !boxJson.base_resp || boxJson.base_resp.status_code !== 0) {
            throw new Error((boxJson && boxJson.base_resp && boxJson.base_resp.status_msg) || '请求失败（Cookie 可能已失效）');
        }
        var subscription = minimaxMergeSubscription(await subPromise, boxJson);
        var usageJson = await usagePromise;
        var usageWindows = parseMinimaxUsage(usageJson);
        var result = {
            index: index,
            name: account.name,
            platform: 'minimax',
            responsiblePerson: account.responsiblePerson,
            phone: account.phone,
            notes: account.notes,
            isPublic: account.isPublic,
            data: {
                usage: usageWindows != null ? { windows: usageWindows } : null,
                subscription: subscription
            },
            success: true,
            cachedAt: Date.now()
        };
        setCache(index, result);
        return result;
    } catch (err) {
        return {
            index: index,
            name: account.name,
            platform: 'minimax',
            responsiblePerson: account.responsiblePerson,
            phone: account.phone,
            notes: account.notes,
            isPublic: account.isPublic,
            error: err.message,
            success: false
        };
    }
}

// ============ 阶跃星辰 StepFun 账号（platform.stepfun.com，Step 套餐）============

// Connect RPC 协议：全部 POST JSON；请求字段 camelCase，响应 snake_case 且 int64 为字符串。
// 鉴权：Cookie Oasis-Token = "<accessJWT>...<refreshJWT>"（两段 JWT 用字面 ... 拼接），
// access 段仅 30 分钟有效；过期后调 PassportService/RefreshToken 用 refresh 段（约 30 天，
// 续期不轮换）换新，并只回写 Cookie 中的 Oasis-Token 段（保留 _wafdytokenv1 等 WAF 段）。

// webid 优先取账号字段；未填时从 Cookie 的 Oasis-Webid 兜底解析（同 minimaxGroupId 手法）
function stepfunWebid(account) {
    if (account.stepfun_webid) return String(account.stepfun_webid);
    var m = String(account.cookie || '').match(/Oasis-Webid=([^;\s]+)/);
    return m ? m[1] : '';
}

function stepfunHeaders(account) {
    return {
        'accept': '*/*',
        'content-type': 'application/json',
        'connect-protocol-version': '1',
        'cookie': account.cookie || '',
        'oasis-appid': '10300',
        'oasis-platform': 'web',
        'oasis-webid': stepfunWebid(account),
        'origin': 'https://platform.stepfun.com',
        'referer': 'https://platform.stepfun.com/',
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36'
    };
}

// 原始 Connect 请求：resolve {statusCode, json, text, headers}，非 2xx 也 resolve 由调用方分类。
// 不复用 httpsRequest：401 的 JSON 错误体是 token 刷新判断依据，
// RefreshToken 的 oasis-token 响应头是回写 Cookie 来源，两者都要求非 2xx / 响应头可见。
function stepfunRaw(path, headers, bodyObj) {
    return new Promise(function(resolve, reject) {
        var m = ('https://platform.stepfun.com' + path).match(/^https:\/\/([^\/]+)(\/.*)$/);
        if (!m) return reject(new Error('Invalid URL'));
        var bodyStr = bodyObj == null ? '{}' : JSON.stringify(bodyObj);
        var opts = {
            hostname: m[1], path: m[2], method: 'POST',
            headers: Object.assign({}, headers, {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(bodyStr)
            })
        };
        var req = https.request(opts, function(res) {
            var data = '';
            res.on('data', function(c) { data += c; });
            res.on('end', function() {
                var json = null;
                try { json = data ? JSON.parse(data) : null; } catch (e) { /* 保留 text */ }
                resolve({ statusCode: res.statusCode, json: json, text: data, headers: res.headers });
            });
        });
        req.on('error', reject);
        req.setTimeout(15000, function() { req.destroy(new Error('timeout')); });
        req.write(bodyStr);
        req.end();
    });
}

// 401 错误体分类：'expired'（access 过期，可刷新）/ 'embezzled'（webid 不匹配，配置错误）/ 'unauthenticated'
function stepfunAuthErrorKind(res) {
    if (!res || res.statusCode !== 401 || !res.json) return null;
    var msg = String(res.json.message || '');
    if (msg.indexOf('token is expired') !== -1) return 'expired';
    if (msg.indexOf('embezzled') !== -1) return 'embezzled';
    return 'unauthenticated';
}

// 单次业务调用：2xx 返回 json；400 且空 body 视为 WAF 瞬断重试一次；401 抛带 stepfunKind 的错。
async function stepfunCall(account, path, bodyObj) {
    var res = await stepfunRaw(path, stepfunHeaders(account), bodyObj);
    if (res.statusCode === 400 && !res.text) {
        res = await stepfunRaw(path, stepfunHeaders(account), bodyObj);
    }
    if (res.statusCode >= 200 && res.statusCode < 300 && res.json) return res.json;
    var msg = (res.json && res.json.message) || (res.text || '').slice(0, 200) || ('HTTP ' + res.statusCode);
    var err = new Error('阶跃请求失败: ' + msg);
    var kind = stepfunAuthErrorKind(res);
    if (kind === 'embezzled') err = new Error('阶跃 Cookie 与 webid 不匹配（oasis-token is embezzled），请重新完整复制 Cookie');
    err.stepfunKind = kind;
    throw err;
}

// 只替换 Cookie 串中的 Oasis-Token 段（保留 _wafdytokenv1 / Oasis-Webid 等其余段）；无该段则追加
function stepfunReplaceTokenCookie(cookie, newToken) {
    var s = String(cookie || '').trim();
    if (!s) return 'Oasis-Token=' + newToken;
    if (/(^|;\s*)Oasis-Token=/.test(s)) {
        return s.replace(/(^|;\s*)Oasis-Token=[^;]*/, function(m0, p) { return p + 'Oasis-Token=' + newToken; });
    }
    return s + '; Oasis-Token=' + newToken;
}

function saveStepfunCookie(index, newCookie) {
    try {
        var accounts = readAccounts();
        if (!accounts[index]) return;
        if ((accounts[index].platform || 'glm') !== 'stepfun') return;
        accounts[index].cookie = newCookie;
        writeAccounts(accounts);
    } catch (e) { /* ignore write errors */ }
}

// 用 refresh 段换新 access。新 Oasis-Token 优先取响应头 oasis-token（官方拼好的完整串），
// 兜底用 body 的 accessToken.raw + '...' + refreshToken.raw 自拼；回写文件并更新内存副本。
async function stepfunRefresh(account, index) {
    var res = await stepfunRaw('/passport/proto.api.passport.v1.PassportService/RefreshToken', stepfunHeaders(account), {});
    if (!(res.statusCode >= 200 && res.statusCode < 300) || !res.json) {
        throw new Error('阶跃 token 刷新失败（Cookie 可能已整体失效，需重新抓取完整 Cookie）: '
            + ((res.json && res.json.message) || ('HTTP ' + res.statusCode)));
    }
    var concat = res.headers && res.headers['oasis-token'];
    if (!concat && res.json.accessToken && res.json.refreshToken) {
        concat = res.json.accessToken.raw + '...' + res.json.refreshToken.raw;
    }
    if (!concat) throw new Error('阶跃 token 刷新响应缺少新 token');
    var newCookie = stepfunReplaceTokenCookie(account.cookie || '', concat);
    saveStepfunCookie(index, newCookie);
    // 本进程内后续请求立即用新 Cookie（accounts.json 也可能被其他写覆盖，以内存更新为准）
    account.cookie = newCookie;
    return newCookie;
}

// 同账号并发去重：多个接口同时 401 时合并为一次刷新（refresh 段不轮换，重复刷新无害，只是无谓请求/写盘）
function stepfunRefreshOnce(account, index) {
    if (!account._stepfunRefreshPromise) {
        account._stepfunRefreshPromise = stepfunRefresh(account, index).finally(function() {
            account._stepfunRefreshPromise = null;
        });
    }
    return account._stepfunRefreshPromise;
}

// 401（access 过期）时刷新后重试一次；其余错误原样抛出
async function withStepfunAuthRetry(account, index, requestFn) {
    try {
        return await requestFn(account);
    } catch (authErr) {
        if (!authErr || authErr.stepfunKind !== 'expired') throw authErr;
        await stepfunRefreshOnce(account, index);
        return await requestFn(account);
    }
}

// 阶跃秒级时间串（如 "1792467733"）→ 毫秒；"0"/缺省 → 0
function stepfunSecToMs(v) {
    var n = Number(v) || 0;
    return n > 0 ? n * 1000 : 0;
}

// 北京时间当日零点（毫秒）：+8h 对齐到日再折回，服务器任意时区下结果一致
function stepfunBeijingTodayStart(nowMs) {
    var shifted = nowMs + 8 * 3600000;
    return shifted - (shifted % 86400000) - 8 * 3600000;
}

// 手机号脱敏：保留前 3 后 4；位数不足返回 null（后端脱敏后再出接口）
function stepfunMaskMobile(mobile) {
    var s = String(mobile || '').trim();
    if (!/^\d{7,}$/.test(s)) return null;
    return s.slice(0, 3) + '****' + s.slice(-4);
}

// GetStepPlanStatus → 订阅摘要；无 subscription（未订阅）返回 null。
// activated_at/expired_at 为秒串；到期日期取北京日期（+8h 后取 UTC 日期，与 minimax 到期日同一手法）。
function parseStepfunPlanStatus(json) {
    var sub = json && json.subscription;
    if (!sub) return null;
    var def = (json && json.plan_definition) || {};
    var activatedMs = stepfunSecToMs(sub.activated_at);
    var expireMs = stepfunSecToMs(sub.expired_at);
    var d = expireMs ? new Date(expireMs + 8 * 3600000) : null;
    return {
        planName: sub.name || null,
        status: sub.status,
        statusText: sub.status === 1 ? '生效中' : '状态' + (sub.status != null ? sub.status : '?'),
        autoRenew: !!sub.auto_renew,
        activatedMs: activatedMs || null,
        expireMs: expireMs || null,
        expireDate: d ? d.getUTCFullYear() + '-' + minimaxPad2(String(d.getUTCMonth() + 1)) + '-' + minimaxPad2(String(d.getUTCDate())) : null,
        priceYuan: def.price != null ? (Number(def.price) || 0) / 100 : null,
        durationDays: def.duration_days || null,
        supportModels: Array.isArray(def.support_models) ? def.support_models.slice() : []
    };
}

// 剩余率（0~1，1=未使用）→ 已用百分比（0~100，保留 1 位小数）；非法输入返回 null
function stepfunLeftRateToPct(rate) {
    if (typeof rate !== 'number' || rate < 0) return null;
    return Math.round((1 - Math.min(1, rate)) * 1000) / 10;
}

// 月度积分窗：剩余率优先，兜底用订阅桶（type=1）的 Σ(total-residual)/Σtotal；
// 重置时间=套餐到期（续费换新周期），周期=激活→到期的真实时长。充值桶（type=2）单列一窗。
function stepfunCreditWindows(json, subscription) {
    var lim = (json && json.plan_credit_rate_limit) || {};
    var buckets = Array.isArray(lim.credit_buckets) ? lim.credit_buckets : [];
    var subBuckets = buckets.filter(function(b) { return Number(b && b.type) === 1; });
    var topupBuckets = buckets.filter(function(b) { return Number(b && b.type) === 2; });
    var resetMs = subscription && subscription.expireMs ? subscription.expireMs : null;
    var periodMs = (subscription && subscription.expireMs && subscription.activatedMs)
        ? Math.max(0, subscription.expireMs - subscription.activatedMs) : null;
    var sum = function(list, fn) {
        return list.reduce(function(a, b) { return a + fn(b); }, 0);
    };
    var pct = stepfunLeftRateToPct(lim.subscription_credit_left_rate);
    if (pct === null && subBuckets.length) {
        var total = sum(subBuckets, function(b) { return Number(b.credit_total) || 0; });
        var used = total - sum(subBuckets, function(b) { return Number(b.credit_residual) || 0; });
        if (total > 0) pct = Math.round((used / total) * 1000) / 10;
    }
    var windows = [];
    if (pct !== null) {
        var win = { label: '月度积分', usedPct: pct, resetMs: resetMs, periodMs: periodMs, segments: 0 };
        var quota = sum(subBuckets, function(b) { return Number(b.credit_total) || 0; });
        if (quota > 0) {
            win.used = quota - sum(subBuckets, function(b) { return Number(b.credit_residual) || 0; });
            win.quota = quota;
        }
        windows.push(win);
    }
    if (topupBuckets.length) {
        var tQuota = sum(topupBuckets, function(b) { return Number(b.credit_total) || 0; });
        var tUsed = tQuota - sum(topupBuckets, function(b) { return Number(b.credit_residual) || 0; });
        var tExpire = stepfunSecToMs(topupBuckets[0].expire_at);
        if (tQuota > 0) {
            windows.push({ label: '充值积分', usedPct: Math.round((tUsed / tQuota) * 1000) / 10, used: tUsed, quota: tQuota, resetMs: tExpire || null, periodMs: null, segments: 0 });
        }
    }
    return windows;
}

// QueryStepPlanRateLimit（+订阅摘要取真实周期）→ windows[]，契约与 MiniMax 一致
// （{label, usedPct 或 used+quota, resetMs, periodMs, segments}）。
// 零值陷阱：credit 制套餐（plan_family=2）的 5h/周字段恒 0 且 reset_time="0"，
// 语义是「无此窗口」而非「0% 剩余」——仅当对应 reset_time 非 "0" 时才生成 5h/周窗。
function parseStepfunRateLimit(json, subscription) {
    if (!json) return [];
    var windows = stepfunCreditWindows(json, subscription);
    var fiveHourReset = Number(json.five_hour_usage_reset_time) || 0;
    if (fiveHourReset > 0) {
        var pct5 = stepfunLeftRateToPct(json.five_hour_usage_left_rate);
        if (pct5 !== null) {
            windows.push({ label: '5h 限额', usedPct: pct5, resetMs: fiveHourReset * 1000, periodMs: 5 * 3600000, segments: 5 });
        }
    }
    var weeklyReset = Number(json.weekly_usage_reset_time) || 0;
    if (weeklyReset > 0) {
        var pct7 = stepfunLeftRateToPct(json.weekly_usage_left_rate);
        if (pct7 !== null) {
            windows.push({ label: '周限额', usedPct: pct7, resetMs: weeklyReset * 1000, periodMs: 7 * 86400000, segments: 7 });
        }
    }
    return windows;
}

// QueryStepPlanUsages → 按模型聚合（credit 降序）：{models:[{modelId,credits,calls}], totalCredits, totalCalls}
function parseStepfunUsages(json) {
    var records = (json && Array.isArray(json.records)) ? json.records : [];
    var map = {}, order = [];
    var totalCredits = 0, totalCalls = 0;
    records.forEach(function(r) {
        if (!r || !r.model_id) return;
        if (!Object.prototype.hasOwnProperty.call(map, r.model_id)) {
            map[r.model_id] = { modelId: r.model_id, credits: 0, calls: 0 };
            order.push(r.model_id);
        }
        map[r.model_id].credits += Number(r.credit_consumed) || 0;
        map[r.model_id].calls += Number(r.calls) || 0;
        totalCredits += Number(r.credit_consumed) || 0;
        totalCalls += Number(r.calls) || 0;
    });
    var models = order.map(function(k) { return map[k]; });
    models.sort(function(a, b) { return b.credits - a.credits; });
    return { models: models, totalCredits: totalCredits, totalCalls: totalCalls };
}

// QueryStepPlanUsages（多日窗口）→ 前端通用图表契约 {x_time, modelDataList, totalUsage}。
// 官方按「UTC 日桶 × 模型」聚合，record.from_time 即桶起点；标签换算北京日期（+8h 取日期）。
// 模型取并集保序、缺失日补 0；tokensUsage 装的是 credit 数值（该平台纵轴单位为积分）。
function parseStepfunModelUsage(json, days) {
    var records = (json && Array.isArray(json.records)) ? json.records : [];
    if (!records.length) return null;
    var byDay = {};
    var seen = {};
    var order = [];
    records.forEach(function(r) {
        if (!r || !r.model_id) return;
        var fromMs = Number(r.from_time) || 0;
        if (!fromMs) return;
        var d = new Date(fromMs + 8 * 3600000);
        var key = d.getUTCFullYear() + '-' + minimaxPad2(String(d.getUTCMonth() + 1)) + '-' + minimaxPad2(String(d.getUTCDate()));
        if (!byDay[key]) byDay[key] = {};
        if (!seen[r.model_id]) { seen[r.model_id] = true; order.push(r.model_id); }
        byDay[key][r.model_id] = (byDay[key][r.model_id] || 0) + (Number(r.credit_consumed) || 0);
    });
    var dayKeys = Object.keys(byDay).sort().slice(-(days || 7));
    if (!dayKeys.length) return null;
    var modelDataList = order.map(function(name) {
        return { modelName: name, tokensUsage: dayKeys.map(function(k) { return byDay[k][name] || 0; }) };
    });
    var total = 0;
    dayKeys.forEach(function(k) { Object.keys(byDay[k]).forEach(function(m) { total += byDay[k][m]; }); });
    return { x_time: dayKeys, modelDataList: modelDataList, totalUsage: { totalTokensUsage: total } };
}

// 阶跃用量曲线：近 N 天（北京日对齐）单次查询；pageSize 500 覆盖 30 天 × 模型并集上限。
async function fetchStepfunModelUsage(account, index, period) {
    var days = period === '30d' ? 30 : 7;
    var nowMs = Date.now();
    var startTime = stepfunBeijingTodayStart(nowMs) - (days - 1) * 86400000;
    var json = await withStepfunAuthRetry(account, index, function(acc) {
        return stepfunCall(acc, '/api/step.openapi.devcenter.Dashboard/QueryStepPlanUsages',
            { startTime: startTime, toTime: nowMs, page: 1, pageSize: 500 });
    });
    var chart = parseStepfunModelUsage(json, days);
    if (!chart) throw new Error('未获取到用量曲线数据（Cookie 可能已失效）');
    return chart;
}

// 阶跃邀请活动：邀请好友双方各得 15 天 plan，每人可邀请上限 invite_max_count 个；
// 新注册用户首次调用另有 15 天（REGISTER 奖励）。三个接口均软失败，无数据返回 undefined。
// invite 记录字段: invitee_masked_phone / invitee_nickname / reward_days / used_at(秒串)。
// reward 记录(GetCampaignStatus)字段: reward_type(1=新注册赠/4=邀请赠) / reward_days / status / activated_at / expired_at。
// 邀请链接为 https://platform.stepfun.com/?invite_code_v2=<code>（官方 short_link 同源）。
function parseStepfunCampaign(linkJson, invitesJson, statusJson) {
    var campaign = null;
    if (linkJson && linkJson.invite_code) {
        campaign = {
            inviteCode: String(linkJson.invite_code),
            inviteUrl: 'https://platform.stepfun.com/?invite_code_v2=' + encodeURIComponent(String(linkJson.invite_code)),
            inviteCount: Number(linkJson.invite_count) || 0,
            inviteMaxCount: Number(linkJson.invite_max_count) || 0,
            remainingRewardDays: Number(linkJson.remaining_reward_days) || 0,
            invites: [],
            rewards: []
        };
    }
    if (campaign && invitesJson && Array.isArray(invitesJson.invites)) {
        campaign.invites = invitesJson.invites.map(function(it) {
            if (!it) return null;
            return {
                nickname: it.invitee_nickname || null,
                maskedPhone: it.invitee_masked_phone || null,
                rewardDays: Number(it.reward_days) || 0,
                usedAtMs: stepfunSecToMs(it.used_at) || null
            };
        }).filter(Boolean);
    }
    if (campaign && statusJson && Array.isArray(statusJson.rewards)) {
        campaign.rewards = statusJson.rewards.map(function(r) {
            if (!r) return null;
            return {
                rewardDays: Number(r.reward_days) || 0,
                // reward_type: 1=新注册赠送 4=邀请赠送
                rewardType: r.reward_type === 1 ? 'register' : (r.reward_type === 4 ? 'invite' : 'other'),
                status: r.status,
                activatedMs: stepfunSecToMs(r.activated_at) || null,
                expiredMs: stepfunSecToMs(r.expired_at) || null
            };
        }).filter(Boolean);
    }
    return campaign; // 未拿到邀请码时返回 undefined（前端不渲染该节）
}

// 阶跃抓取：并行调 套餐状态（主，硬失败）+ 限额（软）+ 今日用量（软）+ 账号信息（软）+ 按量余额（软）+ 邀请活动（软）。
// 套餐状态 401（access 过期）时刷新 token 整体重试一次；限额失败 → usage 为 null → 卡片「待接入」。
// 今日窗口取北京时间当日零点 → now；金额字段官方为分，统一换算为元。
async function fetchStepfunUsage(account, index) {
    try {
        var planJson = await withStepfunAuthRetry(account, index, function(acc) {
            return stepfunCall(acc, '/api/step.openapi.devcenter.Dashboard/GetStepPlanStatus', {});
        });
        var subscription = parseStepfunPlanStatus(planJson);
        if (!subscription) throw new Error('未获取到套餐信息（该账号可能未订阅 Step 套餐）');

        var nowMs = Date.now();
        var ratePromise = withStepfunAuthRetry(account, index, function(acc) {
            return stepfunCall(acc, '/api/step.openapi.devcenter.Dashboard/QueryStepPlanRateLimit', {});
        }).catch(function() { return null; });
        var todayPromise = withStepfunAuthRetry(account, index, function(acc) {
            return stepfunCall(acc, '/api/step.openapi.devcenter.Dashboard/QueryStepPlanUsages',
                { startTime: stepfunBeijingTodayStart(nowMs), toTime: nowMs, page: 1, pageSize: 100 });
        }).catch(function() { return null; });
        var userPromise = withStepfunAuthRetry(account, index, function(acc) {
            return stepfunCall(acc, '/api/step.openapi.devcenter.Dashboard/UserInfo', {});
        }).catch(function() { return null; });
        var balancePromise = withStepfunAuthRetry(account, index, function(acc) {
            return stepfunCall(acc, '/api/step.openapi.devcenter.Dashboard/QueryAccountBalance', {});
        }).catch(function() { return null; });
        // 邀请活动三件套（软失败）：邀请链接/邀请记录/奖励账本
        var campaignPromise = Promise.all([
            withStepfunAuthRetry(account, index, function(acc) {
                return stepfunCall(acc, '/api/step.openapi.devcenter.Dashboard/GetCampaignInviteLink', {});
            }).catch(function() { return null; }),
            withStepfunAuthRetry(account, index, function(acc) {
                return stepfunCall(acc, '/api/step.openapi.devcenter.Dashboard/ListCampaignInvites', {});
            }).catch(function() { return null; }),
            withStepfunAuthRetry(account, index, function(acc) {
                return stepfunCall(acc, '/api/step.openapi.devcenter.Dashboard/GetCampaignStatus', {});
            }).catch(function() { return null; })
        ]);

        var usage = null;
        var windows = parseStepfunRateLimit(await ratePromise, subscription);
        if (windows.length) {
            var today = parseStepfunUsages(await todayPromise);
            usage = {
                windows: windows,
                today: today ? { credits: today.totalCredits, calls: today.totalCalls, models: today.models } : null
            };
        }
        var userJson = await userPromise;
        var user = userJson ? {
            uid: userJson.uid || null,
            nickname: userJson.nickname || null,
            mobileMasked: stepfunMaskMobile(userJson.mobile),
            payMode: userJson.payMode
        } : null;
        var balJson = await balancePromise;
        var balance = balJson ? {
            voucherYuan: (Number(balJson.voucher) || 0) / 100,
            balanceYuan: (Number(balJson.balance) || 0) / 100,
            costYesterdayYuan: (Number(balJson.cost_yesterday) || 0) / 100,
            costMonthYuan: (Number(balJson.cost_month) || 0) / 100
        } : null;
        var campaignParts = await campaignPromise;
        var campaign = parseStepfunCampaign(campaignParts[0], campaignParts[1], campaignParts[2]);

        var result = {
            index: index,
            name: account.name,
            platform: 'stepfun',
            responsiblePerson: account.responsiblePerson,
            phone: account.phone,
            notes: account.notes,
            isPublic: account.isPublic,
            data: {
                usage: usage,
                subscription: subscription,
                user: user,
                balance: balance,
                campaign: campaign
            },
            success: true,
            cachedAt: Date.now()
        };
        setCache(index, result);
        return result;
    } catch (err) {
        return {
            index: index,
            name: account.name,
            platform: 'stepfun',
            responsiblePerson: account.responsiblePerson,
            phone: account.phone,
            notes: account.notes,
            isPublic: account.isPublic,
            error: err.message,
            success: false
        };
    }
}

// ============ 智云账号（真实浏览器执行瑞数挑战）============

async function fetchTelecomUsage(account, index) {
    try {
        var data = await telecomjs.fetchBalance(account.satoken);
        var result = {
            index: index,
            name: account.name,
            platform: 'telecomjs',
            responsiblePerson: account.responsiblePerson,
            notes: account.notes,
            isPublic: account.isPublic,
            data: data,
            success: true,
            cachedAt: Date.now()
        };
        setCache(index, result);
        return result;
    } catch (err) {
        return {
            index: index,
            name: account.name,
            platform: 'telecomjs',
            responsiblePerson: account.responsiblePerson,
            notes: account.notes,
            isPublic: account.isPublic,
            error: err.message,
            success: false
        };
    }
}

// ============ 统一调度 ============

async function fetchAccountUsage(account, index) {
    var platform = account.platform || 'glm';
    if (platform === 'yescode') {
        return fetchYesCodeUsage(account, index);
    }
    if (platform === 'sub2api' || platform === 'huoli') {
        return fetchSub2apiUsage(account, index);
    }
    if (platform === 'volc') {
        return fetchVolcUsage(account, index);
    }
    if (platform === 'qwen') {
        return fetchQwenUsage(account, index);
    }
    if (platform === 'minimax') {
        return fetchMiniMaxUsage(account, index);
    }
    if (platform === 'stepfun') {
        return fetchStepfunUsage(account, index);
    }
    if (platform === 'telecomjs') {
        return fetchTelecomUsage(account, index);
    }
    return fetchGLMUsage(account, index);
}

async function fetchAccountExpire(account, index) {
    var platform = account.platform || 'glm';
    if (platform !== 'glm') {
        // 这些平台到期信息从各自接口获取，由前端渲染
        return { success: false, cachedAt: Date.now() };
    }
    return fetchGLMExpire(account, index);
}

function getAccount(req) {
    var accounts = readAccounts();
    return accounts[parseInt(req.params.index)];
}

module.exports = function(app) {

    // 密码验证
    app.post('/api/auth', jsonParser, function(req, res) {
        var ip = clientIp(req);
        var now = Date.now();
        var st = authBanState(ip, now);
        if (st.banned) {
            return res.status(429).json({ success: false, error: '密码连续错误次数过多，已封禁 ' + Math.ceil(st.retryAfterSec / 60) + ' 分钟，请稍后再试', retryAfterSec: st.retryAfterSec });
        }
        if (req.body.password !== PASSWORD) {
            var after = authBanRecordFailure(ip, now);
            if (after.banned) {
                return res.status(429).json({ success: false, error: '密码连续错误 ' + AUTH_FAIL_LIMIT + ' 次，已封禁 15 分钟', retryAfterSec: after.retryAfterSec });
            }
            return res.json({ success: false, error: '密码错误，连续错误 ' + AUTH_FAIL_LIMIT + ' 次将封禁 15 分钟' });
        }
        authBanReset(ip);
        res.json({ success: true });
    });

    // ============ 功能开关(公开,无鉴权) ============
    // 前端启动时拉取一次,据此决定是否渲染/轮询可选集成功能。
    // 只暴露布尔值与网关地址字符串,绝不暴露 token / 密码。
    app.get('/api/features', function(req, res) {
        res.json({
            relayEnabled: config.relayEnabled,
            modelsGatewayUrl: config.modelsGatewayUrl
        });
    });

    // ============ 用量查询 ============
    // /api/usage 始终秒回:有缓存(含过期)先展示,缺失则返回 loading 骨架;
    // 需要刷新的账号在后台抓取,前端再调 /api/usage/:index 补齐(join 同一 inflight)。

    app.get('/api/usage', async function(req, res) {
        try {
            var accounts = readAccounts();
            var force = req.query.force === '1';
            var results = [];
            for (var i = 0; i < accounts.length; i++) {
                var account = accounts[i];
                if (!account || isHiddenFromGuest(req, account)) continue;

                var fresh = getCached(i);
                var lastKnown = getCachedLastKnown(i);

                // 非强制且缓存仍新鲜:直接返回,不触发抓取
                if (!force && fresh) {
                    results.push(usageForResponse(fresh));
                    continue;
                }

                // 需要刷新:后台启动(不 await),响应立刻带着旧数据或骨架返回
                ensureUsageFetch(account, i, force || !fresh).catch(function() { /* 单卡补齐时会再取错误结果 */ });

                if (lastKnown) {
                    var shown = usageForResponse(lastKnown);
                    results.push(Object.assign({}, shown, {
                        pending: true,
                        stale: !fresh,
                        refreshing: !!force
                    }));
                } else {
                    results.push(accountUsageShell(account, i));
                }
            }
            res.json(results);
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.get('/api/usage/:index', async function(req, res) {
        try {
            var i = parseInt(req.params.index);
            var account = getAccount(req);
            if (!account) return res.status(404).json({ error: '未找到账号' });
            if (isHiddenFromGuest(req, account)) return res.status(404).json({ error: '未找到账号' });
            var force = req.query.force === '1';
            if (!force) {
                var c = getCached(i);
                if (c) return res.json(usageForResponse(c));
            }
            // 等待后台抓取完成(与列表接口共享 inflight);完成后返回最终结果
            res.json(usageForResponse(await ensureUsageFetch(account, i, force)));
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // ============ 凭证导出接口(为中转站等内部系统同步最新登录态) ============
    // 默认关闭:仅当 .env 配置 CREDENTIALS_EXPORT=1 时注册路由,否则接口不存在。
    // 背景:yescode 等平台官方 token 有效期缩短为 24h,本项目已支持账密自动重登并持续
    // 刷新凭证;下游(中转站外部渠道)按账号名精确匹配拉取,避免各自维护登录。
    // GET /api/credentials?password=<管理密码>&platform=yescode → { "账号名": "凭证" }
    var CREDENTIAL_FIELDS = {
        yescode: 'cookie',
        sub2api: 'authorization',
        glm: 'authorization',
        huoli: 'authorization',
        volc: 'cookie',
        qwen: 'cookie',
        minimax: 'cookie',
        stepfun: 'cookie',
        telecomjs: 'satoken'
    };
    if (config.credentialsExportEnabled) {
        app.get('/api/credentials', function(req, res) {
            try {
                var cIp = clientIp(req);
                var cNow = Date.now();
                var cSt = authBanState(cIp, cNow);
                if (cSt.banned) {
                    return res.status(429).json({ error: '密码连续错误次数过多，已封禁 ' + Math.ceil(cSt.retryAfterSec / 60) + ' 分钟，请稍后再试', retryAfterSec: cSt.retryAfterSec });
                }
                if (req.query.password !== PASSWORD) {
                    authBanRecordFailure(cIp, cNow);
                    return res.status(401).json({ error: 'unauthorized' });
                }
                authBanReset(cIp);
                var platform = req.query.platform || 'yescode';
                var field = CREDENTIAL_FIELDS[platform];
                if (!field) return res.status(400).json({ error: '不支持的平台: ' + platform });
                var out = {};
                readAccounts().forEach(function(acc) {
                    if (!acc || (acc.platform || 'glm') !== platform) return;
                    var cred = (acc[field] || '').trim();
                    if (cred) out[acc.name] = cred;
                });
                res.json(out);
            } catch (err) { res.status(500).json({ error: err.message }); }
        });
    }

    // ============ 权重接口(为中转站提供 token 分配权重,纯读缓存 + 默认兜底) ============
    app.get('/api/weights', function(req, res) {
        try {
            // 中转站等下游按账号名轮询本接口属常态（可不带密码），仅当带了错误密码才计入防爆破
            var authenticated = req.query.password === PASSWORD;
            if (!authenticated && req.query.password) {
                var wIp = clientIp(req);
                var wNow = Date.now();
                var wSt = authBanState(wIp, wNow);
                if (wSt.banned) {
                    return res.status(429).json({ error: '密码连续错误次数过多，已封禁 ' + Math.ceil(wSt.retryAfterSec / 60) + ' 分钟，请稍后再试', retryAfterSec: wSt.retryAfterSec });
                }
                authBanRecordFailure(wIp, wNow);
            }
            var wantDetail = authenticated && req.query.detail === '1';
            var accounts = readAccounts();
            var result = {};
            var detail = [];
            var generatedAt = Date.now();
            var entries = buildWeightEntries(accounts, authenticated, generatedAt);
            for (var i = 0; i < entries.length; i++) {
                var entry = entries[i];
                var acc = entry.account;
                var cfg = weights.getWeightConfig(acc);
                var cached = entry.cached;                          // 纯读最近已知，绝不触发官方刷新
                var s = entry.score;
                var base = s ? s.weight : null;                      // token 失效/无缓存 → null → 走默认权重
                var final = weights.finalWeight(base, cfg);
                if (s && s.exhausted) final = 0;                     // 耗尽账号权重恒为 0,不受策略 A/D 复活
                result[acc.name] = final;
                if (wantDetail) {
                    detail.push({
                        index: entry.index, name: acc.name, platform: entry.platform, weight: final,
                        base: base, source: base === null ? 'default' : 'computed',
                        strategy: cfg.strategy, configValue: cfg.value, defaultWeight: cfg.defaultWeight,
                        score5h: s ? s.score5h : null, score7d: s ? s.score7d : null,
                        used5h: s ? s.used5h : null, used7d: s ? s.used7d : null,
                        theo5h: s ? s.theo5h : null, theo7d: s ? s.theo7d : null,
                        exhausted: s ? s.exhausted : false,
                        availableBalance: s && s.availableBalance != null ? s.availableBalance : null,
                        averageDaily: s && s.averageDaily != null ? s.averageDaily : null,
                        remainingDays: s && s.remainingDays != null ? s.remainingDays : null,
                        noConsumption: s ? !!s.noConsumption : false,
                        capacityScore: s && s.capacityScore != null ? s.capacityScore : null,
                        codingAverage: s && s.codingAverage != null ? s.codingAverage : null,
                        codingPressure: s && s.codingPressure != null ? s.codingPressure : null,
                        codingSampleSize: s && s.codingSampleSize != null ? s.codingSampleSize : null,
                        timeMultiplier: s && s.timeMultiplier != null ? s.timeMultiplier : null,
                        peak: s ? !!s.peak : false,
                        cachedAt: cached ? cached.cachedAt : null
                    });
                }
            }
            if (wantDetail) {
                res.json({ weights: result, detail: detail, generatedAt: generatedAt, cacheTtlMs: CACHE_TTL });
            } else {
                res.json(result);
            }
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // ---- sub2api 容量快照（代理拉取 + 5s 内存缓存）----
    // 供监控页渲染「当前调度中|总容量」胶囊；按 matched_key 聚合后悬浮可看
    // 指向同一权重的多个 sub2api 账号细分。sub2api 侧快照为内网开放数据。
    // 未配置 SUB2API_BASE_URL 时整体禁用(前端也不会轮询本接口)。
    var _sub2apiCapacityCache = { at: 0, data: null };
    app.get('/api/sub2api/capacity', function(req, res) {
        try {
            if (!config.relayEnabled) return res.status(404).json({ error: 'SUB2API_BASE_URL 未配置,中转站功能未启用' });
            if (req.query.password !== PASSWORD) return res.status(401).json({ error: 'unauthorized' });
            var now = Date.now();
            if (_sub2apiCapacityCache.data && now - _sub2apiCapacityCache.at < 5000) {
                return res.json(_sub2apiCapacityCache.data);
            }
            var url = SUB2API_BASE.replace(/\/+$/, '') + '/api/weight-snapshot';
            httpGetJSON(url, 5000).then(function(envelope) {
                // sub2api 统一信封 {code:0, message, data:{generated_at, accounts:[...]}}
                var data = (envelope && envelope.code === 0 && envelope.data) ? envelope.data : null;
                if (!data || !Array.isArray(data.accounts)) {
                    return res.status(502).json({ error: 'unexpected sub2api snapshot shape' });
                }
                _sub2apiCapacityCache = { at: Date.now(), data: data };
                res.json(data);
            }).catch(function(err) {
                res.status(502).json({ error: 'sub2api snapshot fetch failed: ' + err.message });
            });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // ---- 用户实时活动快照(代理拉取 + 内存缓存,调度/用量两个端点)----
    // 调度快照(高频,15s 轮询):当前有占用/排队用户 + 近跑模型;
    // 用量榜单(低频,5 分钟轮询 + 手动刷新):今日站内+外部合并 + 按模型明细。
    // 数据来自中转站内网开放端点(可用 RELAY_SNAPSHOT_TOKEN 开启门禁)。
    var _relayActivityCache = { at: 0, data: null };
    function relaySnapshotUrl(path) {
        var url = SUB2API_BASE.replace(/\/+$/, '') + path;
        if (RELAY_SNAPSHOT_TOKEN) url += '?token=' + encodeURIComponent(RELAY_SNAPSHOT_TOKEN);
        return url;
    }
    app.get('/api/relay/activity', function(req, res) {
        try {
            if (!config.relayEnabled) return res.status(404).json({ error: 'SUB2API_BASE_URL 未配置,中转站功能未启用' });
            if (req.query.password !== PASSWORD) return res.status(401).json({ error: 'unauthorized' });
            var now = Date.now();
            if (_relayActivityCache.data && now - _relayActivityCache.at < 10000) {
                return res.json(_relayActivityCache.data);
            }
            httpGetJSON(relaySnapshotUrl('/api/user-activity-snapshot'), 8000).then(function(envelope) {
                // sub2api 统一信封 {code:0, message, data:{generated_at, users:[...]}}
                var data = (envelope && envelope.code === 0 && envelope.data) ? envelope.data : null;
                if (!data || !Array.isArray(data.users)) {
                    return res.status(502).json({ error: 'unexpected relay activity snapshot shape' });
                }
                _relayActivityCache = { at: Date.now(), data: data };
                res.json(data);
            }).catch(function(err) {
                res.status(502).json({ error: 'relay activity snapshot fetch failed: ' + err.message });
            });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    var _relayUsageCache = { at: 0, data: null };
    app.get('/api/relay/usage', function(req, res) {
        try {
            if (!config.relayEnabled) return res.status(404).json({ error: 'SUB2API_BASE_URL 未配置,中转站功能未启用' });
            if (req.query.password !== PASSWORD) return res.status(401).json({ error: 'unauthorized' });
            var now = Date.now();
            if (req.query.force !== '1' && _relayUsageCache.data && now - _relayUsageCache.at < 4 * 60 * 1000) {
                return res.json(_relayUsageCache.data);
            }
            httpGetJSON(relaySnapshotUrl('/api/user-usage-snapshot'), 15000).then(function(envelope) {
                var data = (envelope && envelope.code === 0 && envelope.data) ? envelope.data : null;
                if (!data || !Array.isArray(data.users)) {
                    return res.status(502).json({ error: 'unexpected relay usage snapshot shape' });
                }
                _relayUsageCache = { at: Date.now(), data: data };
                res.json(data);
            }).catch(function(err) {
                res.status(502).json({ error: 'relay usage snapshot fetch failed: ' + err.message });
            });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // 权重配置读取(管理员):每个账号的 weightConfig + 当前 base/final
    app.get('/api/weights/config', checkAuth, function(req, res) {
        try {
            var accounts = readAccounts();
            var list = [];
            var entries = buildWeightEntries(accounts, true, Date.now());
            for (var i = 0; i < entries.length; i++) {
                var entry = entries[i];
                var acc = entry.account;
                var cfg = weights.getWeightConfig(acc);
                var s = entry.score;
                var base = s ? s.weight : null;
                var finalW = weights.finalWeight(base, cfg);
                if (s && s.exhausted) finalW = 0;                    // 耗尽账号权重恒为 0
                list.push({ index: entry.index, name: acc.name, platform: entry.platform, config: cfg, base: base, final: finalW, exhausted: s ? s.exhausted : false });
            }
            res.json(list);
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // 权重配置写入(管理员):{ defaultWeight, strategy, value } 任选提供
    app.put('/api/weights/config/:index', jsonParser, checkAuth, function(req, res) {
        try {
            var accounts = readAccounts();
            var idx = parseInt(req.params.index);
            if (!accounts[idx]) return res.status(404).json({ error: '未找到账号' });
            var cfg = weights.getWeightConfig(accounts[idx]);
            if (req.body && req.body.defaultWeight != null) cfg.defaultWeight = req.body.defaultWeight;
            if (req.body && req.body.strategy != null) cfg.strategy = req.body.strategy;
            if (req.body && req.body.value != null) cfg.value = req.body.value;
            cfg = weights.getWeightConfig({ weightConfig: cfg });   // 复用校验/兜底
            accounts[idx].weightConfig = cfg;
            writeAccounts(accounts);
            res.json({ success: true, index: idx, config: cfg });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // ============ API Keys（仅管理员可见可操作） ============

    app.get('/api/keys/:index', checkAuth, async function(req, res) {
        try {
            var i = parseInt(req.params.index);
            var account = getAccount(req);
            if (!account) return res.status(404).json({ error: '未找到账号' });
            if (isHiddenFromGuest(req, account)) return res.status(404).json({ error: '未找到账号' });
            if ((account.platform || 'glm') !== 'glm') {
                return res.json([]);
            }
            var json = await withGlmAuthRetry(account, i, function(acc) {
                return httpsGet(keysUrl(acc, '?keyType=' + (acc.teamEdition ? 2 : 1)), makeHeaders(acc));
            });
            var keys = json.data || [];
            var accounts = readAccounts();
            accounts[i].keyCount = keys.length;
            writeAccounts(accounts);
            var c = usageCache[i];
            if (c && c.result) c.result.keyCount = keys.length;
            res.json(keys);
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.get('/api/keys/:index/copy/:apiKey', checkAuth, async function(req, res) {
        try {
            var i = parseInt(req.params.index);
            var account = getAccount(req);
            if (!account) return res.status(404).json({ error: '未找到账号' });
            var json = await withGlmAuthRetry(account, i, function(acc) {
                return httpsGet(keysUrl(acc, '/copy/' + req.params.apiKey), makeHeaders(acc));
            });
            res.json(json.data || {});
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.post('/api/keys/:index', jsonParser, checkAuth, async function(req, res) {
        try {
            var i = parseInt(req.params.index);
            var account = getAccount(req);
            if (!account) return res.status(404).json({ error: '未找到账号' });
            var json = await withGlmAuthRetry(account, i, function(acc) {
                return httpsRequest('POST', keysUrl(acc), makeHeaders(acc), { name: req.body.name, keyType: acc.teamEdition ? 2 : 1 });
            });
            res.json(json.data || {});
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.delete('/api/keys/:index/:apiKey', checkAuth, async function(req, res) {
        try {
            var i = parseInt(req.params.index);
            var account = getAccount(req);
            if (!account) return res.status(404).json({ error: '未找到账号' });
            await withGlmAuthRetry(account, i, function(acc) {
                return httpsRequest('DELETE', keysUrl(acc, '/' + req.params.apiKey), makeHeaders(acc));
            });
            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // ============ IP 白名单（智谱账号,查看与操作均需密码）============

    app.get('/api/ip-whitelist/:index', checkAuth, async function(req, res) {
        try {
            var i = parseInt(req.params.index);
            var account = getAccount(req);
            if (!account) return res.status(404).json({ error: '未找到账号' });
            if ((account.platform || 'glm') !== 'glm') return res.json([]);
            var json = await withGlmAuthRetry(account, i, function(acc) {
                return httpsGet(ipWhitelistUrl(acc, '/list'), makeHeaders(acc));
            });
            if (json && json.code != null && json.code !== 200) throw new Error(json.msg || '查询失败');
            res.json(json.rows || []);
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.post('/api/ip-whitelist/:index', jsonParser, checkAuth, async function(req, res) {
        try {
            var i = parseInt(req.params.index);
            var account = getAccount(req);
            if (!account) return res.status(404).json({ error: '未找到账号' });
            var ip = (req.body && req.body.ipAddress || '').trim();
            if (!isValidIp(ip)) return res.status(400).json({ error: 'IP 地址格式不正确,支持 IPv4 或 IPv4/CIDR,如 1.2.3.4 或 10.0.0.0/8' });
            var json = await withGlmAuthRetry(account, i, function(acc) {
                return httpsRequest('POST', ipWhitelistUrl(acc), makeHeaders(acc), { ipAddress: ip });
            });
            if (json && json.code != null && json.code !== 200) throw new Error(json.msg || '添加失败');
            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.delete('/api/ip-whitelist/:index/:id', checkAuth, async function(req, res) {
        try {
            var i = parseInt(req.params.index);
            var account = getAccount(req);
            if (!account) return res.status(404).json({ error: '未找到账号' });
            var json = await withGlmAuthRetry(account, i, function(acc) {
                return httpsRequest('DELETE', ipWhitelistUrl(acc, '/' + req.params.id), makeHeaders(acc));
            });
            if (json && json.code != null && json.code !== 200) throw new Error(json.msg || '删除失败');
            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // ============ 风控/异常提示（智谱个人版账号,查看与刷新均无需管理员）============

    app.get('/api/risk/:index', async function(req, res) {
        try {
            var i = parseInt(req.params.index);
            var account = getAccount(req);
            if (!account) return res.status(404).json({ error: '未找到账号' });
            if (isHiddenFromGuest(req, account)) return res.status(404).json({ error: '未找到账号' });
            // 仅智谱账号有风控接口;团队版(ENTERPRISE)不适用
            if ((account.platform || 'glm') !== 'glm') return res.json({ level: null, text: '', teamEdition: false });
            if (decodeJwtUserType(account.authorization) !== 'PERSONAL') {
                return res.json({ level: null, text: '', teamEdition: true });
            }
            var json = await withGlmAuthRetry(account, i, function(acc) {
                return httpsGet(riskInfoUrl(), makeHeaders(acc));
            });
            var level = (json && json.data != null) ? json.data : null;
            var text = '';
            if (level) text = `(${level})` + (RISK_TIPS[level] || RISK_TIPS_FALLBACK);

            // 每次打开详情刷新:有风险则记录,已解除则清除
            var accounts = readAccounts();
            if (accounts[i]) {
                if (text) {
                    accounts[i].risk = { level: level, text: text, checkedAt: Date.now() };
                } else {
                    delete accounts[i].risk;
                }
                writeAccounts(accounts);
                // 同步刷新内存用量缓存里的 risk,避免 /api/usage 仍返回旧值
                var c = usageCache[i];
                if (c && c.result) c.result.risk = text ? accounts[i].risk : undefined;
            }
            res.json({ level: level || null, text: text, teamEdition: false });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // ============ 重置卡(Coding Plan 个人版,仅管理员打开详情时加载)============

    app.get('/api/reset-cards/:index', checkAuth, async function(req, res) {
        try {
            var i = parseInt(req.params.index);
            var account = getAccount(req);
            if (!account) return res.status(404).json({ error: '未找到账号' });
            // 仅智谱个人版账号有重置卡;团队版(teamEdition)不适用。
            // 不用 JWT user_type 判断:部分个人订阅账号 JWT 也标 ENTERPRISE(见 weights.js 同款说明)
            if ((account.platform || 'glm') !== 'glm' || account.teamEdition) {
                return res.json({ cards: [] });
            }
            var json = await withGlmAuthRetry(account, i, function(acc) {
                return httpsGet(resetCardsUrl(), makeHeaders(acc));
            });
            var cards = parseGlmResetCards(json && json.data);
            // 每次打开详情刷新:有卡则记录数量与到期时间,无卡则清除(与风控同模式)
            persistGlmResetCards(i, cards);
            res.json({ cards: cards, checkedAt: Date.now() });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // 使用一张重置卡:先取最新列表校验该卡仍有效,再调官方 use 接口,成功后刷新本地缓存
    app.post('/api/reset-cards/:index/use', jsonParser, checkAuth, async function(req, res) {
        try {
            var i = parseInt(req.params.index);
            var account = getAccount(req);
            if (!account) return res.status(404).json({ error: '未找到账号' });
            if ((account.platform || 'glm') !== 'glm' || account.teamEdition) {
                return res.status(400).json({ error: '该账号不支持重置卡' });
            }
            var cardType = String((req.body && req.body.type) || '');
            var useType = RESET_CARD_USE_TYPES[cardType];
            var recordId = parseInt(req.body && req.body.recordId, 10);
            if (!useType || !Number.isInteger(recordId) || recordId <= 0) {
                return res.status(400).json({ error: '参数不正确,需要 type 与 recordId' });
            }
            // 用前校验:页面上的卡可能已被使用或过期,以官方最新列表为准
            var listJson = await withGlmAuthRetry(account, i, function(acc) {
                return httpsGet(resetCardsUrl(), makeHeaders(acc));
            });
            var stillValid = parseGlmResetCards(listJson && listJson.data).some(function(c) {
                return c.type === cardType && c.recordId === recordId;
            });
            if (!stillValid) return res.status(409).json({ error: '该重置卡已使用、已过期或不存在,请刷新后重试' });

            var json = await withGlmAuthRetry(account, i, function(acc) {
                return httpsRequest('POST', resetCardUseUrl(), makeHeaders(acc), {
                    targetType: 'PERSONAL',
                    resetType: useType,
                    recordId: recordId,
                    requestId: uuidV4()
                });
            });
            if (json && json.code != null && json.code !== 200) throw new Error(json.msg || '使用失败');

            // 使用成功后重取列表刷新缓存(该卡 available 置 false 即消失),并回传前端免二次请求
            var afterJson = await withGlmAuthRetry(account, i, function(acc) {
                return httpsGet(resetCardsUrl(), makeHeaders(acc));
            });
            var cards = parseGlmResetCards(afterJson && afterJson.data);
            persistGlmResetCards(i, cards);
            res.json({ success: true, cards: cards, checkedAt: Date.now() });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // ============ 智云自助登录（手机号核对后，成功自动更新 satoken）============

    app.post('/api/telecomjs/login/:index', jsonParser, async function(req, res) {
        try {
            var idx = parseInt(req.params.index);
            var accounts = readAccounts();
            var account = accounts[idx];
            if (!account) return res.status(404).json({ error: '未找到账号' });
            if (isHiddenFromGuest(req, account)) return res.status(404).json({ error: '未找到账号' });
            if ((account.platform || 'glm') !== 'telecomjs') {
                return res.status(400).json({ error: '该账号不是智云账号' });
            }
            var expectedTelephone = normalizeTelephone(account.phone);
            if (!/^1[3-9]\d{9}$/.test(expectedTelephone)) {
                return res.status(409).json({ error: '该账号未配置有效的管辖手机号，请联系管理员维护' });
            }
            var submittedTelephone = normalizeTelephone(req.body && req.body.telephone);
            var attemptKey = String(req.ip || req.socket.remoteAddress || '') + ':' + idx;
            var attempt = telecomPhoneAttempts.get(attemptKey);
            var now = Date.now();
            if (attempt && now - attempt.startedAt < 10 * 60 * 1000 && attempt.count >= 8) {
                return res.status(429).json({ error: '手机号核对失败次数过多，请 10 分钟后重试' });
            }
            if (submittedTelephone !== expectedTelephone) {
                if (!attempt || now - attempt.startedAt >= 10 * 60 * 1000) attempt = { count: 0, startedAt: now };
                attempt.count++;
                telecomPhoneAttempts.set(attemptKey, attempt);
                return res.status(403).json({ error: '手机号与该账号登记信息不一致' });
            }
            telecomPhoneAttempts.delete(attemptKey);
            var expectedName = account.name || '';
            var session = await telecomjs.startLogin({
                accountKey: idx + ':' + expectedName,
                telephone: expectedTelephone,
                onToken: async function(token) {
                    var latest = readAccounts();
                    var target = latest[idx];
                    if (!target || (target.platform || 'glm') !== 'telecomjs' || (target.name || '') !== expectedName
                        || normalizeTelephone(target.phone) !== expectedTelephone) {
                        throw new Error('账号信息已发生变化，请重新核对手机号');
                    }
                    target.satoken = token;
                    writeAccounts(latest);
                    clearCacheIndex(idx);
                }
            });
            res.json(session);
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.get('/api/telecomjs/login/:sessionId', function(req, res) {
        var session = telecomjs.getLogin(req.params.sessionId);
        if (!session) return res.status(404).json({ error: '登录会话不存在或已过期' });
        res.json(session);
    });

    app.get('/api/telecomjs/login/:sessionId/screenshot', async function(req, res) {
        try {
            var png = await telecomjs.getLoginScreenshot(req.params.sessionId);
            res.set('Cache-Control', 'no-store');
            res.type('png').send(png);
        } catch (err) { res.status(410).json({ error: err.message }); }
    });

    app.delete('/api/telecomjs/login/:sessionId', async function(req, res) {
        try {
            var found = await telecomjs.cancelLogin(req.params.sessionId);
            if (!found) return res.status(404).json({ error: '登录会话不存在或已过期' });
            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // ============ 账号管理（需密码） ============

    app.get('/api/accounts', checkAuth, function(req, res) {
        try { res.json(readAccounts()); } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.post('/api/accounts', jsonParser, checkAuth, function(req, res) {
        try {
            var accounts = readAccounts();
            accounts.push(req.body);
            writeAccounts(accounts);
            clearCache();
            res.json({ success: true, index: accounts.length - 1 });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.put('/api/accounts/:index', jsonParser, checkAuth, function(req, res) {
        try {
            var accounts = readAccounts();
            var idx = parseInt(req.params.index);
            if (!accounts[idx]) return res.status(404).json({ error: '未找到账号' });
            // 编辑账号表单不含 weightConfig,替换时保留原有权重配置
            if (accounts[idx].weightConfig && req.body && !('weightConfig' in req.body)) {
                req.body.weightConfig = accounts[idx].weightConfig;
            }
            accounts[idx] = req.body;
            writeAccounts(accounts);
            clearCache();
            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.put('/api/accounts', jsonParser, checkAuth, function(req, res) {
        try {
            if (!Array.isArray(req.body)) return res.status(400).json({ error: '参数必须是数组' });
            writeAccounts(req.body);
            clearCache();
            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.delete('/api/accounts/:index', checkAuth, function(req, res) {
        try {
            var accounts = readAccounts();
            var idx = parseInt(req.params.index);
            if (!accounts[idx]) return res.status(404).json({ error: '未找到账号' });
            accounts.splice(idx, 1);
            writeAccounts(accounts);
            clearCache();
            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // ============ 用量曲线 ============

    app.get('/api/model-usage/:index', async function(req, res) {
        try {
            var i = parseInt(req.params.index);
            var account = getAccount(req);
            if (!account) return res.status(404).json({ error: '未找到账号' });
            if (isHiddenFromGuest(req, account)) return res.status(404).json({ error: '未找到账号' });
            if ((account.platform || 'glm') === 'qwen') {
                var qwenChart = await fetchQwenModelUsage(account, req.query.period || '7d');
                return res.json({ data: qwenChart });
            }
            if ((account.platform || 'glm') === 'minimax') {
                var mmChart = await fetchMiniMaxModelUsage(account, req.query.period || '7d');
                return res.json({ data: mmChart });
            }
            if ((account.platform || 'glm') === 'stepfun') {
                var sfChart = await fetchStepfunModelUsage(account, i, req.query.period || '7d');
                return res.json({ data: sfChart });
            }
            if ((account.platform || 'glm') !== 'glm') {
                var platName = account.platform === 'sub2api' ? 'Sub2API' : (account.platform === 'huoli' ? '火狸' : (account.platform === 'volc' ? '火山' : (account.platform === 'telecomjs' ? '智云' : (account.platform === 'qwen' ? '千问' : (account.platform === 'minimax' ? 'MiniMax' : (account.platform === 'stepfun' ? '阶跃' : 'YesCode'))))));
                return res.json({ error: platName + ' 暂不支持用量曲线' });
            }
            var period = req.query.period || '7d';
            var now = new Date();
            var pad = function(n) { return n < 10 ? '0' + n : '' + n; };
            function fmtDate(d, hms) {
                return d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate()) + ' ' + hms;
            }
            var endDate = fmtDate(now, '23:59:59');
            var startD = new Date(now);
            if (period === '30d') {
                startD.setDate(startD.getDate() - 29);
            } else if (period !== 'today') { // 7d default
                startD.setDate(startD.getDate() - 6);
            }
            var startDate = fmtDate(startD, '00:00:00');
            var url = 'https://bigmodel.cn/api/monitor/usage/model-usage?startTime='
                + encodeURIComponent(startDate) + '&endTime=' + encodeURIComponent(endDate);
            // 团队版需带 type=2，否则拿到的是个人维度数据（与 quota/limit 口径一致）
            if (account.teamEdition) url += '&type=2';
            var json = await withGlmAuthRetry(account, i, function(acc) {
                return httpsGet(url, makeHeaders(acc));
            });
            res.json(json);
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // ============ 订阅到期时间 ============

    app.get('/api/expire', async function(req, res) {
        try {
            var accounts = readAccounts();
            var force = req.query.force === '1';
            var results = await Promise.all(accounts.map(function(account, i) {
                if (isHiddenFromGuest(req, account)) return null;  // 游客跳过私有账号
                if (!force) { var c = getExpireCached(i); if (c) return c; }
                return fetchAccountExpire(account, i);
            }));
            res.json(results.filter(Boolean));
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.get('/api/expire/:index', async function(req, res) {
        try {
            var i = parseInt(req.params.index);
            var account = getAccount(req);
            if (!account) return res.status(404).json({ error: '未找到账号' });
            if (isHiddenFromGuest(req, account)) return res.status(404).json({ error: '未找到账号' });
            if (req.query.force !== '1') { var c = getExpireCached(i); if (c) return res.json(c); }
            res.json(await fetchAccountExpire(account, i));
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

};

// 供单测覆盖 GLM 自动重登路径（不走 HTTP 路由）
module.exports._isGlmAuthError = isGlmAuthError;
module.exports._hasGlmLoginCredentials = hasGlmLoginCredentials;
// 供单测覆盖重置卡列表解析（不走 HTTP 路由）
module.exports._parseGlmResetCards = parseGlmResetCards;
// 供单测覆盖千问用量曲线响应解析（不走 HTTP 路由）
module.exports._parseQwenModelUsageJson = parseQwenModelUsageJson;
module.exports._loginGlm = loginGlm;
module.exports._fetchGLMUsage = fetchGLMUsage;
module.exports._yescodeLogin = yescodeLogin;
module.exports._fetchYesCodeUsage = fetchYesCodeUsage;
module.exports._hasYescodeLoginCredentials = hasYescodeLoginCredentials;
module.exports._loginSub2api = loginSub2api;
module.exports._fetchSub2apiUsage = fetchSub2apiUsage;
module.exports._sub2apiCreds = sub2apiCreds;
module.exports._sub2apiBaseUrl = sub2apiBaseUrl;
module.exports._withGlmAuthRetry = withGlmAuthRetry;
module.exports._parseMinimaxSubscription = parseMinimaxSubscription;
module.exports._parseMinimaxSubscribeInfo = parseMinimaxSubscribeInfo;
module.exports._minimaxMergeSubscription = minimaxMergeSubscription;
module.exports._parseMinimaxUsage = parseMinimaxUsage;
module.exports._parseMinimaxModelUsage = parseMinimaxModelUsage;
// 供单测覆盖阶跃星辰解析与 Cookie 维护（不走 HTTP 路由）
module.exports._stepfunWebid = stepfunWebid;
module.exports._stepfunMaskMobile = stepfunMaskMobile;
module.exports._stepfunReplaceTokenCookie = stepfunReplaceTokenCookie;
module.exports._stepfunSecToMs = stepfunSecToMs;
module.exports._stepfunBeijingTodayStart = stepfunBeijingTodayStart;
module.exports._parseStepfunPlanStatus = parseStepfunPlanStatus;
module.exports._parseStepfunRateLimit = parseStepfunRateLimit;
module.exports._parseStepfunUsages = parseStepfunUsages;
module.exports._parseStepfunModelUsage = parseStepfunModelUsage;
module.exports._parseStepfunCampaign = parseStepfunCampaign;
// 供单测覆盖凭证加密与密码防爆破（不走 HTTP 路由）
module.exports._encryptSecret = encryptSecret;
module.exports._decryptSecretOrNull = decryptSecretOrNull;
module.exports._encryptAccounts = encryptAccounts;
module.exports._decryptAccounts = decryptAccounts;
module.exports._authBanState = authBanState;
module.exports._authBanRecordFailure = authBanRecordFailure;
module.exports._authBanReset = authBanReset;
module.exports._clientIp = clientIp;
module.exports._minimaxGroupId = minimaxGroupId;

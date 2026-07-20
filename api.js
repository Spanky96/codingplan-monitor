var fs = require('fs');
var path = require('path');
var https = require('https');
var express = require('express');
var jsonParser = express.json();

var config = require('./config');
var telecomjs = require('./telecomjs');
var glmAccountsFile = config.accountsFile;
var PASSWORD = config.adminPassword;
var weights = require('./weights');
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

function readAccounts() {
    if (!fs.existsSync(glmAccountsFile)) {
        writeAccounts([]);
        return [];
    }
    return JSON.parse(fs.readFileSync(glmAccountsFile, 'utf8')).accounts;
}
function writeAccounts(accounts) {
    fs.writeFileSync(glmAccountsFile, JSON.stringify({ accounts: accounts }, null, 2));
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

function checkAuth(req, res, next) {
    if (req.headers['x-auth-password'] !== PASSWORD)
        return res.status(401).json({ error: '密码错误' });
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
        var result = { index: index, name: account.name, platform: 'glm', responsiblePerson: account.responsiblePerson, phone: account.phone, notes: account.notes, keyCount: account.keyCount, teamEdition: account.teamEdition || undefined, personalEdition: personalEdition, isPublic: account.isPublic, risk: account.risk || undefined, data: json.data, success: true, cachedAt: Date.now() };
        setCache(index, result);
        return result;
    } catch (err) {
        return { index: index, name: account.name, platform: 'glm', responsiblePerson: account.responsiblePerson, phone: account.phone, notes: account.notes, keyCount: account.keyCount, teamEdition: account.teamEdition || undefined, isPublic: account.isPublic, risk: account.risk || undefined, error: err.message, success: false };
    }
}

async function fetchGLMExpire(account, index) {
    try {
        var json = await withGlmAuthRetry(account, index, async function(acc) {
            return httpsGet('https://bigmodel.cn/api/biz/trial-cards/current-user', makeHeaders(acc));
        });
        var result = { expireTime: json.data && json.data.expireTime, inviteCode: json.data && json.data.inviteCode, success: true, cachedAt: Date.now() };
        setExpireCache(index, result);
        return result;
    } catch (err) {
        return { error: err.message, success: false, cachedAt: Date.now() };
    }
}

// ============ YesCode 账号 ============

async function fetchYesCodeUsage(account, index) {
    try {
        var headers = {
            'accept': 'application/json, text/plain, */*',
            'cookie': account.cookie || ''
        };
        var json = await httpsGet('https://co.yes.vg/api/v1/auth/profile', headers);
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

// ============ 火狸 账号 ============

async function loginHuoli(email, password) {
    var json = await httpsRequest('POST', 'https://huolilink.com/api/v1/auth/login', {
        'accept': 'application/json, text/plain, */*',
        'accept-language': 'zh',
        'content-type': 'application/json'
    }, { email: email, password: password, user_type: 'personal' });
    if (json.code !== 0 || !json.data || !json.data.access_token) {
        throw new Error('火狸登录失败: ' + (json.message || '未知错误'));
    }
    return 'Bearer ' + json.data.access_token;
}

function saveHuoliToken(index, newAuth) {
    try {
        var accounts = readAccounts();
        if (accounts[index] && accounts[index].platform === 'huoli') {
            accounts[index].authorization = newAuth;
            writeAccounts(accounts);
        }
    } catch (e) { /* ignore write errors */ }
}

async function fetchHuoliUsage(account, index) {
    try {
        var headers = {
            'accept': 'application/json, text/plain, */*',
            'authorization': account.authorization || ''
        };
        var json;
        try {
            json = await httpsGet('https://huolilink.com/api/v1/subscriptions/active?timezone=Asia%2FShanghai', headers);
        } catch (authErr) {
            // 如果是 401 且有 email/password，自动重新登录
            if (authErr.message && authErr.message.indexOf('HTTP 401') >= 0 && account.huoli_email && account.huoli_password) {
                var newAuth = await loginHuoli(account.huoli_email, account.huoli_password);
                saveHuoliToken(index, newAuth);
                headers.authorization = newAuth;
                json = await httpsGet('https://huolilink.com/api/v1/subscriptions/active?timezone=Asia%2FShanghai', headers);
            } else {
                throw authErr;
            }
        }
        var result = {
            index: index,
            name: account.name,
            platform: 'huoli',
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
            platform: 'huoli',
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
    if (platform === 'huoli') {
        return fetchHuoliUsage(account, index);
    }
    if (platform === 'volc') {
        return fetchVolcUsage(account, index);
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
        res.json({ success: req.body.password === PASSWORD });
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

    // ============ 权重接口(为中转站提供 token 分配权重,纯读缓存 + 默认兜底) ============
    app.get('/api/weights', function(req, res) {
        try {
            var authenticated = req.query.password === PASSWORD;
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

    // ============ API Keys（查看公开，操作需密码） ============

    app.get('/api/keys/:index', async function(req, res) {
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
            if ((account.platform || 'glm') !== 'glm') {
                var platName = account.platform === 'huoli' ? '火狸' : (account.platform === 'volc' ? '火山' : (account.platform === 'telecomjs' ? '智云' : 'YesCode'));
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
module.exports._loginGlm = loginGlm;
module.exports._fetchGLMUsage = fetchGLMUsage;
module.exports._withGlmAuthRetry = withGlmAuthRetry;

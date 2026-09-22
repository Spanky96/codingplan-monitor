// ============ 智谱 GLM 账号（bigmodel.cn）============
// 公共 helpers(请求头/URL 构造/风控文案/重置卡解析)+ 抓取 + 401 自动重登回写。
var { httpsGet, httpsRequest } = require('../../lib/http');
var { readAccounts, writeAccounts } = require('../accounts');
var { setCache, setExpireCache, patchCachedResult } = require('../cache');
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

// 智谱账号订阅列表接口(到期时间兜底 / 用户 customerId 均取自这里)
function subscriptionListUrl() {
    return 'https://bigmodel.cn/api/biz/subscription/list';
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
    patchCachedResult(i, { resetCards: cards.length ? accounts[i].resetCards : undefined });
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
            return httpsGet(subscriptionListUrl(), makeHeaders(acc));
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


module.exports = {
    makeHeaders: makeHeaders,
    keysUrl: keysUrl,
    ipWhitelistUrl: ipWhitelistUrl,
    riskInfoUrl: riskInfoUrl,
    resetCardsUrl: resetCardsUrl,
    subscriptionListUrl: subscriptionListUrl,
    resetCardUseUrl: resetCardUseUrl,
    RESET_CARD_USE_TYPES: RESET_CARD_USE_TYPES,
    RISK_TIPS: RISK_TIPS,
    RISK_TIPS_FALLBACK: RISK_TIPS_FALLBACK,
    decodeJwtUserType: decodeJwtUserType,
    parseGlmResetCards: parseGlmResetCards,
    persistGlmResetCards: persistGlmResetCards,
    isValidIp: isValidIp,
    uuidV4: uuidV4,
    isGlmAuthError: isGlmAuthError,
    hasGlmLoginCredentials: hasGlmLoginCredentials,
    loginGlm: loginGlm,
    saveGlmToken: saveGlmToken,
    withGlmAuthRetry: withGlmAuthRetry,
    fetchGLMUsage: fetchGLMUsage,
    fetchGLMExpire: fetchGLMExpire
};

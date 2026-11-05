// ============ Sub2API 中转站账号（任意部署站点;旧火狸兼容）============
var { httpsGet, httpsRequest } = require('../../lib/http');
var { readAccounts, writeAccounts } = require('../accounts');
var { setCache } = require('../cache');

// ============ Sub2API 中转站 账号 ============
// 火狸(huolilink.com) 本质是 sub2api 部署,泛化为任意 sub2api 站点:
// 账号配 base_url + 登录账密,access_token 24h 过期后自动重登续期(旧 huoli 账号无 base_url 时回退 huolilink)。
// 续期优先级:refresh_token(POST /api/v1/auth/refresh,免账密,响应 rotate 出新 rt 须回写)
// > 账密重登(login 响应若带 refresh_token 也一并保存)。

function sub2apiBaseUrl(account) {
    return (account.base_url || 'https://huolilink.com').replace(/\/+$/, '');
}

// 账密字段:sub2api 账号用 sub2api_email/password,旧 huoli 账号回退 huoli_email/password
function sub2apiCreds(account) {
    var email = account.sub2api_email || account.huoli_email || '';
    var password = account.sub2api_password || account.huoli_password || '';
    return (email && password) ? { email: email, password: password } : null;
}

// 登录并返回完整凭证(authorization + login 响应携带的 refresh_token,若有)
async function loginSub2apiTokens(baseUrl, email, password) {
    var json = await httpsRequest('POST', baseUrl + '/api/v1/auth/login', {
        'accept': 'application/json, text/plain, */*',
        'accept-language': 'zh',
        'content-type': 'application/json'
    }, { email: email, password: password });
    if (json.code !== 0 || !json.data || !json.data.access_token) {
        throw new Error('Sub2API 登录失败: ' + (json.message || '未知错误'));
    }
    return { authorization: 'Bearer ' + json.data.access_token, refreshToken: json.data.refresh_token || '' };
}

async function loginSub2api(baseUrl, email, password) {
    return (await loginSub2apiTokens(baseUrl, email, password)).authorization;
}

// 用 refresh_token 换新 access_token(官方 24h 过期后的免账密续期路径)。
// 服务端会 rotate:旧 refresh_token 即刻作废,新 rt 必须回写账号,否则只能续期一次。
async function refreshSub2apiToken(baseUrl, refreshToken) {
    var json = await httpsRequest('POST', baseUrl + '/api/v1/auth/refresh', {
        'accept': 'application/json, text/plain, */*',
        'content-type': 'application/json'
    }, { refresh_token: refreshToken });
    if (json.code !== 0 || !json.data || !json.data.access_token) {
        throw new Error('Sub2API Token 刷新失败: ' + (json.message || '未知错误'));
    }
    return { authorization: 'Bearer ' + json.data.access_token, refreshToken: json.data.refresh_token || '' };
}

// 续期单飞:同一账号并发 401 时共享同一次续期。
// refresh_token 一次性(rotate),两个并发各自刷新会导致第二次必败,必须收敛为一次。
var renewInFlight = {};

function renewSub2apiAuth(account, index, baseUrl) {
    if (renewInFlight[index]) return renewInFlight[index];
    var task = (async function() {
        if (account.sub2api_refresh_token) {
            try {
                return await refreshSub2apiToken(baseUrl, account.sub2api_refresh_token);
            } catch (refreshErr) {
                var credsAfterFail = sub2apiCreds(account);
                if (!credsAfterFail) {
                    throw new Error('Sub2API 自动续期失败(refresh_token 已失效且未配置登录账密,请重新配置): ' + refreshErr.message);
                }
                return await loginSub2apiTokens(baseUrl, credsAfterFail.email, credsAfterFail.password);
            }
        }
        var creds = sub2apiCreds(account);
        if (creds) return await loginSub2apiTokens(baseUrl, creds.email, creds.password);
        throw new Error('Sub2API Token 已过期: 未配置 Refresh Token 与登录账密,无法自动续期');
    })();
    renewInFlight[index] = task;
    var clear = function() { delete renewInFlight[index]; };
    task.then(clear, clear);
    return task;
}

function saveSub2apiTokens(index, newAuth, refreshToken) {
    try {
        var accounts = readAccounts();
        var acc = accounts[index];
        if (acc && (acc.platform === 'sub2api' || acc.platform === 'huoli')) {
            accounts[index] = Object.assign({}, acc, {
                authorization: newAuth,
                // login/refresh 未返回新 rt 时保留账号原有 rt(refresh 失败回退 login 的场景)
                sub2api_refresh_token: refreshToken || acc.sub2api_refresh_token || undefined
            });
            writeAccounts(accounts);
        }
    } catch (e) { /* ignore write errors */ }
}

// sub2api 请求(GET/POST),401(或无 token)时自动续期后重试:refresh_token 优先,回退账密重登。
// 每次调用都从 account 取最新 token(前一次调用续期后已回写 account.authorization),避免携带过期 token 重复续期。
// url 支持绝对地址(签到活动等站内其他模块)或以 / 开头的路径(拼 baseUrl)。
async function sub2apiCall(account, index, baseUrl, method, url, headers, body) {
    var full = /^https?:\/\//i.test(url) ? url : baseUrl + url;
    var h = Object.assign({}, headers, { authorization: account.authorization || (headers && headers.authorization) || '' });
    var send = function(authz) {
        return method === 'POST'
            ? httpsRequest('POST', full, Object.assign({}, h, { authorization: authz }), body || {})
            : httpsGet(full, Object.assign({}, h, { authorization: authz }));
    };
    try {
        return await send(h.authorization);
    } catch (authErr) {
        var isAuthErr = authErr.message && authErr.message.indexOf('HTTP 401') >= 0;
        if (!isAuthErr && account.authorization) throw authErr;
        var renewed;
        try {
            renewed = await renewSub2apiAuth(account, index, baseUrl);
        } catch (renewErr) {
            // 保留原始 HTTP 401 信息(卡片诊断需要),再附续期失败原因
            throw new Error(renewErr.message + '; 原始错误: ' + authErr.message);
        }
        saveSub2apiTokens(index, renewed.authorization, renewed.refreshToken);
        // 本进程内后续请求立即用新 token（accounts.json 也可能被其他写覆盖，以内存更新为准）
        account.authorization = renewed.authorization;
        if (renewed.refreshToken) account.sub2api_refresh_token = renewed.refreshToken;
        return await send(renewed.authorization);
    }
}

async function sub2apiGet(account, index, baseUrl, path, headers) {
    return sub2apiCall(account, index, baseUrl, 'GET', path, headers, null);
}

async function sub2apiPost(account, index, baseUrl, url, headers, body) {
    return sub2apiCall(account, index, baseUrl, 'POST', url, headers, body || {});
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
        // 签到活动状态(账号配 checkin_info_url 才拉):软失败仅置 error,不影响主数据
        var checkinData = null;
        if (account.checkin_info_url) {
            var checkin = require('../checkin');   // 惰性 require:checkin 顶层引用本模块,需打破环
            checkinData = await checkin.fetchCheckinStatus(account, index);
        }
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
            data: { me: (meJson && meJson.data) || null, subscriptions: subs, current: current, stats: stats, checkin: checkinData },
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


module.exports = {
    sub2apiBaseUrl: sub2apiBaseUrl,
    sub2apiCreds: sub2apiCreds,
    loginSub2api: loginSub2api,
    refreshSub2apiToken: refreshSub2apiToken,
    renewSub2apiAuth: renewSub2apiAuth,
    saveSub2apiTokens: saveSub2apiTokens,
    sub2apiGet: sub2apiGet,
    sub2apiPost: sub2apiPost,
    fetchSub2apiUsage: fetchSub2apiUsage
};

// ============ Sub2API 中转站账号（任意部署站点;旧火狸兼容）============
var { httpsGet, httpsRequest } = require('../../lib/http');
var { readAccounts, writeAccounts } = require('../accounts');
var { setCache } = require('../cache');

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


module.exports = {
    sub2apiBaseUrl: sub2apiBaseUrl,
    sub2apiCreds: sub2apiCreds,
    loginSub2api: loginSub2api,
    saveSub2apiToken: saveSub2apiToken,
    fetchSub2apiUsage: fetchSub2apiUsage
};

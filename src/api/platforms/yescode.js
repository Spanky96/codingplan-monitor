// ============ YesCode 账号（co.yes.vg）============
var https = require('https');
var { httpsGet } = require('../../lib/http');
var { readAccounts, writeAccounts } = require('../accounts');
var { setCache } = require('../cache');

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

function saveYescodeCredentials(index, patch) {
    try {
        var accounts = readAccounts();
        if (accounts[index] && accounts[index].platform === 'yescode') {
            Object.assign(accounts[index], patch);
            writeAccounts(accounts);
            return true;
        }
    } catch (e) { /* 请求仍可使用内存中的新凭证，落盘失败留待下次刷新 */ }
    return false;
}

function saveYescodeCookie(index, newCookie) {
    return saveYescodeCredentials(index, { cookie: newCookie });
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

function getYescodeProfileEmail(profileResponse) {
    var profile = profileResponse && (profileResponse.data || profileResponse);
    var email = profile && typeof profile.email === 'string' ? profile.email.trim() : '';
    return email && email.indexOf('@') > 0 ? email : '';
}

// YesCode 登录接口的参数名仍是 username，但当前只接受邮箱。历史界面曾允许填写
// profile username，因此趁 Cookie 有效时用 profile.email 自动校准并持久化登录标识。
function syncYescodeLoginEmail(account, index, profileResponse, saveCredentials) {
    if (!account.yescode_password) return false;
    var email = getYescodeProfileEmail(profileResponse);
    if (!email || account.yescode_username === email) return false;
    account.yescode_username = email;
    return (saveCredentials || saveYescodeCredentials)(index, { yescode_username: email });
}

// profile 失效(401)且配置了账密 → 自动重登；无 Cookie 且有账密时也直接登录获取
async function withYescodeAuthRetry(account, index, requestFn, dependencies) {
    dependencies = dependencies || {};
    var login = dependencies.login || yescodeLogin;
    var saveCookie = dependencies.saveCookie || saveYescodeCookie;
    try {
        return await requestFn(account);
    } catch (authErr) {
        var isAuthErr = authErr.message && authErr.message.indexOf('HTTP 401') >= 0;
        if ((!isAuthErr && account.cookie) || !hasYescodeLoginCredentials(account)) throw authErr;
        var newCookie = await login(account.yescode_username, account.yescode_password);
        saveCookie(index, newCookie);
        // 本进程内后续请求立即用新 Cookie（accounts.json 也可能被其他写覆盖，以内存更新为准）
        account.cookie = newCookie;
        return await requestFn(account);
    }
}

async function fetchYesCodeUsage(account, index) {
    try {
        var json = await withYescodeAuthRetry(account, index, yescodeProfileRequest);
        syncYescodeLoginEmail(account, index, json);
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


module.exports = {
    yescodeLogin: yescodeLogin,
    saveYescodeCredentials: saveYescodeCredentials,
    saveYescodeCookie: saveYescodeCookie,
    hasYescodeLoginCredentials: hasYescodeLoginCredentials,
    getYescodeProfileEmail: getYescodeProfileEmail,
    syncYescodeLoginEmail: syncYescodeLoginEmail,
    withYescodeAuthRetry: withYescodeAuthRetry,
    fetchYesCodeUsage: fetchYesCodeUsage
};

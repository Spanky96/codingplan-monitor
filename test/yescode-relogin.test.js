'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var os = require('os');
var path = require('path');
var https = require('https');

var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yescode-relogin-'));
var accountsFile = path.join(tmpDir, 'accounts.json');
var cacheFile = path.join(tmpDir, 'usage-cache.json');

process.env.ACCOUNTS_FILE = accountsFile;
process.env.USAGE_CACHE_FILE = cacheFile;
process.env.ADMIN_PASSWORD = 'test-pwd';

// 先准备空账号文件，避免 api 模块加载时读盘失败
fs.writeFileSync(accountsFile, JSON.stringify({ accounts: [] }));
fs.writeFileSync(cacheFile, '{}');

// 必须在 require api 前 stub https（api 顶层即引用 https）
var originalRequest = https.request;
var originalGet = https.get;
var callLog = [];
var mode = 'relogin-success';

var NEW_AUTH = 'NEW_AUTH_TOKEN_ABC';
var NEW_CSRF = 'NEW_CSRRF_TOKEN_DEF=';
var NEW_COOKIE = 'yescode_auth=' + NEW_AUTH + '; yescode_csrf=' + NEW_CSRF;

function respond(statusCode, body, headers) {
    var listeners = { data: [], end: [] };
    var res = {
        statusCode: statusCode,
        headers: headers || {},
        on: function(ev, cb) {
            if (ev === 'data') listeners.data.push(cb);
            if (ev === 'end') listeners.end.push(cb);
            return res;
        }
    };
    process.nextTick(function() {
        var chunk = typeof body === 'string' ? body : JSON.stringify(body);
        listeners.data.forEach(function(cb) { cb(chunk); });
        listeners.end.forEach(function(cb) { cb(); });
    });
    return res;
}

function fakeRequest(opts, cb) {
    var method = (opts.method || 'GET').toUpperCase();
    var host = opts.hostname || opts.host || '';
    var pathName = opts.path || '/';
    var url = 'https://' + host + pathName;
    var written = '';
    var req = {
        on: function() { return req; },
        write: function(chunk) { written += chunk; },
        end: function() {
            callLog.push({ method: method, url: url, body: written, headers: opts.headers || {} });
            var cookie = (opts.headers && opts.headers.cookie) || '';

            if (pathName.indexOf('/api/v1/auth/login') >= 0) {
                var parsed = {};
                try { parsed = JSON.parse(written || '{}'); } catch (e) { parsed = {}; }
                if (mode === 'login-fail' || parsed.password !== 'good-pass') {
                    return cb(respond(401, { error: 'Invalid credentials' }));
                }
                return cb(respond(200, { token: NEW_AUTH, user: { id: 10109 } }, {
                    'set-cookie': [
                        'yescode_auth=' + NEW_AUTH + '; Path=/; Max-Age=86400; HttpOnly; SameSite=Lax',
                        'yescode_csrf=' + NEW_CSRF + '; Path=/; Max-Age=86400; SameSite=Strict'
                    ]
                }));
            }

            if (pathName.indexOf('/api/v1/auth/profile') >= 0) {
                if (cookie.indexOf(NEW_AUTH) >= 0) {
                    return cb(respond(200, { id: 10109, username: 'zhangjun2025', balance: 300 }));
                }
                return cb(respond(401, { error: 'Invalid token' }));
            }

            return cb(respond(404, { error: 'not found' }));
        }
    };
    return req;
}

// api.js 里 httpsGet 调用形式：https.get(urlString, { headers }, cb)
https.request = fakeRequest;
https.get = function(urlOrOpts, optionsOrCb, maybeCb) {
    var opts;
    var cb;
    if (typeof urlOrOpts === 'string') {
        var u = new URL(urlOrOpts);
        var optionObj = (typeof optionsOrCb === 'object' && optionsOrCb) || {};
        cb = typeof optionsOrCb === 'function' ? optionsOrCb : maybeCb;
        opts = {
            hostname: u.hostname,
            path: u.pathname + u.search,
            method: 'GET',
            headers: optionObj.headers || {}
        };
    } else {
        opts = Object.assign({}, urlOrOpts, { method: 'GET' });
        cb = optionsOrCb;
    }
    var req = fakeRequest(opts, cb);
    // https.get 会自动 end
    process.nextTick(function() { req.end(); });
    return req;
};

// 在 stub 后加载 api（config 读 env）
delete require.cache[require.resolve('../src/config')];
delete require.cache[require.resolve('../src/api')];
var api = require('../src/api');

function writeAccounts(list) {
    fs.writeFileSync(accountsFile, JSON.stringify({ accounts: list }, null, 2));
}

function readAccounts() {
    // accounts.json 中凭证字段已加密落盘,读断言前先经 api 的解密层
    return api._decryptAccounts(JSON.parse(fs.readFileSync(accountsFile, 'utf8')).accounts);
}

test('hasYescodeLoginCredentials requires both username and password', function() {
    assert.equal(api._hasYescodeLoginCredentials({}), false);
    assert.equal(api._hasYescodeLoginCredentials({ yescode_username: 'u' }), false);
    assert.equal(api._hasYescodeLoginCredentials({ yescode_password: 'p' }), false);
    assert.equal(api._hasYescodeLoginCredentials({ yescode_username: 'u', yescode_password: 'p' }), true);
});

test('yescodeLogin assembles cookie from set-cookie headers', async function() {
    mode = 'relogin-success';
    var cookie = await api._yescodeLogin('user1', 'good-pass');
    assert.equal(cookie, NEW_COOKIE);
});

test('fetchYesCodeUsage auto-relogins on 401 and saves new cookie', async function() {
    mode = 'relogin-success';
    callLog = [];
    writeAccounts([{
        platform: 'yescode',
        name: 'zhangjun5',
        cookie: 'yescode_auth=EXPIRED_TOKEN; yescode_csrf=OLD_CSRF=',
        yescode_username: 'user1',
        yescode_password: 'good-pass'
    }]);

    var result = await api._fetchYesCodeUsage(readAccounts()[0], 0);
    assert.equal(result.success, true);
    assert.equal(result.data.username, 'zhangjun2025');

    var loginCalls = callLog.filter(function(c) { return c.url.indexOf('/api/v1/auth/login') >= 0; });
    assert.equal(loginCalls.length, 1);
    var body = JSON.parse(loginCalls[0].body);
    assert.equal(body.username, 'user1');
    assert.equal(body.password, 'good-pass');

    // 新 Cookie 回写 accounts.json
    var saved = readAccounts()[0];
    assert.equal(saved.cookie, NEW_COOKIE);
});

test('fetchYesCodeUsage logs in directly when cookie missing', async function() {
    mode = 'relogin-success';
    callLog = [];
    writeAccounts([{
        platform: 'yescode',
        name: 'zhangjun5',
        yescode_username: 'user1',
        yescode_password: 'good-pass'
    }]);

    var result = await api._fetchYesCodeUsage(readAccounts()[0], 0);
    assert.equal(result.success, true);
    assert.equal(readAccounts()[0].cookie, NEW_COOKIE);
});

test('fetchYesCodeUsage does not relogin without credentials', async function() {
    mode = 'relogin-success';
    callLog = [];
    writeAccounts([{
        platform: 'yescode',
        name: 'zhangjun5',
        cookie: 'yescode_auth=EXPIRED_TOKEN'
    }]);

    var result = await api._fetchYesCodeUsage(readAccounts()[0], 0);
    assert.equal(result.success, false);
    assert.match(result.error, /HTTP 401/);
    var loginCalls = callLog.filter(function(c) { return c.url.indexOf('/api/v1/auth/login') >= 0; });
    assert.equal(loginCalls.length, 0);
});

test('fetchYesCodeUsage propagates login failure', async function() {
    mode = 'login-fail';
    callLog = [];
    writeAccounts([{
        platform: 'yescode',
        name: 'zhangjun5',
        cookie: 'yescode_auth=EXPIRED_TOKEN',
        yescode_username: 'user1',
        yescode_password: 'wrong-pass'
    }]);

    var result = await api._fetchYesCodeUsage(readAccounts()[0], 0);
    assert.equal(result.success, false);
    assert.match(result.error, /YesCode 登录失败 HTTP 401/);
    // 登录失败不覆盖原 Cookie
    assert.equal(readAccounts()[0].cookie, 'yescode_auth=EXPIRED_TOKEN');
});

test.after(function() {
    https.request = originalRequest;
    https.get = originalGet;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
});

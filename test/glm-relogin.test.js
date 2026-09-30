'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var os = require('os');
var path = require('path');
var https = require('https');

var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glm-relogin-'));
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

function respond(statusCode, body) {
    var listeners = { data: [], end: [] };
    var res = {
        statusCode: statusCode,
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
            var auth = (opts.headers && (opts.headers.authorization || opts.headers.Authorization)) || '';

            if (pathName.indexOf('/api/auth/login') >= 0) {
                var parsed = {};
                try { parsed = JSON.parse(written || '{}'); } catch (e) { parsed = {}; }
                if (mode === 'login-fail' || parsed.password !== 'good-pass') {
                    return cb(respond(200, { code: 401, msg: '密码错误' }));
                }
                return cb(respond(200, { code: 200, data: { access_token: 'NEW_TOKEN_XYZ' } }));
            }

            if (pathName.indexOf('/api/monitor/usage/quota/limit') >= 0) {
                if (auth === 'OLD_TOKEN' || auth === 'Bearer OLD_TOKEN') {
                    return cb(respond(401, { msg: 'unauthorized' }));
                }
                if (auth === 'NEW_TOKEN_XYZ' || auth === 'Bearer NEW_TOKEN_XYZ') {
                    return cb(respond(200, { code: 200, data: { ok: true, tokens: 1 } }));
                }
                return cb(respond(401, { msg: 'unauthorized' }));
            }

            return cb(respond(404, { msg: 'not found' }));
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

test('isGlmAuthError recognizes 401/403/405', function() {
    assert.equal(api._isGlmAuthError(new Error('HTTP 401: unauthorized')), true);
    assert.equal(api._isGlmAuthError(new Error('HTTP 403: forbidden')), true);
    assert.equal(api._isGlmAuthError(new Error('HTTP 405: method')), true);
    assert.equal(api._isGlmAuthError(new Error('HTTP 500: boom')), false);
});

test('hasGlmLoginCredentials requires both username and password', function() {
    assert.equal(api._hasGlmLoginCredentials({}), false);
    assert.equal(api._hasGlmLoginCredentials({ glm_username: 'u' }), false);
    assert.equal(api._hasGlmLoginCredentials({ glm_password: 'p' }), false);
    assert.equal(api._hasGlmLoginCredentials({ glm_username: 'u', glm_password: 'p' }), true);
});

test('fetchGLMUsage auto-relogins on 401 when credentials present', async function() {
    mode = 'relogin-success';
    callLog = [];
    writeAccounts([{
        platform: 'glm',
        name: '测试',
        authorization: 'OLD_TOKEN',
        organization: 'org-1',
        project: 'proj-1',
        glm_username: 'user1',
        glm_password: 'good-pass'
    }]);

    var result = await api._fetchGLMUsage(readAccounts()[0], 0);
    assert.equal(result.success, true);
    assert.equal(result.data.ok, true);

    var loginCalls = callLog.filter(function(c) { return c.url.indexOf('/api/auth/login') >= 0; });
    assert.equal(loginCalls.length, 1);
    var body = JSON.parse(loginCalls[0].body);
    assert.equal(body.username, 'user1');
    assert.equal(body.loginType, 'password');

    var saved = readAccounts()[0];
    assert.equal(saved.authorization, 'NEW_TOKEN_XYZ');
});

test('fetchGLMUsage does not relogin without credentials', async function() {
    mode = 'relogin-success';
    callLog = [];
    writeAccounts([{
        platform: 'glm',
        name: '测试2',
        authorization: 'OLD_TOKEN',
        organization: 'org-1',
        project: 'proj-1'
    }]);

    var result = await api._fetchGLMUsage(readAccounts()[0], 0);
    assert.equal(result.success, false);
    assert.match(result.error, /HTTP 401/);
    var loginCalls = callLog.filter(function(c) { return c.url.indexOf('/api/auth/login') >= 0; });
    assert.equal(loginCalls.length, 0);
});

test.after(function() {
    https.request = originalRequest;
    https.get = originalGet;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
});

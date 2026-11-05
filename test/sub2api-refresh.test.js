'use strict';

// sub2api refresh_token 自动续期:access_token 过期(401 TOKEN_EXPIRED)时优先用
// refresh_token 调 /api/v1/auth/refresh 换新(响应会 rotate 出新 refresh_token,须回写),
// 失败再回退账密重登;并发 401 单飞共享同一次续期,避免旧 rt 重复刷新必败。

var test = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var os = require('os');
var path = require('path');
var https = require('https');

var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sub2api-refresh-'));
var accountsFile = path.join(tmpDir, 'accounts.json');
var cacheFile = path.join(tmpDir, 'usage-cache.json');

process.env.ACCOUNTS_FILE = accountsFile;
process.env.USAGE_CACHE_FILE = cacheFile;
process.env.ADMIN_PASSWORD = 'test-pwd';

fs.writeFileSync(accountsFile, JSON.stringify({ accounts: [] }));
fs.writeFileSync(cacheFile, '{}');

var originalRequest = https.request;
var originalGet = https.get;
var callLog = [];
var refreshMode = 'ok';          // ok=refresh 成功 / fail=refresh 401(rt 失效)
var validRt = 'RT1';             // 服务端当前有效 refresh_token(refresh 成功后 rotate)
var RT2 = 'RT2_ROTATED';
var REFRESH_AT = 'Bearer RT_AT';
var LOGIN_AT = 'Bearer NEW_S2A_TOKEN';

function respond(statusCode, body) {
    var listeners = { data: [], end: [] };
    var res = {
        statusCode: statusCode,
        headers: {},
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

function authorized(auth) {
    return auth === REFRESH_AT || auth === LOGIN_AT;
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
            var auth = (opts.headers && opts.headers.authorization) || '';

            if (pathName.indexOf('/api/v1/auth/refresh') >= 0) {
                var parsed = {};
                try { parsed = JSON.parse(written || '{}'); } catch (e) { parsed = {}; }
                if (refreshMode === 'ok' && parsed.refresh_token === validRt) {
                    validRt = RT2; // 服务端 rotate:旧 rt 即刻作废
                    return cb(respond(200, { code: 0, message: 'success', data: {
                        access_token: REFRESH_AT.replace('Bearer ', ''),
                        refresh_token: RT2, expires_in: 86400, token_type: 'Bearer'
                    } }));
                }
                return cb(respond(401, { code: 'TOKEN_EXPIRED', message: 'Token has expired' }));
            }

            if (pathName.indexOf('/api/v1/auth/login') >= 0) {
                var lp = {};
                try { lp = JSON.parse(written || '{}'); } catch (e) { lp = {}; }
                if (lp.password !== 'good-pass') {
                    return cb(respond(200, { code: 401, message: '邮箱或密码错误' }));
                }
                return cb(respond(200, { code: 0, message: 'success', data: {
                    access_token: LOGIN_AT.replace('Bearer ', ''),
                    refresh_token: 'LOGIN_RT', expires_in: 86400
                } }));
            }

            if (pathName.indexOf('/api/v1/auth/me') >= 0) {
                if (authorized(auth)) return cb(respond(200, { code: 0, data: { email: 'u@x.com', balance: 12.34 } }));
                return cb(respond(401, { code: 'TOKEN_EXPIRED', message: 'Token has expired' }));
            }

            if (pathName.indexOf('/api/v1/subscriptions') >= 0) {
                if (!authorized(auth)) return cb(respond(401, { code: 'TOKEN_EXPIRED', message: 'Token has expired' }));
                return cb(respond(200, { code: 0, data: [
                    { status: 'active', expires_at: '2026-12-01T00:00:00+08:00', daily_usage_usd: 1.5, group: { name: '在用卡', daily_limit_usd: 10 } }
                ] }));
            }

            if (pathName.indexOf('/api/v1/usage/dashboard/stats') >= 0) {
                return cb(respond(404, { error: 'not found' }));
            }

            return cb(respond(404, { error: 'not found' }));
        }
    };
    return req;
}

https.request = fakeRequest;
https.get = function(urlOrOpts, optionsOrCb, maybeCb) {
    var opts;
    var cb;
    if (typeof urlOrOpts === 'string') {
        var u = new URL(urlOrOpts);
        var optionObj = (typeof optionsOrCb === 'object' && optionsOrCb) || {};
        cb = typeof optionsOrCb === 'function' ? optionsOrCb : maybeCb;
        opts = { hostname: u.hostname, path: u.pathname + u.search, method: 'GET', headers: optionObj.headers || {} };
    } else {
        opts = Object.assign({}, urlOrOpts, { method: 'GET' });
        cb = optionsOrCb;
    }
    var req = fakeRequest(opts, cb);
    process.nextTick(function() { req.end(); });
    return req;
};

delete require.cache[require.resolve('../src/config')];
delete require.cache[require.resolve('../src/api')];
var api = require('../src/api');

function writeAccounts(list) {
    fs.writeFileSync(accountsFile, JSON.stringify({ accounts: list }, null, 2));
}

function readAccounts() {
    return api._decryptAccounts(JSON.parse(fs.readFileSync(accountsFile, 'utf8')).accounts);
}

function resetServerState() {
    validRt = 'RT1';
    refreshMode = 'ok';
}

test('401 with refresh_token renews via auth/refresh, saves rotated tokens', async function() {
    resetServerState();
    callLog = [];
    writeAccounts([{
        platform: 'sub2api',
        name: 'yym’s supernb',
        alias: 'SUPER·NB',
        base_url: 'https://super-nb.me',
        authorization: 'Bearer EXPIRED',
        sub2api_refresh_token: 'RT1'
    }]);

    var result = await api._fetchSub2apiUsage(readAccounts()[0], 0);
    assert.equal(result.success, true);
    assert.equal(result.data.me.balance, 12.34);
    assert.equal(result.data.current.group.name, '在用卡');

    var refreshCalls = callLog.filter(function(c) { return c.url.indexOf('/api/v1/auth/refresh') >= 0; });
    assert.equal(refreshCalls.length, 1);
    assert.equal(JSON.parse(refreshCalls[0].body).refresh_token, 'RT1');

    var saved = readAccounts()[0];
    assert.equal(saved.authorization, REFRESH_AT);
    assert.equal(saved.sub2api_refresh_token, RT2); // rotate 出的新 rt 必须回写
});

test('no stored token: renews directly with refresh_token', async function() {
    resetServerState();
    callLog = [];
    writeAccounts([{
        platform: 'sub2api',
        name: 't',
        base_url: 'https://super-nb.me',
        sub2api_refresh_token: 'RT1'
    }]);

    var result = await api._fetchSub2apiUsage(readAccounts()[0], 0);
    assert.equal(result.success, true);
    assert.equal(readAccounts()[0].authorization, REFRESH_AT);
});

test('failed refresh falls back to email/password login', async function() {
    resetServerState();
    refreshMode = 'fail';
    callLog = [];
    writeAccounts([{
        platform: 'sub2api',
        name: 't',
        base_url: 'https://super-nb.me',
        authorization: 'Bearer EXPIRED',
        sub2api_refresh_token: 'RT1',
        sub2api_email: 'u@x.com',
        sub2api_password: 'good-pass'
    }]);

    var result = await api._fetchSub2apiUsage(readAccounts()[0], 0);
    assert.equal(result.success, true);
    assert.ok(callLog.some(function(c) { return c.url.indexOf('/api/v1/auth/refresh') >= 0; }));
    assert.ok(callLog.some(function(c) { return c.url.indexOf('/api/v1/auth/login') >= 0; }));

    var saved = readAccounts()[0];
    assert.equal(saved.authorization, LOGIN_AT);
    assert.equal(saved.sub2api_refresh_token, 'LOGIN_RT'); // login 响应带 rt 也一并保存
});

test('failed refresh without credentials yields readable error, keeps old token', async function() {
    resetServerState();
    refreshMode = 'fail';
    callLog = [];
    writeAccounts([{
        platform: 'sub2api',
        name: 't',
        base_url: 'https://super-nb.me',
        authorization: 'Bearer EXPIRED',
        sub2api_refresh_token: 'RT1'
    }]);

    var result = await api._fetchSub2apiUsage(readAccounts()[0], 0);
    assert.equal(result.success, false);
    assert.match(result.error, /续期失败/);
    var saved = readAccounts()[0];
    assert.equal(saved.authorization, 'Bearer EXPIRED');
    assert.equal(saved.sub2api_refresh_token, 'RT1');
});

test('concurrent fetches share one refresh (rotated rt is single-use)', async function() {
    resetServerState();
    callLog = [];
    writeAccounts([{
        platform: 'sub2api',
        name: 't',
        base_url: 'https://super-nb.me',
        authorization: 'Bearer EXPIRED',
        sub2api_refresh_token: 'RT1'
    }]);

    var results = await Promise.all([
        api._fetchSub2apiUsage(readAccounts()[0], 0),
        api._fetchSub2apiUsage(readAccounts()[0], 0)
    ]);
    assert.equal(results[0].success, true);
    assert.equal(results[1].success, true);
    // 两个并发 401 只允许一次 auth/refresh:第二次复用同一次续期结果
    var refreshCalls = callLog.filter(function(c) { return c.url.indexOf('/api/v1/auth/refresh') >= 0; });
    assert.equal(refreshCalls.length, 1);
});

test('refresh token is encrypted at rest', async function() {
    resetServerState();
    callLog = [];
    writeAccounts([{
        platform: 'sub2api',
        name: 't',
        base_url: 'https://super-nb.me',
        authorization: 'Bearer EXPIRED',
        sub2api_refresh_token: 'RT1'
    }]);

    await api._fetchSub2apiUsage(readAccounts()[0], 0);
    var raw = JSON.parse(fs.readFileSync(accountsFile, 'utf8')).accounts[0];
    assert.equal(raw.sub2api_refresh_token.indexOf('enc:v1'), 0);
    assert.equal(raw.sub2api_refresh_token.indexOf(RT2), -1);
});

test.after(function() {
    https.request = originalRequest;
    https.get = originalGet;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
});

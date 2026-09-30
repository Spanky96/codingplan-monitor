'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var os = require('os');
var path = require('path');
var https = require('https');

var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sub2api-relogin-'));
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
var mode = 'ok';
var withStats = false;
var subMode = 'mixed'; // mixed=过期旧卡+active / only-old=仅过期>3天 / recent=过期2天内

var NEW_TOKEN = 'Bearer NEW_S2A_TOKEN';

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

            if (pathName.indexOf('/api/v1/auth/login') >= 0) {
                var parsed = {};
                try { parsed = JSON.parse(written || '{}'); } catch (e) { parsed = {}; }
                if (mode === 'login-fail' || parsed.password !== 'good-pass') {
                    return cb(respond(200, { code: 401, message: '邮箱或密码错误' }));
                }
                return cb(respond(200, { code: 0, message: 'success', data: { access_token: 'NEW_S2A_TOKEN', expires_in: 86400 } }));
            }

            if (pathName.indexOf('/api/v1/auth/me') >= 0) {
                if (auth === NEW_TOKEN) return cb(respond(200, { code: 0, data: { email: 'u@x.com', balance: 12.34 } }));
                return cb(respond(401, { message: 'unauthorized' }));
            }

            if (pathName.indexOf('/api/v1/subscriptions') >= 0) {
                if (auth !== NEW_TOKEN) return cb(respond(401, { message: 'unauthorized' }));
                if (subMode === 'only-old') {
                    return cb(respond(200, { code: 0, data: [
                        { status: 'expired', expires_at: '2026-07-31T21:59:15+08:00', daily_usage_usd: 30, group: { name: '旧卡', daily_limit_usd: 30 } }
                    ] }));
                }
                if (subMode === 'recent') {
                    return cb(respond(200, { code: 0, data: [
                        { status: 'expired', expires_at: new Date(Date.now() - 2 * 86400000).toISOString(), daily_usage_usd: 5, group: { name: '刚过期卡', daily_limit_usd: 10 } }
                    ] }));
                }
                return cb(respond(200, { code: 0, data: [
                    { status: 'expired', expires_at: '2026-07-31T21:59:15+08:00', daily_usage_usd: 30, group: { name: '旧卡', daily_limit_usd: 30 } },
                    { status: 'active', expires_at: '2026-10-01T00:00:00+08:00', daily_usage_usd: 1.5, group: { name: '新卡', daily_limit_usd: 10 } }
                ] }));
            }

            if (pathName.indexOf('/api/v1/usage/dashboard/stats') >= 0) {
                if (!withStats) return cb(respond(404, { error: 'not found' }));
                return cb(respond(200, { code: 0, data: {
                    today_requests: 12, today_tokens: 1234567, today_input_tokens: 1000000, today_output_tokens: 234567,
                    today_cache_read_tokens: 5000000, today_cost: 3.25, today_actual_cost: 0.85,
                    total_requests: 11235, total_tokens: 1618949385, total_cost: 1967.77, total_actual_cost: 254.01
                } }));
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
    // accounts.json 中凭证字段已加密落盘,读断言前先经 api 的解密层
    return api._decryptAccounts(JSON.parse(fs.readFileSync(accountsFile, 'utf8')).accounts);
}

test('sub2apiCreds requires both email and password, with huoli fallback', function() {
    assert.equal(api._sub2apiCreds({}), null);
    assert.equal(api._sub2apiCreds({ sub2api_email: 'u' }), null);
    assert.equal(api._sub2apiCreds({ sub2api_email: 'u', sub2api_password: 'p' }).email, 'u');
    assert.equal(api._sub2apiCreds({ huoli_email: 'h', huoli_password: 'p' }).email, 'h');
});

test('fetchSub2apiUsage relogins on 401, saves token and picks active sub', async function() {
    mode = 'ok';
    callLog = [];
    writeAccounts([{
        platform: 'sub2api',
        name: 'SUPER·NB',
        alias: 'SUPER·NB',
        base_url: 'https://super-nb.me/',
        authorization: 'Bearer EXPIRED',
        sub2api_email: 'u@x.com',
        sub2api_password: 'good-pass'
    }]);

    var result = await api._fetchSub2apiUsage(readAccounts()[0], 0);
    assert.equal(result.success, true);
    assert.equal(result.baseUrl, 'https://super-nb.me');
    assert.equal(result.alias, 'SUPER·NB');
    // active 订阅优先于 expired
    assert.equal(result.data.current.status, 'active');
    assert.equal(result.data.current.group.name, '新卡');
    assert.equal(result.data.me.balance, 12.34);
    assert.equal(result.data.subscriptions.length, 2);

    var loginCalls = callLog.filter(function(c) { return c.url.indexOf('/api/v1/auth/login') >= 0; });
    assert.equal(loginCalls.length, 1);
    var body = JSON.parse(loginCalls[0].body);
    assert.equal(body.email, 'u@x.com');
    assert.equal(body.password, 'good-pass');

    assert.equal(readAccounts()[0].authorization, NEW_TOKEN);
});

test('fetchSub2apiUsage logs in directly without token', async function() {
    mode = 'ok';
    callLog = [];
    writeAccounts([{
        platform: 'sub2api',
        name: 'SUPER·NB',
        base_url: 'https://super-nb.me',
        sub2api_email: 'u@x.com',
        sub2api_password: 'good-pass'
    }]);

    var result = await api._fetchSub2apiUsage(readAccounts()[0], 0);
    assert.equal(result.success, true);
    assert.equal(readAccounts()[0].authorization, NEW_TOKEN);
});

test('fetchSub2apiUsage does not relogin without credentials', async function() {
    mode = 'ok';
    callLog = [];
    writeAccounts([{
        platform: 'sub2api',
        name: 'SUPER·NB',
        base_url: 'https://super-nb.me',
        authorization: 'Bearer EXPIRED'
    }]);

    var result = await api._fetchSub2apiUsage(readAccounts()[0], 0);
    assert.equal(result.success, false);
    assert.match(result.error, /HTTP 401/);
    assert.equal(callLog.filter(function(c) { return c.url.indexOf('/auth/login') >= 0; }).length, 0);
});

test('fetchSub2apiUsage propagates login failure and keeps old token', async function() {
    mode = 'login-fail';
    callLog = [];
    writeAccounts([{
        platform: 'sub2api',
        name: 'SUPER·NB',
        base_url: 'https://super-nb.me',
        authorization: 'Bearer EXPIRED',
        sub2api_email: 'u@x.com',
        sub2api_password: 'wrong-pass'
    }]);

    var result = await api._fetchSub2apiUsage(readAccounts()[0], 0);
    assert.equal(result.success, false);
    assert.match(result.error, /Sub2API 登录失败/);
    assert.equal(readAccounts()[0].authorization, 'Bearer EXPIRED');
});

test('fetchSub2apiUsage includes usage stats when endpoint available, tolerates 404', async function() {
    mode = 'ok';
    withStats = true;
    callLog = [];
    writeAccounts([{
        platform: 'sub2api',
        name: 'SUPER·NB',
        base_url: 'https://super-nb.me',
        sub2api_email: 'u@x.com',
        sub2api_password: 'good-pass'
    }]);
    var result = await api._fetchSub2apiUsage(readAccounts()[0], 0);
    assert.equal(result.success, true);
    assert.equal(result.data.stats.today_tokens, 1234567);
    assert.equal(result.data.stats.today_cost, 3.25);
    // 切回无 stats 接口(旧版部署):软失败,stats 为 null,主数据正常
    withStats = false;
    callLog = [];
    result = await api._fetchSub2apiUsage(readAccounts()[0], 0);
    assert.equal(result.success, true);
    assert.equal(result.data.stats, null);
    assert.equal(result.data.me.balance, 12.34);
});

test('legacy huoli account falls back to huolilink base and creds', async function() {
    mode = 'ok';
    callLog = [];
    writeAccounts([{
        platform: 'huoli',
        name: '火狸旧账号',
        huoli_email: 'h@x.com',
        huoli_password: 'good-pass'
    }]);

    var result = await api._fetchSub2apiUsage(readAccounts()[0], 0);
    assert.equal(result.success, true);
    assert.equal(result.baseUrl, 'https://huolilink.com');
    assert.equal(result.platform, 'huoli'); // 旧账号平台标识保留
    assert.ok(callLog.every(function(c) { return c.url.indexOf('huolilink.com') === 0 || c.url.indexOf('https://huolilink.com') === 0; }));
});

test('expired subscription older than 3 days is hidden (current=null)', async function() {
    mode = 'ok'; withStats = true; subMode = 'only-old';
    writeAccounts([{ platform: 'sub2api', name: 't', base_url: 'https://super-nb.me', sub2api_email: 'u@x.com', sub2api_password: 'good-pass' }]);
    var result = await api._fetchSub2apiUsage(readAccounts()[0], 0);
    assert.equal(result.success, true);
    assert.equal(result.data.current, null);           // 旧过期卡不再作为当前订阅
    assert.equal(result.data.subscriptions.length, 1); // 原始列表仍保留
    assert.equal(result.data.me.balance, 12.34);       // 余额照常
});

test('subscription expired within 3 days is still shown as current', async function() {
    mode = 'ok'; withStats = false; subMode = 'recent';
    writeAccounts([{ platform: 'sub2api', name: 't', base_url: 'https://super-nb.me', sub2api_email: 'u@x.com', sub2api_password: 'good-pass' }]);
    var result = await api._fetchSub2apiUsage(readAccounts()[0], 0);
    assert.equal(result.success, true);
    assert.equal(result.data.current.group.name, '刚过期卡');
});

test.after(function() {
    https.request = originalRequest;
    https.get = originalGet;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
});

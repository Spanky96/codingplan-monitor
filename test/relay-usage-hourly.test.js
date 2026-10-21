'use strict';

/* /api/relay/usage-hourly 代理路由:
 * - 管理密码鉴权(401)
 * - 透传中转站 /api/user-usage-hourly-snapshot(带 RELAY_SNAPSHOT_TOKEN 门禁参数)
 * - 统一信封 {code:0,data:{rows}} 解包,异常形状 502
 * - 60s 内存缓存:窗口内复用,force=1 旁路
 * httpGetJSON 在 routes/relay 加载前替换为桩(解构捕获的是桩引用)。 */

var test = require('node:test');
var assert = require('node:assert/strict');
var fs = require('node:fs');
var os = require('node:os');
var path = require('node:path');

var fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glm-usage-hourly-'));

process.env.SUB2API_BASE_URL = 'http://sub2api.example:8090';
process.env.RELAY_SNAPSHOT_TOKEN = 'tok123';
process.env.CREDENTIALS_EXPORT = '';
process.env.ACCOUNTS_FILE = path.join(fixtureDir, 'accounts.json');
process.env.USAGE_CACHE_FILE = path.join(fixtureDir, 'usage-cache.json');
process.env.ADMIN_PASSWORD = 'test-password';

var upstreamCalls = [];
var nextEnvelope = null;

var httpLib = require('../src/lib/http');
httpLib.httpGetJSON = function (url, timeout) {
    upstreamCalls.push({ url: url, timeout: timeout });
    if (nextEnvelope instanceof Error) return Promise.reject(nextEnvelope);
    return Promise.resolve(nextEnvelope);
};

var registerRelay = require('../src/api/routes/relay');

var PASSWORD = 'test-password';

function mockRes() {
    var r = { statusCode: 200, body: null, ended: false };
    r.status = function (c) { r.statusCode = c; return r; };
    r.json = function (b) { r.body = b; r.ended = true; return r; };
    return r;
}

function makeApp() {
    var app = {};
    app.get = function (route, handler) { app['GET ' + route] = handler; };
    registerRelay(app);
    return app;
}

function callRoute(app, route, query) {
    var res = mockRes();
    var req = { query: query || {} };
    app[route](req, res);
    return new Promise(function (resolve) {
        var wait = function () { res.ended ? resolve(res) : setTimeout(wait, 5); };
        wait();
    });
}

test('registers hourly proxy route when relay enabled', function () {
    var app = makeApp();
    assert.ok(app['GET /api/relay/usage-hourly'], 'hourly route should register');
});

test('hourly route rejects wrong password with 401', function () {
    var app = makeApp();
    return callRoute(app, 'GET /api/relay/usage-hourly', { password: 'wrong' }).then(function (res) {
        assert.equal(res.statusCode, 401);
        assert.deepEqual(res.body, { error: 'unauthorized' });
        assert.equal(upstreamCalls.length, 0);
    });
});

test('hourly route proxies snapshot endpoint with token gate and unwraps envelope', function () {
    var app = makeApp();
    nextEnvelope = { code: 0, message: 'ok', data: { generated_at: '2026-10-21T10:00:00+08:00', day_start: '2026-10-21T00:00:00+08:00', rows: [{ hour: 9, user_id: 1, model: 'glm-5.3', requests: 2, total_tokens: 200 }] } };

    return callRoute(app, 'GET /api/relay/usage-hourly', { password: PASSWORD }).then(function (res) {
        assert.equal(res.statusCode, 200);
        assert.equal(upstreamCalls.length, 1);
        assert.equal(upstreamCalls[0].url, 'http://sub2api.example:8090/api/user-usage-hourly-snapshot?token=tok123');
        assert.ok(Array.isArray(res.body.rows), 'unwrapped data passthrough');
        assert.equal(res.body.rows[0].model, 'glm-5.3');
    });
});

test('hourly route reuses cached snapshot within 60s and force=1 bypasses', function () {
    var app = makeApp();
    nextEnvelope = { code: 0, data: { rows: [] } };
    // 缓存闭包在每次 registerRelay(app) 时新建,计数按本用例相对增量断言
    var before = upstreamCalls.length;

    return callRoute(app, 'GET /api/relay/usage-hourly', { password: PASSWORD }).then(function (res) {
        assert.equal(res.statusCode, 200);
        assert.equal(upstreamCalls.length, before + 1);

        return callRoute(app, 'GET /api/relay/usage-hourly', { password: PASSWORD });
    }).then(function (res) {
        assert.equal(res.statusCode, 200);
        assert.equal(upstreamCalls.length, before + 1, 'cache hit: no extra upstream call');

        return callRoute(app, 'GET /api/relay/usage-hourly', { password: PASSWORD, force: '1' });
    }).then(function (res) {
        assert.equal(res.statusCode, 200);
        assert.equal(upstreamCalls.length, before + 2, 'force=1 bypasses cache');
    });
});

test('hourly route returns 502 on unexpected snapshot shape', function () {
    var app = makeApp();
    nextEnvelope = { code: 0, data: { generated_at: 'x' } };   // 缺 rows 数组

    return callRoute(app, 'GET /api/relay/usage-hourly', { password: PASSWORD, force: '1' }).then(function (res) {
        assert.equal(res.statusCode, 502);
        assert.equal(res.body.error, 'unexpected relay hourly snapshot shape');
    });
});

test('hourly route returns 502 on upstream fetch failure', function () {
    var app = makeApp();
    nextEnvelope = new Error('connection refused');

    return callRoute(app, 'GET /api/relay/usage-hourly', { password: PASSWORD, force: '1' }).then(function (res) {
        assert.equal(res.statusCode, 502);
        assert.match(res.body.error, /relay hourly snapshot fetch failed: connection refused/);
    });
});

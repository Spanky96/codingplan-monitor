'use strict';

/* 隐私模式(full 档:全隐私):内外网访客一律强制,管理员(头/query 密码)豁免。
 * split 档的行为见 privacy-mode.test.js(node --test 每文件独立进程,可各自设 env)。 */

var test = require('node:test');
var assert = require('node:assert/strict');
var fs = require('node:fs');
var os = require('node:os');
var path = require('node:path');

var fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glm-usage-privacy-full-'));

process.env.SUB2API_BASE_URL = '';
process.env.MODELS_GATEWAY_URL = '';
process.env.CREDENTIALS_EXPORT = '';
process.env.PRIVACY_MODE = 'full';
process.env.PRIVACY_EXTERNAL_HOSTS = '';
process.env.ACCOUNTS_FILE = path.join(fixtureDir, 'accounts.json');
process.env.USAGE_CACHE_FILE = path.join(fixtureDir, 'usage-cache.json');
process.env.ADMIN_PASSWORD = 'test-password';

var FIXTURE_ACCOUNTS = [
    { platform: 'glm', name: 'glm1-张三', responsiblePerson: '张三', phone: '13800000001', isPublic: true },
    { platform: 'glm', name: 'glm2-王五', responsiblePerson: '王五', phone: '13800000002' }
];
fs.writeFileSync(process.env.ACCOUNTS_FILE, JSON.stringify({ accounts: FIXTURE_ACCOUNTS }, null, 2));

var registerApi = require('../src/api');
var config = require('../src/config');
var cache = require('../src/api/cache');

function captureRoutes() {
    var routes = {};
    var app = {};
    ['get', 'post', 'put', 'delete'].forEach(function(method) {
        app[method] = function(route) {
            routes[method + ' ' + route] = Array.prototype.slice.call(arguments, 1);
        };
    });
    registerApi(app);
    return routes;
}

function mockRes() {
    var r = { statusCode: 200, body: null, ended: false, headers: {} };
    r.status = function(c) { r.statusCode = c; return r; };
    r.set = function(k, v) { r.headers[k] = v; return r; };
    r.json = function(b) { r.body = b; r.ended = true; return r; };
    return r;
}

function internalReq(extra) {
    return Object.assign({ headers: {}, query: {}, socket: { remoteAddress: '192.168.0.50' } }, extra || {});
}
var ADMIN_HEADER = { 'x-auth-password': 'test-password' };

test('full mode forces privacy for internal guests too; admins exempt', async function() {
    assert.equal(config.privacyMode, 'full');
    assert.equal(registerApi._forcedPrivacy(internalReq()), true, '内网游客也强制(full 档)');

    var routes = captureRoutes();
    FIXTURE_ACCOUNTS.forEach(function(account, i) {
        cache.setCache(i, {
            index: i, name: account.name, platform: 'glm', responsiblePerson: account.responsiblePerson,
            phone: account.phone, data: { limits: [] }, success: true, cachedAt: Date.now()
        });
    });

    var res = mockRes();
    await routes['get /api/usage'][0](internalReq(), res);
    assert.deepEqual(res.body.map(function(r) { return r.name; }), ['智谱1', '智谱2']);
    assert.equal('responsiblePerson' in res.body[0], false);

    var wres = mockRes();
    await routes['get /api/weights'][0](internalReq(), wres);
    assert.deepEqual(Object.keys(wres.body).sort(), ['智谱1', '智谱2'], 'full 档 weights 别名 key');

    var ares = mockRes();
    await routes['get /api/usage'][0](internalReq({ headers: ADMIN_HEADER }), ares);
    assert.equal(ares.body[0].name, 'glm1-张三', '管理员豁免');
    assert.equal(ares.body[0].responsiblePerson, '张三');

    var pwres = mockRes();
    await routes['get /api/weights'][0](internalReq({ query: { password: 'test-password' } }), pwres);
    assert.ok(Object.keys(pwres.body).indexOf('glm1-张三') >= 0, '带密码请求(中转站)拿真实账号名');

    var fres = mockRes();
    await routes['get /api/features'][0](internalReq(), fres);
    assert.equal(fres.body.privacyForced, true);
});

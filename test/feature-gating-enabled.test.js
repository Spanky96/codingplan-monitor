'use strict';

/* 配置企业集成 env 后的功能启用行为:
 * - SUB2API_BASE_URL 配置 → relayEnabled,网关地址去尾部斜杠
 * - CREDENTIALS_EXPORT=1 → /api/credentials 路由注册
 * - /api/features 如实上报启用状态与 models 网关地址 */

var test = require('node:test');
var assert = require('node:assert/strict');
var fs = require('node:fs');
var os = require('node:os');
var path = require('node:path');

var fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glm-usage-gating-on-'));

process.env.SUB2API_BASE_URL = 'http://sub2api.example:8090/';
process.env.MODELS_GATEWAY_URL = 'https://gw.example/v1';
process.env.CREDENTIALS_EXPORT = '1';
process.env.PRIVACY_MODE = '';
process.env.PRIVACY_EXTERNAL_HOSTS = '';
process.env.ACCOUNTS_FILE = path.join(fixtureDir, 'accounts.json');
process.env.USAGE_CACHE_FILE = path.join(fixtureDir, 'usage-cache.json');
process.env.ADMIN_PASSWORD = 'test-password';

var registerApi = require('../src/api');
var config = require('../src/config');

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
    var r = { statusCode: 200, body: null, ended: false };
    r.status = function(c) { r.statusCode = c; return r; };
    r.set = function() { return r; };   // headers(no-store 等)
    r.json = function(b) { r.body = b; r.ended = true; return r; };
    return r;
}

test('relay integration is enabled with SUB2API_BASE_URL (trailing slash trimmed)', function() {
    assert.equal(config.relayEnabled, true);
    assert.equal(config.sub2apiBaseUrl, 'http://sub2api.example:8090');
});

test('credentials export route registers when CREDENTIALS_EXPORT is set', function() {
    var routes = captureRoutes();
    assert.ok(routes['get /api/credentials'], 'credentials 路由应已注册');
});

test('features endpoint reports enabled state and gateway url', function() {
    var routes = captureRoutes();
    var handler = routes['get /api/features'][0];
    var res = mockRes();
    handler({}, res);
    assert.deepEqual(res.body, { relayEnabled: true, modelsGatewayUrl: 'https://gw.example/v1', privacyForced: false });
});

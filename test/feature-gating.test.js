'use strict';

/* 未配置任何企业集成 env 时的 gating 行为:
 * - /api/credentials 路由不注册(默认关闭)
 * - /api/relay/*、/api/sub2api/capacity 返回 404 明确错误
 * - /api/features 如实上报未启用状态
 * 注意:显式设为空字符串而非 delete——若删除,config.js 里的 dotenv 会从
 * 仓库根 .env(开发者本地可能配了真实值)补回来,破坏测试隔离。 */

var test = require('node:test');
var assert = require('node:assert/strict');
var fs = require('node:fs');
var os = require('node:os');
var path = require('node:path');

var fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glm-usage-gating-'));

process.env.SUB2API_BASE_URL = '';
process.env.RELAY_SNAPSHOT_TOKEN = '';
process.env.MODELS_GATEWAY_URL = '';
process.env.CREDENTIALS_EXPORT = '';
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

test('relay integration is disabled without SUB2API_BASE_URL', function() {
    assert.equal(config.relayEnabled, false);
    assert.equal(config.sub2apiBaseUrl, '');
});

test('credentials export route is not registered by default', function() {
    var routes = captureRoutes();
    assert.equal(routes['get /api/credentials'], undefined);
});

test('relay proxy routes return 404 when relay is not configured', function() {
    var routes = captureRoutes();
    ['/api/sub2api/capacity', '/api/relay/activity', '/api/relay/usage'].forEach(function(route) {
        var handler = routes['get ' + route][0];
        var res = mockRes();
        handler({ query: { password: 'test-password' } }, res);
        assert.equal(res.statusCode, 404, route + ' 应返回 404');
        assert.ok(res.body && /SUB2API_BASE_URL/.test(res.body.error), route + ' 错误信息应指明未配置');
    });
});

test('features endpoint reports disabled state', function() {
    var routes = captureRoutes();
    var handler = routes['get /api/features'][0];
    var res = mockRes();
    handler({}, res);
    assert.deepEqual(res.body, { relayEnabled: false, modelsGatewayUrl: '', privacyForced: false });
});

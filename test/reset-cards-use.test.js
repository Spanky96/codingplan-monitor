'use strict';

// use 路由集成测试:官方 use 接口已要求请求体携带 grantType(缺失时报
// 「指定的重置次数不可用,请刷新后重试」)。后端须以最新列表中该卡的
// grantType 为准透传,不信任前端传值。

var test = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var os = require('os');
var path = require('path');
var https = require('https');

var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reset-cards-use-'));
var accountsFile = path.join(tmpDir, 'accounts.json');
var cacheFile = path.join(tmpDir, 'usage-cache.json');

process.env.ACCOUNTS_FILE = accountsFile;
process.env.USAGE_CACHE_FILE = cacheFile;
process.env.ADMIN_PASSWORD = 'test-pwd';

fs.writeFileSync(accountsFile, JSON.stringify({ accounts: [{
    platform: 'glm',
    name: '测试账号',
    authorization: 'TOK',
    organization: 'org-1',
    project: 'proj-1'
}] }));
fs.writeFileSync(cacheFile, '{}');

// 官方最新列表:一张 GLOBAL 老卡(小 recordId)+ 一张 DIRECT 新卡(大 recordId)
var OFFICIAL_LIST = {
    code: 200,
    success: true,
    data: {
        targetType: 'PERSONAL',
        fiveHourResets: [],
        weekResets: [
            { recordId: 9, grantType: 'GLOBAL', expireTime: '2026-12-22 23:59:59', available: true },
            { recordId: 2165677, grantType: 'DIRECT', expireTime: '2026-11-22 10:24:28', available: true }
        ]
    }
};

var useCalls = [];

function respond(body) {
    var listeners = { data: [], end: [] };
    var res = {
        statusCode: 200,
        on: function(ev, cb) {
            if (ev === 'data') listeners.data.push(cb);
            if (ev === 'end') listeners.end.push(cb);
            return res;
        }
    };
    process.nextTick(function() {
        var chunk = JSON.stringify(body);
        listeners.data.forEach(function(cb) { cb(chunk); });
        listeners.end.forEach(function(cb) { cb(); });
    });
    return res;
}

function fakeRequest(opts, cb) {
    var method = (opts.method || 'GET').toUpperCase();
    var host = opts.hostname || opts.host || '';
    var pathName = opts.path || '/';
    var written = '';
    var req = {
        on: function() { return req; },
        write: function(chunk) { written += chunk; },
        end: function() {
            if (pathName.indexOf('/customer-package-reset/list') >= 0) {
                return cb(respond(OFFICIAL_LIST));
            }
            if (pathName.indexOf('/customer-package-reset/use') >= 0) {
                var body = {};
                try { body = JSON.parse(written || '{}'); } catch (e) { body = {}; }
                useCalls.push({ url: 'https://' + host + pathName, body: body });
                return cb(respond({ code: 200, success: true, msg: '操作成功', data: true }));
            }
            return cb(respond({ code: 404, msg: 'not found' }));
        }
    };
    return req;
}

var originalRequest = https.request;
var originalGet = https.get;
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
var express = require('express');
var api = require('../src/api');
var app = express();
api(app);
var server = app.listen(0);
var base = 'http://127.0.0.1:' + server.address().port;

function postUse(payload) {
    return fetch(base + '/api/reset-cards/0/use', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-auth-password': 'test-pwd' },
        body: JSON.stringify(payload)
    }).then(function(r) { return r.json().then(function(j) { return { status: r.status, json: j }; }); });
}

test('use DIRECT card forwards grantType from freshest official list', async function() {
    useCalls = [];
    var r = await postUse({ type: 'week', recordId: 2165677 });
    assert.equal(r.status, 200);
    assert.equal(r.json.success, true);
    assert.equal(useCalls.length, 1);
    assert.equal(useCalls[0].body.grantType, 'DIRECT');
    assert.equal(useCalls[0].body.targetType, 'PERSONAL');
    assert.equal(useCalls[0].body.resetType, 'WEEK');
    assert.equal(useCalls[0].body.recordId, 2165677);
});

test('use GLOBAL card forwards grantType from freshest official list', async function() {
    useCalls = [];
    var r = await postUse({ type: 'week', recordId: 9 });
    assert.equal(r.status, 200);
    assert.equal(r.json.success, true);
    assert.equal(useCalls.length, 1);
    assert.equal(useCalls[0].body.grantType, 'GLOBAL');
});

test('card missing from freshest list still rejected with 409', async function() {
    useCalls = [];
    var r = await postUse({ type: 'week', recordId: 424242 });
    assert.equal(r.status, 409);
    assert.match(r.json.error, /已使用、已过期或不存在/);
    assert.equal(useCalls.length, 0);
});

test.after(function() {
    https.request = originalRequest;
    https.get = originalGet;
    server.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
});

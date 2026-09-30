'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var os = require('os');
var path = require('path');

var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'console-url-'));
process.env.ACCOUNTS_FILE = path.join(tmpDir, 'accounts.json');
process.env.USAGE_CACHE_FILE = path.join(tmpDir, 'usage-cache.json');
process.env.ADMIN_PASSWORD = 'test-pwd';
fs.writeFileSync(process.env.ACCOUNTS_FILE, JSON.stringify({ accounts: [] }));
fs.writeFileSync(process.env.USAGE_CACHE_FILE, '{}');

var api = require('../src/api');
var buildConsoleUrl = api._buildConsoleUrl;

test('glm console url appends token from authorization', function() {
    var built = buildConsoleUrl('glm', { authorization: 'jwt-abc/123+=' });
    assert.equal(built.url, 'https://bigmodel.cn/coding-plan?token=jwt-abc%2F123%2B%3D');
    assert.equal(built.hasToken, true);
    assert.equal(built.platform, 'glm');
});

test('minimax console url carries base64url encoded cookie', function() {
    var cookie = 'minimax_group_id_v2=2082871950555750610; sess_token=abc/123+中=; acw_tc=xyz';
    var built = buildConsoleUrl('minimax', { cookie: cookie });
    assert.ok(built.url.indexOf('https://platform.minimax.cn/console/plan?ck=') === 0);
    // base64url 字母表不含 + / =,无需再 encodeURIComponent,可无损反解回原 cookie
    var ck = built.url.split('?ck=')[1];
    assert.equal(Buffer.from(ck, 'base64url').toString('utf8'), cookie);
    assert.equal(built.hasToken, true);
    assert.equal(built.platform, 'minimax');
});

test('console url degrades to plain url when credential missing', function() {
    var glm = buildConsoleUrl('glm', {});
    assert.equal(glm.url, 'https://bigmodel.cn/coding-plan');
    assert.equal(glm.hasToken, false);

    var minimax = buildConsoleUrl('minimax', { cookie: '' });
    assert.equal(minimax.url, 'https://platform.minimax.cn/console/plan');
    assert.equal(minimax.hasToken, false);
});

test('console url returns null for unregistered platform', function() {
    assert.equal(buildConsoleUrl('unknown', {}), null);
    // 原型链成员名不得当作平台命中(否则产出垃圾 URL / 抛错,应走未登记分支)
    assert.equal(buildConsoleUrl('constructor', {}), null);
    assert.equal(buildConsoleUrl('__proto__', {}), null);
    assert.equal(buildConsoleUrl('toString', {}), null);
});

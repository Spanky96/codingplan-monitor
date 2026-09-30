'use strict';

/* 隐私模式(split 档:内网无隐私/外网隐私):
 * - 内外网判定(Host 白名单短路 + 客户端 IP 兜底)
 * - forcedPrivacy 矩阵(游客/管理员头/管理员 query 密码 × 内/外网)
 * - /api/usage 列表与单卡:账号名→别名,负责人/电话/备注与平台身份字段删除,缓存对象不被修改
 * - /api/weights:key 换别名(与 usage 同一别名表)
 * - /api/features:privacyForced 上报 + no-store
 * 注意:显式设 PRIVACY_* 而非留空——若删除,config.js 的 dotenv 会从仓库根 .env
 * (本地配了真实 split)补回来,破坏测试隔离;full 档行为见 privacy-full-mode.test.js。 */

var test = require('node:test');
var assert = require('node:assert/strict');
var fs = require('node:fs');
var os = require('node:os');
var path = require('node:path');

var fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glm-usage-privacy-'));

process.env.SUB2API_BASE_URL = '';
process.env.MODELS_GATEWAY_URL = '';
process.env.CREDENTIALS_EXPORT = '';
process.env.PRIVACY_MODE = 'split';
process.env.PRIVACY_EXTERNAL_HOSTS = 'lwai.05info.com';
process.env.ACCOUNTS_FILE = path.join(fixtureDir, 'accounts.json');
process.env.USAGE_CACHE_FILE = path.join(fixtureDir, 'usage-cache.json');
process.env.ADMIN_PASSWORD = 'test-password';

// 覆盖矩阵的账号:两个公开 glm(中间夹一个私有 glm,验证别名跳号)、yescode、sub2api、stepfun
var FIXTURE_ACCOUNTS = [
    { platform: 'glm', name: 'glm1-张三', responsiblePerson: '张三', phone: '13800000001', notes: 'n1', isPublic: true },
    { platform: 'glm', name: 'glm2-私有', responsiblePerson: '李四', phone: '13800000002', notes: 'n2', isPublic: false },
    { platform: 'glm', name: 'glm3-王五', responsiblePerson: '王五', phone: '13800000003', notes: 'n3' },
    { platform: 'yescode', name: 'yc-张三', responsiblePerson: '张三', phone: '13800000004', notes: 'n4', isPublic: true },
    { platform: 'sub2api', name: 's2a-张三', responsiblePerson: '张三', phone: '13800000005', notes: 'n5', isPublic: true },
    { platform: 'stepfun', name: 'sf-张三', responsiblePerson: '张三', phone: '13800000006', notes: 'n6', isPublic: true }
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

// 内网请求(socket 直连私网地址,无反代头)
function internalReq(extra) {
    return Object.assign({ headers: {}, query: {}, socket: { remoteAddress: '192.168.0.50' } }, extra || {});
}
// 外网请求(命中 PRIVACY_EXTERNAL_HOSTS 的 Host)
function externalReq(extra) {
    return Object.assign({ headers: { host: 'lwai.05info.com:8887' }, query: {}, socket: { remoteAddress: '192.168.0.50' } }, extra || {});
}
var ADMIN_HEADER = { 'x-auth-password': 'test-password' };

// ============ 单元:配置与判定 ============

test('privacy config normalizes mode and external hosts', function() {
    assert.equal(config.privacyMode, 'split');
    assert.deepEqual(config.privacyExternalHosts, ['lwai.05info.com']);
});

test('isPrivateIp covers RFC1918 / loopback / link-local / IPv6', function() {
    var isPrivateIp = registerApi._isPrivateIp;
    ['10.1.2.3', '192.168.0.20', '172.16.0.1', '172.31.255.255', '127.0.0.1', '169.254.1.1',
     '::1', 'fe80::1', 'fc00::1', 'fd12::1', '::ffff:192.168.0.5'].forEach(function(ip) {
        assert.equal(isPrivateIp(ip), true, ip + ' 应为私网');
    });
    ['203.0.113.9', '8.8.8.8', '172.32.0.1', '192.169.0.1', '2001:db8::1', 'unknown', ''].forEach(function(ip) {
        assert.equal(isPrivateIp(ip), false, ip + ' 应为公网/未知');
    });
});

test('isExternalRequest: host whitelist short-circuits, address chain is spoof-resistant', function() {
    var isExternal = registerApi._isExternalRequest;
    // Host 命中 → 外网(即便来源 IP 是私网,如反代直连后端)
    assert.equal(isExternal(externalReq()), true);
    // 反代透传的外部域名(x-forwarded-host)同样命中
    assert.equal(isExternal(internalReq({ headers: { 'x-forwarded-host': 'LWAI.05INFO.com' } })), true);
    // Host 未命中 + 私网客户端 → 内网
    assert.equal(isExternal(internalReq({ headers: { host: '192.168.0.20:8886' } })), false);
    // Host 未命中 + XFF 公网(反代如实透传)→ 外网
    assert.equal(isExternal(internalReq({ headers: { host: '192.168.0.20:8886', 'x-forwarded-for': '203.0.113.9' } })), true);
    // Host 未命中 + XFF 私网(内网用户经内网反代)→ 内网
    assert.equal(isExternal(internalReq({ headers: { host: '192.168.0.20:8886', 'x-forwarded-for': '10.0.0.8' } })), false);
    // 伪造首段私网 + 追加式反代链含真实公网段 → 仍判外网(首段伪造无效)
    assert.equal(isExternal(internalReq({ headers: { host: '192.168.0.20:8886', 'x-forwarded-for': '10.0.0.1, 203.0.113.9' } })), true);
    // socket 对端已是公网(NAT 直连)→ 无视伪造的私网 XFF,判外网
    assert.equal(isExternal({ headers: { host: '192.168.0.20:8886', 'x-forwarded-for': '10.0.0.1' }, query: {}, socket: { remoteAddress: '203.0.113.9' } }), true);
    // 全私网 XFF 链(内网多级反代)→ 内网
    assert.equal(isExternal(internalReq({ headers: { host: '192.168.0.20:8886', 'x-forwarded-for': '10.0.0.1, 192.168.1.2' } })), false);
});

test('forcedPrivacy matrix under split mode', function() {
    var forced = registerApi._forcedPrivacy;
    assert.equal(forced(internalReq()), false, '内网游客不强制');
    assert.equal(forced(externalReq()), true, '外网游客强制');
    assert.equal(forced(externalReq({ headers: ADMIN_HEADER })), false, '外网管理员(头)不强制');
    assert.equal(forced(externalReq({ query: { password: 'test-password' } })), false, '外网管理员(query 密码,中转站)不强制');
    assert.equal(forced(externalReq({ query: { password: 'wrong' } })), true, '错误密码仍按游客强制');
});

// ============ 单元:别名与脱敏 ============

test('buildAliasMap skips private accounts and numbers per platform', function() {
    var aliasMap = registerApi._buildAliasMap(FIXTURE_ACCOUNTS);
    assert.equal(aliasMap[0], '智谱1');
    assert.equal(aliasMap[1], undefined, '私有账号不参与编号');
    assert.equal(aliasMap[2], '智谱2', '私有账号不占序号');
    assert.equal(aliasMap[3], 'YesCode1');
    assert.equal(aliasMap[4], 'Sub2API1');
    assert.equal(aliasMap[5], '阶跃星辰1');
});

test('maskUsageResult replaces name, strips owner fields and platform identity, never mutates source', function() {
    var maskUsageResult = registerApi._maskUsageResult;
    var glmSource = { index: 0, name: 'glm1-张三', platform: 'glm', responsiblePerson: '张三', phone: '13800000001', notes: 'n1', data: { limits: [] }, success: true };
    var glmSnapshot = JSON.parse(JSON.stringify(glmSource));
    var glmMasked = maskUsageResult(glmSource, '智谱1');
    assert.equal(glmMasked.name, '智谱1');
    assert.equal('responsiblePerson' in glmMasked, false);
    assert.equal('phone' in glmMasked, false);
    assert.equal('notes' in glmMasked, false);
    assert.equal(glmMasked.data, glmSource.data, '未涉及平台的 data 保持原引用');
    assert.deepEqual(glmSource, glmSnapshot, '源对象(缓存本体)未被修改');

    var ycSource = { index: 3, name: 'yc-张三', platform: 'yescode', responsiblePerson: '张三', phone: 'p', notes: 'n', data: { username: 'real@mail.com', email: 'real@mail.com', balance: 5 }, success: true };
    var ycMasked = maskUsageResult(ycSource, 'YesCode1');
    assert.equal(ycMasked.data.username, undefined);
    assert.equal(ycMasked.data.email, undefined);
    assert.equal(ycMasked.data.balance, 5);
    assert.equal(ycSource.data.username, 'real@mail.com', '源 data 未被修改');

    var s2aSource = { index: 4, name: 's2a-张三', platform: 'sub2api', data: { me: { email: 'a@b.c', username: 'ab', balance: 9 } }, success: true };
    var s2aMasked = maskUsageResult(s2aSource, 'Sub2API1');
    assert.equal(s2aMasked.data.me.email, undefined);
    assert.equal(s2aMasked.data.me.username, undefined);
    assert.equal(s2aMasked.data.me.balance, 9);
    assert.equal(s2aSource.data.me.email, 'a@b.c');

    var sfSource = { index: 5, name: 'sf-张三', platform: 'stepfun', data: { user: { nickname: 'n', mobileMasked: '138****0000', uid: 7 }, campaign: { invites: [{ nickname: 'x' }], inviteCode: 'ABC' } }, success: true };
    var sfMasked = maskUsageResult(sfSource, '阶跃星辰1');
    assert.equal(sfMasked.data.user.nickname, undefined);
    assert.equal(sfMasked.data.user.uid, undefined);
    assert.equal(sfMasked.data.campaign.invites, undefined, '好友邀请记录(第三方 PII)删除');
    assert.equal(sfMasked.data.campaign.inviteCode, 'ABC');
    assert.equal(sfSource.data.campaign.invites.length, 1, '源 invites 未被修改');
});

// ============ 路由级:/api/usage ============

function primeCache() {
    FIXTURE_ACCOUNTS.forEach(function(account, i) {
        cache.setCache(i, {
            index: i, name: account.name, platform: account.platform || 'glm',
            responsiblePerson: account.responsiblePerson, phone: account.phone, notes: account.notes,
            data: i === 3 ? { username: 'real@mail.com', email: 'real@mail.com', balance: 5 }
                : { limits: [{ type: 'CREDIT_LIMIT', unit: 6, used: 1, percentage: 10 }] },
            success: true, cachedAt: Date.now()
        });
    });
}

test('GET /api/usage: external guest gets aliases and no owner fields (cache untouched)', async function() {
    primeCache();
    // 内存缓存快照(路由真正读取的对象):脱敏不得污染缓存本体
    var snapshot = FIXTURE_ACCOUNTS.map(function(_, i) { return JSON.parse(JSON.stringify(cache.getCachedLastKnown(i))); });
    var routes = captureRoutes();
    var res = mockRes();
    await routes['get /api/usage'][0](externalReq(), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.length, 5, '私有账号对游客隐藏');
    // 别名:两个公开 glm → 智谱1/智谱2(私有 glm 不占号),其余平台各自 1 号
    assert.deepEqual(res.body.map(function(r) { return r.name; }), ['智谱1', '智谱2', 'YesCode1', 'Sub2API1', '阶跃星辰1']);
    res.body.forEach(function(r) {
        assert.equal('responsiblePerson' in r, false);
        assert.equal('phone' in r, false);
        assert.equal('notes' in r, false);
    });
    assert.equal(res.body[2].data.username, undefined, 'yescode 身份字段删除');
    assert.equal(res.body[2].data.balance, 5);
    // 缓存本体未被脱敏污染
    FIXTURE_ACCOUNTS.forEach(function(_, i) {
        assert.deepEqual(cache.getCachedLastKnown(i), snapshot[i], '缓存第 ' + i + ' 项未被修改');
    });
});

test('GET /api/usage: internal guest and external admin keep real names', async function() {
    primeCache();
    var routes = captureRoutes();
    var res = mockRes();
    await routes['get /api/usage'][0](internalReq(), res);
    assert.equal(res.body[0].name, 'glm1-张三', '内网游客维持原状');
    assert.equal(res.body[0].responsiblePerson, '张三');

    var res2 = mockRes();
    await routes['get /api/usage'][0](externalReq({ headers: ADMIN_HEADER }), res2);
    assert.equal(res2.body[0].name, 'glm1-张三', '外网管理员豁免');
    assert.equal(res2.body[0].responsiblePerson, '张三');
});

test('GET /api/usage/:index: single account masked for external guest', async function() {
    primeCache();
    var routes = captureRoutes();
    var res = mockRes();
    await routes['get /api/usage/:index'][0](externalReq({ params: { index: '2' } }), res);
    assert.equal(res.body.name, '智谱2', '单卡别名与列表一致');
    assert.equal('responsiblePerson' in res.body, false);
});

// ============ 路由级:/api/weights 与 /api/features ============

test('GET /api/weights: external guest gets alias keys; password request keeps real names', async function() {
    primeCache();
    var routes = captureRoutes();
    var res = mockRes();
    await routes['get /api/weights'][0](externalReq(), res);
    var keys = Object.keys(res.body).sort();
    assert.deepEqual(keys, ['Sub2API1', 'YesCode1', '智谱1', '智谱2', '阶跃星辰1'], 'key 为别名且与 usage 别名一致');
    assert.equal(keys.indexOf('glm2-私有'), -1, '私有账号不下发');

    var res2 = mockRes();
    await routes['get /api/weights'][0](externalReq({ query: { password: 'test-password' } }), res2);
    assert.ok(Object.keys(res2.body).indexOf('glm1-张三') >= 0, '带密码(中转站)拿真实账号名');
    assert.ok(Object.keys(res2.body).indexOf('glm2-私有') >= 0, '带密码可见私有账号');
});

test('GET /api/features reports privacyForced with no-store', async function() {
    var routes = captureRoutes();
    var res = mockRes();
    await routes['get /api/features'][0](externalReq(), res);
    assert.equal(res.body.privacyForced, true);
    assert.equal(res.headers['Cache-Control'], 'no-store');

    var res2 = mockRes();
    await routes['get /api/features'][0](internalReq(), res2);
    assert.equal(res2.body.privacyForced, false);
});

test('usage/weights responses are no-store (content varies per requester)', async function() {
    primeCache();
    var routes = captureRoutes();
    var res = mockRes();
    await routes['get /api/usage'][0](externalReq(), res);
    assert.equal(res.headers['Cache-Control'], 'no-store');
    var res2 = mockRes();
    await routes['get /api/usage/:index'][0](externalReq({ params: { index: '0' } }), res2);
    assert.equal(res2.headers['Cache-Control'], 'no-store');
    var res3 = mockRes();
    await routes['get /api/weights'][0](externalReq(), res3);
    assert.equal(res3.headers['Cache-Control'], 'no-store');
});

test('wrong query password throttles the admin oracle (3 strikes ban)', function() {
    var forced = registerApi._forcedPrivacy;
    // 独立 IP,避免影响其他用例的封禁表状态
    var spoof = function(query) {
        return externalReq({ query: query, socket: { remoteAddress: '192.168.0.99' } });
    };
    assert.equal(forced(spoof({ password: 'wrong-1' })), true);
    assert.equal(forced(spoof({ password: 'wrong-2' })), true);
    assert.equal(forced(spoof({ password: 'wrong-3' })), true, '第三次错误触发封禁');
    // 封禁期内即使密码正确也按游客(阻断经 privacyForced 反射差异爆破管理密码)
    assert.equal(forced(spoof({ password: 'test-password' })), true, '封禁期内正确密码不生效');
});

'use strict';

// 覆盖:管理密码防爆破(3 次封 15 分钟) + 账号凭证加密存储(AES-256-GCM)

var test = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var os = require('os');
var path = require('path');

var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'authban-crypt-'));
process.env.ACCOUNTS_FILE = path.join(tmpDir, 'accounts.json');
process.env.USAGE_CACHE_FILE = path.join(tmpDir, 'usage-cache.json');
process.env.ADMIN_PASSWORD = 'test-pwd';
process.env.ACCOUNT_SECRET = 'test-secret-0123456789abcdef0123456789abcdef';
fs.writeFileSync(process.env.ACCOUNTS_FILE, JSON.stringify({ accounts: [] }));
fs.writeFileSync(process.env.USAGE_CACHE_FILE, '{}');

var api = require('../src/api');

// ============ 管理密码防爆破 ============

function fakeReq(ip, password) {
    return {
        headers: password === undefined ? {} : { 'x-auth-password': password },
        socket: { remoteAddress: ip },
        connection: { remoteAddress: ip }
    };
}

test('clientIp prefers x-forwarded-for first hop', function() {
    // 无任何来源时归为 unknown(封禁表仍以该 key 累计,不至于裸奔)
    assert.equal(api._clientIp(fakeReq(null)), 'unknown');
    assert.equal(api._clientIp({ headers: { 'x-forwarded-for': '1.2.3.4, 10.0.0.1' }, socket: { remoteAddress: '10.0.0.1' } }), '1.2.3.4');
    assert.equal(api._clientIp({ headers: {}, socket: { remoteAddress: '192.168.1.9' } }), '192.168.1.9');
});

test('auth ban: 连续 3 次失败后封 15 分钟,第 4 次(正确密码)也被拒', function() {
    var ip = '10.1.1.' + Math.floor(Math.random() * 250);
    var t0 = 1789900000000;

    var s1 = api._authBanRecordFailure(ip, t0);
    assert.equal(s1.banned, false);
    assert.equal(s1.fails, 1);
    var s2 = api._authBanRecordFailure(ip, t0 + 1000);
    assert.equal(s2.banned, false);
    assert.equal(s2.fails, 2);
    var s3 = api._authBanRecordFailure(ip, t0 + 2000);
    assert.equal(s3.banned, true, '第 3 次失败即封禁');
    assert.equal(s3.retryAfterSec, 900, '封禁 15 分钟 = 900 秒');

    // 封禁期间查询(时间推进 5 分钟)仍然 banned;封禁起点是第 3 次失败的时刻(t0+2000)
    var mid = api._authBanState(ip, t0 + 300000);
    assert.equal(mid.banned, true);
    assert.equal(mid.retryAfterSec, 602);

    // 封禁期间再失败不延长封禁(仍按原截止时间)
    var again = api._authBanRecordFailure(ip, t0 + 400000);
    assert.equal(again.banned, true);
    assert.equal(again.retryAfterSec, 502);

    // 到期后自动解禁,计数清零重新累计(截止时刻 = 第 3 次失败 t0+2000 + 15 分钟)
    var after = api._authBanState(ip, t0 + 902001);
    assert.equal(after.banned, false);
    assert.equal(after.fails, 0);
});

test('auth ban: 密码正确后 reset 清零失败计数', function() {
    var ip = '10.2.2.' + Math.floor(Math.random() * 250);
    var t0 = 1789900000000;
    api._authBanRecordFailure(ip, t0);
    api._authBanRecordFailure(ip, t0 + 1);
    assert.equal(api._authBanState(ip, t0 + 2).fails, 2);
    api._authBanReset(ip);
    assert.equal(api._authBanState(ip, t0 + 3).fails, 0);
    assert.equal(api._authBanState(ip, t0 + 3).banned, false);
});

// ============ 凭证加密存储 ============

test('encryptSecret produces enc:v1 ciphertext and round-trips', function() {
    var plain = 'super-secret-password-123';
    var enc = api._encryptSecret(plain);
    assert.notEqual(enc, plain);
    assert.ok(enc.indexOf('enc:v1:') === 0, '密文带 enc:v1 前缀');
    // 同一明文两次加密结果不同(随机 IV)
    assert.notEqual(api._encryptSecret(plain), enc);
    assert.equal(api._decryptSecretOrNull(enc), plain);
});

test('encryptSecret is idempotent for empty / already-encrypted values', function() {
    assert.equal(api._encryptSecret(''), '');
    var enc = api._encryptSecret('x');
    assert.equal(api._encryptSecret(enc), enc, '已加密值不重复加密');
});

test('decryptSecretOrNull returns null for plaintext or corrupt ciphertext', function() {
    assert.equal(api._decryptSecretOrNull('plain-password'), null);
    assert.equal(api._decryptSecretOrNull(''), null);
    assert.equal(api._decryptSecretOrNull(null), null);
    var enc = api._encryptSecret('abc');
    // 篡改数据段 → GCM 认证失败 → null(调用方按明文兜底)
    var parts = enc.split(':');
    parts[3] = Buffer.from('tampered').toString('base64url');
    assert.equal(api._decryptSecretOrNull(parts.join(':')), null);
});

test('encrypt/decrypt accounts only touch credential fields', function() {
    var accounts = [{
        platform: 'glm',
        name: '测试账号',
        responsiblePerson: '张三',
        phone: '13800000000',
        notes: '备注',
        authorization: 'jwt-token',
        glm_username: 'user@example.com',
        glm_password: 'p@ss',
        organization: 'org-1',
        keyCount: 3
    }];
    var encrypted = api._encryptAccounts(accounts);
    // 原对象不被修改(不可变)
    assert.equal(accounts[0].glm_password, 'p@ss');
    assert.equal(accounts[0].authorization, 'jwt-token');
    // 密文落盘字段
    assert.ok(encrypted[0].glm_password.indexOf('enc:v1:') === 0);
    assert.ok(encrypted[0].authorization.indexOf('enc:v1:') === 0);
    // 非凭证字段原样
    assert.equal(encrypted[0].name, '测试账号');
    assert.equal(encrypted[0].glm_username, 'user@example.com');
    assert.equal(encrypted[0].keyCount, 3);

    var decrypted = api._decryptAccounts(encrypted);
    assert.equal(decrypted[0].glm_password, 'p@ss');
    assert.equal(decrypted[0].authorization, 'jwt-token');
    assert.equal(decrypted[0].name, '测试账号');
});

test('decryptAccounts keeps legacy plaintext fields as-is', function() {
    var legacy = [{ platform: 'yescode', name: '旧账号', cookie: 'legacy-plain-cookie' }];
    var out = api._decryptAccounts(legacy);
    assert.equal(out[0].cookie, 'legacy-plain-cookie', '无 enc:v1 前缀视为历史明文');
});

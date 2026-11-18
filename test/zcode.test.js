'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-test-'));
process.env.ACCOUNTS_FILE = path.join(dir, 'accounts.json');
process.env.ADMIN_PASSWORD = 'test-admin';
process.env.ZCODE_BRIDGE_TOKEN = 'test-bridge';
const { createService } = require('../src/zcode/service');
const { parseProjectToken, decryptSigningKey } = require('../src/zcode/protocol');
const input = { accountName: 'pilot', apiKeyId: 'original-key', sessionId: 'test-session',
    upstreamUrl: 'https://open.bigmodel.cn/api/anthropic/v1/messages?beta=true' };

function fixture() {
    const pair = crypto.generateKeyPairSync('ed25519');
    const f = { now: 1800000000000, calls: [], accounts: [{ name: 'pilot', platform: 'glm',
        organization: 'org', project: 'project', authorization: 'login-secret', zcode: { enabled: true } }],
        keys: [{ name: 'original', apiKey: 'original-key' }, { name: 'zcode-api-key', apiKey: 'zcode-key' }] };
    function key(token, info) { return crypto.hkdfSync('sha256', token, 'WD_CLIENT_SIGN_KDF_SALT', info, 32); }
    f.fetch = async (url, init) => {
        f.calls.push({ url, init });
        if (f.error) throw new Error('do not leak login-secret');
        let data;
        if (url.endsWith('?keyType=1')) data = f.keys;
        else if (url.endsWith('/zcode-key/access_tokens')) {
            assert.equal(init.headers.authorization, 'Bearer login-secret');
            assert.deepEqual(JSON.parse(init.body), { clientType: 'zcode', clientVersion: '3.18.2' });
            const claims = { token_use: 'project_access', api_key: 'zcode-key', exp: f.now / 1000 + 18000 };
            f.token = 'header.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.signature';
            data = { enabled: true, accessToken: f.token, expiresIn: 18000 };
        } else if (url.endsWith('/c1f3a7e2/v2/client')) {
            const body = JSON.parse(init.body);
            assert.equal(body.accessToken, f.token);
            assert.equal(body.sig, crypto.createHmac('sha256', key(f.token, 'getSignKey_hmac'))
                .update('get_sign_key\nzcode-key\n' + body.ts + '\n' + body.nonce).digest('base64'));
            const iv = crypto.randomBytes(12);
            const aes = crypto.createCipheriv('aes-256-gcm', key(f.token, 'ed25519_priv'), iv);
            aes.setAAD(Buffer.from('zcode-key'));
            const der = pair.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
            data = { privateCipher: Buffer.concat([iv, aes.update(der), aes.final(), aes.getAuthTag()]).toString('base64') };
            if (f.beforeHandshakeReturn) f.beforeHandshakeReturn();
        } else assert.fail('Unexpected endpoint: ' + url);
        return { ok: true, status: 200, json: async () => ({ code: 200, data }) };
    };
    f.service = createService({ fetch: f.fetch, readAccounts: () => f.accounts,
        retryAuth: (account, _, fn) => fn(account), now: () => f.now, version: '3.18.2' });
    f.verify = result => {
        assert.equal(result.enabled, true);
        assert.equal(result.headers.Authorization, 'Bearer ' + f.token);
        const h = result.headers;
        assert.ok(crypto.verify(null, Buffer.from(['zcode-key', h['X-Client-Ts'], '3.18.2', input.sessionId, h['X-Client-Nonce']].join('\n')),
            pair.publicKey, Buffer.from(h['X-Client-Sig'], 'base64')));
        const challenge = crypto.createHash('sha256').update(['zcode-key', 'zcode', input.sessionId, h['X-Client-Ts']].join('\n')).digest('hex').slice(0, 32);
        assert.equal(crypto.createHash('sha256').update(challenge + '\n' + h['X-Client-Pow']).digest()[0], 0);
    };
    return f;
}

test('paid project token, independently verified signing and POW; one concurrent refresh', async () => {
    const f = fixture();
    const results = await Promise.all(Array.from({ length: 8 }, () => f.service.authorize(input)));
    assert.equal(f.calls.length, 3);
    results.forEach(f.verify);
    assert.equal(new Set(results.map(r => r.headers['X-Client-Nonce'])).size, 8);
    const status = f.service.status(f.accounts[0]);
    assert.equal(status.signedRequests, 8);
    assert.equal(status.benefitVerified, false);
    assert.ok(!JSON.stringify(status).includes(f.token));
    f.now += 17900 * 1000;
    f.verify(await f.service.authorize(input));
    assert.equal(f.calls.length, 6);
});

test('explicit disable uses original channel without upstream access', async () => {
    const f = fixture();
    f.accounts[0].zcode.enabled = false;
    assert.deepEqual(await f.service.authorize(input), { enabled: false });
    assert.equal(f.calls.length, 0);
});

test('restricts upstream and matches original API key to account', async () => {
    const f = fixture();
    for (const upstreamUrl of ['https://evil.example/api/anthropic/v1/messages', 'http://open.bigmodel.cn/api/anthropic/v1/messages',
        'https://open.bigmodel.cn/api/paas/v4/chat/completions', input.upstreamUrl + '&redirect=evil']) {
        await assert.rejects(f.service.authorize({ ...input, upstreamUrl }), /zcode_invalid_upstream/);
    }
    assert.equal(f.calls.length, 0);
    await assert.rejects(f.service.authorize({ ...input, apiKeyId: 'someone-else' }), /zcode_account_key_mismatch/);
    assert.equal(f.service.status(f.accounts[0]).signedRequests, 0);
});

test('missing or ambiguous ZCode key fails without creating a key', async () => {
    for (const keys of [[], [{ name: 'zcode-api-key', apiKey: 'a' }, { name: 'zcode-api-key', apiKey: 'b' }]]) {
        const f = fixture(); f.keys = keys;
        await assert.rejects(f.service.authorize(input), /zcode_key_(missing|ambiguous)/);
        assert.equal(f.calls.length, 1);
    }
});

test('account changed or disabled during issuance cannot use stale credentials', async () => {
    for (const mutate of [a => { a.authorization = 'new-login'; }, a => { a.zcode.enabled = false; }]) {
        const f = fixture(); f.beforeHandshakeReturn = () => mutate(f.accounts[0]);
        await assert.rejects(f.service.authorize(input), /zcode_account_changed/);
    }
});

test('failed refresh is closed and never leaks upstream errors', async () => {
    const f = fixture(); await f.service.authorize(input);
    f.now += 17900 * 1000; f.error = true;
    await assert.rejects(f.service.authorize(input), e => e.message === 'zcode_upstream_unavailable');
    assert.ok(!JSON.stringify(f.service.status(f.accounts[0])).includes('login-secret'));
});

test('explicit admin check renews material and reports no credential values', async () => {
    const f = fixture(); await f.service.authorize(input);
    const result = await f.service.check(0);
    assert.equal(f.calls.length, 6);
    assert.equal(result.ready, true);
    assert.equal(result.headers, undefined);
    assert.ok(!JSON.stringify(result).includes(f.token));
});

test('rejects expired, wrong-kind, wrong-account or disabled project tokens and invalid cipher', () => {
    for (const claims of [{ exp: 1, token_use: 'project_access', api_key: 'a' },
        { exp: 9999999999, token_use: 'login', api_key: 'a' }, { exp: 9999999999, token_use: 'project_access', api_key: 'b' }]) {
        const accessToken = 'h.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.s';
        assert.throws(() => parseProjectToken({ accessToken }, 'a'), /zcode_project_token_invalid/);
    }
    assert.throws(() => decryptSigningKey(Buffer.alloc(100).toString('base64'), 'secret', 'a'), /zcode_signing_key_invalid/);
});

test('bridge requires a separate secret; admin status/check never expose signed headers', async t => {
    const express = require('express');
    fs.writeFileSync(process.env.ACCOUNTS_FILE, JSON.stringify({ accounts: [{ name: 'pilot' }] }));
    let calls = 0;
    const app = express();
    require('../src/api/routes/zcode')(app, {
        authorize: async () => { calls++; return { enabled: false }; },
        status: () => ({ ready: true }), check: async () => ({ ready: true })
    });
    const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
    t.after(() => { server.close(); server.closeAllConnections(); });
    const base = 'http://127.0.0.1:' + server.address().port;
    for (const headers of [{}, { 'X-Auth-Password': 'test-admin' }, { 'X-ZCode-Bridge-Token': 'wrong' }]) {
        const res = await fetch(base + '/api/zcode/authorize', { method: 'POST', headers });
        assert.equal(res.status, 401); assert.equal(res.headers.get('cache-control'), 'no-store');
    }
    assert.equal(calls, 0);
    const ok = await fetch(base + '/api/zcode/authorize', { method: 'POST', headers: { 'X-ZCode-Bridge-Token': 'test-bridge' } });
    assert.deepEqual(await ok.json(), { enabled: false }); assert.equal(calls, 1);
    const privateStatus = await fetch(base + '/api/zcode/status/0'); assert.equal(privateStatus.status, 401);
    const checked = await fetch(base + '/api/zcode/check/0', { method: 'POST', headers: { 'X-Auth-Password': 'test-admin' } });
    assert.deepEqual(await checked.json(), { ready: true });
});

test('dashboard uses live enablement even for cached usage, exposing only a boolean', async t => {
    const express = require('express');
    const app = express();
    require('../src/api/routes/usage')(app);
    const account = { name: 'pilot', platform: 'glm', zcode: { enabled: true, relayAccountName: 'private-alias' }, authorization: 'private-login' };
    const save = () => fs.writeFileSync(process.env.ACCOUNTS_FILE, JSON.stringify({ accounts: [account] }));
    save();
    require('../src/api/cache').setCache(0, { index: 0, name: 'pilot', platform: 'glm', success: true, data: {} });
    const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
    t.after(() => { server.close(); server.closeAllConnections(); });
    const base = 'http://127.0.0.1:' + server.address().port;
    for (const enabled of [true, false]) {
        account.zcode.enabled = enabled; save();
        for (const url of ['/api/usage', '/api/usage/0']) {
            const data = await (await fetch(base + url)).json();
            const row = Array.isArray(data) ? data[0] : data;
            assert.equal(row.zcodeEnabled, enabled);
            assert.equal(row.zcode, undefined);
            assert.ok(!JSON.stringify(data).includes('private-'));
        }
    }
});

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

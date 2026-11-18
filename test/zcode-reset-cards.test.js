'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createResetService } = require('../src/zcode/reset-cards');

function fixture() {
    const f = { now: 1800000000000, calls: [], stateValue: {}, granted: false,
        accounts: [{ name: 'A', platform: 'glm', organization: 'org', project: 'p', authorization: 'bigmodel-secret' }] };
    const jwt = name => 'h.' + Buffer.from(JSON.stringify({ sub: name, exp: f.now / 1000 + 3600 })).toString('base64url') + '.sig';
    f.state = { read: () => structuredClone(f.stateValue), write: value => { f.stateValue = structuredClone(value); } };
    f.fetch = async (url, init) => {
        f.calls.push({ url, init });
        if (f.hook) await f.hook(url, init);
        let data;
        if (url.includes('/getAuthCode?appId=zcode')) {
            assert.equal(init.headers.authorization, 'bigmodel-secret');
            data = { authCode: 'one-time-code' };
        } else if (url.endsWith('/oauth/token')) {
            assert.equal(JSON.parse(init.body).code, 'one-time-code');
            data = { token: jwt('zcode-secret'), bigmodel: { access_token: jwt('business-secret') } };
        } else {
            assert.equal(init.headers.authorization, 'Bearer ' + jwt('zcode-secret'));
            assert.equal(init.headers['X-Bigmodel-Authorization'], jwt('business-secret'));
            assert.equal(init.headers['Bigmodel-Target-Type'], 'PERSONAL');
            if (url.endsWith('/status')) {
                if (f.statusFails) return { ok: false, status: 503 };
                data = { available_five_hour_resets: [], available_week_resets: f.cards || [],
                    latest_five_hour_reset_history: null, latest_week_reset_history: null };
            } else if (url.endsWith('/opportunity')) {
                if (f.opportunityFails) throw new Error('secret raw upstream failure');
                if (f.throttled) return { ok: false, status: 429 };
                if (f.granted) { f.cards = [{ expire_at: f.now + 3600000 }]; data = { granted: true }; }
                else return { ok: true, status: 200, json: async () => ({ code: 3301, data: { granted: false, next_try_at: f.now + 3600000 } }) };
            } else assert.fail('Unexpected endpoint ' + url);
        }
        return { ok: true, status: 200, json: async () => ({ code: 0, data }) };
    };
    f.create = () => createResetService({ fetch: f.fetch, readAccounts: () => f.accounts,
        retryAuth: (a, i, fn) => fn(a), now: () => f.now, state: f.state });
    f.service = f.create();
    f.check = () => f.service.check({ ...f.accounts[0] }, 0);
    f.claims = () => f.calls.filter(c => c.url.endsWith('/opportunity'));
    return f;
}

test('refresh obtains separate login credentials, checks eligibility and confirms new cards without using them', async () => {
    const f = fixture(); f.granted = true;
    const r = await f.check();
    assert.equal(r.state, 'granted'); assert.equal(r.available.week, 1);
    assert.equal(f.calls.length, 5); assert.equal(f.claims().length, 1);
    assert.ok(!f.calls.some(c => c.url.endsWith('/use')));
    for (const value of ['bigmodel-secret', 'one-time-code', 'zcode-secret', 'business-secret']) {
        assert.ok(!JSON.stringify(r).includes(value)); assert.ok(!JSON.stringify(f.stateValue).includes(value));
    }
    assert.ok(!JSON.stringify(f.stateValue).includes('headers'));
});

test('all concurrent refreshes share a claim and honor server next_try_at across service restart', async () => {
    const f = fixture();
    const r = await Promise.all(Array.from({ length: 8 }, () => f.check()));
    assert.ok(r.every(x => x.state === 'not_eligible')); assert.equal(f.claims().length, 1);
    f.service = f.create();
    assert.equal((await f.check()).state, 'cooldown'); assert.equal(f.claims().length, 1);
    f.now += 3600001;
    assert.equal((await f.check()).state, 'not_eligible'); assert.equal(f.claims().length, 2);
});

test('timeout preserves claim idempotency key on retry and restart, with a five minute backoff', async () => {
    const f = fixture(); f.opportunityFails = true;
    assert.equal((await f.check()).state, 'unavailable');
    const key = JSON.parse(f.claims()[0].init.body).idempotency_key;
    f.service = f.create(); await f.check(); assert.equal(f.claims().length, 1);
    f.opportunityFails = false; f.now += 5 * 60000 + 1;
    await f.check();
    assert.equal(JSON.parse(f.claims()[1].init.body).idempotency_key, key);
});

test('bare 429 backs off ten minutes without looping or probing alternate credentials', async () => {
    const f = fixture(); f.throttled = true;
    const r = await f.check(); assert.equal(r.state, 'cooldown'); assert.equal(r.nextCheckAt, f.now + 600000);
    await f.check(); assert.equal(f.claims().length, 1);
});

test('status failure prevents claiming, retains existing card inventory and leaks no errors', async () => {
    const f = fixture(); f.statusFails = true;
    f.accounts[0].resetCards = { count: 2, cards: [{ recordId: 1 }, { recordId: 2 }] };
    const r = await f.check();
    assert.equal(r.state, 'unavailable'); assert.equal(f.claims().length, 0);
    assert.equal(f.accounts[0].resetCards.count, 2);
    assert.ok(!JSON.stringify(r).includes('secret'));
});

test('account replacement during status cannot trigger claim or return stale status', async () => {
    const f = fixture();
    f.hook = url => { if (url.endsWith('/status')) f.accounts[0] = { ...f.accounts[0], name: 'B', authorization: 'replacement' }; };
    await assert.rejects(f.check(), /changed/); assert.equal(f.claims().length, 0);
});

test('model routing switch does not gate card benefits; unsupported accounts do not request', async () => {
    const f = fixture(); f.accounts[0].zcode = { enabled: false };
    assert.equal((await f.check()).state, 'not_eligible');
    const calls = f.calls.length; f.accounts[0].teamEdition = true;
    assert.equal((await f.check()).state, 'unsupported'); assert.equal(f.calls.length, calls);
});

test('cannot submit a claim unless its retry state is durably saved', async () => {
    const f = fixture(); f.state.write = () => { throw new Error('disk full'); };
    assert.equal((await f.check()).state, 'unavailable'); assert.equal(f.claims().length, 0);
});

test('a confirmed claim stays successful even if its follow-up status read fails', async () => {
    const f = fixture(); f.granted = true;
    f.hook = url => { if (url.endsWith('/status') && f.claims().length) f.statusFails = true; };
    const r = await f.check(); assert.equal(r.state, 'granted'); assert.equal(r.available, null);
    await f.check(); assert.equal(f.claims().length, 1);
});

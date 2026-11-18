'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-reset-route-'));
process.env.ACCOUNTS_FILE = path.join(tmp, 'accounts.json');
process.env.USAGE_CACHE_FILE = path.join(tmp, 'cache.json');
process.env.ADMIN_PASSWORD = 'test-reset-pwd';
const account = { name: 'A', platform: 'glm', authorization: 'secret', organization: 'o', project: 'p',
    resetCards: { count: 1, cards: [{ recordId: 7, type: 'week' }] } };
const { readAccounts, writeAccounts } = require('../src/api/accounts');
let response, listHook, zcodeHook, zcodeCalls = 0;
const http = require('../src/lib/http');
http.httpsGet = async url => {
    assert.ok(url.includes('/customer-package-reset/list'));
    if (listHook) listHook();
    return response;
};
const express = require('express');
const app = express();
require('../src/api/routes/keys')(app, { zcodeReset: { check: async () => {
    zcodeCalls++;
    return zcodeHook ? zcodeHook() : { state: 'granted', available: { fiveHour: 0, week: 1 } };
} } });
const server = app.listen(0);
const base = 'http://127.0.0.1:' + server.address().port;
const call = async (method = 'POST', authed = true) => {
    const r = await fetch(base + '/api/reset-cards/0' + (method === 'POST' ? '/refresh' : ''), {
        method, headers: authed ? { 'x-auth-password': 'test-reset-pwd' } : {}
    });
    return { status: r.status, body: await r.json(), cache: r.headers.get('cache-control') };
};
test.beforeEach(() => {
    writeAccounts([account]); zcodeCalls = 0; listHook = null; zcodeHook = null;
    response = { code: 200, data: { fiveHourResets: [], weekResets: [
        { recordId: 99, grantType: 'DIRECT', available: true, expireTime: '2026-12-22 23:59:59' }
    ] } };
});
test.after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('refresh requires admin; read-only GET never asks ZCode to grant cards', async () => {
    assert.equal((await call('POST', false)).status, 401);
    const r = await call('GET'); assert.equal(r.status, 200); assert.equal(zcodeCalls, 0);
});
test('refresh keeps actual BigModel record IDs and grant types for later use', async () => {
    const r = await call(); assert.equal(r.status, 200); assert.equal(r.cache, 'no-store');
    assert.equal(zcodeCalls, 1); assert.equal(r.body.zcode.state, 'granted');
    assert.equal(r.body.cards[0].recordId, 99); assert.equal(r.body.cards[0].grantType, 'DIRECT');
    assert.equal(readAccounts()[0].resetCards.cards[0].recordId, 99);
    assert.ok(!JSON.stringify(r.body).includes('secret'));
});
test('ZCode failure falls back to fresh BigModel inventory without a raw error or credentials', async () => {
    zcodeHook = () => { throw new Error('secret upstream payload'); };
    const r = await call(); assert.equal(r.status, 200); assert.equal(r.body.cards[0].recordId, 99);
    assert.equal(r.body.zcode.state, 'unavailable'); assert.ok(!JSON.stringify(r.body).includes('secret'));
});
test('rejected BigModel response cannot wipe the previous card inventory', async () => {
    response = { code: 500, msg: 'secret' };
    const r = await call(); assert.equal(r.status, 502);
    assert.equal(readAccounts()[0].resetCards.cards[0].recordId, 7);
    assert.ok(!JSON.stringify(r.body).includes('secret'));
});
test('account reorder while inventory is being fetched cannot overwrite the new account', async () => {
    listHook = () => writeAccounts([{ ...account, name: 'B', organization: 'different' }]);
    assert.equal((await call()).status, 502);
    assert.equal(readAccounts()[0].name, 'B'); assert.equal(readAccounts()[0].resetCards.cards[0].recordId, 7);
});
test('cards visible only in ZCode are not fabricated into usable BigModel cards', async () => {
    zcodeHook = () => ({ state: 'granted', available: { fiveHour: 2, week: 4 } });
    const r = await call(); assert.equal(r.body.cards.length, 1);
    assert.match(r.body.zcode.message, /正在同步/);
});

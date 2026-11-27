'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduler-types-'));
process.env.ACCOUNTS_FILE = path.join(dir, 'accounts.json');
process.env.USAGE_CACHE_FILE = path.join(dir, 'cache.json');
process.env.SCHEDULER_STATE_FILE = path.join(dir, 'scheduler.json');
process.env.ADMIN_PASSWORD = 'fixture-password';
process.env.SUB2API_BASE_URL = 'http://localhost';
process.env.SCHEDULER_SYNC_TOKEN = 'fixture-token';

const store = require('../src/scheduler/store'), service = require('../src/scheduler/service');
const { writeAccounts } = require('../src/api/accounts');
const { eligible } = require('../src/scheduler/glm-model-policy');
const { channelModes } = require('../src/scheduler/channels');
const express = require('express');

test('legacy mixed routes migrate to B and standalone account types survive a deselection', () => {
    const accounts = [{ name: '多模型', platform: 'stepfun' }, { name: '智云是备注', platform: 'glm' }, { name: '余额' }];
    const mixed = { 10: 'native', 11: 'fallback', 12: 'paused' };
    const legacy = { accounts: [
        { name: '多模型', role: 'standard', maxConcurrency: 6, channelModes: mixed },
        { name: '余额', role: 'paid', maxConcurrency: 2 }
    ] };
    const migrated = store.validate(legacy, accounts);
    assert.deepEqual(migrated.accountTypes, { '多模型': 'dilution', '智云是备注': 'subscription', '余额': 'paid' });
    assert.equal(migrated.accounts[0].role, 'dilution');
    assert.deepEqual(migrated.accounts[0].channelModes, mixed);
    const deselected = store.validate({ ...migrated, accounts: [] }, accounts);
    assert.deepEqual(deselected.accountTypes, migrated.accountTypes);
    assert.equal(eligible(accounts[2], deselected), false);
    assert.throws(() => store.validate({ ...migrated, accountTypes: { '余额': 'unknown' } }, accounts), /类型无效/);
    assert.throws(() => store.validate(legacy, accounts.concat(accounts[0])), /名称重复/);
});

test('B defaults to replacement on dedicated providers and keeps native and paused exceptions', () => {
    const policy = { role: 'dilution' };
    const mixed = { channels: [{ id: 1, suggestedMode: 'native' }, { id: 2, suggestedMode: 'fallback' }] };
    assert.deepEqual(channelModes(policy, mixed), { 1: 'native', 2: 'fallback' });
    assert.deepEqual(channelModes(policy, { channels: [{ id: 3, suggestedMode: 'native' }] }), { 3: 'fallback' });
    assert.deepEqual(channelModes({ ...policy, channelModes: { 2: 'paused' } }, mixed), { 1: 'paused', 2: 'paused' });
});

test('console saves across legacy orphans, an in-flight deletion and an old open draft', async t => {
    const app = express();
    require('../src/api/routes/accounts')(app);
    require('../src/api/routes/scheduler')(app);
    const server = app.listen(0, '127.0.0.1');
    await require('node:events').once(server, 'listening');
    t.after(() => new Promise(resolve => server.close(resolve)));
    const request = async (route, method = 'GET', body) => {
        const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/' + route, {
            method, headers: { 'X-Auth-Password': process.env.ADMIN_PASSWORD, 'Content-Type': 'application/json' },
            body: body && JSON.stringify(body)
        });
        const result = await response.json();
        assert.equal(response.status, 200, result.error);
        return result;
    };
    const accounts = [{ name: 'Plan' }, { name: 'Reserve', platform: 'minimax' }, { name: 'Mirror', platform: 'other' }];
    writeAccounts(accounts);
    const policy = name => ({ name, role: 'primary', maxConcurrency: 4, autoReset: false });
    const old = { ...store.defaults, enabled: true, accounts: [policy('Plan'), { ...policy('Gone'), role: 'paid', unmetered: true },
        { ...policy('Reserve'), role: 'standard', channelModes: { 1: 'native', 2: 'fallback' } }] };
    store.write({ config: old, events: [], glmModelPolicy: { mode: 'all', flashAccounts: ['Plan'] } });
    let removeDuringSave = false;
    t.mock.method(service, 'telemetry', async () => {
        if (removeDuringSave) {
            removeDuringSave = false;
            await request('accounts/1', 'DELETE');
        }
        return { smart_scheduler_version: 2, weight_sync_enabled: true };
    });
    t.mock.method(service, 'push', async () => ({}));
    t.mock.method(service, 'cycle', async () => {});
    const draft = (await request('scheduler')).config;
    assert.deepEqual(draft.accounts.map(p => p.name), ['Plan', 'Reserve']);
    assert.equal(draft.accountTypes.Reserve, 'dilution');
    const saved = await request('scheduler', 'PUT', old);
    assert.equal(saved.removedAccountCount, 1);
    assert.equal(saved.config.accounts[1].role, 'dilution');
    assert.ok(!Object.hasOwn(service.controls(), 'Gone'));
    draft.accountTypes.Mirror = 'paid';
    removeDuringSave = true;
    const after = await request('scheduler', 'PUT', draft);
    assert.equal(after.removedAccountCount, 1);
    assert.deepEqual(after.config.accounts.map(p => p.name), ['Plan']);
    assert.deepEqual(after.config.accountTypes, { Plan: 'subscription', Mirror: 'paid' });
    assert.deepEqual(after.glmModelPolicy, { mode: 'all', flashAccounts: ['Plan'] });
    await request('accounts/0', 'DELETE');
    assert.equal(store.read().config.enabled, false);
    assert.deepEqual(store.read().glmModelPolicy, { mode: 'all', flashAccounts: [] });
    const empty = await request('scheduler', 'PUT', draft);
    assert.equal(empty.config.enabled, false);
    assert.deepEqual(empty.config.accountTypes, { Mirror: 'paid' });
});
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

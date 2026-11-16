'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduler-protocol-'));
process.env.ACCOUNTS_FILE = path.join(dir, 'accounts.json');
process.env.USAGE_CACHE_FILE = path.join(dir, 'usage.json');
process.env.SCHEDULER_STATE_FILE = path.join(dir, 'scheduler.json');
process.env.SUB2API_BASE_URL = '';
process.env.SCHEDULER_SYNC_TOKEN = '';
fs.writeFileSync(process.env.ACCOUNTS_FILE, JSON.stringify({ accounts: [{ name: 'A', platform: 'glm' }] }));
fs.writeFileSync(process.env.USAGE_CACHE_FILE, '{}');
const store = require('../src/scheduler/store'), service = require('../src/scheduler/service'), cache = require('../src/api/cache');
function fixture() {
    const now = Date.now();
    cache.setCache(0, { name: 'A', platform: 'glm', success: true, cachedAt: now, data: { limits: [{ unit: 3, percentage: 10, nextResetTime: now + 3600000 }] } });
    const state = { config: { ...store.defaults, enabled: true, accounts: [{ name: 'A', role: 'primary', mode: 'auto', maxConcurrency: 4, quotaScale: 1 }] },
        journal: {}, events: [], configChangedAt: now - 1000,
        plan: { generatedAt: now, rows: [{ name: 'A', weight: 8, concurrency: 3, priority: 1 }] } };
    store.write(state); return { now, state };
}
test('managed weights fail closed on expired plan or newer unplanned configuration', () => {
    let { now, state } = fixture();
    assert.equal(service.controls(state, now).A.weight, 8);
    assert.equal(service.controls(state, now + 180001).A.weight, 0);
    state.configChangedAt = now + 1;
    assert.equal(service.controls(state, now).A.weight, 0);
});
test('fresh exhausted quota and pending card request override an older positive plan immediately', () => {
    const { now, state } = fixture();
    cache.setCache(0, { name: 'A', success: true, cachedAt: now, data: { limits: [{ unit: 3, percentage: 100 }] } });
    assert.equal(service.controls(state, now).A.weight, 0);
    const next = fixture(); next.state.pendingResets = { A: { type: 'week', at: now } };
    assert.equal(service.controls(next.state, next.now).A.weight, 0);
});
test('leases are anchored to the plan, not extended by repeated read-only polls', () => {
    const { now, state } = fixture();
    assert.equal(service.controls(state, now).A.expires_at, service.controls(state, now + 90000).A.expires_at);
});
test('v2 exports separate channel weights, and stale quota closes both portions', () => {
    const { now, state } = fixture();
    Object.assign(state.plan.rows[0], { weight: 8, nativeWeight: 6, fallbackWeight: 2, channelModes: { 81: 'native', 104: 'fallback' } });
    store.write(state);
    const control = service.controls(state, now).A;
    assert.equal(control.weight, 6); assert.equal(control.fallback_weight, 2);
    assert.deepEqual(control.channel_modes, { 81: 'native', 104: 'fallback' });
    assert.equal(service.decision('A').weight, 8);
    const stale = service.controls(state, now + 180001).A;
    assert.equal(stale.weight, 0); assert.equal(stale.fallback_weight, 0);
});
test('stopping releases managed controls and leaves normal weight editing available', () => {
    const { state } = fixture(); state.config.enabled = false; store.write(state);
    assert.deepEqual(service.controls(state), {}); assert.equal(service.decision('A'), null);
});
test('config validates unique stable names, manual modes, routes and recharge timestamps', () => {
    const accounts = [{ name: 'A', platform: 'glm' }];
    const input = { enabled: true, accounts: [{ name: 'A', role: 'primary', mode: 'burst', maxConcurrency: 3 }] };
    const c = store.validate(input, accounts);
    assert.equal(c.accounts[0].mode, 'burst'); assert.equal(c.resetWeekMinHours, 24); assert.equal(c.reserveWeeklyCards, undefined); assert.equal(c.maxResetsPerDay, undefined);
    assert.throws(() => store.validate({ ...input, accounts: input.accounts.concat(input.accounts) }, accounts));
    assert.throws(() => store.validate({ ...input, accounts: [{ ...input.accounts[0], replenishAt: 'invalid' }] }, accounts));
});
test('automatic reset is normalized off outside high-consumption mode', () => {
    const accounts = [{ name:'A', platform:'glm' }];
    const policy = { name:'A', role:'primary', mode:'auto', autoReset:true, maxConcurrency:3 };
    assert.equal(store.validate({accounts:[policy]}, accounts).accounts[0].autoReset, false);
    policy.mode = 'burst'; assert.equal(store.validate({accounts:[policy]}, accounts).accounts[0].autoReset, true);
});
test.after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

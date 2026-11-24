'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { plan } = require('../src/scheduler/planner');
const { usedToday } = require('../src/scheduler/card-usage');
const H = 3600000, NOW = Date.parse('2026-11-24T15:00:00+08:00');
const CARD_HOLDERS = ['Burn', 'Carrier', 'Holder'];

// Tuesday afternoon, as in the reported pool: every account is ahead of its
// work-time waterline and every 5h window is 71% spent with four hours to go.
function fixture(names = ['Burn', 'Carrier', 'Balanced']) {
    const accounts = names.map(name => ({ name, platform: 'glm', resetCards: { checkedAt: NOW,
        cards: CARD_HOLDERS.includes(name) ? [{ type: 'week', recordId: 1, expireTime: NOW + 400 * H }] : [] } }));
    const config = { staleAfterSeconds: 600, resetWeekMinHours: 24, resetMinRemainingMinutes: 60,
        accounts: names.map(name => ({ name, role: 'primary', mode: name === 'Burn' ? 'burst' : 'auto',
            autoReset: CARD_HOLDERS.includes(name), maxConcurrency: CARD_HOLDERS.includes(name) ? 4 : 2, quotaScale: 1 })) };
    const usage = accounts.map(a => ({ name: a.name, platform: 'glm', success: true, cachedAt: NOW, data: { limits: [
        { type: 'TOKENS_LIMIT', unit: 3, percentage: 71, nextResetTime: NOW + 4 * H },
        { type: 'TOKENS_LIMIT', unit: 6, percentage: 70, nextResetTime: NOW + 72 * H }] } }));
    const telemetry = Object.fromEntries(names.map(name => [name, { count: 1, current: 1, capacity: 2, limited: false }]));
    return { now: NOW, accounts, config, usage, telemetry };
}
const rows = p => plan(p).rows;
const row = (p, name) => rows(p).find(r => r.name === name);
const sum = (list, pick) => list.reduce((n, x) => n + pick(x), 0);

test('manual burn runs at its ceiling and top weight while 5h protection used to throttle it', () => {
    const p = fixture();
    p.usage[0].data.limits[1].percentage = 97;
    p.previous = { Burn: { weight: 0.5, effectiveMode: 'burst', modeSource: 'manual', fast: true,
        adaptiveConcurrency: 4, concurrency: 1, shortProtection: 2 } };
    const r = row(p, 'Burn');
    assert.equal(r.state, 'burst');
    assert.equal(r.shortProtection, 0);
    assert.equal(r.concurrency, 4);
    assert.equal(r.weight, 10);
    assert.equal(r.priority, 1);
    assert.doesNotMatch(r.reasons.join('；'), /小时|提前收紧/);
});

test('a burn request takes effect at once: full concurrency on entry, no weight smoothing', () => {
    const p = fixture();
    assert.equal(row(p, 'Burn').concurrency, 4);
    p.previous = { Burn: { weight: 0.5, effectiveMode: 'burst', modeSource: 'manual', fast: true, adaptiveConcurrency: 4 } };
    assert.equal(row(p, 'Burn').weight, 10);
    assert.match(row(p, 'Burn').concurrencyReason, /已达允许上限/);
    p.config.accounts[0].maxConcurrency = 2;
    assert.equal(row(p, 'Burn').concurrency, 2);
});

test('upstream limits still halve a burn account, which then recovers one step at a time', () => {
    const p = fixture();
    p.previous = { Burn: row(p, 'Burn') };
    p.telemetry.Burn.limited = true;
    const limited = row(p, 'Burn');
    assert.equal(limited.state, 'cooldown');
    assert.equal(limited.fast, false);
    assert.equal(limited.concurrency, 2);
    p.previous = { Burn: limited };
    p.telemetry.Burn.limited = false;
    p.now += 30000;
    const observing = row(p, 'Burn');
    assert.equal(observing.concurrency, 2);
    assert.match(observing.concurrencyReason, /恢复观察/);
    p.previous = { Burn: { ...observing, busySince: p.now - 120000, plannedAt: p.now - 30000,
        adjustedAt: p.now - 130000, lastLimitedAt: p.now - 130000 } };
    p.telemetry.Burn.current = 2;
    p.now += 30000;
    assert.equal(row(p, 'Burn').concurrency, 3);
});

test('a week card carrier is no longer held back by its own 5h window or a fast-burn forecast', () => {
    const p = fixture();
    const r = row(p, 'Carrier');
    assert.equal(r.accelerationActive, true);
    assert.equal(r.fast, true);
    assert.equal(r.state, 'burst');
    assert.equal(r.shortProtection, 0);
    assert.equal(r.concurrency, 4);
    p.previous = { Carrier: { cachedAt: NOW - 60000, shortUsed: 70, shortRatePerHour: 120, shortRateSamples: 3,
        shortResetAt: p.usage[1].data.limits[0].nextResetTime + 10000 } };
    const forecast = row(p, 'Carrier');
    assert.ok(forecast.shortForecastHours < 0.75);
    assert.equal(forecast.accelerationActive, true);
    assert.equal(forecast.concurrency, 4);
    assert.doesNotMatch(forecast.reasons.join('；'), /提前收紧|额度偏紧/);
});

test('accounts without a burn request or a card keep 5h protection', () => {
    const p = fixture();
    const paced = row(p, 'Balanced');
    assert.equal(paced.state, 'protecting');
    assert.equal(paced.concurrency, 2);
    p.usage[2].data.limits[0].percentage = 98;
    assert.equal(row(p, 'Balanced').concurrency, 1);
    // Surplus catch-up is automatic: its measured fast-burn guard stays.
    p.usage[1].data.limits[1].percentage = 5;
    p.config.accounts[1].autoReset = false;
    p.usage[1].data.limits[0].percentage = 95;
    const surplus = row(p, 'Carrier');
    assert.equal(surplus.accelerationReason, 'surplus');
    assert.equal(surplus.accelerationActive, false);
    assert.equal(surplus.state, 'protecting');
    assert.equal(surplus.fast, false);
});

test('other primaries yield to a burn account while it can still take traffic', () => {
    const p = fixture(['Burn', 'Balanced', 'Late', 'Fresh']);
    [['Balanced', 70, 72], ['Late', 51, 158], ['Fresh', 40, 100]].forEach(([name, week, hours], i) => {
        Object.assign(p.usage[i + 1].data.limits[0], { percentage: 20 });
        Object.assign(p.usage[i + 1].data.limits[1], { percentage: week, nextResetTime: NOW + hours * H });
    });
    const list = rows(p), burn = list.find(r => r.name === 'Burn'), others = list.filter(r => r.name !== 'Burn');
    assert.equal(burn.weight, 10);
    assert.ok(sum(others, r => r.weight) <= 2.6);
    others.forEach(r => { assert.ok(r.weight >= 0.1); assert.match(r.reasons.join('；'), /高速账号优先承接/); });
    assert.ok(row(p, 'Fresh').weight >= row(p, 'Balanced').weight);
    assert.ok(row(p, 'Balanced').weight >= row(p, 'Late').weight);
    // Once the burn account is exhausted its preference disappears.
    p.usage[0].data.limits[0].percentage = 100;
    const exhausted = rows(p);
    assert.equal(exhausted.find(r => r.name === 'Burn').weight, 0);
    const paused = structuredClone(p);
    paused.config.accounts[0].paused = true;
    paused.usage[0].data.limits[0].percentage = 71;
    for (const name of ['Balanced', 'Late', 'Fresh']) {
        assert.equal(exhausted.find(r => r.name === name).weight, row(paused, name).weight);
        assert.ok(exhausted.find(r => r.name === name).weight > 2.6);
        assert.doesNotMatch(exhausted.find(r => r.name === name).reasons.join('；'), /高速账号优先承接/);
    }
});

test('a manual burn is not counted as evidence that the pool is overdrawn', () => {
    const p = fixture(['Burn', 'Balanced', 'Holder']);
    p.usage[2].data.limits[1].percentage = 40;
    const result = plan(p);
    assert.equal(result.summary.weeklyRiskAccounts, 1); // Balanced only.
    assert.equal(result.rows.some(r => r.accelerationReason === 'reset-card'), false);
    // The same account in automatic mode does count, and promotes a card carrier.
    p.config.accounts[0].mode = 'auto';
    assert.equal(plan(p).summary.weeklyRiskAccounts, 2);
    assert.equal(plan(p).rows.some(r => r.accelerationReason === 'reset-card'), true);
});

test('nothing outranks a manual burn, not even automatic catch-up', () => {
    const p = fixture(['Burn', 'Laggard']);
    Object.assign(p.usage[1].data.limits[0], { percentage: 20 });
    Object.assign(p.usage[1].data.limits[1], { percentage: 0, nextResetTime: NOW + 60 * H });
    const catchUp = row(p, 'Laggard');
    assert.equal(catchUp.accelerationReason, 'surplus');
    assert.equal(catchUp.accelerationActive, true);
    assert.equal(row(p, 'Burn').weight, 10);
    assert.equal(row(p, 'Burn').priority, 1);
    assert.ok(catchUp.weight < row(p, 'Burn').weight);
});

test('an exhausted 5h window no longer holds the weekly card, which reopens both windows', () => {
    const p = fixture();
    Object.assign(p.usage[0].data.limits[0], { percentage: 100 });
    Object.assign(p.usage[0].data.limits[1], { percentage: 100 });
    const r = row(p, 'Burn');
    assert.equal(r.weight, 0);
    assert.equal(r.state, 'exhausted');
    assert.equal(r.reset.type, 'week');
    assert.equal(r.resetDecision.decision, 'use');
    assert.doesNotMatch(r.reasons.join('；'), /周卡无法恢复/);
    // The 24 hour rule before the natural weekly reset is unchanged.
    p.usage[0].data.limits[1].nextResetTime = NOW + 12 * H;
    assert.equal(row(p, 'Burn').reset, null);
});

test('today\'s used cards are counted by Beijing day, type and confirmed result only', () => {
    const start = Date.parse('2026-11-23T16:00:00Z'); // 00:00 on the 24th in Beijing
    const journal = {
        a: { at: start + 3600000, type: 'week', status: 'used', automatic: true },
        b: { at: start + 2 * 3600000, type: 'fiveHour', status: 'used', automatic: false },
        c: { at: start - 3600000, type: 'week', status: 'used' },                 // yesterday
        d: { at: start + 3 * 3600000, type: 'week', status: 'uncertain' },        // unconfirmed
        e: { at: start + 3 * 3600000, type: 'week', status: 'rejected' },         // not spent
        f: { at: 'not a timestamp', type: 'week', status: 'used' }                 // unusable record
    };
    assert.deepEqual(usedToday(journal, start + 10 * 3600000), { total: 2, week: 1, fiveHour: 1 });
    assert.deepEqual(usedToday(journal, start + 26 * 3600000), { total: 0, week: 0, fiveHour: 0 });
    assert.deepEqual(usedToday(undefined, start), { total: 0, week: 0, fiveHour: 0 });
});

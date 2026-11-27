'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { plan } = require('../src/scheduler/planner');
const H = 3600000, NOW = Date.parse('2026-11-20T17:00:00+08:00');

// Friday before the weekend, the work waterline reaches 98% while a
// natural reset is still two days away. A card holder can stay on budget.
function fixture() {
    const accounts = [{ name: 'Card', platform: 'glm', resetCards: { checkedAt: NOW,
        cards: [1, 2].map(recordId => ({ type: 'week', recordId, expireTime: NOW + 200 * H })) } },
    { name: 'Balanced', platform: 'glm' }];
    return { now: NOW, accounts,
        config: { staleAfterSeconds: 600, resetWeekMinHours: 24, resetMinRemainingMinutes: 60,
            accounts: accounts.map((a, i) => ({ name: a.name, role: 'primary', mode: 'auto',
                autoReset: i === 0, maxConcurrency: i === 0 ? 4 : 2, quotaScale: 1 })) },
        usage: accounts.map((a, i) => ({ name: a.name, platform: 'glm', success: true, cachedAt: NOW,
            data: { limits: [{ type: 'TOKENS_LIMIT', unit: 3, percentage: i === 0 ? 6 : 45,
                nextResetTime: NOW + (i === 0 ? 3.5 : 0.1) * H },
            { type: 'TOKENS_LIMIT', unit: 6, percentage: i === 0 ? 98 : 76, nextResetTime: NOW + (i === 0 ? 48 : 75) * H }] } })),
        telemetry: { Card: { count: 1, current: 0, capacity: 3 }, Balanced: { count: 1, current: 2, capacity: 2 } } };
}
const card = p => plan(p).rows.find(r => r.name === 'Card');

test('card-backed 98% week outranks a healthy balanced account without spending early', () => {
    const p = fixture(), rows = plan(p).rows, r = rows.find(r => r.name === 'Card');
    assert.equal(r.accelerationReason, 'reset-card');
    assert.equal(r.accelerationActive, true);
    assert.equal(r.state, 'burst');
    assert.ok(r.weight > rows.find(r => r.name === 'Balanced').weight);
    assert.equal(r.priority, 1);
    assert.equal(r.reset, null);
    assert.ok(r.concurrency <= 4);
});

test('approaching weekly exhaustion does not progressively starve an authorized card-backed burst', () => {
    const p = fixture(), shares = [90, 93, 95, 98].map(used => {
        p.usage[0].data.limits[1].percentage = used;
        const r = card(p);
        assert.equal(r.accelerationActive, true);
        assert.equal(r.reset, null);
        return r.share;
    });
    for (let i = 1; i < shares.length; i++) assert.ok(shares[i] >= shares[i - 1]);
});

test('existing low weights converge above balanced traffic through normal smoothing', () => {
    const p = fixture();
    p.previous = { Card: { weight: 5, effectiveMode: 'burst', modeSource: 'automatic',
        accelerationReason: 'reset-card', accelerationActive: true, adaptiveConcurrency: 3 },
    Balanced: { weight: 9.9 } };
    let result;
    for (let i = 0; i < 3; i++) {
        result = plan(p);
        p.previous = Object.fromEntries(result.rows.map(r => [r.name, r]));
        p.now += 30000;
    }
    assert.equal(result.rows[0].name, 'Card');
    assert.ok(result.rows[0].weight > 8);
});

test('permission, inventory, replenishment and low mode still gate the new weekly baseline', () => {
    for (const change of [
        p => { p.config.accounts[0].autoReset = false; },
        p => { p.accounts[0].resetCards.cards = []; },
        p => { p.accounts[0].resetCards.checkedAt = NOW - 16 * 60000; },
        p => { p.config.accounts[0].mode = 'slow'; },
        p => { p.config.accounts[0].replenishAt = new Date(NOW + H).toISOString(); },
        p => { p.telemetry.Balanced.current = 0; }
    ]) {
        const p = fixture();
        p.previous = { Card: card(p) };
        // Remove the previous plan's shared demand marker when testing idle demand.
        delete p.previous.Card.demandSeenAt;
        change(p);
        const r = card(p);
        assert.ok(r.weeklyWeightFactor < 1);
        assert.notEqual(r.accelerationReason, 'reset-card');
        assert.equal(r.reset, null);
    }
});

test('upstream limits still override card acceleration', () => {
    // Its own 5h window and fast-burn forecasts do not: see scheduler-fast-burn.test.js.
    const p = fixture();
    p.telemetry.Card.limited = true;
    const rows = plan(p).rows, r = rows.find(r => r.name === 'Card');
    assert.equal(r.state, 'cooldown');
    assert.equal(r.accelerationActive, false);
    assert.ok(r.weeklyWeightFactor < 1);
    assert.ok(r.weight < rows.find(r => r.name === 'Balanced').weight);
    assert.ok(r.concurrency <= 2);
    assert.equal(r.reset, null);
});

test('actual exhaustion stops traffic; a weekly card reopens both windows at once', () => {
    const p = fixture(); p.usage[0].data.limits[1].percentage = 100;
    let r = card(p);
    assert.equal(r.weight, 0);
    assert.equal(r.reset.type, 'week');
    p.usage[0].data.limits[0].percentage = 100;
    r = card(p);
    assert.equal(r.weight, 0);
    assert.equal(r.reset.type, 'week');
});

test('confirmed weekly recovery exits acceleration instead of keeping the replenishment boost', () => {
    const p = fixture(); p.previous = { Card: card(p) };
    Object.assign(p.usage[0].data.limits[1], { percentage: 1, nextResetTime: NOW + 168 * H });
    const r = card(p);
    assert.equal(r.effectiveMode, 'auto');
    assert.ok(r.weeklyWeightFactor < 1);
    assert.equal(r.reset, null);
});

function pressuredPool() {
    const p = fixture();
    // Two peers have already spent more than one working day's budget ahead.
    p.usage[0].data.limits[1].percentage = 40;
    p.usage[0].data.limits[1].nextResetTime = NOW + 120 * H;
    p.usage[1].data.limits[1].percentage = 90;
    p.usage[1].data.limits[1].nextResetTime = NOW + 110 * H;
    p.accounts.push({ name: 'Peer' });
    p.config.accounts.push({ ...p.config.accounts[1], name: 'Peer' });
    p.usage.push({ ...structuredClone(p.usage[1]), name: 'Peer' });
    p.telemetry.Peer = { ...p.telemetry.Balanced };
    return p;
}

test('two overdrawn peers activate one healthy card carrier before it reaches 50%', () => {
    const p = pressuredPool(), s = plan(p);
    assert.ok(s.summary.weeklyRiskAccounts >= 2);
    assert.equal(s.rows[0].name, 'Card');
    assert.equal(s.rows[0].accelerationReason, 'reset-card');
    assert.equal(s.rows[0].reset, null);
    assert.match(s.rows.find(r => r.name === 'Peer').reasons.join(' '), /权重减半/);
    p.usage[2].cachedAt = NOW - H;
    assert.notEqual(card(p).accelerationReason, 'reset-card');
    p.usage[2].cachedAt = NOW;
    p.config.accounts[0].autoReset = false;
    assert.equal(plan(p).rows.some(r => r.accelerationReason === 'reset-card'), false);
});

test('a healthy carrier retains priority over an overdrawn card holder; limits and verification still apply', () => {
    const p = pressuredPool();
    p.config.accounts[2].autoReset = true;
    p.accounts[2].resetCards = structuredClone(p.accounts[0].resetCards);
    const active = () => plan(p).rows.filter(r => r.accelerationReason === 'reset-card' && r.accelerationActive).map(r => r.name);
    assert.deepEqual(active(), ['Card']);
    // A nearly spent 5h window cannot promote the overdrawn peer.
    p.usage[2].data.limits[0].percentage = 99;
    p.usage[2].data.limits[0].nextResetTime = NOW + 2 * H;
    assert.deepEqual(active(), ['Card']);
    p.telemetry.Card.limited = true;
    assert.deepEqual(active(), []);
    p.telemetry.Card.limited = false;
    p.usage[2].data.limits[0].percentage = 40;
    p.pendingResets = { Peer: { status: 'submitted' } };
    assert.equal(plan(p).rows.find(r => r.name === 'Peer').weight, 0);
    assert.deepEqual(active(), []); // Only one known at-risk peer still contributes.
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { plan, timestamp } = require('../src/scheduler/planner');
const NOW = Date.UTC(2026, 10, 16, 6), H = 3600000;
function fixture() {
    const accounts = [{ name: 'A', platform: 'glm' }, { name: 'B', platform: 'glm' }, { name: 'Paid', platform: 'telecomjs' }, { name: 'Mini', platform: 'minimax' }];
    const config = { enabled: true, allowPaid: false, allowDilution: false, staleAfterSeconds: 600, resetMinRemainingMinutes: 60,
        accounts: accounts.map((a, i) => ({ name: a.name, role: i < 2 ? 'primary' : i === 2 ? 'paid' : 'dilution', mode: 'auto', maxConcurrency: 8, quotaScale: 1 })) };
    const usage = accounts.map((a, i) => ({ ...a, success: true, cachedAt: NOW, data: i < 2 ? { limits: [
        { unit: 3, percentage: 20, nextResetTime: NOW + 4 * H }, { unit: 6, percentage: 40, nextResetTime: NOW + 100 * H }
    ] } : i === 2 ? { balance: 100 } : { usage: { windows: [{ usedPct: 20, periodMs: 168 * H, resetMs: NOW + 100 * H }] } } }));
    return { accounts, config, usage, telemetry: Object.fromEntries(accounts.map(a => [a.name, { count: 1, current: 1, limited: false }])), now: NOW };
}
const row = (p, name) => plan(p).rows.find(r => r.name === name);
test('healthy accounts share load; paid and dilution remain hard-disabled', () => {
    const p = fixture();
    assert.equal(row(p, 'A').weight, row(p, 'B').weight);
    assert.ok(row(p, 'A').weight > 0);
    assert.equal(row(p, 'Paid').weight, 0);
    assert.equal(row(p, 'Mini').weight, 0);
});
test('weekly deadline increases priority and 5h scarcity reduces it', () => {
    const p = fixture(); p.usage[0].data.limits[1].nextResetTime = NOW + 8 * H;
    p.usage[1].data.limits[1].nextResetTime = NOW + 72 * H;
    assert.ok(row(p, 'A').weight > row(p, 'B').weight);
    p.usage[0].data.limits[0].percentage = 98;
    assert.ok(row(p, 'A').weight < row(p, 'B').weight);
});
test('exhaustion, stale samples, changed account identity and missing mappings never revive accounts', () => {
    const p = fixture(); p.usage[0].data.limits[0].percentage = 100;
    assert.equal(row(p, 'A').weight, 0);
    p.usage[0].data.limits[0].percentage = 0; p.usage[0].cachedAt = NOW - 601000;
    assert.equal(row(p, 'A').state, 'stale');
    p.usage[0].cachedAt = NOW; p.usage[0].name = 'Old';
    assert.equal(row(p, 'A').weight, 0);
    delete p.telemetry.B;
    assert.equal(row(p, 'B').state, 'unmapped');
});
test('reaching the reset clock is insufficient without an upstream observation', () => {
    const p = fixture(); p.usage[0].data.limits[0].nextResetTime = NOW - 1; p.usage[0].cachedAt = NOW - 2000;
    assert.equal(row(p, 'A').state, 'refreshing');
    assert.equal(row(p, 'A').weight, 0);
});
test('fallback probes paid capacity first and lets dilution fill the remaining gap with explicit permission', () => {
    const p = fixture(); p.config.allowPaid = p.config.allowDilution = true;
    assert.equal(row(p, 'Paid').weight, 0);
    p.usage[0].data.limits[1].percentage = p.usage[1].data.limits[1].percentage = 100;
    assert.ok(row(p, 'Paid').weight > 0); assert.ok(row(p, 'Mini').weight > 0);
    p.usage[2].data.balance = 0;
    assert.ok(row(p, 'Mini').weight > 0);
});
test('manual low-speed and burn modes work without bypassing quota exhaustion', () => {
    const p = fixture(); p.config.accounts[0].mode = 'slow'; p.config.accounts[1].mode = 'burst';
    assert.ok(row(p, 'B').weight > row(p, 'A').weight);
    assert.equal(row(p, 'A').concurrency, 1);
    p.usage[1].data.limits[1].percentage = 100;
    assert.equal(row(p, 'B').weight, 0);
});
test('verified card inventory accelerates ahead-of-budget usage and selects earliest expiry after exhaustion', () => {
    const p = fixture(); p.config.accounts[0].autoReset = true; p.config.accounts[0].mode = 'burst'; p.usage[0].data.limits[1].percentage = 85;
    p.telemetry.A.current = p.telemetry.B.current = 8;
    p.accounts[0].resetCards = { cards: [
        { type: 'week', recordId: 2, expireTime: NOW + 72 * H }, { type: 'week', recordId: 1, expireTime: NOW + 24 * H }
    ] };
    assert.equal(row(p, 'A').state, 'burst');
    p.usage[0].data.limits[1].percentage = 100;
    assert.equal(row(p, 'A').reset.recordId, 1);
    p.usage[0].data.limits[1].nextResetTime = NOW + 0.5 * H;
    assert.equal(row(p, 'A').reset, null);
});
test('AIMD backs off on rate limits and grows only after a stable busy interval', () => {
    const p = fixture(); p.previous = { A: { adaptiveConcurrency: 4, concurrency: 4, adjustedAt: NOW - 180000 } };
    p.telemetry.A.limited = true;
    assert.equal(row(p, 'A').adaptiveConcurrency, 2);
    p.previous.A = { adaptiveConcurrency: 2, concurrency: 2, adjustedAt: NOW - 30000, limited: true };
    assert.equal(row(p, 'A').adaptiveConcurrency, 2);
    p.telemetry.A.limited = false; p.telemetry.A.current = 2;
    p.previous.A = { adaptiveConcurrency: 2, concurrency: 2, busySince: NOW - 180000, plannedAt: NOW - 30000, adjustedAt: NOW - 180000 };
    assert.equal(row(p, 'A').adaptiveConcurrency, 3);
});
test('all alias channels receive capacity while respecting the configured pool ceiling', () => {
    const p = fixture(); p.telemetry.A.count = 3;
    p.usage[0].data.limits[1].percentage = 0;
    assert.ok(row(p, 'A').concurrency >= 3);
    assert.ok(row(p, 'A').concurrency <= 8);
});
test('paid placeholders require explicit allowance for unmetered operation', () => {
    const p = fixture(); p.config.allowPaid = true; p.usage[2] = null;
    p.usage[0].data.limits[1].percentage = p.usage[1].data.limits[1].percentage = 100;
    assert.equal(row(p, 'Paid').weight, 0);
    p.config.accounts[2].unmetered = true;
    assert.ok(row(p, 'Paid').weight > 0);
});
test('official card times are interpreted in Beijing timezone independently of container timezone', () => {
    assert.equal(timestamp('2026-11-16 14:00:00'), NOW);
});
function exhaustedWithCards() {
    const p = fixture(); p.config.accounts[0].autoReset = true; p.config.accounts[0].mode = 'burst';
    p.usage[0].data.limits[1].percentage = 100;
    p.accounts[0].resetCards = { cards: [1,2].map(recordId => ({ type: 'week', recordId, expireTime: NOW + 72 * H })) };
    p.telemetry.B.current = 8;
    return p;
}
test('half-day natural weekly reset never consumes a card even when the pool is exhausted', () => {
    const p = exhaustedWithCards(); p.usage[0].data.limits[1].nextResetTime = NOW + 12 * H;
    p.usage[1].data.limits[1].percentage = 100;
    const r = row(p, 'A'); assert.equal(r.reset, null); assert.match(r.reasons[0], /不足 24 小时/);
});
test('upcoming recharge still avoids a wasted reset', () => {
    const p = exhaustedWithCards(); p.config.accounts[0].replenishAt = new Date(NOW + 8 * H).toISOString();
    assert.match(row(p, 'A').reasons[0], /等待到账/);
});
test('an exhausted 5h window does not hold the weekly card back, because it reopens both windows', () => {
    const p = exhaustedWithCards(); p.usage[0].data.limits[0].percentage = 100;
    const r = row(p, 'A');
    assert.equal(r.weight, 0);
    assert.equal(r.reset.type, 'week');
    assert.match(r.reasons[0], /自动使用最早到期的周卡/);
});
test('explicit burst replenishment has no daily or reserve limit and no unrelated account cooldown', () => {
    const p = exhaustedWithCards(); p.accounts[0].resetCards.cards.pop();
    p.config.maxResetsPerDay = 0; p.config.reserveWeeklyCards = 10;
    p.resetBudget = { usedToday: 20, lastAttemptAt: NOW - 1000 };
    p.telemetry.A.current = p.telemetry.B.current = 0;
    assert.ok(row(p, 'A').reset);
});
test('short-window card cannot compensate for nearly exhausted weekly quota', () => {
    const p = exhaustedWithCards(); p.usage[0].data.limits[1].percentage = 90; p.usage[0].data.limits[0].percentage = 100;
    p.accounts[0].resetCards.cards.forEach(c => { c.type = 'fiveHour'; });
    assert.equal(row(p, 'A').reset, null); assert.match(row(p, 'A').reasons[0], /周额度剩余不足/);
});
test('early dilution requires opt-in timing and all primary accounts to be quota-constrained', () => {
    const p = fixture(); p.config.allowDilution = true; p.config.fallbackWhen = 'pressure';
    p.telemetry.Paid.current=0;p.telemetry.Mini.current=0;
    assert.equal(row(p, 'Mini').weight, 0);
    p.usage[0].data.limits[0].percentage = p.usage[1].data.limits[0].percentage = 90;
    assert.ok(row(p, 'Mini').weight > 0);
    assert.ok(row(p, 'Mini').share < 20);
    p.config.allowDilution = false;
    assert.equal(row(p, 'Mini').weight, 0);
});
test('confirmed forecast enables only the fallback channel at a small weight budget, preserving native MiniMax', () => {
    const p=withNativeMini();p.config.allowDilution=true;p.config.fallbackWhen='pressure';
    p.telemetry.Paid.current=0;p.telemetry.Mini.current=0;
    for(const [i,name] of ['A','B'].entries()) {
        p.usage[i].data.limits[0].percentage=i===0?70:40;
        p.usage[i].data.limits[1].percentage=10; // Isolate the 45-minute forecast from weekly quota pressure.
        p.previous||(p.previous={});
        p.previous[name]={shortRatePerHour:i===0?120:0,shortRateSamples:4};
    }
    let planned=plan(p);
    assert.equal(planned.summary.fallbackAssessment.active,false);
    p.previousSummary=planned.summary;p.now+=60000;
    planned=plan(p);const mini=planned.rows.find(r=>r.name==='Mini');
    assert.equal(planned.summary.fallbackAssessment.fraction,0.05);
    assert.ok(mini.fallbackWeight>0);assert.ok(mini.nativeWeight>0);
    assert.ok(mini.fallbackWeight<=planned.rows.filter(r=>r.role==='primary').reduce((n,r)=>n+r.weight,0)*0.05);
    assert.match(mini.reasons.join('；'),/备用分流已启用/);
    p.config.allowDilution=false;assert.equal(row(p,'Mini').fallbackWeight,0);
});
test('a paid placeholder without balance data is not reported as confirmed empty balance or silently enabled',()=>{
    const p=fixture();p.config.allowPaid=true;p.config.fallbackWhen='pressure';p.usage[2].data={};
    p.usage[0].data.limits[0].percentage=p.usage[1].data.limits[0].percentage=90;
    assert.equal(row(p,'Paid').weight,0);assert.match(row(p,'Paid').reasons.join('；'),/未提供余额数据/);
    p.config.accounts[2].unmetered=true;assert.ok(row(p,'Paid').weight>0);assert.equal(row(p,'Mini').fallbackWeight,0);
});
test('automatic decisions may replenish with opt-in; slow mode and missing permission do not', () => {
    const p = exhaustedWithCards(); p.config.accounts[0].mode = 'auto';
    assert.ok(row(p, 'A').reset);
    p.config.accounts[0].mode = 'slow'; assert.equal(row(p, 'A').reset, null);
    p.config.accounts[0].mode = 'auto'; p.config.accounts[0].autoReset = false;
    assert.equal(row(p, 'A').reset, null);
});
test('near-exhaustion and rounded CREDIT percentages never consume a card early', () => {
    const p = exhaustedWithCards();
    p.usage[0].data.limits[1].percentage = 99.95;
    assert.ok(row(p, 'A').weight > 0); assert.equal(row(p, 'A').reset, null);
    Object.assign(p.usage[0].data.limits[1], { percentage: 100, usage: 140000, currentValue: 139999, remaining: 1 });
    assert.ok(row(p, 'A').weight > 0); assert.equal(row(p, 'A').reset, null);
    Object.assign(p.usage[0].data.limits[1], { currentValue: 140000, remaining: 0 });
    assert.ok(row(p, 'A').reset);
});
function withNativeMini() {
    const p = fixture(); p.config.accounts[3].role = 'standard';
    p.config.accounts[3].channelModes = {81:'native',82:'native',104:'fallback'};
    p.telemetry.Mini.channels = [81,82,104].map(id => ({id, suggestedMode:id === 104 ? 'fallback' : 'native'}));
    p.telemetry.Mini.count = 3; return p;
}
test('native MiniMax keeps operating when replacement routes are disabled or waiting', () => {
    const p = withNativeMini();
    assert.ok(row(p, 'Mini').nativeWeight > 0); assert.equal(row(p, 'Mini').fallbackWeight, 0);
    p.config.allowDilution = true;
    assert.ok(row(p, 'Mini').nativeWeight > 0); assert.equal(row(p, 'Mini').fallbackWeight, 0);
    p.usage[0].data.limits[1].percentage = p.usage[1].data.limits[1].percentage = 100;
    assert.ok(row(p, 'Mini').nativeWeight > 0); assert.ok(row(p, 'Mini').fallbackWeight > 0);
    assert.equal(row(p, 'Mini').weight, row(p, 'Mini').nativeWeight + row(p, 'Mini').fallbackWeight);
});
test('channel modes are provider-independent, and quota exhaustion still stops every alias', () => {
    const p = withNativeMini(); p.config.accounts[0].channelModes = {1:'fallback'};
    p.telemetry.A.channels = [{id:1}];
    assert.equal(row(p, 'A').weight, 0);
    p.usage[3].data.usage.windows[0].usedPct = 100;
    assert.equal(row(p, 'Mini').weight, 0);
});
test('unselected personal accounts never receive controller decisions', () => {
    const p = fixture(); p.config.accounts = p.config.accounts.filter(x=>x.name !== 'A');
    assert.equal(row(p, 'A'), undefined);
});

test('B keeps a mixed provider’s native traffic independent from the GLM downgrade gate', () => {
    const p = withNativeMini();
    p.config.accounts[3].role = 'dilution';
    p.telemetry.Mini.channels[0].current = 8;
    p.telemetry.Mini.current = 8;
    const planned = plan(p);
    assert.ok(planned.rows.find(r => r.name === 'Mini').nativeWeight > 0);
    assert.equal(planned.rows.find(r => r.name === 'Mini').fallbackWeight, 0);
    assert.ok(planned.summary.fallbackAssessment.demand < 8);
    p.telemetry.Mini.channels[0].current = p.telemetry.Mini.current = 0;
    p.config.allowDilution = true;
    for (const u of p.usage.slice(0, 2)) u.data.limits[0].percentage = 100;
    assert.ok(row(p, 'Mini').fallbackWeight > 0);
});

test('permission for missing balance never reopens an empty prepaid account', () => {
    const p = fixture();
    for (const u of p.usage.slice(0, 2)) u.data.limits[0].percentage = 100;
    p.config.allowPaid = true;
    p.config.accounts[2].unmetered = true;
    p.usage[2].data = { balance: 0 };
    assert.equal(row(p, 'Paid').state, 'exhausted');
    p.config.accounts[2].unmetered = false;
    p.usage[2].data = { me: { balance: 2 } };
    assert.ok(row(p, 'Paid').weight > 0);
});

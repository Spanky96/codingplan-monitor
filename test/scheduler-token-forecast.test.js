'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createForecast, cutoff } = require('../src/scheduler/token-forecast');
const H = 3600000, DAY = 24 * H, T = Date.parse('2026-11-21T16:00:00+08:00');
const midnight = cutoff(T) - 18 * H;
function sample(f, now, values) {
    const accounts = values.map(a => ({ name: a.name, platform: a.platform || 'glm' }));
    const usage = values.map(a => ({ name: a.name, success: true, cachedAt: a.cachedAt ?? now, data: { level: 'max', limits: [
        { type: a.type || 'TOKENS_LIMIT', unit: 3, percentage: a.short, ...(a.shortQuota ? { usage: a.shortQuota, currentValue: a.shortQuota * a.short / 100 } : {}), nextResetTime: a.shortReset || T + 4 * H },
        { type: a.type || 'TOKENS_LIMIT', unit: 6, percentage: a.week, ...(a.weekQuota ? { usage: a.weekQuota, currentValue: a.weekQuota * a.week / 100 } : {}), nextResetTime: a.weekReset || T + 48 * H }
    ] } }));
    f.observe(accounts, usage, values.filter(a => a.paid).map(a => ({ name: a.name, role: 'paid' })), {
        generated_at: new Date(now), day_start: new Date(midnight).toISOString(), day_end: new Date(midnight + DAY).toISOString(),
        rows: values.map(a => ({ account_name: a.name + '-relay', total_tokens: a.tokens || 0 }))
    }, now);
    return f.result(now);
}

test('estimate is bounded by both quotas, counts natural recovery only for time left, and stops at Beijing 18:00 on weekends', () => {
    const f = createForecast(), end = cutoff(T);
    const a = { name: 'glm1', short: 87, week: 85, tokens: 1000, shortReset: end - H / 12 };
    assert.equal(sample(f, T, [a]).tokens, null);
    const now = T + H / 4;
    const reading = { ...a, short: 97, week: 87, tokens: 1100 };
    // 10 tokens per 1% short, 50 per 1% week and 400 tokens/hour.
    assert.equal(sample(f, now, [reading]).tokens, Math.round(30 + 400 / 12));
    const smaller = { ...a, short: 60, week: 97 };
    const other = createForecast(); sample(other, T, [smaller]);
    assert.equal(sample(other, now, [{ ...smaller, short: 70, week: 99, tokens: 1100 }]).tokens, 50);
    assert.equal(f.result(end), null);
    assert.equal(f.result(now + 5 * 60000), null);
});

test('estimates include unselected Coding Plans, borrow only matching measured tiers and report missing coverage', () => {
    const f = createForecast();
    const names = ['glm1', 'glm11', 'personal', 'other version', 'paid', 'not GLM'];
    const first = names.map((name, i) => ({ name, week: 25, short: 50, tokens: 1000,
        type: i === 3 ? 'CREDIT_LIMIT' : 'TOKENS_LIMIT', paid: i === 4, platform: i === 5 ? 'minimax' : 'glm' }));
    sample(f, T, first);
    const s = sample(f, T + H / 4, first.map((a, i) => i > 1 ? a : { ...a, week: 27, short: 60, tokens: 1100 }));
    assert.equal(s.total, 4); assert.equal(s.covered, 3); assert.equal(s.byTier, 1);
    assert.equal(s.tokens, 400 + 400 + 500); // each limited by its own remaining short budget
});

test('quota resets, idle accounts and missing samples never turn daily cumulative tokens into quota', () => {
    const f = createForecast(), a = { name: 'A', short: 20, week: 30, tokens: 10000 };
    sample(f, T, [a]);
    assert.equal(sample(f, T + H / 4, [{ ...a, short: 1, week: 32, tokens: 20000, shortReset: T + 5 * H }]).tokens, null);
    assert.equal(sample(f, T + H / 2, [{ ...a, cachedAt: T }]).covered, 0);
    const z = { ...a, week: 100 };
    assert.equal(sample(f, T + H, [z]).tokens, 0);
    assert.equal(sample(f, T + H, [z, { ...a, name: 'B' }]).tokens, null);
});

test('rounded V2 weekly deltas below two points use a conservative ceiling on burn', () => {
    const f = createForecast();
    const a = { name: 'A', short: 20, week: 98, tokens: 1000 };
    sample(f, T, [a]);
    assert.equal(sample(f, T + H / 4, [{ ...a, short: 25, week: 99, tokens: 1100 }]).tokens, 50);
    const g = createForecast();
    sample(g, T, [a]);
    assert.equal(sample(g, T + H / 4, [{ ...a, short: 25, tokens: 1100 }]).tokens, 200);
});

test('same-unit V3 CREDIT windows scale the measured short-window conversion by the official budget ratio', () => {
    const f = createForecast(), a = { name: 'A', short: 20, week: 98, tokens: 1000,
        type: 'CREDIT_LIMIT', shortQuota: 28000, weekQuota: 140000 };
    sample(f, T, [a]);
    const result = sample(f, T + H / 4, [{ ...a, short: 25, week: 99, tokens: 1100 }]);
    assert.equal(result.tokens, 100);
});

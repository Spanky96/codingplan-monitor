'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { observeWeeklyUsage } = require('../src/api/weekly-usage');
const H = 3600000, DAY = 24 * H, T = Date.parse('2026-11-18T00:00:00+08:00');
function read(records, at, used, reset = T + 3 * DAY, project = 'P') {
    return observeWeeklyUsage(records, { name: 'A', project }, { cachedAt: at, success: true, data: { limits: [
        { type: 'CREDIT_LIMIT', unit: 6, usage: 1000, currentValue: used * 10, percentage: Math.floor(used), nextResetTime: reset }
    ] } });
}
test('Beijing day baseline survives serialization, index moves and small reset clock drift', () => {
    const records = {};
    read(records, T - 1000, 41);
    read(records, T + 1000, 42);
    const d = read(JSON.parse(JSON.stringify(records)), T + 15 * H, 67.2, T + 3 * DAY + 500);
    assert.deepEqual(d, { day: T, from: 42, to: 67.2, since: T + 1000, source: 'midnight' });
    assert.equal(read(records, T + 15 * H, 67.2, T + 3 * DAY, 'replacement').from, 67.2);
});
test('missed midnight is labeled from the first reading and a new official week starts at zero', () => {
    const records = {};
    assert.equal(read(records, T + H, 80).source, 'sample');
    const start = T + 2 * H;
    const r = read(records, start + 5000, 0.3, start + 7 * DAY);
    assert.deepEqual(r, { day: T, from: 0, to: 0.3, since: start, source: 'reset' });
    const d = read(records, T + DAY + H, 15, start + 7 * DAY);
    assert.equal(d.from, 15); assert.equal(d.source, 'sample');
});

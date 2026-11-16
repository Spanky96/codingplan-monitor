'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const context = { Date, isFinite }; vm.createContext(context);
vm.runInContext(fs.readFileSync(require('node:path').join(__dirname, '../public/js/app/status.js'), 'utf8'), context);
test('exhausted tooltip waits for the latest of exhausted windows and ignores MCP', () => {
    const now = Date.now(), acc = { success: true, platform: 'glm', data: { limits: [
        { unit: 3, percentage: 100, nextResetTime: now + 3600000 },
        { unit: 6, percentage: 100, nextResetTime: now + 3 * 86400000 },
        { unit: 5, percentage: 100, nextResetTime: now + 30 * 86400000 }
    ] } };
    assert.match(context.quotaStatusHint(acc, now), /已耗尽，约 3 天无法使用/);
    acc.data.limits[1].nextResetTime = undefined;
    assert.match(context.quotaStatusHint(acc, now), /恢复时间待确认/);
});
test('forecast for an available account is explicitly predictive', () => {
    const a = { success: true, resetRecommendation: { needed: true, unavailableHours: 48, weeklyPct: 80, theoPct: 40 } };
    assert.match(context.quotaStatusHint(a), /预计提前耗尽/);
    assert.doesNotMatch(context.quotaStatusHint(a), /已耗尽/);
});

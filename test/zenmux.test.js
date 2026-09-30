var test = require('node:test');
var assert = require('node:assert/strict');

var zenmux = require('../src/api/platforms/zenmux');
var weights = require('../src/weights');

test('ZenMux subscription response is normalized into Flow windows', function() {
    var parsed = zenmux.parseZenmuxSubscription({
        success: true,
        data: {
            plan: { tier: 'ultra', amount_usd: 200, interval: 'month', expires_at: '2026-10-09T03:02:00.000Z' },
            currency: 'usd',
            base_usd_per_flow: 0.03283,
            effective_usd_per_flow: 0.03283,
            account_status: 'healthy',
            quota_5_hour: {
                usage_percentage: 0.0715,
                resets_at: '2026-09-30T06:35:09.000Z',
                max_flows: 800,
                used_flows: 57.2,
                remaining_flows: 742.8,
                used_value_usd: 1.88,
                max_value_usd: 26.27
            },
            quota_7_day: {
                usage_percentage: 0.6907,
                resets_at: '2026-09-30T06:49:00.000Z',
                max_flows: 3414,
                used_flows: 2358.65,
                remaining_flows: 1055.35,
                used_value_usd: 77.43,
                max_value_usd: 112.1
            },
            quota_monthly: { max_flows: 14631, max_value_usd: 480.4 }
        }
    });

    assert.equal(parsed.subscription.planName, 'ZenMux Ultra');
    assert.equal(parsed.subscription.amountUsd, 200);
    assert.equal(parsed.accountStatus, 'healthy');
    assert.ok(Math.abs(parsed.usage.windows[0].usedPct - 7.15) < 1e-9);
    assert.equal(parsed.usage.windows[0].quota, 800);
    assert.equal(parsed.usage.windows[1].usedPct, 69.07);
    assert.deepEqual(parsed.monthlyQuota, { maxFlows: 14631, maxValueUsd: 480.4 });
});

test('ZenMux authorization accepts raw and Bearer-prefixed Management keys', function() {
    assert.equal(zenmux.zenmuxAuthorization({ authorization: 'sk-mg-v1-test' }), 'Bearer sk-mg-v1-test');
    assert.equal(zenmux.zenmuxAuthorization({ authorization: 'Bearer sk-mg-v1-test' }), 'Bearer sk-mg-v1-test');
});

test('ZenMux model usage merges adjacent months into a Beijing-time period', function() {
    var chart = zenmux.parseZenmuxModelUsage([
        { success: true, data: { tokensByModel: [
            { bizTime: '20260929', modelSlug: 'anthropic/claude-sonnet-4.5', tokens: '100', requestCounts: '2' },
            { bizTime: '20260930', modelSlug: 'anthropic/claude-sonnet-4.5', tokens: '200', requestCounts: '3' }
        ] } },
        { success: true, data: { tokensByModel: [
            { bizTime: '20261001', modelSlug: 'openai/gpt-5', tokens: '300', requestCounts: '4' }
        ] } }
    ], '7d', Date.UTC(2026, 9, 1, 8));

    assert.deepEqual(chart.x_time, [
        '2026-09-25', '2026-09-26', '2026-09-27', '2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01'
    ]);
    assert.deepEqual(chart.modelDataList[0].tokensUsage, [0, 0, 0, 0, 100, 200, 0]);
    assert.deepEqual(chart.modelDataList[1].tokensUsage, [0, 0, 0, 0, 0, 0, 300]);
    assert.deepEqual(chart.totalUsage, { totalTokensUsage: 600, totalModelCallCount: 9 });
});

test('ZenMux today usage converts decimal strings to numbers', function() {
    assert.deepEqual(zenmux.parseZenmuxTodayUsage({
        success: true,
        data: { tokensTotal: '1500', tokensPrompt: '1000', tokensCompletion: '500', requestCounts: '12' }
    }), { tokensTotal: 1500, tokensPrompt: 1000, tokensCompletion: 500, requestCounts: 12 });
});

test('ZenMux Flow windows participate in unified account weights', function() {
    var now = Date.now();
    var score = weights.scoreAccount({
        platform: 'zenmux',
        data: { usage: { windows: [
            { label: '每5小时', usedPct: 20, resetMs: now + 4 * 3600000, periodMs: 5 * 3600000 },
            { label: '每周', usedPct: 30, resetMs: now + 6 * 86400000, periodMs: 7 * 86400000 }
        ] } }
    });

    assert.ok(score);
    assert.equal(score.exhausted, false);
    assert.equal(score.windows.length, 2);
    assert.ok(score.weight > 0);
});

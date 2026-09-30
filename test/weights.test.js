'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var weights = require('../src/weights');

function telecomData(overrides) {
    return {
        platform: 'telecomjs',
        data: Object.assign({
            balance: 90,
            platformGiftBalance: 0,
            sevenDayConsumption: 2,
            consumptionRangeDays: 2
        }, overrides || {})
    };
}

test('telecom capacity score follows available-day buckets', function() {
    assert.equal(weights.telecomCapacityScore(0), 0);
    assert.equal(weights.telecomCapacityScore(6.99), 1);
    assert.equal(weights.telecomCapacityScore(7), 2);
    assert.equal(weights.telecomCapacityScore(14), 3);
    assert.equal(weights.telecomCapacityScore(30), 4);
    assert.equal(weights.telecomCapacityScore(60), 5);
    assert.equal(weights.telecomCapacityScore(90), 6);
    assert.equal(weights.telecomCapacityScore(Infinity), 6);
});

test('telecom peak multiplier uses China time regardless of server timezone', function() {
    assert.equal(weights.telecomTimeMultiplier(Date.UTC(2026, 6, 16, 5, 59)), 0.5); // 13:59 CST
    assert.equal(weights.telecomTimeMultiplier(Date.UTC(2026, 6, 16, 6, 0)), 2);    // 14:00 CST
    assert.equal(weights.telecomTimeMultiplier(Date.UTC(2026, 6, 16, 9, 59)), 2);   // 17:59 CST
    assert.equal(weights.telecomTimeMultiplier(Date.UTC(2026, 6, 16, 10, 0)), 0.5); // 18:00 CST
});

test('telecom weight rises when CodingPlan accounts are tighter', function() {
    var peak = Date.UTC(2026, 6, 16, 7, 0); // 15:00 CST
    var healthy = weights.scoreTelecomAccount(telecomData(), [{ weight: 6 }], peak);
    var tight = weights.scoreTelecomAccount(telecomData(), [{ weight: 0 }, { weight: 2 }], peak);

    assert.equal(healthy.remainingDays, 90);
    assert.equal(healthy.capacityScore, 6);
    assert.equal(healthy.codingPressure, 1);
    assert.equal(healthy.timeMultiplier, 2);
    assert.equal(healthy.weight, 12);
    assert.ok(tight.codingPressure > healthy.codingPressure);
    assert.ok(tight.weight > healthy.weight);
});

test('telecom off-peak weight is one quarter of its peak weight', function() {
    var account = telecomData();
    var coding = [{ weight: 3 }];
    var peak = weights.scoreTelecomAccount(account, coding, Date.UTC(2026, 6, 16, 7, 0));
    var offPeak = weights.scoreTelecomAccount(account, coding, Date.UTC(2026, 6, 16, 2, 0));

    assert.equal(peak.timeMultiplier, 2);
    assert.equal(offPeak.timeMultiplier, 0.5);
    assert.equal(peak.weight, offPeak.weight * 4);
});

test('telecom zero balance is exhausted and no-consumption balance gets full capacity', function() {
    var offPeak = Date.UTC(2026, 6, 16, 2, 0);
    var exhausted = weights.scoreTelecomAccount(telecomData({ balance: 0 }), [], offPeak);
    var unused = weights.scoreTelecomAccount(telecomData({ sevenDayConsumption: 0, consumptionRangeDays: 0 }), [], offPeak);

    assert.equal(exhausted.weight, 0);
    assert.equal(exhausted.exhausted, true);
    assert.equal(unused.capacityScore, 6);
    assert.equal(unused.remainingDays, null);
    assert.equal(unused.noConsumption, true);
});

function qwenData(overrides) {
    return {
        platform: 'qwen',
        data: Object.assign({
            usage: { per5HourPercentage: 0, per1WeekPercentage: 0 },
            subscription: null
        }, overrides || {})
    };
}

test('qwen token plan maps 5h/7d percentages into two windows', function() {
    var result = weights.scoreAccount(qwenData());
    assert.equal(result.weight, 6);
    assert.equal(result.exhausted, false);
    assert.equal(result.windows.length, 2);
    assert.deepEqual(result.windows.map(function(w) { return w.label; }), ['5h', '7d']);
    // 接口无重置时间 -> theoPct 为 -1
    assert.equal(result.windows[0].theoPct, -1);
    assert.equal(result.windows[1].theoPct, -1);
});

test('qwen weight is the bottleneck of 5h and 7d usage', function() {
    // 5h=50%(分 3),7d=20%(分 5) -> 瓶颈 3
    var tight = weights.scoreAccount(qwenData({ usage: { per5HourPercentage: 50, per1WeekPercentage: 20 } }));
    assert.equal(tight.weight, 3);
    // 5h=0(分 6),7d=60%(分 3) -> 瓶颈 3
    var weekly = weights.scoreAccount(qwenData({ usage: { per5HourPercentage: 0, per1WeekPercentage: 60 } }));
    assert.equal(weekly.weight, 3);
});

test('qwen is exhausted when any window hits 99.9%', function() {
    var exhausted = weights.scoreAccount(qwenData({ usage: { per5HourPercentage: 0, per1WeekPercentage: 100 } }));
    assert.equal(exhausted.weight, 0);
    assert.equal(exhausted.exhausted, true);
});

test('qwen uses reset times for rate-based scoring when available', function() {
    var now = Date.UTC(2026, 6, 22, 0, 0);
    var realNow = Date.now;
    Date.now = function() { return now; };
    try {
        // 重置时间居中 -> 两窗口 theoPct 均为 50%;低用量 ratio<0.5 -> 满分 6
        var result = weights.scoreAccount(qwenData({
            usage: {
                per5HourPercentage: 10, per1WeekPercentage: 5,
                per5HourResetTime: now + 2.5 * 3600000,
                per1WeekResetTime: now + 3.5 * 86400000
            }
        }));
        assert.equal(result.windows[0].theoPct, 50);
        assert.equal(result.windows[1].theoPct, 50);
        assert.equal(result.weight, 6);
    } finally {
        Date.now = realNow;
    }
});

// ============ 余额兜底:订阅耗尽但有余额不清零 ============

function s2aData(overrides) {
    return Object.assign({
        platform: 'sub2api',
        data: {
            me: { balance: 230.79 },
            current: {
                status: 'expired',
                expires_at: '2026-07-31T21:59:15+08:00',
                daily_usage_usd: 30.03,
                daily_window_start: '2026-07-31T00:00:00+08:00',
                group: { name: '1天卡', daily_limit_usd: 30 }
            },
            subscriptions: []
        }
    }, overrides || {});
}

test('sub2api expired subscription with balance keeps nonzero weight via balance window', function() {
    var result = weights.scoreAccount(s2aData());
    assert.equal(result.exhausted, false);
    assert.equal(result.weight > 0, true);
    var labels = result.windows.map(function(w) { return w.label; });
    assert.deepEqual(labels, ['余额']); // 过期卡不再作为约束
});

test('sub2api exhausted active subscription with balance is floored, not zeroed', function() {
    var result = weights.scoreAccount(s2aData({
        data: {
            me: { balance: 15 },
            current: {
                status: 'active',
                daily_usage_usd: 30, daily_window_start: new Date(Date.now() - 3600000).toISOString(),
                group: { daily_limit_usd: 30 }
            },
            subscriptions: []
        }
    }));
    assert.equal(result.exhausted, false);
    assert.equal(result.weight, 1); // 耗尽窗口降为 1,余额 $15 → 3,min = 1
    var today = result.windows.filter(function(w) { return w.label === '今日'; })[0];
    assert.equal(today.exhausted, false);
    assert.equal(today.score, 1);
});

test('sub2api exhausted subscription without balance stays zero', function() {
    var result = weights.scoreAccount(s2aData({
        data: {
            me: { balance: 0 },
            current: {
                status: 'active',
                daily_usage_usd: 30, daily_window_start: new Date(Date.now() - 3600000).toISOString(),
                group: { daily_limit_usd: 30 }
            },
            subscriptions: []
        }
    }));
    assert.equal(result.exhausted, true);
    assert.equal(result.weight, 0);
});

test('sub2api no subscription with balance scores by balance alone', function() {
    var result = weights.scoreAccount({ platform: 'sub2api', data: { me: { balance: 230 }, subscriptions: [], current: null } });
    assert.equal(result.weight, 6);
    assert.equal(result.exhausted, false);
});

test('legacy huoli array shape without balance keeps exhausted-to-zero behavior', function() {
    var result = weights.scoreAccount({ platform: 'huoli', data: [
        { daily_usage_usd: 30, daily_window_start: new Date(Date.now() - 3600000).toISOString(), group: { daily_limit_usd: 30 } }
    ] });
    assert.equal(result.exhausted, true);
    assert.equal(result.weight, 0);
});

test('yescode exhausted monthly limit with payg balance is floored, not zeroed', function() {
    var result = weights.scoreAccount({
        platform: 'yescode',
        data: {
            subscription_balance: 0,
            pay_as_you_go_balance: 20,
            credit_balance: 0,
            current_month_spend: 1800,
            last_month_reset: new Date(Date.now() - 15 * 86400000).toISOString(),
            subscription_plan: { daily_balance: 300, last_daily_balance_add: new Date().toISOString(), monthly_spend_limit: 1800 }
        }
    });
    assert.equal(result.exhausted, false);
    assert.equal(result.weight > 0, true);
});

test('yescode exhausted without extra money stays zero', function() {
    var result = weights.scoreAccount({
        platform: 'yescode',
        data: {
            subscription_balance: 0,
            pay_as_you_go_balance: 0,
            credit_balance: 0,
            current_month_spend: 1800,
            last_month_reset: new Date(Date.now() - 15 * 86400000).toISOString(),
            subscription_plan: { daily_balance: 300, monthly_spend_limit: 1800 }
        }
    });
    assert.equal(result.exhausted, true);
    assert.equal(result.weight, 0);
});

test('balance score maps usd magnitude to 1-6 tiers', function() {
    assert.equal(weights.balanceScore(230), 6);
    assert.equal(weights.balanceScore(60), 5);
    assert.equal(weights.balanceScore(25), 4);
    assert.equal(weights.balanceScore(12), 3);
    assert.equal(weights.balanceScore(6), 2);
    assert.equal(weights.balanceScore(0.5), 1);
});

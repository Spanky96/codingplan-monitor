'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var os = require('os');
var path = require('path');

var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stepfun-'));
process.env.ACCOUNTS_FILE = path.join(tmpDir, 'accounts.json');
process.env.USAGE_CACHE_FILE = path.join(tmpDir, 'usage-cache.json');
process.env.ADMIN_PASSWORD = 'test-pwd';
fs.writeFileSync(process.env.ACCOUNTS_FILE, JSON.stringify({ accounts: [] }));
fs.writeFileSync(process.env.USAGE_CACHE_FILE, '{}');

var api = require('../src/api');
var weights = require('../src/weights');

// 与线上 GetStepPlanStatus 响应同构的样例（Plus 套餐，30 天周期）
function planStatusResponse() {
    return {
        status: 1,
        desc: '',
        subscription: {
            plan_type: 1,
            name: 'Plus',
            status: 1,
            pay_channel: 3,
            activated_at: '1789875733',
            expired_at: '1792467733',
            auto_renew: false,
            plan_id: '21',
            plan_family: 2
        },
        agreement: null,
        plan_definition: {
            type: 1,
            price: '9900',
            duration_days: 30,
            support_models: ['step-3.7-flash', 'step-router-v1', 'step-5-preview'],
            available: true,
            original_price: '9900',
            billing_cycle: 1,
            plan_family: 2
        }
    };
}

// 与线上 QueryStepPlanRateLimit 响应同构的样例（credit 制，16 亿积分/30 天）
function rateLimitResponse(leftRate, buckets) {
    return {
        status: 1,
        desc: '',
        five_hour_usage_left_rate: 0,
        five_hour_usage_reset_time: '0',
        weekly_usage_left_rate: 0,
        weekly_usage_reset_time: '0',
        plan_family: 2,
        plan_credit_rate_limit: {
            subscription_credit_left_rate: leftRate,
            subscription_credit_reset_time: '0',
            topup_credit_left_rate: 0,
            credit_buckets: buckets != null ? buckets : [
                { type: 1, credit_total: '1600000000', credit_residual: '1600000000', expire_at: '1792467733', next_reset_at: '0' }
            ]
        }
    };
}

// 与线上 QueryStepPlanUsages 响应同构的样例（UTC 日桶 × 模型，int64 为字符串）
function usagesResponse(records) {
    return { status: 1, desc: '', records: records, total: records.length };
}

test('stepfun plan status parses subscription summary with beijing expire date', function() {
    var sub = api._parseStepfunPlanStatus(planStatusResponse());
    assert.equal(sub.planName, 'Plus');
    assert.equal(sub.statusText, '生效中');
    assert.equal(sub.autoRenew, false);
    // activated_at=1789875733(2026-09-19 11:42 北京)，expired_at=1792467733(2026-10-20 11:42 北京)
    assert.equal(sub.activatedMs, 1789875733000);
    assert.equal(sub.expireMs, 1792467733000);
    assert.equal(sub.expireDate, '2026-10-20');
    assert.equal(sub.priceYuan, 99);
    assert.equal(sub.durationDays, 30);
    assert.deepEqual(sub.supportModels, ['step-3.7-flash', 'step-router-v1', 'step-5-preview']);
});

test('stepfun plan status is null without subscription (未订阅)', function() {
    var json = planStatusResponse();
    json.subscription = null;
    assert.equal(api._parseStepfunPlanStatus(json), null);
    assert.equal(api._parseStepfunPlanStatus(null), null);
});

test('stepfun rate limit builds a single monthly credit window (5h/weekly 为「无此窗口」而非 0% 剩余)', function() {
    var sub = api._parseStepfunPlanStatus(planStatusResponse());
    var windows = api._parseStepfunRateLimit(rateLimitResponse(1), sub);
    assert.equal(windows.length, 1);
    var w = windows[0];
    assert.equal(w.label, '月度积分');
    assert.equal(w.usedPct, 0);
    assert.equal(w.used, 0);
    assert.equal(w.quota, 1600000000);
    assert.equal(w.resetMs, 1792467733000);
    // 周期 = 激活→到期的真实时长（30 天）
    assert.equal(w.periodMs, 2592000000);
    assert.equal(w.segments, 0);
});

test('stepfun rate limit converts left rate to used percent', function() {
    var sub = api._parseStepfunPlanStatus(planStatusResponse());
    var windows = api._parseStepfunRateLimit(rateLimitResponse(0.75), sub);
    assert.equal(windows.length, 1);
    assert.equal(windows[0].usedPct, 25);
});

test('stepfun rate limit falls back to credit buckets when left rate missing', function() {
    var sub = api._parseStepfunPlanStatus(planStatusResponse());
    var json = rateLimitResponse(undefined, [
        { type: 1, credit_total: '1600000000', credit_residual: '1200000000', expire_at: '1792467733', next_reset_at: '0' }
    ]);
    var windows = api._parseStepfunRateLimit(json, sub);
    assert.equal(windows.length, 1);
    assert.equal(windows[0].usedPct, 25);
    assert.equal(windows[0].used, 400000000);
    assert.equal(windows[0].quota, 1600000000);
});

test('stepfun rate limit adds 5h/weekly windows only when reset time is set', function() {
    var sub = api._parseStepfunPlanStatus(planStatusResponse());
    var json = rateLimitResponse(0.9);
    json.five_hour_usage_reset_time = '1789877000';
    json.five_hour_usage_left_rate = 0.5;
    json.weekly_usage_reset_time = '1790304000';
    json.weekly_usage_left_rate = 0.8;
    var windows = api._parseStepfunRateLimit(json, sub);
    assert.equal(windows.length, 3);
    assert.equal(windows[1].label, '5h 限额');
    assert.equal(windows[1].usedPct, 50);
    assert.equal(windows[1].resetMs, 1789877000000);
    assert.equal(windows[1].periodMs, 5 * 3600000);
    assert.equal(windows[1].segments, 5);
    assert.equal(windows[2].label, '周限额');
    assert.equal(windows[2].usedPct, 20);
    assert.equal(windows[2].segments, 7);
});

test('stepfun rate limit separates topup bucket window', function() {
    var sub = api._parseStepfunPlanStatus(planStatusResponse());
    var json = rateLimitResponse(1, [
        { type: 1, credit_total: '1600000000', credit_residual: '1500000000', expire_at: '1792467733', next_reset_at: '0' },
        { type: 2, credit_total: '800000000', credit_residual: '600000000', expire_at: '1792467733', next_reset_at: '0' }
    ]);
    var windows = api._parseStepfunRateLimit(json, sub);
    assert.equal(windows.length, 2);
    assert.equal(windows[0].label, '月度积分');
    assert.equal(windows[1].label, '充值积分');
    assert.equal(windows[1].usedPct, 25);
    assert.equal(windows[1].used, 200000000);
    assert.equal(windows[1].quota, 800000000);
});

test('stepfun rate limit tolerates null input', function() {
    var sub = api._parseStepfunPlanStatus(planStatusResponse());
    assert.deepEqual(api._parseStepfunRateLimit(null, sub), []);
});

test('stepfun usages aggregate per model sorted by credits desc', function() {
    var res = api._parseStepfunUsages(usagesResponse([
        { from_time: '1789862400000', to_time: '1789948800000', model_id: 'step-5-preview', calls: 1, credit_consumed: '2930', model_type: 1 },
        { from_time: '1789948800000', to_time: '1790035200000', model_id: 'step-5-preview', calls: 2, credit_consumed: '6000', model_type: 1 },
        { from_time: '1789948800000', to_time: '1790035200000', model_id: 'step-3.7-flash', calls: 3, credit_consumed: '100000', model_type: 1 }
    ]));
    assert.deepEqual(res.models, [
        { modelId: 'step-3.7-flash', credits: 100000, calls: 3 },
        { modelId: 'step-5-preview', credits: 8930, calls: 3 }
    ]);
    assert.equal(res.totalCredits, 108930);
    assert.equal(res.totalCalls, 6);
    // 空记录 → 全零
    var empty = api._parseStepfunUsages(usagesResponse([]));
    assert.deepEqual(empty.models, []);
    assert.equal(empty.totalCredits, 0);
});

test('stepfun model usage chart maps UTC day buckets to beijing dates with zero fill', function() {
    var chart = api._parseStepfunModelUsage(usagesResponse([
        { from_time: '1789862400000', to_time: '1789948800000', model_id: 'step-5-preview', calls: 1, credit_consumed: '2930', model_type: 1 },
        { from_time: '1789948800000', to_time: '1790035200000', model_id: 'step-5-preview', calls: 2, credit_consumed: '6000', model_type: 1 },
        { from_time: '1789948800000', to_time: '1790035200000', model_id: 'step-3.7-flash', calls: 3, credit_consumed: '100000', model_type: 1 }
    ]), 7);
    // UTC 日桶（00:00 UTC 起）→ 北京日期标签（+8h 不跨日，同为当日）
    assert.deepEqual(chart.x_time, ['2026-09-20', '2026-09-21']);
    var byName = {};
    chart.modelDataList.forEach(function(m) { byName[m.modelName] = m.tokensUsage; });
    assert.deepEqual(byName['step-5-preview'], [2930, 6000]);
    assert.deepEqual(byName['step-3.7-flash'], [0, 100000]);
    assert.equal(chart.totalUsage.totalTokensUsage, 108930);
    assert.equal(api._parseStepfunModelUsage(usagesResponse([]), 7), null);
});

test('stepfun model usage chart keeps only last N days', function() {
    var records = [];
    for (var i = 0; i < 9; i++) {
        // 2026-09-12 起 9 个 UTC 日桶
        records.push({ from_time: String((1789344000000 + i * 86400000)), to_time: String((1789430400000 + i * 86400000)), model_id: 'm', calls: 1, credit_consumed: '10', model_type: 1 });
    }
    var chart = api._parseStepfunModelUsage(usagesResponse(records), 7);
    assert.equal(chart.x_time.length, 7);
    // 9 天（09-14..09-22）截取最后 7 天
    assert.equal(chart.x_time[0], '2026-09-16');
    assert.equal(chart.x_time[6], '2026-09-22');
    assert.equal(chart.totalUsage.totalTokensUsage, 70);
});

test('stepfun helpers: webid / mobile mask / cookie replace / time', function() {
    assert.equal(api._stepfunWebid({ stepfun_webid: 'wid-1' }), 'wid-1');
    assert.equal(api._stepfunWebid({ cookie: 'Oasis-Webid=abc123; _wafdytokenv1=k' }), 'abc123');
    assert.equal(api._stepfunWebid({}), '');

    assert.equal(api._stepfunMaskMobile('18795905631'), '187****5631');
    assert.equal(api._stepfunMaskMobile('123'), null);
    assert.equal(api._stepfunMaskMobile(null), null);

    var ck = 'Oasis-Webid=w; Oasis-Token=OLD; _wafdytokenv1=k';
    assert.equal(api._stepfunReplaceTokenCookie(ck, 'NEW'), 'Oasis-Webid=w; Oasis-Token=NEW; _wafdytokenv1=k');
    assert.equal(api._stepfunReplaceTokenCookie('Oasis-Token=OLD; a=1', 'NEW'), 'Oasis-Token=NEW; a=1');
    assert.equal(api._stepfunReplaceTokenCookie('a=1', 'NEW'), 'a=1; Oasis-Token=NEW');
    assert.equal(api._stepfunReplaceTokenCookie('', 'NEW'), 'Oasis-Token=NEW');

    assert.equal(api._stepfunSecToMs('0'), 0);
    assert.equal(api._stepfunSecToMs('1792467733'), 1792467733000);
    assert.equal(api._stepfunSecToMs(''), 0);

    // 北京当日零点：2026-09-20 12:04 北京 → 2026-09-20 00:00 北京（= 2026-09-19 16:00 UTC）
    assert.equal(api._stepfunBeijingTodayStart(1789963470000), 1789920000000);
});

test('stepfun windows feed weights.scoreAccount via shared contract', function() {
    var score = weights.scoreAccount({
        platform: 'stepfun',
        data: {
            usage: {
                windows: [
                    { label: '月度积分', usedPct: 40, resetMs: Date.now() + 25 * 86400000, periodMs: 30 * 86400000, segments: 0 }
                ]
            },
            subscription: {}
        }
    });
    assert.ok(score, '有月度积分窗口时应产生评分');
    assert.equal(score.windows.length, 1);
    assert.equal(score.used7d, 40);
    assert.equal(score.exhausted, false);
});

test('stepfun without usage data scores null so default weight applies', function() {
    var score = weights.scoreAccount({ platform: 'stepfun', data: { usage: null, subscription: {} } });
    assert.equal(score, null);
});

// 与线上 GetCampaignInviteLink / ListCampaignInvites / GetCampaignStatus 响应同构的样例
test('stepfun campaign parses invite link, invites and reward ledger', function() {
    var c = api._parseStepfunCampaign(
        { invite_code: 'IRUGMYGI', invite_count: 1, invite_max_count: 3, remaining_reward_days: 30 },
        { invites: [
            { invitee_masked_phone: '138****5678', invitee_nickname: '好友A', reward_days: 15, used_at: '1789600000' }
        ] },
        { rewards: [
            { reward_type: 1, reward_days: 15, status: 2, activated_at: '1789600000', expired_at: '1790900000' },
            { reward_type: 4, reward_days: 15, status: 1, activated_at: '0', expired_at: '0' }
        ] }
    );
    assert.equal(c.inviteCode, 'IRUGMYGI');
    assert.equal(c.inviteUrl, 'https://platform.stepfun.com/?invite_code_v2=IRUGMYGI');
    assert.equal(c.inviteCount, 1);
    assert.equal(c.inviteMaxCount, 3);
    assert.equal(c.remainingRewardDays, 30);
    assert.equal(c.invites.length, 1);
    assert.equal(c.invites[0].nickname, '好友A');
    assert.equal(c.invites[0].maskedPhone, '138****5678');
    assert.equal(c.invites[0].rewardDays, 15);
    assert.equal(c.invites[0].usedAtMs, 1789600000000);
    assert.deepEqual(c.rewards.map(function(r) { return r.rewardType; }), ['register', 'invite']);
    assert.equal(c.rewards[0].activatedMs, 1789600000000);
});

test('stepfun campaign tolerates partial/empty inputs', function() {
    // 未拿到邀请码（接口失败）→ null，前端不渲染该节
    assert.equal(api._parseStepfunCampaign(null, null, null), null);
    // 只拿到链接：记录/奖励为空数组
    var only = api._parseStepfunCampaign({ invite_code: 'ABC', invite_count: 0, invite_max_count: 3 }, null, null);
    assert.equal(only.inviteCount, 0);
    assert.deepEqual(only.invites, []);
    assert.deepEqual(only.rewards, []);
    // 空邀请列表
    var empty = api._parseStepfunCampaign({ invite_code: 'ABC' }, { invites: [] }, { rewards: [] });
    assert.deepEqual(empty.invites, []);
});

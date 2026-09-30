'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var os = require('os');
var path = require('path');

var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minimax-'));
process.env.ACCOUNTS_FILE = path.join(tmpDir, 'accounts.json');
process.env.USAGE_CACHE_FILE = path.join(tmpDir, 'usage-cache.json');
process.env.ADMIN_PASSWORD = 'test-pwd';
fs.writeFileSync(process.env.ACCOUNTS_FILE, JSON.stringify({ accounts: [] }));
fs.writeFileSync(process.env.USAGE_CACHE_FILE, '{}');

var api = require('../src/api');
var weights = require('../src/weights');

// 与线上 message/box(message_category=4) 响应同构的样例(权益发放通知)
function messageBoxResponse(infos) {
    return {
        template_infos: infos,
        not_read_count: 0,
        total_count: infos.length,
        base_resp: { status_code: 0, status_msg: 'success' }
    };
}

function planMessage(planName, expireDate, sendTime) {
    return {
        template_info: {
            template_id: 380887392731200,
            name: 'Token Plan 权益发放通知',
            content: '您已成功获得 <b>' + planName + '</b> 权益。当前权益有效期截止至 <b>' + expireDate + '</b>。',
            type: 47,
            create_at: sendTime - 1,
            update_at: sendTime - 1,
            delete_at: 0,
            title: '您已成功获得 <b>' + planName + '</b> 权益。当前权益有效期截止至 <b>' + expireDate + '</b>。'
        },
        receiver_address: '2082871950555750610',
        send_type: 3,
        not_read: false,
        message_category: 4,
        send_time: sendTime,
        notification_id: 425670361952552
    };
}

test('minimax subscription parses plan name and expire date from benefit notice', function() {
    var sub = api._parseMinimaxSubscription(messageBoxResponse([
        planMessage('Token Plan Max (1个月)', '2026年08月30日', 1785477404776)
    ]));
    assert.equal(sub.planName, 'Token Plan Max (1个月)');
    assert.equal(sub.expireDate, '2026-08-30');
    assert.equal(sub.notifiedAt, 1785477404776);
    // 到期时间取当日 23:59:59(本地时区),保证「天后到期」计数当天仍剩 1 天
    var end = new Date(sub.expireMs);
    assert.equal(end.getHours(), 23);
    assert.equal(end.getMinutes(), 59);
});

test('minimax subscription picks the latest notice on renewals', function() {
    var sub = api._parseMinimaxSubscription(messageBoxResponse([
        planMessage('Token Plan Max (1个月)', '2026年08月30日', 1785477404776),
        planMessage('Token Plan Pro (1个月)', '2026年09月30日', 1788155804776)
    ]));
    assert.equal(sub.planName, 'Token Plan Pro (1个月)');
    assert.equal(sub.expireDate, '2026-09-30');
});

test('minimax subscription skips notices without an expire date', function() {
    var noDate = planMessage('Token Plan Max (1个月)', '2026年08月30日', 1785477404776);
    noDate.template_info.content = '感谢您使用 MiniMax。';
    delete noDate.template_info.title;
    var sub = api._parseMinimaxSubscription(messageBoxResponse([noDate]));
    assert.equal(sub, null);
});

test('minimax subscription is null for empty message box', function() {
    assert.equal(api._parseMinimaxSubscription(messageBoxResponse([])), null);
    assert.equal(api._parseMinimaxSubscription({}), null);
    assert.equal(api._parseMinimaxSubscription(null), null);
});

// ============ 订阅到期:官方订阅接口(charge/combo)优先,消息盒子兜底 ============
// 与线上 cycle_audio_resource_package 响应同构的样例:
// current_subscribe_end_time_ts 为北京时间次日零点(1788019200000 = 2026-08-30 00:00 CST,即 08-29 24 点到期)
function chargeResponse(endTs, title) {
    return {
        current_subscribe: {
            current_subscribe_title: title,
            current_subscribe_end_time: '08/30/2026',
            current_subscribe_end_time_ts: endTs,
            renewal_date: '08/29/2026',
            renewal_trigger_time_ts: 1787932800000,
            renewal_state: 0
        },
        base_resp: { status_code: 0, status_msg: 'success' }
    };
}

test('minimax subscribe info takes plan title and Beijing-time expire date from charge api', function() {
    var sub = api._parseMinimaxSubscribeInfo(chargeResponse(1788019200000, 'TokenPlanMax-月度会员'));
    assert.equal(sub.planName, 'TokenPlanMax-月度会员');
    assert.equal(sub.expireDate, '2026-08-30');
    assert.equal(sub.expireMs, 1788019200000);
});

test('minimax subscribe info returns null without current subscription', function() {
    assert.equal(api._parseMinimaxSubscribeInfo({ base_resp: { status_code: 0 } }), null);
    assert.equal(api._parseMinimaxSubscribeInfo(chargeResponse(0, 'Plus')), null);
    assert.equal(api._parseMinimaxSubscribeInfo(null), null);
});

test('minimax merge prefers charge api over stale benefit notice (renewed account)', function() {
    // 官方 08-30 到期,消息盒子仍停留在上一周期 08-18 → 以官方为准,不再误标已过期
    var sub = api._minimaxMergeSubscription(
        chargeResponse(1788019200000, 'TokenPlanMax-月度会员'),
        messageBoxResponse([planMessage('Token Plan Max (1个月)', '2026年08月18日', 1785477404776)])
    );
    assert.equal(sub.expireDate, '2026-08-30');
    assert.equal(sub.planName, 'TokenPlanMax-月度会员');
});

test('minimax merge falls back to benefit notice when charge api has no subscription', function() {
    var sub = api._minimaxMergeSubscription(
        null,
        messageBoxResponse([planMessage('Token Plan Max (1个月)', '2026年08月30日', 1785477404776)])
    );
    assert.equal(sub.expireDate, '2026-08-30');
    assert.equal(sub.planName, 'Token Plan Max (1个月)');
});

test('minimax merge borrows plan name from notice when charge api title missing', function() {
    var sub = api._minimaxMergeSubscription(
        chargeResponse(1788019200000, ''),
        messageBoxResponse([planMessage('Token Plan Max (1个月)', '2026年08月18日', 1785477404776)])
    );
    assert.equal(sub.expireDate, '2026-08-30');
    assert.equal(sub.planName, 'Token Plan Max (1个月)');
});

test('minimax group id prefers account field then cookie fallback', function() {
    assert.equal(api._minimaxGroupId({ group_id: '111', cookie: 'minimax_group_id_v2=222' }), '111');
    assert.equal(api._minimaxGroupId({ cookie: 'a=b; minimax_group_id_v2=2082871950551556306; c=d' }), '2082871950551556306');
    assert.equal(api._minimaxGroupId({ cookie: 'a=b' }), '');
    assert.equal(api._minimaxGroupId({}), '');
});

test('minimax without usage data scores null so default weight applies', function() {
    var score = weights.scoreAccount({ platform: 'minimax', data: { usage: null, subscription: {} } });
    assert.equal(score, null);
});

test('minimax windows map percent and quota windows once usage arrives', function() {
    var resetMs = Date.now() + 30 * 60000;
    var score = weights.scoreAccount({
        platform: 'minimax',
        data: {
            usage: {
                windows: [
                    { label: '5h限额', usedPct: 10, resetMs: resetMs, periodMs: 5 * 3600000 },
                    { label: '周限额', usedPct: 20, resetMs: Date.now() + 6 * 86400000, periodMs: 7 * 86400000 },
                    { label: '视频赠送', used: 0, quota: 3, resetMs: Date.now() + 9 * 3600000, periodMs: 24 * 3600000, weightExcluded: true }
                ]
            },
            subscription: null
        }
    });
    assert.ok(score, '有用量窗口时应产生评分');
    // 视频赠送 weightExcluded=true,不计入权重/紧张度 → 评分窗口只剩 5h/周限额
    assert.equal(score.windows.length, 2);
    assert.equal(score.exhausted, false);
});

// 与线上 /backend/account/token_plan/remains_percent 响应同构的样例
// general(无限额, 百分比) + video(计数 0/3, 0/21),均含 interval + weekly
function remainsPercentResponse(models) {
    return {
        model_remains: models,
        base_resp: { status_code: 0, status_msg: 'success' }
    };
}

function generalModel() {
    return {
        model_name: 'general',
        start_time: 1785740400000,
        end_time: 1785758400000,
        remains_time: 15300901,
        current_interval_total_count: -1,
        current_interval_used_count: -1,
        current_interval_remains_count: -1,
        current_interval_used_percent: '0%',
        current_interval_total_percent: '100%',
        current_interval_status: 1,
        weekly_start_time: 1785686400000,
        weekly_end_time: 1786291200000,
        weekly_remains_time: 548100901,
        current_weekly_total_count: -1,
        current_weekly_used_count: -1,
        current_weekly_remains_count: -1,
        current_weekly_used_percent: '0%',
        current_weekly_total_percent: '100%',
        current_weekly_status: 1
    };
}

function videoModel() {
    return {
        model_name: 'video',
        start_time: 1785686400000,
        end_time: 1785772800000,
        remains_time: 29700901,
        current_interval_total_count: 3,
        current_interval_used_count: 0,
        current_interval_remains_count: 3,
        current_interval_used_percent: '0%',
        current_interval_total_percent: '100%',
        current_interval_status: 1,
        weekly_start_time: 1785686400000,
        weekly_end_time: 1786291200000,
        weekly_remains_time: 548100901,
        current_weekly_total_count: 21,
        current_weekly_used_count: 0,
        current_weekly_remains_count: 21,
        current_weekly_used_percent: '0%',
        current_weekly_total_percent: '100%',
        current_weekly_status: 1
    };
}

test('minimax usage maps general percent + video count into three windows', function() {
    var ws = api._parseMinimaxUsage(remainsPercentResponse([generalModel(), videoModel()]));
    assert.equal(ws.length, 3);

    var byLabel = {};
    ws.forEach(function(w) { byLabel[w.label] = w; });

    // general: counts=-1 → 走 usedPct 路径;百分比窗口按 GLM 风格 5 等分
    assert.equal(byLabel['5h 限额'].usedPct, 0);
    assert.equal(byLabel['5h 限额'].resetMs, 1785758400000);
    assert.equal(byLabel['5h 限额'].periodMs, 18000000); // 5h
    assert.equal(byLabel['5h 限额'].segments, 5);
    assert.equal(byLabel['周限额'].usedPct, 0);
    assert.equal(byLabel['周限额'].periodMs, 604800000); // 7d
    assert.equal(byLabel['周限额'].segments, 5);

    // video: 仅每日赠送(0/3),周窗不展示;打 weightExcluded 标记,不计入权重/紧张度
    assert.equal(byLabel['视频赠送'].used, 0);
    assert.equal(byLabel['视频赠送'].quota, 3);
    assert.equal(byLabel['视频赠送'].resetMs, 1785772800000);
    assert.equal(byLabel['视频赠送'].periodMs, 86400000); // 24h
    assert.equal(byLabel['视频赠送'].weightExcluded, true);
    assert.ok(!byLabel['视频周赠'], 'video 周窗不应被返回');
});

test('minimax usage returns null on auth failure or empty input', function() {
    assert.equal(api._parseMinimaxUsage({ base_resp: { status_code: 401, status_msg: 'unauthorized' } }), null);
    assert.equal(api._parseMinimaxUsage(null), null);
    assert.equal(api._parseMinimaxUsage({}), null);
});

test('minimax usage returns empty array when no model_remains entries', function() {
    assert.deepEqual(api._parseMinimaxUsage(remainsPercentResponse([])), []);
});

test('minimax usage integrates with weights.scoreAccount for percent + count windows', function() {
    var ws = api._parseMinimaxUsage(remainsPercentResponse([generalModel(), videoModel()]));
    var score = weights.scoreAccount({
        platform: 'minimax',
        data: { usage: { windows: ws }, subscription: null }
    });
    assert.ok(score, '应有评分');
    // 视频赠送 weightExcluded=true 不参与评分 → 仅 5h/周限额 两个窗口
    assert.equal(score.windows.length, 2);
    assert.equal(score.exhausted, false);
});

test('minimax video gift exhaustion does not drag the weight to zero', function() {
    var ws = api._parseMinimaxUsage(remainsPercentResponse([generalModel(), videoModel()]));
    // 把视频赠送用满(3/3),general 仍宽裕(0%)
    var wsExhausted = ws.map(function(w) {
        return w.label === '视频赠送' ? Object.assign({}, w, { used: 3 }) : w;
    });
    var score = weights.scoreAccount({
        platform: 'minimax',
        data: { usage: { windows: wsExhausted }, subscription: null }
    });
    assert.ok(score, '应有评分');
    assert.equal(score.exhausted, false, '视频赠送耗尽不应判定账号耗尽');
    assert.ok(score.weight > 0, '视频赠送耗尽时权重不应为 0');
});

// ============ 用量曲线(token_plan/usage_summary)============
// 与线上 usage_summary 响应同构:date_model_usage 每日一项,含逐模型 input/output/cache 明细 + 当日 total_token。
function usageSummaryResponse(days) {
    return {
        total_token_consumed: '58.77M',
        date_model_usage: days,
        base_resp: { status_code: 0, status_msg: 'success' }
    };
}
// 真实样例 2026-08-03:模型 total_token 含 cache_read 会重复计数;input+output 才是净消耗。
function activeDay() {
    return {
        date: '2026-08-03',
        models: [
            { model: 'MiniMax-M3-512k', input_token: 58668127, cache_read_token: 56552320, output_token: 105665, total_token: 115326112 },
            { model: 'speech-02-hd', input_token: 85, cache_read_token: 0, output_token: 0, total_token: 85 },
            { model: 'MiniMax-M2.7-highspeed', input_token: 28, cache_read_token: 0, cache_create_token: 28, output_token: 33, total_token: 89 }
        ],
        total_input_token: 58668240,
        total_output_token: 105698,
        total_token: 58773938
    };
}
function idleDay(date) {
    return { date: date, models: [], total_input_token: 0, total_output_token: 0, total_token: 0 };
}

test('minimax model usage takes last N days and unions models across the window', function() {
    // 9 天历史,末尾为活跃日;近 7 天 = [d3..d8, 2026-08-03]
    var days = [];
    for (var i = 1; i <= 8; i++) days.push(idleDay('2026-07-2' + (i < 10 ? i : ''))); // 占位空闲日
    days.push(activeDay());
    var chart = api._parseMinimaxModelUsage(usageSummaryResponse(days), '7d');
    assert.equal(chart.x_time.length, 7);
    assert.equal(chart.x_time[6], '2026-08-03', '近 7 天应以活跃日收尾');
    // 三个模型都进入并集
    var names = chart.modelDataList.map(function(m) { return m.modelName; });
    assert.deepEqual(names, ['MiniMax-M3-512k', 'speech-02-hd', 'MiniMax-M2.7-highspeed']);
    // 活跃日前 6 天补 0,活跃日取 input+output(净消耗,非含 cache 的 total_token)
    var m3 = chart.modelDataList[0].tokensUsage;
    assert.equal(m3.length, 7);
    assert.equal(m3[6], 58668127 + 105665);
    m3.slice(0, 6).forEach(function(v) { assert.equal(v, 0); });
});

test('minimax model usage per-model values sum to the day total (no cache double-count)', function() {
    var chart = api._parseMinimaxModelUsage(usageSummaryResponse([activeDay()]), '7d');
    var daySum = chart.modelDataList.reduce(function(a, m) {
        return a + m.tokensUsage.reduce(function(s, v) { return s + v; }, 0);
    }, 0);
    assert.equal(daySum, 58773938, '逐模型 input+output 之和应等于当日 total_token');
    // 总量汇总用日级 total_token,与官方 total_token_consumed 58.77M 口径一致
    assert.equal(chart.totalUsage.totalTokensUsage, 58773938);
});

test('minimax model usage 30d window slices last 30 days', function() {
    var days = [];
    for (var i = 0; i < 40; i++) days.push(idleDay('2026-0' + (i < 9 ? '7' : '8') + '-' + (i % 28 + 1)));
    days.push(activeDay());
    var chart = api._parseMinimaxModelUsage(usageSummaryResponse(days), '30d');
    assert.equal(chart.x_time.length, 30);
    assert.equal(chart.x_time[29], '2026-08-03');
});

test('minimax model usage returns null on auth failure or empty data', function() {
    assert.equal(api._parseMinimaxModelUsage({ base_resp: { status_code: 1001 } }, '7d'), null);
    assert.equal(api._parseMinimaxModelUsage({ base_resp: { status_code: 0 }, date_model_usage: [] }, '7d'), null);
    assert.equal(api._parseMinimaxModelUsage(null, '7d'), null);
});

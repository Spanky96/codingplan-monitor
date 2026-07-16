// weights.js — 权重评分纯函数:把缓存的各平台用量数据映射为分流权重。
// 权重越高 = 越宽裕(中转站可多分配 token),0 = 已耗尽。
//
// 核心原则:权重由「消耗速率比 ratio = usedPct / theoPct」主导(即基于重置时间衡量,
// 而非周期已使用百分比)。ratio 的物理意义 ≈ 按当前速率整周期预计用量 / 100:
//   ratio=1 → 重置时刚好用完;ratio=2 → 半路耗尽;ratio=6 → 1/6 周期耗尽。
// 这与前端 public/index.html 的「理论水位线 / tensionInfo」是同一个对照量,故权重方向
// 与 usage 页面看到的充裕/正常/偏快/紧张完全一致。
// 仅基于传入的缓存数据计算,绝不发起任何网络请求。

'use strict';

var FIVE_HOURS_MS = 5 * 3600000;   // GLM unit=3 / 火山 session
var ONE_DAY_MS = 86400000;         // yescode/huoli 今日
var SEVEN_DAYS_MS = 7 * 86400000;  // GLM unit=6 / 火山 weekly
var THIRTY_DAYS_MS = 30 * 86400000; // yescode/huoli/火山 月度默认
// 与前端一致的耗尽判定:官方数据常停在 99.9x%,但额度实际已不可用,统一按 ≥99.9% 视为耗尽 → 权重 0
var EXHAUSTED_PCT = 99.9;
// 周期早期理论进度阈值(%):低于此值时样本不足、ratio 会爆炸,改用绝对用量兜底,避免刚重置就被误判紧张
var MIN_TRUST_THEO = 3;

// 智云为按量余额账号:预计可用天数先映射为 1~6 容量分，再叠加 CodingPlan
// 紧张度与中国时区峰谷倍率。最终仍由 finalWeight 钳制到 0~10。
var TELECOM_DAY_BUCKETS = [7, 14, 30, 60, 90];
var TELECOM_PEAK_START_HOUR = 14;
var TELECOM_PEAK_END_HOUR = 18;

// 智谱个人账号「需要重置」建议阈值。只有周额度已经明显超前，且按当前速度会在
// 官方重置前至少停用一天时才提示，避免给短时波动或临近重置的账号制造噪声。
var RESET_MIN_WEEKLY_PCT = 60;
var RESET_MIN_EXCESS_PCT = 15;
var RESET_MIN_RATE_RATIO = 1.3;
var RESET_MIN_REMAINING_MS = ONE_DAY_MS;
var RESET_MIN_UNAVAILABLE_MS = ONE_DAY_MS;

// 纯用量分桶 → 1~6(用量越高分越低);用于「无重置时间」与「周期刚开始」两种兜底场景
function bucketScore(usedPct) {
    if (usedPct < 15) return 6;
    if (usedPct < 30) return 5;
    if (usedPct < 50) return 4;
    if (usedPct < 70) return 3;
    if (usedPct < 85) return 2;
    return 1;
}

// 消耗速率比 → 分数(6 最宽裕 .. 1 最紧张)。分界对齐前端 tensionInfo 的 0.8 / 1.3 / 2.0
function rateScore(ratio) {
    if (ratio <= 0.5) return 6;   // 整周期最多用一半 → 极宽裕
    if (ratio <= 0.8) return 5;   // 最多用 80% → 宽裕
    if (ratio <= 1.0) return 4;   // 恰好用完 → 正常
    if (ratio <= 1.3) return 3;   // 略超 → 偏快
    if (ratio <= 2.0) return 2;   // 半周期耗尽 → 紧张
    return 1;                     // 更快耗尽 → 极紧张
}

// 终点法理论进度:endIso 为周期「重置时刻」(GLM nextResetTime / 火山 ResetTime / ResetTimestamp)。
// 与 index.html theoPctFromEnd 一致。缺失/非法 → -1(语义=无重置时间,无法算速率)
function theoPctFromEnd(endIso, periodMs) {
    if (!endIso) return -1;
    var resetMs = new Date(endIso).getTime();
    if (isNaN(resetMs)) return -1;
    var elapsed = Date.now() - (resetMs - periodMs);
    return elapsed > 0 ? Math.min(100, (elapsed / periodMs) * 100) : 0;
}

// 起点法理论进度:startIso 为周期「起点」(yescode last_*_reset / huoli *_window_start)。
// 与 index.html theoPctFromStart 一致。缺失/非法 → -1
function theoPctFromStart(startIso, periodMs) {
    if (!startIso) return -1;
    var startMs = new Date(startIso).getTime();
    if (isNaN(startMs)) return -1;
    var elapsed = Date.now() - startMs;
    return elapsed > 0 ? Math.min(100, (elapsed / periodMs) * 100) : 0;
}

// 单窗口评分。theoPct 由各平台外部用 theoPctFrom* 算好;null/undefined/<0 表示无重置时间。
// 返回 { score, usedPct, theoPct, ratio, exhausted, noData }
function scoreWindow(usedPct, theoPct) {
    var hasTheo = (theoPct !== null && theoPct !== undefined && theoPct >= 0);

    // 已耗尽 → 0
    if (usedPct >= EXHAUSTED_PCT) {
        return { score: 0, usedPct: usedPct, theoPct: theoPct, ratio: null, exhausted: true, noData: false };
    }
    // 暂无用量 → 最宽裕
    if (usedPct <= 0) {
        return { score: 6, usedPct: usedPct, theoPct: theoPct, ratio: 0, exhausted: false, noData: false };
    }
    // 无重置时间 → 无法算速率,退回纯用量分桶
    if (!hasTheo) {
        return { score: bucketScore(usedPct), usedPct: usedPct, theoPct: theoPct, ratio: null, exhausted: false, noData: false };
    }
    var ratio = usedPct / theoPct;
    // 周期刚开始(theoPct 过小,ratio 爆炸不可信):用绝对余量兜底抬高(刚重置低用量→高分;异常高用量→低分)
    var score = theoPct < MIN_TRUST_THEO
        ? Math.max(bucketScore(usedPct), rateScore(ratio))
        : rateScore(ratio);
    return { score: score, usedPct: usedPct, theoPct: theoPct, ratio: ratio, exhausted: false, noData: false };
}

// 把 (label, usedPct, theoPct) 包成窗口对象(scoreWindow 结果 + label)
function makeWindow(label, usedPct, theoPct) {
    var sw = scoreWindow(usedPct, theoPct);
    return {
        label: label,
        score: sw.score,
        usedPct: sw.usedPct,
        theoPct: sw.theoPct,
        ratio: sw.ratio,
        exhausted: sw.exhausted,
        noData: sw.noData
    };
}

function pctOf(limit) {
    return typeof limit.percentage === 'number'
        ? limit.percentage
        : (parseFloat(limit.percentage) || 0);
}

function findWindow(windows, label) {
    for (var i = 0; i < windows.length; i++) {
        if (windows[i].label === label) return windows[i];
    }
    return null;
}

function findLevel(arr, level) {
    for (var i = 0; i < arr.length; i++) {
        if (arr[i] && arr[i].Level === level) return arr[i];
    }
    return null;
}

// ============ 各平台 → 窗口数组 [{label, usedPct, theoPct, ...}] ============

// GLM:limits 中 unit=3(5h) 与 unit=6(7d);_unlimited 跳过
function glmWindows(data) {
    var limits = data && Array.isArray(data.limits) ? data.limits : [];
    var l5 = null, l7 = null;
    for (var i = 0; i < limits.length; i++) {
        if (!limits[i]) continue;
        if (limits[i].unit === 3) l5 = limits[i];
        else if (limits[i].unit === 6) l7 = limits[i];
    }
    var ws = [];
    if (l5 && !l5._unlimited) ws.push(makeWindow('5h', pctOf(l5), theoPctFromEnd(l5.nextResetTime, FIVE_HOURS_MS)));
    if (l7 && !l7._unlimited) ws.push(makeWindow('7d', pctOf(l7), theoPctFromEnd(l7.nextResetTime, SEVEN_DAYS_MS)));
    return ws;
}

// 智谱个人账号周额度重置建议。返回 null 表示无需提示；返回对象供 API 和前端展示原因。
// nowMs 可注入，便于稳定测试。personalEdition=false 或 teamEdition=true 明确排除团队账号。
function getGLMResetRecommendation(cachedResult, nowMs) {
    if (!cachedResult || (cachedResult.platform || 'glm') !== 'glm' || !cachedResult.data) return null;
    if (cachedResult.teamEdition || cachedResult.personalEdition === false) return null;

    var limits = Array.isArray(cachedResult.data.limits) ? cachedResult.data.limits : [];
    var activeLimits = limits.filter(function(limit) { return limit && !limit._unlimited; });
    // 任一额度已经耗尽时不再建议申请重置。
    if (activeLimits.some(function(limit) { return pctOf(limit) >= EXHAUSTED_PCT; })) return null;

    var weekly = null;
    for (var i = 0; i < activeLimits.length; i++) {
        if (activeLimits[i].unit === 6) { weekly = activeLimits[i]; break; }
    }
    if (!weekly) return null;

    var weeklyPct = pctOf(weekly);
    if (weeklyPct < RESET_MIN_WEEKLY_PCT) return null;

    var now = typeof nowMs === 'number' ? nowMs : Date.now();
    var resetAt = weekly.nextResetTime ? new Date(weekly.nextResetTime).getTime() : NaN;
    if (!isFinite(resetAt)) return null;
    var remainingMs = resetAt - now;
    if (remainingMs < RESET_MIN_REMAINING_MS) return null;

    var elapsedMs = now - (resetAt - SEVEN_DAYS_MS);
    if (elapsedMs <= 0 || elapsedMs >= SEVEN_DAYS_MS) return null;
    var theoPct = (elapsedMs / SEVEN_DAYS_MS) * 100;
    if (theoPct <= 0) return null;

    var excessPct = weeklyPct - theoPct;
    var rateRatio = weeklyPct / theoPct;
    if (excessPct < RESET_MIN_EXCESS_PCT || rateRatio < RESET_MIN_RATE_RATIO) return null;

    var timeToExhaustMs = elapsedMs * ((100 - weeklyPct) / weeklyPct);
    var unavailableMs = remainingMs - timeToExhaustMs;
    if (unavailableMs < RESET_MIN_UNAVAILABLE_MS) return null;

    return {
        needed: true,
        weeklyPct: weeklyPct,
        theoPct: theoPct,
        excessPct: excessPct,
        rateRatio: rateRatio,
        resetAt: new Date(resetAt).toISOString(),
        projectedExhaustAt: new Date(now + timeToExhaustMs).toISOString(),
        unavailableHours: unavailableMs / 3600000
    };
}

// YesCode:今日/本周/本月,起点法(last_*_reset)
function yescodeWindows(d) {
    var plan = (d && d.subscription_plan) || {};
    var ws = [];
    var dq = plan.daily_balance || 0;
    if (dq > 0) {
        var spent = Math.max(0, dq - (d.subscription_balance || 0));
        ws.push(makeWindow('今日', (spent / dq) * 100, theoPctFromStart(d.last_daily_balance_add, ONE_DAY_MS)));
    }
    if (plan.weekly_limit > 0) {
        ws.push(makeWindow('本周', ((d.current_week_spend || 0) / plan.weekly_limit) * 100, theoPctFromStart(d.last_week_reset, SEVEN_DAYS_MS)));
    }
    if (plan.monthly_spend_limit > 0) {
        ws.push(makeWindow('本月', ((d.current_month_spend || 0) / plan.monthly_spend_limit) * 100, theoPctFromStart(d.last_month_reset, THIRTY_DAYS_MS)));
    }
    return ws;
}

// huoli:data 为数组,取 data[0];今日/本周/本月,起点法(*_window_start)。月度用量字段对齐前端 index.html:1236
function huoliWindows(data) {
    var sub = Array.isArray(data) ? data[0] : data;
    if (!sub) return [];
    var grp = sub.group || {};
    var ws = [];
    if (grp.daily_limit_usd > 0) {
        ws.push(makeWindow('今日', ((sub.daily_usage_usd || 0) / grp.daily_limit_usd) * 100, theoPctFromStart(sub.daily_window_start, ONE_DAY_MS)));
    }
    if (grp.weekly_limit_usd > 0) {
        ws.push(makeWindow('本周', ((sub.weekly_usage_usd || 0) / grp.weekly_limit_usd) * 100, theoPctFromStart(sub.weekly_window_start, SEVEN_DAYS_MS)));
    }
    if (grp.monthly_limit_usd > 0) {
        ws.push(makeWindow('本月', ((sub.monthly_usage_usd || 0) / grp.monthly_limit_usd) * 100, theoPctFromStart(sub.monthly_window_start, THIRTY_DAYS_MS)));
    }
    return ws;
}

// 火山C 月度实际周期:优先订阅 [StartTime, EndTime](首月约 32 天),回退 30 天。对齐前端 volcCodingMonthlyPeriodMs
function volcCodingMonthlyPeriodMs(subscription) {
    if (subscription && subscription.StartTime && subscription.EndTime) {
        var start = new Date(subscription.StartTime).getTime();
        var end = new Date(subscription.EndTime).getTime();
        if (end > start) return end - start;
    }
    return THIRTY_DAYS_MS;
}

// 火山:按 planType 分派 A(AgentPlan)/ C(CodingPlan)
function volcWindows(data, planType) {
    var usage = (data && data.usage) || {};
    var ws = [];
    if (planType === 'coding') {
        var monthlyPeriod = volcCodingMonthlyPeriodMs(data && data.subscription);
        var levels = [
            { label: '5h', level: 'session', period: FIVE_HOURS_MS },
            { label: '7d', level: 'weekly', period: SEVEN_DAYS_MS },
            { label: '月', level: 'monthly', period: monthlyPeriod }
        ];
        var arr = Array.isArray(usage.QuotaUsage) ? usage.QuotaUsage : [];
        levels.forEach(function(it) {
            var item = findLevel(arr, it.level);
            if (item && typeof item.Percent === 'number') {
                var resetIso = item.ResetTimestamp ? new Date(item.ResetTimestamp * 1000).toISOString() : null;
                ws.push(makeWindow(it.label, item.Percent, theoPctFromEnd(resetIso, it.period)));
            }
        });
    } else {
        var buckets = [
            { label: '5h', b: usage.AFPFiveHour, period: FIVE_HOURS_MS },
            { label: '7d', b: usage.AFPWeekly, period: SEVEN_DAYS_MS },
            { label: '月', b: usage.AFPMonthly, period: THIRTY_DAYS_MS }
        ];
        buckets.forEach(function(it) {
            if (it.b && it.b.Quota > 0) {
                ws.push(makeWindow(it.label, (it.b.Used / it.b.Quota) * 100, theoPctFromEnd(it.b.ResetTime, it.period)));
            }
        });
    }
    return ws;
}

// ============ 多窗口取瓶颈 ============

// 任一窗口耗尽 → 整体 0;否则取所有有效窗口 score 的 min(最紧张=瓶颈);无有效窗口 → null
function aggregate(windows) {
    var valid = windows.filter(function(w) { return w && !w.noData; });
    if (valid.length === 0) return null;
    var anyExhausted = valid.some(function(w) { return w.exhausted; });
    if (anyExhausted) return { weight: 0, exhausted: true, windows: valid };
    var weight = Math.min.apply(null, valid.map(function(w) { return w.score; }));
    return { weight: weight, exhausted: false, windows: valid };
}

// 映射到 scoreAccount 返回结构(兼容 api.js detail 的 score5h/score7d/used5h/used7d/theo5h/theo7d)
// GLM:5h/7d 两窗口分别填对应槽位;其他平台:瓶颈窗(最低 score)填 7d 槽位,5h 留 null
function buildResult(platform, agg) {
    var windows = agg.windows;
    var w5h = null, w7d = null;
    if (platform === 'glm') {
        w5h = findWindow(windows, '5h');
        w7d = findWindow(windows, '7d');
    } else if (windows.length > 0) {
        w7d = windows.reduce(function(a, b) { return a.score <= b.score ? a : b; });
    }
    return {
        weight: agg.weight,
        score5h: w5h ? w5h.score : null,
        score7d: w7d ? w7d.score : null,
        used5h: w5h ? w5h.usedPct : null,
        used7d: w7d ? w7d.usedPct : null,
        theo5h: w5h ? w5h.theoPct : null,
        theo7d: w7d ? w7d.theoPct : null,
        exhausted: agg.exhausted,
        windows: windows
    };
}

// 账号综合权重。cachedResult: usageCache 中各 fetch*Usage 的返回。
// 返回 { weight, score5h, score7d, used5h, used7d, theo5h, theo7d, exhausted, windows } 或 null(无可用窗口)
function scoreAccount(cachedResult) {
    if (!cachedResult || !cachedResult.data) return null;
    var platform = cachedResult.platform || 'glm';

    var windows;
    if (platform === 'glm') windows = glmWindows(cachedResult.data);
    else if (platform === 'yescode') windows = yescodeWindows(cachedResult.data);
    else if (platform === 'huoli') windows = huoliWindows(cachedResult.data);
    else if (platform === 'volc') windows = volcWindows(cachedResult.data, cachedResult.planType);
    else return null;

    var agg = aggregate(windows);
    if (!agg) return null;
    return buildResult(platform, agg);
}

// ============ 智云按量账号 ============

function telecomCapacityScore(remainingDays) {
    if (!(remainingDays > 0)) return 0;
    for (var i = 0; i < TELECOM_DAY_BUCKETS.length; i++) {
        if (remainingDays < TELECOM_DAY_BUCKETS[i]) return i + 1;
    }
    return 6;
}

// 其他 CodingPlan 的平均基础分越低，压力系数越高:平均 6 分 → ×1，平均 0 分 → ×2。
// 无有效 CodingPlan 缓存时使用中性 ×1，避免凭空放大按量消费。
function codingPressure(codingScores) {
    var values = (codingScores || []).map(function(score) {
        return score && typeof score.weight === 'number' && isFinite(score.weight)
            ? Math.max(0, Math.min(6, score.weight))
            : null;
    }).filter(function(value) { return value !== null; });
    if (values.length === 0) return { average: null, multiplier: 1, sampleSize: 0 };
    var average = values.reduce(function(sum, value) { return sum + value; }, 0) / values.length;
    return {
        average: average,
        multiplier: 1 + ((6 - average) / 6),
        sampleSize: values.length
    };
}

function telecomTimeMultiplier(nowMs) {
    var now = new Date(typeof nowMs === 'number' ? nowMs : Date.now());
    var chinaHour = (now.getUTCHours() + 8) % 24;
    return chinaHour >= TELECOM_PEAK_START_HOUR && chinaHour < TELECOM_PEAK_END_HOUR ? 2 : 0.5;
}

function scoreTelecomAccount(cachedResult, codingScores, nowMs) {
    if (!cachedResult || cachedResult.platform !== 'telecomjs' || !cachedResult.data) return null;
    var data = cachedResult.data;
    var balance = Math.max(0, Number(data.balance) || 0);
    var gift = Math.max(0, Number(data.platformGiftBalance) || 0);
    var available = balance + gift;
    var hasSevenDayStats = data.sevenDayConsumption != null;
    var rangeDays = data.consumptionRangeDays != null
        ? Math.max(0, Number(data.consumptionRangeDays) || 0)
        : (hasSevenDayStats ? 0 : 30);
    var consumption = Math.max(0, Number(
        hasSevenDayStats ? data.sevenDayConsumption
            : (data.thirtyDayConsumption != null ? data.thirtyDayConsumption : data.timeRangeConsumption)
    ) || 0);
    var averageDaily = data.averageDailyConsumption != null
        ? Math.max(0, Number(data.averageDailyConsumption) || 0)
        : (rangeDays > 0 ? consumption / rangeDays : 0);
    var remainingDays = available > 0 && averageDaily === 0 ? Infinity
        : (averageDaily > 0 ? available / averageDaily : 0);
    var capacityScore = telecomCapacityScore(remainingDays);
    var pressure = codingPressure(codingScores);
    var timeMultiplier = telecomTimeMultiplier(nowMs);
    var exhausted = available <= 0;
    return {
        weight: exhausted ? 0 : capacityScore * pressure.multiplier * timeMultiplier,
        score5h: null,
        score7d: capacityScore,
        used5h: null,
        used7d: null,
        theo5h: null,
        theo7d: null,
        exhausted: exhausted,
        windows: [],
        availableBalance: available,
        averageDaily: averageDaily,
        remainingDays: isFinite(remainingDays) ? remainingDays : null,
        noConsumption: available > 0 && averageDaily === 0,
        capacityScore: capacityScore,
        codingAverage: pressure.average,
        codingPressure: pressure.multiplier,
        codingSampleSize: pressure.sampleSize,
        timeMultiplier: timeMultiplier,
        peak: timeMultiplier === 2
    };
}

// ============ 权重策略与兜底(在 base 之上做最终计算,范围 0~10)============

var DEFAULT_WEIGHT_CONFIG = { defaultWeight: 1, strategy: 'B', value: 1 };

// 合并账号自定义配置与默认值(返回新对象,校验非法输入)
function getWeightConfig(acc) {
    var cfg = (acc && acc.weightConfig) ? acc.weightConfig : {};
    var def = DEFAULT_WEIGHT_CONFIG;
    return {
        defaultWeight: (typeof cfg.defaultWeight === 'number' && isFinite(cfg.defaultWeight))
            ? cfg.defaultWeight : def.defaultWeight,
        strategy: (['A', 'B', 'C', 'D'].indexOf(cfg.strategy) >= 0) ? cfg.strategy : def.strategy,
        value: (typeof cfg.value === 'number' && isFinite(cfg.value)) ? cfg.value : def.value
    };
}

// 策略变换(已知 base 时)
function applyStrategy(base, cfg) {
    var v = cfg.value;
    if (cfg.strategy === 'A') return v;                  // 固定值
    if (cfg.strategy === 'B') return base * v;           // 倍率
    if (cfg.strategy === 'C') return Math.min(base, v);  // 最高值(上限钳制)
    if (cfg.strategy === 'D') return base + v;           // 固定加减
    return base;
}

// 钳制到 [0,10] 并取整
function clamp10(x) { return Math.max(0, Math.min(10, Math.round(x * 10) / 10)); }

// 最终权重:base 为 null/undefined/NaN(token 失效或无缓存)→ 用 defaultWeight;否则应用策略;统一 clamp [0,10]
function finalWeight(base, cfg) {
    var noBase = (base === null || base === undefined || (typeof base === 'number' && isNaN(base)));
    var raw = noBase ? cfg.defaultWeight : applyStrategy(base, cfg);
    return clamp10(raw);
}

module.exports = {
    EXHAUSTED_PCT: EXHAUSTED_PCT,
    MIN_TRUST_THEO: MIN_TRUST_THEO,
    scoreWindow: scoreWindow,
    rateScore: rateScore,
    theoPctFromEnd: theoPctFromEnd,
    theoPctFromStart: theoPctFromStart,
    getGLMResetRecommendation: getGLMResetRecommendation,
    scoreAccount: scoreAccount,
    scoreTelecomAccount: scoreTelecomAccount,
    telecomCapacityScore: telecomCapacityScore,
    codingPressure: codingPressure,
    telecomTimeMultiplier: telecomTimeMultiplier,
    bucketScore: bucketScore,
    getWeightConfig: getWeightConfig,
    applyStrategy: applyStrategy,
    finalWeight: finalWeight,
    DEFAULT_WEIGHT_CONFIG: DEFAULT_WEIGHT_CONFIG
};

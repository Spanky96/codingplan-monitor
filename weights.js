// weights.js — 权重评分纯函数:把缓存的 GLM 用量数据映射为 0~6 权重。
// 权重越高 = 越宽裕(中转站可多分配 token),0 = 已耗尽。
// 仅基于传入的缓存数据计算,绝不发起任何网络请求。

'use strict';

var FIVE_HOURS_MS = 5 * 3600000;   // unit=3
var SEVEN_DAYS_MS = 7 * 86400000;  // unit=6

// 计算单窗口(5h 或 7d)的权重。
// limit: quota/limit 接口里的一项 { unit, percentage, nextResetTime, _unlimited, ... }
// periodMs: 该窗口周期毫秒数
// 返回 { score, usedPct, theoPct, exhausted, noData }
function scoreWindow(limit, periodMs) {
    // 无约束(缺失或无限额度)→ 不影响整体,标记 noData
    if (!limit || limit._unlimited) {
        return { score: null, usedPct: null, theoPct: null, exhausted: false, noData: true };
    }

    var usedPct = typeof limit.percentage === 'number'
        ? limit.percentage
        : (parseFloat(limit.percentage) || 0);

    // 已耗尽 → 0
    if (usedPct >= 100) {
        return { score: 0, usedPct: usedPct, theoPct: null, exhausted: true, noData: false };
    }

    // 时间理论进度(参考 public/index.html 紧张度算法)
    var theoPct = 100;
    if (limit.nextResetTime) {
        var resetMs = new Date(limit.nextResetTime).getTime();
        if (!isNaN(resetMs)) {
            var elapsed = Date.now() - (resetMs - periodMs);
            theoPct = elapsed > 0 ? Math.min(100, (elapsed / periodMs) * 100) : 0;
        }
    }

    // 暂无用量 → 最宽裕
    if (usedPct <= 0) {
        return { score: 6, usedPct: usedPct, theoPct: theoPct, exhausted: false, noData: false };
    }

    // 用量分桶(base)
    var base;
    if (usedPct < 15) base = 6;
    else if (usedPct < 30) base = 5;
    else if (usedPct < 50) base = 4;
    else if (usedPct < 70) base = 3;
    else if (usedPct < 85) base = 2;
    else base = 1;

    // 时间速率修正:ratio = 实际用量% / 理论进度%
    var ratio = theoPct > 0 ? usedPct / theoPct : 1;
    var adj = 0;
    if (ratio >= 2.0) adj = -2;        // 消耗远超时间进度 → 紧张降权
    else if (ratio >= 1.3) adj = -1;
    else if (ratio <= 0.5) adj = 1;    // 消耗远低于进度 → 宽裕加权

    var score = Math.max(1, Math.min(6, base + adj));
    return { score: score, usedPct: usedPct, theoPct: theoPct, exhausted: false, noData: false };
}

// 账号综合权重:5h 与 7d 取瓶颈(min),任一窗口耗尽则整体 0。
// cachedResult: usageCache 中 fetchGLMUsage 的返回({ data: { limits: [...] }, ... })
// 返回 { weight, score5h, score7d, used5h, used7d, theo5h, theo7d, exhausted } 或 null(无可用窗口)
function scoreAccount(cachedResult) {
    var data = cachedResult && cachedResult.data;
    var limits = data && Array.isArray(data.limits) ? data.limits : [];

    var l5 = null, l7 = null;
    for (var i = 0; i < limits.length; i++) {
        if (!limits[i]) continue;
        if (limits[i].unit === 3) l5 = limits[i];
        else if (limits[i].unit === 6) l7 = limits[i];
    }

    var w5 = scoreWindow(l5, FIVE_HOURS_MS);
    var w7 = scoreWindow(l7, SEVEN_DAYS_MS);

    // 两窗口都无数据(非 GLM 风格或缺少 5h/7d)→ 无法评分
    if (w5.noData && w7.noData) return null;

    // 任一窗口耗尽 → 整体 0
    if (w5.exhausted || w7.exhausted) {
        return {
            weight: 0,
            score5h: w5.score, score7d: w7.score,
            used5h: w5.usedPct, used7d: w7.usedPct,
            theo5h: w5.theoPct, theo7d: w7.theoPct,
            exhausted: true
        };
    }

    // 瓶颈原则:取两窗口较低者;仅一个有数据时取该窗口
    var weight;
    if (w5.noData) weight = w7.score;
    else if (w7.noData) weight = w5.score;
    else weight = Math.min(w5.score, w7.score);

    return {
        weight: weight,
        score5h: w5.score, score7d: w7.score,
        used5h: w5.usedPct, used7d: w7.usedPct,
        theo5h: w5.theoPct, theo7d: w7.theoPct,
        exhausted: false
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
    scoreWindow: scoreWindow,
    scoreAccount: scoreAccount,
    getWeightConfig: getWeightConfig,
    applyStrategy: applyStrategy,
    finalWeight: finalWeight,
    DEFAULT_WEIGHT_CONFIG: DEFAULT_WEIGHT_CONFIG
};

// ============ ZenMux Builder Subscription（zenmux.ai）============
var { httpsGet } = require('../../lib/http');
var { setCache } = require('../cache');

var BASE_URL = 'https://zenmux.ai';
var FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
var SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
var ONE_DAY_MS = 24 * 60 * 60 * 1000;

function zenmuxAuthorization(account) {
    var key = String(account.authorization || '').trim();
    return /^Bearer\s+/i.test(key) ? key : (key ? 'Bearer ' + key : '');
}

function zenmuxHeaders(account) {
    return {
        accept: 'application/json, text/plain, */*',
        authorization: zenmuxAuthorization(account),
        'user-agent': 'codingplan-monitor/1.0'
    };
}

function zenmuxRequestOptions() {
    return { proxyUrl: process.env.ZENMUX_PROXY_URL || '', timeoutMs: 15000 };
}

function zenmuxGet(account, path) {
    return httpsGet(BASE_URL + path, zenmuxHeaders(account), zenmuxRequestOptions());
}

function unwrapZenmuxData(json) {
    if (!json || json.success === false) {
        throw new Error('ZenMux API 返回失败: ' + ((json && (json.message || json.error)) || '未知错误'));
    }
    return json.data || json;
}

function numberOrZero(value) {
    var n = Number(value);
    return isFinite(n) ? n : 0;
}

function zenmuxUsagePercent(quota) {
    var raw = Number(quota && quota.usage_percentage);
    if (isFinite(raw)) return Math.max(0, Math.min(100, raw <= 1 ? raw * 100 : raw));
    var max = numberOrZero(quota && quota.max_flows);
    return max > 0 ? Math.max(0, Math.min(100, numberOrZero(quota.used_flows) / max * 100)) : 0;
}

function normalizeZenmuxWindow(label, quota, periodMs) {
    quota = quota || {};
    return {
        label: label,
        used: numberOrZero(quota.used_flows),
        quota: numberOrZero(quota.max_flows),
        remaining: numberOrZero(quota.remaining_flows),
        usedPct: zenmuxUsagePercent(quota),
        usedValueUsd: numberOrZero(quota.used_value_usd),
        maxValueUsd: numberOrZero(quota.max_value_usd),
        resetMs: quota.resets_at ? Date.parse(quota.resets_at) || null : null,
        periodMs: periodMs,
        unit: 'flow'
    };
}

function zenmuxTierName(tier) {
    var names = { free: 'Free', pro: 'Starter', starter: 'Starter', max: 'Max', ultra: 'Ultra' };
    return names[String(tier || '').toLowerCase()] || String(tier || '-');
}

function parseZenmuxSubscription(json) {
    var data = unwrapZenmuxData(json);
    var plan = data.plan || {};
    var expires = plan.expires_at ? Date.parse(plan.expires_at) || null : null;
    var monthly = data.quota_monthly || {};
    return {
        subscription: {
            tier: plan.tier || null,
            planName: 'ZenMux ' + zenmuxTierName(plan.tier),
            amountUsd: numberOrZero(plan.amount_usd),
            interval: plan.interval || null,
            expireMs: expires,
            expireDate: expires ? new Date(expires).toISOString().slice(0, 10) : null
        },
        usage: {
            windows: [
                normalizeZenmuxWindow('每5小时', data.quota_5_hour, FIVE_HOURS_MS),
                normalizeZenmuxWindow('每周', data.quota_7_day, SEVEN_DAYS_MS)
            ]
        },
        monthlyQuota: {
            maxFlows: numberOrZero(monthly.max_flows),
            maxValueUsd: numberOrZero(monthly.max_value_usd)
        },
        currency: data.currency || 'usd',
        baseUsdPerFlow: numberOrZero(data.base_usd_per_flow),
        effectiveUsdPerFlow: numberOrZero(data.effective_usd_per_flow),
        accountStatus: data.account_status || null
    };
}

function parseZenmuxTodayUsage(json) {
    var data = unwrapZenmuxData(json);
    return {
        tokensTotal: numberOrZero(data.tokensTotal),
        tokensPrompt: numberOrZero(data.tokensPrompt),
        tokensCompletion: numberOrZero(data.tokensCompletion),
        requestCounts: numberOrZero(data.requestCounts)
    };
}

function beijingDateKey(timestamp) {
    var d = new Date((timestamp == null ? Date.now() : timestamp) + 8 * 60 * 60 * 1000);
    return String(d.getUTCFullYear())
        + String(d.getUTCMonth() + 1).padStart(2, '0')
        + String(d.getUTCDate()).padStart(2, '0');
}

function dateKeysForPeriod(period, nowMs) {
    var days = period === '30d' ? 30 : 7;
    var endKey = beijingDateKey(nowMs);
    var endUtc = Date.UTC(+endKey.slice(0, 4), +endKey.slice(4, 6) - 1, +endKey.slice(6, 8));
    var keys = [];
    for (var i = days - 1; i >= 0; i--) keys.push(beijingDateKey(endUtc - i * ONE_DAY_MS - 8 * 60 * 60 * 1000));
    return keys;
}

function parseZenmuxModelUsage(responses, period, nowMs) {
    var keys = dateKeysForPeriod(period, nowMs);
    var allowed = {};
    keys.forEach(function(key) { allowed[key] = true; });
    var models = {};
    var order = [];
    var totalCalls = 0;
    (responses || []).forEach(function(json) {
        var data = unwrapZenmuxData(json);
        (Array.isArray(data.tokensByModel) ? data.tokensByModel : []).forEach(function(row) {
            var key = String(row && row.bizTime || '').slice(0, 8);
            var model = row && row.modelSlug;
            if (!allowed[key] || !model) return;
            if (!models[model]) {
                models[model] = {};
                order.push(model);
            }
            models[model][key] = (models[model][key] || 0) + numberOrZero(row.tokens);
            totalCalls += numberOrZero(row.requestCounts);
        });
    });
    var series = order.map(function(model) {
        return { modelName: model, tokensUsage: keys.map(function(key) { return models[model][key] || 0; }) };
    });
    var totalTokens = series.reduce(function(total, item) {
        return total + item.tokensUsage.reduce(function(sum, value) { return sum + value; }, 0);
    }, 0);
    return {
        x_time: keys.map(function(key) { return key.slice(0, 4) + '-' + key.slice(4, 6) + '-' + key.slice(6, 8); }),
        modelDataList: series,
        totalUsage: { totalTokensUsage: totalTokens, totalModelCallCount: totalCalls }
    };
}

async function fetchZenmuxModelUsage(account, period) {
    var keys = dateKeysForPeriod(period);
    var months = [];
    keys.forEach(function(key) { if (months.indexOf(key.slice(0, 6)) < 0) months.push(key.slice(0, 6)); });
    var responses = await Promise.all(months.map(function(month) {
        return zenmuxGet(account, '/api/v1/management/usage?type=usage&query_dimension=BIZ_MTH&query_time=' + month
            + '&bill_types=metered%2Csubscription%2CfallbackMetered');
    }));
    return parseZenmuxModelUsage(responses, period);
}

async function fetchZenmuxUsage(account, index) {
    try {
        var detailJson = await zenmuxGet(account, '/api/v1/management/subscription/detail');
        var data = parseZenmuxSubscription(detailJson);
        try {
            var todayKey = beijingDateKey();
            var todayJson = await zenmuxGet(account, '/api/v1/management/usage?type=usage&query_dimension=BIZ_DT&query_time=' + todayKey
                + '&bill_types=metered%2Csubscription%2CfallbackMetered');
            data.today = parseZenmuxTodayUsage(todayJson);
        } catch (usageErr) { data.today = null; }
        var result = {
            index: index,
            name: account.name,
            platform: 'zenmux',
            responsiblePerson: account.responsiblePerson,
            phone: account.phone,
            notes: account.notes,
            isPublic: account.isPublic,
            data: data,
            success: true,
            cachedAt: Date.now()
        };
        setCache(index, result);
        return result;
    } catch (err) {
        return {
            index: index,
            name: account.name,
            platform: 'zenmux',
            responsiblePerson: account.responsiblePerson,
            phone: account.phone,
            notes: account.notes,
            isPublic: account.isPublic,
            error: err.message,
            success: false
        };
    }
}

module.exports = {
    zenmuxAuthorization: zenmuxAuthorization,
    zenmuxUsagePercent: zenmuxUsagePercent,
    parseZenmuxSubscription: parseZenmuxSubscription,
    parseZenmuxTodayUsage: parseZenmuxTodayUsage,
    beijingDateKey: beijingDateKey,
    parseZenmuxModelUsage: parseZenmuxModelUsage,
    fetchZenmuxModelUsage: fetchZenmuxModelUsage,
    fetchZenmuxUsage: fetchZenmuxUsage
};

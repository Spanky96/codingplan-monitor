'use strict';

// Pure planning: no network, clock or persistence. All percentages are 0..100.
const { channelCounts } = require('./channels');
const { scoreAccount } = require('../weights');
const { concurrencyCeiling, resetAllowed, quotaLink, chooseMode, chooseConcurrency } = require('./adaptation');
const { assessFallback } = require('./fallback');
const HOUR = 3600000;
const EXHAUSTED = 100;
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
function timestamp(value) {
    if (typeof value === 'number') return value;
    // Official reset-card timestamps are Beijing wall time, including in UTC containers.
    if (typeof value === 'string' && /^\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d$/.test(value)) {
        return Date.parse(value.replace(' ', 'T') + '+08:00');
    }
    return Date.parse(value);
}
function windowsOf(usage) {
    if (!usage || !usage.success || !usage.data) return [];
    if ((usage.platform || 'glm') === 'glm') {
        return (usage.data.limits || []).filter(w => w && !w._unlimited && [3, 6].includes(w.unit)).map(w => ({
            type: w.unit === 3 ? 'fiveHour' : 'week',
            meter: w.type, quota: Number(w.usage) > 0 ? Number(w.usage) : null,
            used: Number(w.usage) > 0 && Number.isFinite(w.currentValue) ? 100 * w.currentValue / w.usage : Number(w.percentage),
            depleted: Number.isFinite(w.remaining) ? w.remaining <= 0 && (!Number.isFinite(w.currentValue) || !(w.usage > 0) || w.currentValue >= w.usage) : Number(w.percentage) >= 100,
            resetAt: timestamp(w.nextResetTime), hours: w.unit === 3 ? 5 : 168
        }));
    }
    return (((usage.data.usage || {}).windows) || []).filter(w => w && !w.weightExcluded).map(w => ({
        type: w.periodMs <= 5 * HOUR ? 'fiveHour' : 'week',
        used: typeof w.usedPct === 'number' ? w.usedPct : (w.quota > 0 ? 100 * w.used / w.quota : NaN),
        resetAt: timestamp(w.resetMs), hours: w.periodMs / HOUR
    }));
}
function validCards(account, now) {
    return ((account.resetCards || {}).cards || []).filter(c =>
        c.recordId && ['week', 'fiveHour'].includes(c.type) && timestamp(c.expireTime) > now
    ).map(c => ({ ...c, expiresAt: timestamp(c.expireTime) })).sort((a, b) => a.expiresAt - b.expiresAt);
}

function plan({ config, accounts, usage, telemetry = {}, previous = {}, previousSummary = {}, now }) {
    const primaryPolicies = config.accounts.filter(p => p.role === 'primary' && !p.paused);
    const observed = primaryPolicies.reduce((n, p) => n + ((telemetry[p.name] || {}).current || 0), 0);
    const lastDemandAt = Math.max(0, ...primaryPolicies.map(p => (telemetry[p.name] || {}).demandAt || 0),
        ...Object.values(previous).map(r => r.demandSeenAt || 0));
    const demandNow = observed > 0 || (lastDemandAt > 0 && now - lastDemandAt < 15 * 60000);
    const rows = config.accounts.map(policy => {
        const index = accounts.findIndex(a => a.name === policy.name);
        const account = accounts[index];
        const cached = usage[index];
        const old = previous[policy.name] || {};
        const live = telemetry[policy.name];
        const ws = windowsOf(cached);
        const short = ws.find(w => w.type === 'fiveHour');
        const week = ws.find(w => w.type === 'week');
        const routes = channelCounts(policy, live);
        const cards = resetAllowed(policy, account) ? validCards(account, now) : [];
        let reasons = [], state = 'balanced', raw = 1, reset = null;
        const row = { name: policy.name, index, role: policy.role, mode: policy.mode || 'auto', weight: 0, concurrency: 1,
            maxConcurrency: concurrencyCeiling(policy), configuredMaxConcurrency: policy.maxConcurrency, priority: 999, state, reasons,
            effectiveMode: policy.mode || 'auto', modeSource: policy.mode && policy.mode !== 'auto' ? 'manual' : 'automatic',
            shortUsed: short ? short.used : null, weeklyUsed: week ? week.used : null,
            shortResetAt: short && Number.isFinite(short.resetAt) ? short.resetAt : null,
            weeklyResetAt: week && Number.isFinite(week.resetAt) ? week.resetAt : null,
            observedConcurrency: live ? live.current : null, matched: live ? live.count : 0,
            cachedAt: cached && cached.cachedAt, reset: null, channelModes: routes.modes, nativeChannels: routes.native, fallbackChannels: routes.fallback };
        row.quotaLink = quotaLink(short, week);
        ['short', 'weekly'].forEach(label => {
            const w = label === 'short' ? short : week;
            const oldRate = old[label + 'RatePerHour'];
            row[label + 'RatePerHour'] = oldRate || 0;
            row[label + 'RateSamples'] = old[label + 'RateSamples'] || 0;
            const elapsed = cached && old.cachedAt ? (cached.cachedAt - old.cachedAt) / HOUR : 0;
            if (w && elapsed > 0 && old[label + 'Used'] != null) {
                const delta = w.used - old[label + 'Used'];
                const sameWindow = !old[label + 'ResetAt'] || !Number.isFinite(w.resetAt) || Math.abs(old[label + 'ResetAt'] - w.resetAt) < 60000;
                row[label + 'RateSamples'] = delta >= 0 && sameWindow && elapsed <= 1 / 6 ? (old[label + 'RateSamples'] || 0) + 1 : 0;
                row[label + 'RatePerHour'] = delta >= 0 && sameWindow && elapsed <= 1 / 6
                    ? (oldRate == null ? delta / elapsed : 0.65 * oldRate + 0.35 * delta / elapsed) : 0;
            }
        });
        const stop = (state, reason) => Object.assign(row, { state, reasons: [reason] });
        if (!account) return stop('missing', '账号已删除或改名，请重新选择');
        if (!live || !live.count) return stop('unmapped', '未匹配到中转站账号');
        if (live.unavailable) return stop('upstream-blocked', '中转站账号存在异常或上游冷却，保留原保护状态');
        if (policy.paused) return stop('paused', '管理员已在智能调度中暂停此账号');
        if (policy.role === 'paid' && !config.allowPaid) return stop('standby', '按量付费兜底关闭');
        if (!routes.native && !routes.fallback) return stop('paused', '全部渠道已暂停');
        if (!(policy.role === 'paid' && policy.unmetered) && (!cached || cached.name !== account.name || !cached.success || !cached.cachedAt ||
            now - cached.cachedAt > config.staleAfterSeconds * 1000 || cached.cachedAt > now + 60000)) {
            return stop('stale', '用量数据缺失或过期，等待刷新后恢复');
        }
        const genericScore = !ws.length && policy.role === 'standard' && cached && cached.success ? scoreAccount(cached) : null;
        if (policy.role !== 'paid' && ((!ws.length && !genericScore) || ws.some(w => !Number.isFinite(w.used) || w.used < 0))) {
            return stop('stale', '缺少可信的额度窗口');
        }
        // Do not infer a reset from the clock alone: wait for a new upstream reading.
        if (ws.some(w => Number.isFinite(w.resetAt) && w.resetAt <= now && cached.cachedAt <= w.resetAt)) {
            return stop('refreshing', '已到重置时刻，等待官方额度确认');
        }
        let shortFactor = 1;
        if (short) {
            const hours = Number.isFinite(short.resetAt) ? clamp((short.resetAt - now) / HOUR, 0.25, 5) : 5;
            shortFactor = clamp(((100 - short.used) / hours) / 20, 0.05, 2);
            if (row.shortRateSamples >= 3 && row.shortRatePerHour > 0) {
                row.shortForecastHours = Math.max(0, 100 - short.used) / row.shortRatePerHour;
                if (row.shortForecastHours < 0.25 && hours > 0.75) shortFactor = Math.min(shortFactor, 0.2);
                else if (row.shortForecastHours < 0.75 && hours > 1) shortFactor = Math.min(shortFactor, 0.55);
                if (row.shortForecastHours < 0.75 && hours > 1) reasons.push('按官方近期消耗速度，5h 预计 ' + Math.round(row.shortForecastHours * 60) + ' 分钟耗尽，提前收紧');
            }
        }
        Object.assign(row, chooseMode({ policy, account, cards, short, week, shortFactor, old, live, now,
            recentDemand: demandNow, weekMinHours: config.resetWeekMinHours || 24 }));
        const exhausted = ws.filter(w => w.used >= EXHAUSTED);
        if (exhausted.length) {
            // A weekly card cannot clear an exhausted 5h window. Restore the shorter window last.
            const target = exhausted.find(w => w.type === 'week') || exhausted[0];
            const card = target.depleted ? cards.find(c => c.type === target.type) : null;
            if (card) {
                reset = { type: card.type, recordId: card.recordId, expireTime: card.expireTime };
            }
            return Object.assign(stop('exhausted', '额度已用尽，等待自然重置'), { reset });
        }
        if (policy.role === 'paid' && !policy.unmetered) {
            const d = cached.data || {};
            if (d.balance == null && d.platformGiftBalance == null) return stop('stale', '未提供余额数据，需允许无余额数据的按量占位才可兜底');
            if (!(Number(d.balance || 0) + Number(d.platformGiftBalance || 0) > 0)) return stop('exhausted', '按量账号无可用余额');
        }
        if (genericScore) {
            if (genericScore.exhausted || !(genericScore.weight > 0)) return stop('exhausted', '额度已用尽');
            raw = genericScore.weight;
        }
        if (shortFactor < 0.6) { state = 'protecting'; reasons.push('5 小时额度偏紧，降低流量并保留并发分摊'); }
        if (week) {
            let hours = Number.isFinite(week.resetAt) ? clamp((week.resetAt - now) / HOUR, 1, 168) : 168;
            if (hours < 24 && week.used < 90) {
                state = 'draining'; reasons.push('周额度临近重置，优先消耗剩余额度');
            }
            // Required remaining burn rate, normalized to a full week's average rate.
            raw = Math.sqrt(clamp(((100 - week.used) / hours) / (100 / 168), 0.05, 16));
        }
        raw *= shortFactor * policy.quotaScale;
        if (policy.role === 'primary' && row.effectiveMode === 'slow') {
            raw *= 0.2; state = 'slow'; reasons.unshift('管理员指定低速保护，限制流量与并发');
        } else if (policy.role === 'primary' && row.effectiveMode === 'burst') {
            if (row.accelerationActive !== false) raw *= row.accelerationFactor || 4;
            state = row.accelerationActive === false ? 'protecting' : 'burst';
            reasons.unshift(row.modeReason || '人工高速消耗，优先分配流量');
        }
        if (row.modeReason && row.effectiveMode !== 'burst') reasons.unshift(row.modeReason);
        const allocation = chooseConcurrency({ policy, routes, short, shortFactor, old, live, now,
            effectiveMode: row.accelerationActive === false ? 'auto' : row.effectiveMode, recentDemand: demandNow });
        if (allocation.shortProtection && row.effectiveMode !== 'slow') state = 'protecting';
        if (!reasons.length) reasons.push('按周剩余额度与重置时间分流，保持多账号均衡');
        if (live.limited) { state = 'cooldown'; raw *= 0.25; }
        reasons.push('并发 ' + allocation.concurrency + '/' + allocation.concurrencyCeiling + '：' + allocation.concurrencyReason);
        return Object.assign(row, allocation, { state, reasons, raw });
    });
    const primaryReady = rows.filter(r => r.role === 'primary' && r.nativeChannels && r.raw > 0 && !r.limited);
    const hasPrimary = primaryReady.length > 0;
    const fallbackAssessment = assessFallback({ rows, previous: previousSummary.fallbackAssessment,
        config, now, recentDemand: demandNow });
    const earlyFallback = fallbackAssessment.active;
    rows.forEach(r => {
        if (r.raw && r.role === 'paid' && hasPrimary && !earlyFallback) {
            r.raw = 0; r.state = 'standby'; r.reasons = ['按量渠道待命'];
        }
    });
    const hasPaid = rows.some(r => r.role === 'paid' && r.raw > 0 && r.nativeChannels && !r.limited);
    const fallbackAllowed = config.allowDilution && (!hasPrimary || earlyFallback) && !hasPaid;
    rows.forEach(r => {
        if (r.raw && !r.nativeChannels && (!r.fallbackChannels || !fallbackAllowed)) {
            r.raw = 0; r.state = 'standby'; r.reasons = ['备用分流待命'];
        }
    });
    const peak = Math.max(1, ...rows.map(r => r.raw || 0));
    rows.forEach(r => {
        if (!r.raw) return;
        let target = clamp(10 * r.raw / peak, 0.1, 10);
        const old = previous[r.name];
        // Smooth non-emergency transitions only. Zero/exhaustion always takes effect immediately.
        if (old && old.weight > 0 && r.role === 'primary' && !['protecting', 'cooldown', 'slow'].includes(r.state)) {
            target = 0.65 * old.weight + 0.35 * target;
        }
        r.weight = Math.round(target * 10) / 10;
    });
    const primaryWeight = rows.filter(r => r.role === 'primary' && r.nativeChannels).reduce((n, r) => n + r.weight, 0);
    const fallbackPools = rows.filter(r => r.weight > 0 && (r.fallbackChannels || r.role === 'paid')).length;
    const fallbackCap = hasPrimary ? primaryWeight * (fallbackAssessment.fraction || 0.15) / Math.max(1, fallbackPools) : Infinity;
    rows.forEach(r => {
        if (r.role === 'paid' && hasPrimary) r.weight = Math.floor(Math.min(r.weight, fallbackCap) * 10) / 10;
        const total = r.nativeChannels + (fallbackAllowed ? r.fallbackChannels : 0);
        r.fallbackWeight = fallbackAllowed && r.fallbackChannels && total
            ? Math.floor(Math.min(r.weight * r.fallbackChannels / total, fallbackCap) * 10) / 10 : 0;
        r.nativeWeight = r.nativeChannels ? Math.round((r.weight - r.fallbackWeight) * 10) / 10 : 0;
        r.weight = Math.round((r.nativeWeight + r.fallbackWeight) * 10) / 10;
        if (r.fallbackWeight > 0) {
            const reason = '备用分流已启用：' + (hasPrimary ? fallbackAssessment.reason : '主力当前不可用');
            if (!r.nativeChannels) { r.state = 'fallback'; r.reasons = [reason]; }
            else r.reasons.push(reason);
        }
        if (r.role === 'paid' && r.weight > 0) r.reasons.push('按量兜底已启用：' + (hasPrimary ? fallbackAssessment.reason : '主力当前不可用'));
    });
    rows.sort((a, b) => b.weight - a.weight || a.name.localeCompare(b.name));
    const sum = rows.reduce((v, r) => v + r.weight, 0);
    rows.forEach((r, i) => { r.priority = i + 1; r.share = sum ? Math.round(1000 * r.weight / sum) / 10 : 0; delete r.raw; });
    const primary = rows.filter(r => r.role === 'primary');
    const available = primary.filter(r => r.weight > 0 && !r.limited);
    const current = primary.reduce((n, r) => n + (r.observedConcurrency || 0), 0);
    const capacity = available.reduce((n, r) => n + Math.max(r.concurrency, (telemetry[r.name] || {}).capacity || 0), 0);
    const demandSeenAt = current > 0 ? now : Math.max(0,
        ...primary.map(r => (telemetry[r.name] || {}).demandAt || 0),
        ...Object.values(previous).map(r => r.demandSeenAt || 0));
    const recentDemand = now - demandSeenAt < 15 * 60000;
    const imminent = available.length > 0 && available.every(r => {
        const shortHours = r.shortRatePerHour > 0 ? (100 - r.shortUsed) / r.shortRatePerHour : Infinity;
        const weeklyHours = r.weeklyRatePerHour > 0 ? (100 - r.weeklyUsed) / r.weeklyRatePerHour : Infinity;
        return (shortHours < 1 && r.shortResetAt - now > HOUR) || (weeklyHours < 1 && r.weeklyResetAt - now > HOUR);
    });
    const pressure = recentDemand && (available.length === 0 ||
        (capacity > 0 && current / capacity >= 0.75) || imminent || fallbackAssessment.active);
    const stock = { week: 0, fiveHour: 0 };
    config.accounts.forEach(p => {
        const a = accounts.find(a => a.name === p.name);
        if (resetAllowed(p, a)) validCards(a, now).forEach(c => { stock[c.type]++; });
    });
    rows.forEach(r => {
        r.demandSeenAt = demandSeenAt;
        if (!r.reset) return;
        const card = r.reset, p = config.accounts.find(p => p.name === r.name);
        const resetAt = card.type === 'week' ? r.weeklyResetAt : r.shortResetAt;
        const hours = (resetAt - now) / HOUR;
        const expiresSoon = timestamp(card.expireTime) - now < 6 * HOUR;
        let hold = '';
        if (!Number.isFinite(hours) || hours <= 0) hold = '缺少可信的自然重置时间，先核对额度';
        else if (card.type === 'week' && hours < (config.resetWeekMinHours || 24)) hold = '周额度不足 24 小时即自然恢复，保留周卡';
        else if (card.type === 'fiveHour' && hours <= config.resetMinRemainingMinutes / 60) hold = '5 小时窗口临近自然恢复，保留短周期卡';
        else if (p.replenishAt && timestamp(p.replenishAt) > now && timestamp(p.replenishAt) - now < (card.type === 'week' ? 24 : 1) * HOUR) hold = '已安排近期充值或补充额度，等待到账';
        else if (card.type === 'week' && r.shortUsed >= EXHAUSTED && (!r.shortResetAt || r.shortResetAt - now > 0.5 * HOUR)) hold = '5 小时窗口也已耗尽，周卡无法恢复当前可用性，先等短窗口恢复';
        else if (card.type === 'fiveHour' && (r.quotaLink ? r.quotaLink.weeklyRemainingInShortPct < 25 : r.weeklyUsed != null && r.weeklyUsed > 85)) hold = '周额度剩余不足，短周期卡的可用收益有限';
        else if ((p.mode || 'auto') === 'auto' && !recentDemand) hold = '近期无主力请求，等待需求后再用卡';
        r.resetDecision = { decision: hold ? 'hold' : 'use', type: card.type, stock: stock[card.type],
            naturalResetHours: Number.isFinite(hours) ? Math.round(hours * 10) / 10 : null,
            pressure, expiresSoon, benefit: Math.max(0, Math.min(hours, 168)) * (expiresSoon ? 2 : 1) };
        r.reasons = [hold ? '暂不用卡：' + hold : '已授权且额度已用尽，自动使用最早到期的' + (card.type === 'week' ? '周卡' : '5 小时卡')];
        if (hold) r.reset = null;
    });
    return { generatedAt: now, rows, summary: {
        pressure, recentDemand, cardStock: stock, fallbackAssessment,
        active: rows.filter(r => r.weight > 0).length,
        capacity: rows.filter(r => r.weight > 0).reduce((v, r) => v + r.concurrency, 0),
        paid: rows.some(r => r.role === 'paid' && r.weight > 0),
        dilution: rows.some(r => r.fallbackWeight > 0),
        unavailable: !rows.some(r => r.weight > 0),
        warning: '权重是新请求的目标比例；会话粘性、模型路由和并发占用会影响实际比例。总需求超过额度供给时，调度无法保证全天不断供。'
    } };
}

module.exports = { plan, windowsOf, validCards, timestamp, EXHAUSTED };

'use strict';
const MINUTE = 60000, HOUR = 60 * MINUTE;

// Forecast capacity, not token consumption. Only official quota deltas contribute.
function assessFallback({ rows, previous = {}, config, now, recentDemand, load }) {
    const primary = rows.filter(r => r.role === 'primary' && r.nativeChannels);
    const ready = primary.filter(r => r.raw > 0 && !r.limited);
    const capacity = ready.reduce((sum, r) => sum + r.concurrency, 0);
    const assigned = rows.filter(r => r.role === 'primary' || r.role === 'paid' || r.fallbackChannels).reduce((sum, r) =>
        sum + (r.role === 'primary' || r.role === 'paid' ? r.observedConcurrency || 0 : r.observedFallbackConcurrency || 0), 0);
    const current = load && now-load.at>=0 && now-load.at<90000 ? Math.max(assigned,load.inFlight) : assigned;
    const consecutive = previous.at && now >= previous.at && now - previous.at <= 90000;
    const old = consecutive ? previous : {};
    const demand = Math.round(Math.max(current, (old.demand || 0) * 0.8 + current * 0.2) * 1000) / 1000;
    const horizon = now + 45 * MINUTE, events = [];
    let atRiskCapacity = 0;
    for (const r of ready) {
        const losses = ['short', 'weekly'].map(label => {
            const used = r[label + 'Used'], rate = r[label + 'RatePerHour'];
            const resetAt = r[label + 'ResetAt'];
            if (!(used >= 50 && used < 100 && rate > 0 && r[label + 'RateSamples'] >= 3 && resetAt > now)) return Infinity;
            const end = now + (100 - used) / rate * HOUR;
            return end + 15 * MINUTE < resetAt ? end : Infinity;
        });
        const end = Math.min(...losses);
        if (end < horizon) {
            atRiskCapacity += r.concurrency;
            events.push({ at: end, delta: -r.concurrency });
        }
    }
    for (const r of primary.filter(r => r.state === 'exhausted')) {
        const blocked = ['short', 'weekly'].filter(label => r[label + 'Used'] >= 100);
        if (!blocked.length) continue;
        const recoverAt = Math.max(...blocked.map(label => r[label + 'ResetAt'] || Infinity));
        if (recoverAt > now && recoverAt < horizon) {
            // Estimate the conservative initial capacity; actual reopening still requires fresh usage.
            events.push({ at: recoverAt, delta: Math.min(2, r.maxConcurrency) });
        }
    }
    events.sort((a, b) => a.at - b.at);
    let projected = capacity, minimum = capacity;
    for (let i = 0; i < events.length; i++) {
        projected += events[i].delta;
        const until = i + 1 < events.length ? events[i + 1].at : horizon;
        // A brief gap immediately before natural recovery does not justify model substitution.
        if (until - events[i].at >= 5 * MINUTE) minimum = Math.min(minimum, projected);
    }
    const allTight = ready.length > 0 && ready.every(r => r.shortUsed >= 85 || r.weeklyUsed >= 95);
    // Count fresh, mapped quota accounts, including exhausted ones awaiting recovery.
    // A working card carrier can deliberately run ahead of its own weekly budget.
    const measured = primary.filter(r => (r.raw > 0 || r.state === 'exhausted') &&
        (r.weeklyPace || (Number.isFinite(r.shortUsed) && r.shortResetAt > now)));
    const quotaRisk = measured.filter(r => {
        const ahead = r.weeklyPace?.workAheadPct;
        const carrier = r.accelerationReason === 'reset-card' && r.accelerationActive;
        const weekTight = !carrier && r.weeklyResetAt - now >= 24 * HOUR &&
            (ahead >= 20 || (r.weeklyUsed >= 90 && ahead >= 10));
        const shortTight = r.shortUsed >= 85 && r.shortResetAt - now > 45 * MINUTE &&
            (r.shortProtection > 0 || r.shortUsed >= 100);
        return weekTight || shortTight;
    }).length;
    const quotaPressure = quotaRisk >= 2 && quotaRisk * 3 >= measured.length;
    const overloaded = capacity > 0 && demand >= capacity * 0.85;
    const forecast = capacity > 0 && atRiskCapacity >= capacity * 0.4 && minimum < capacity && demand >= minimum * 0.75;
    const permitted = config.fallbackWhen === 'pressure' && recentDemand && capacity > 0 && (config.allowPaid || config.allowDilution);
    const triggered = permitted && (allTight || quotaPressure || overloaded || forecast);
    const pendingSince = triggered ? old.pendingSince || now : 0;
    const confirmed = triggered && (allTight || now - pendingSince >= MINUTE);
    const calmSince = !triggered && old.active ? old.calmSince || now : 0;
    const retained = permitted && old.active && (!calmSince || now - calmSince < 3 * MINUTE);
    const active = !!(confirmed || retained);
    const fraction = active ? confirmed ? (allTight || quotaPressure) ? 0.15 : overloaded ? 0.10 : 0.05 : old.fraction : 0;
    const reason = active && !confirmed ? '恢复观察，暂时保留小比例分流' : allTight ? '可用主力额度普遍偏紧'
        : quotaPressure ? quotaRisk + '/' + measured.length + ' 个主力周预算超前或短窗临近耗尽，提前分流'
        : overloaded ? '主力并发持续接近承接上限' : forecast ? '预计 45 分钟内可用并发下降至 ' + minimum + '，已计入临近自然恢复' : '主力承接余量足够';
    const capacityGap = demand > capacity ? Math.max(0, Math.ceil(demand / 0.85) - capacity) : 0;
    return { at: now, active, pendingSince, calmSince, fraction, reason, demand, capacity, capacityGap,
        demandSource: load ? load.source : 'account-slots', unassigned: load ? load.unassigned : 0,
        projectedCapacity: minimum, atRiskCapacity, horizonMinutes: 45, quotaPressure, quotaRisk, quotaMeasured: measured.length };
}

module.exports = { assessFallback };

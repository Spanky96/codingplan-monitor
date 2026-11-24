'use strict';
const HOUR = 3600000;
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

// Match the dashboard's work-time waterline: weekdays 08:00–18:00, Beijing time.
// Weekends must not manufacture a catch-up deficit before Monday's demand arrives.
function weeklyWaterline(resetAt, now) {
    const start = resetAt - 168 * HOUR, day = 24 * HOUR, offset = 8 * HOUR;
    let total = 0, elapsed = 0;
    for (let midnight = Math.floor((start + offset) / day) * day - offset; midnight < resetAt; midnight += day) {
        const dow = new Date(midnight + offset).getUTCDay();
        if (dow === 0 || dow === 6) continue;
        const from = Math.max(start, midnight + 8 * HOUR), to = Math.min(resetAt, midnight + 18 * HOUR);
        total += Math.max(0, to - from);
        elapsed += Math.max(0, Math.min(now, to) - from);
    }
    return total ? clamp(100 * elapsed / total, 0, 100) : clamp(100 * (now - start) / (168 * HOUR), 0, 100);
}

function concurrencyCeiling(policy) {
    return Math.max(1, Math.min(policy.maxConcurrency || 1, policy.role === 'primary' ? 4 : 64));
}
function resetAllowed(policy, account) {
    return !!(policy && account && policy.autoReset && !policy.paused && policy.role === 'primary' &&
        policy.mode !== 'slow' && (account.platform || 'glm') === 'glm' && !account.teamEdition);
}
// Couple windows only when the provider supplies totals in the same CREDIT unit.
// Percentages and request token counts alone do not establish a conversion ratio.
function quotaLink(short, week) {
    if (!short || !week || short.meter !== 'CREDIT_LIMIT' || week.meter !== short.meter || !(short.quota > 0 && week.quota > 0)) return null;
    const ratio = short.quota / week.quota;
    const needed = Math.max(0, 100 - week.used) / ratio;
    return { source: 'official-credit', shortToWeekRatio: ratio,
        weeklyRemainingInShortPct: Math.round(needed * 100) / 100,
        canFinishInCurrentShortWindow: needed <= Math.max(0, 100 - short.used) };
}
function weeklyPace(week, now) {
    if (!week || !Number.isFinite(week.resetAt)) return null;
    const hours = (week.resetAt - now) / HOUR;
    if (!(hours > 0 && hours <= 168)) return null;
    const elapsed = 168 - hours, expected = elapsed / 168 * 100;
    const waterline = weeklyWaterline(week.resetAt, now);
    const rate = elapsed >= 1 ? week.used / elapsed : 0;
    const finish = rate > 0 ? Math.max(0, 100 - week.used) / rate : Infinity;
    const tenth = n => Math.round(n * 10) / 10;
    return { expectedPct: tenth(expected), waterlinePct: tenth(waterline), aheadPct: tenth(week.used - expected),
        workAheadPct: tenth(week.used - waterline), projectedGapHours: Number.isFinite(finish) ? tenth(hours - finish) : null };
}
function chooseMode({ policy, account, cards, short, week, shortFactor, old, live, now, recentDemand, weekMinHours, pace, atRisk }) {
    const requested = policy.mode || 'auto';
    const result = { effectiveMode: requested, modeSource: requested === 'auto' ? 'automatic' : 'manual', modeReason: '' };
    if (requested !== 'auto' || policy.role !== 'primary') return result;
    const hold = reason => ({ ...result, modeReason: reason });
    if (!pace) return hold('缺少可信的周窗口，暂不自动加速');
    const hours = (week.resetAt - now) / HOUR, elapsed = 168 - hours;
    const meanRate = elapsed >= 1 ? week.used / elapsed : 0;
    const remaining = Math.max(0, 100 - week.used);
    const finishHours = meanRate > 0 ? remaining / meanRate : Infinity;
    if (!recentDemand) return hold('近期无主力请求，保持均衡');
    const continuing = old.effectiveMode === 'burst' && old.modeSource === 'automatic';
    const accelerating = continuing && old.accelerationActive !== false;
    // A high percentage alone is not pressure when the remaining allowance can
    // comfortably cover the time to natural recovery. Keep measured fast-burn
    // forecasts (which lower shortFactor) and actual upstream limits binding.
    const shortTight = !short || shortProtection(short, shortFactor, old, now) > 0 || shortFactor < (accelerating ? 0.45 : 0.65) ||
        (short.used >= (accelerating ? 90 : 80) && shortFactor < 1);
    const burst = (reason, source, factor = 4) => {
        // A carrier holding a weekly card may spend its whole short window: the
        // card, or the natural short reset, reopens it. Surplus catch-up has no
        // such card and keeps the measured fast-burn and short-window guards.
        const limited = live.limited || (old.lastLimitedAt && now - old.lastLimitedAt < 120000);
        const blocked = limited ? '上游限流或恢复观察，暂缓加速'
            : source !== 'reset-card' && shortTight ? '5h 保护，暂缓加速' : '';
        // Keep the weekly strategy visible while temporary protection removes its boost.
        return { ...result, effectiveMode: 'burst', accelerationReason: source, accelerationFactor: factor,
            accelerationActive: !blocked, modeReason: reason + (blocked ? '；' + blocked : '') };
    };

    // Burning this week's surplus is independent of permission to spend a reset card.
    // Separate hysteresis keeps a previous card-backed burst from relaxing this trigger.
    const catchingUp = continuing && old.accelerationReason === 'surplus';
    const deficit = -pace.workAheadPct;
    const lagging = elapsed >= 1 && deficit >= (catchingUp ? 5 : 10);
    const expiring = hours <= 24 && remaining >= (catchingUp ? 5 : 10);
    if (remaining > 0 && (lagging || expiring)) {
        const requiredRate = remaining / hours;
        const factor = clamp(requiredRate / Math.max(meanRate, 100 / 168), 1.5, 4);
        return burst('周余量 ' + Math.round(remaining) + '%，距重置约 ' + Math.ceil(hours) + ' 小时；' +
            (lagging ? '落后理论水位 ' + Math.round(deficit) + ' 个百分点，自动高速补进度' : '临近到期，自动高速消耗余量'), 'surplus', factor);
    }
    if (!resetAllowed(policy, account)) return hold('此账号不参与自动用卡，按周额度调度');
    const weeklyCard = cards.find(c => c.type === 'week');
    if (!weeklyCard) return hold('无可用周卡，回到额度均衡');
    const checked = (account.resetCards || {}).checkedAt;
    if (!checked || now - checked > 15 * 60000 || checked > now + 60000) return hold('卡库存待刷新，暂不为用卡加速');
    if (hours < weekMinHours) return hold('临近周自然恢复，暂不为用卡加速');
    const usingCards = continuing && old.accelerationReason === 'reset-card';
    const link = quotaLink(short, week);
    const shortWait = link && !link.canFinishInCurrentShortWindow ? Math.max(0, (short.resetAt - now) / HOUR) : 0;
    const pacedFinish = Math.max(shortWait, finishHours);
    const individual = week.used >= (usingCards ? 45 : 50) && pace.aheadPct >= (usingCards ? 10 : 15)
        && hours - pacedFinish >= (usingCards ? 12 : weekMinHours);
    // Under shared pressure a carrier can start before its own week is overdrawn.
    // Estimate at twice its observed weekly average, subject to the current 5h window.
    const pooled = atRisk >= 2;
    const finish = individual ? pacedFinish : Math.max(shortWait, finishHours / 2);
    if (!individual && !(pooled && hours - finish >= weekMinHours)) return hold('周进度尚不需要用卡加速');
    const replenish = policy.replenishAt ? Date.parse(policy.replenishAt) : NaN;
    if (replenish > now && replenish - now < (finish + weekMinHours) * HOUR) return hold('预计补充额度将覆盖缺口，暂不加速用卡');
    if (!cards.some(c => c.type === 'week' && c.expiresAt > now + finish * HOUR)) return hold('预计耗尽前周卡将到期，暂不依赖该卡加速');
    const reason = pooled ? atRisk + ' 个主力周用量领先至少一个工作日，优先承担流量'
        : '按本周速度预计提前耗尽约 ' + Math.round(hours - finish) + ' 小时';
    return burst(reason + '；有周卡，自动高速', 'reset-card');
}
function shortProtection(short, shortFactor, old, now) {
    const shortHours = short && Number.isFinite(short.resetAt) ? Math.max(0, (short.resetAt - now) / HOUR) : 5;
    let protection = 0;
    if (short && (shortFactor < 0.25 || (short.used >= 95 && shortHours > 0.5))) protection = 2;
    else if (short && (shortFactor < 0.6 || (short.used >= 85 && shortHours > 0.5))) protection = 1;
    if (old.shortProtection === 2 && shortFactor < 0.4) protection = 2;
    else if (old.shortProtection >= 1 && shortFactor < 0.75) protection = Math.max(protection, 1);
    return protection;
}
function chooseConcurrency({ policy, routes, short, shortFactor, old, live, now, effectiveMode, recentDemand, fast = false }) {
    const ceiling = concurrencyCeiling(policy);
    const channels = Math.max(1, routes.native + routes.fallback);
    const initial = Math.min(ceiling, Math.max(2, channels));
    let adaptive = clamp(old.adaptiveConcurrency || initial, 1, ceiling);
    let adjustedAt = old.adjustedAt || now, lastLimitedAt = old.lastLimitedAt || 0;
    // A high-speed row spends its short window on purpose, so it has no quota cap.
    const protection = fast ? 0 : shortProtection(short, shortFactor, old, now);
    const quotaCap = Math.min(ceiling, protection === 2 ? 1 : protection === 1 ? 2 : ceiling);
    const previousActual = clamp(old.concurrency || initial, 1, ceiling);
    // Only consecutive, timely samples establish sustained saturation; idle/gaps reset it.
    const consecutive = old.plannedAt && now - old.plannedAt >= 0 && now - old.plannedAt <= 90000;
    const saturated = live.current >= previousActual * 0.75;
    let busySince = !live.limited && saturated ? (consecutive && old.busySince ? old.busySince : now) : 0;
    let reason = '等待持续负载';
    if (live.limited) {
        lastLimitedAt = now; busySince = 0;
        if (!old.limited || now - adjustedAt >= 120000) {
            adaptive = Math.max(1, Math.floor(Math.min(adaptive, previousActual) / 2)); adjustedAt = now;
        }
        reason = '上游限流，降低并发';
    } else if (lastLimitedAt && now - lastLimitedAt < 120000) {
        busySince = 0; reason = '限流恢复观察';
    } else if (fast && recentDemand && !old.fast && ceiling > adaptive) {
        // The request to burn is explicit, so entering needs no one-step probe.
        // Recovery after a limit still climbs one step per sustained busy interval.
        adaptive = ceiling; adjustedAt = now; busySince = 0;
        reason = '高速模式有需求，并发升至上限';
    } else if (effectiveMode === 'burst' && old.effectiveMode !== 'burst' && recentDemand && protection === 0 && ceiling > adaptive) {
        adaptive = Math.min(ceiling, adaptive + 1); adjustedAt = now; busySince = 0;
        reason = '高速进入，试探增加一档';
    } else if (busySince && now - busySince >= 120000 && now - adjustedAt >= 120000 && quotaCap > adaptive) {
        adaptive = Math.min(ceiling, adaptive + 1); adjustedAt = now; busySince = 0;
        reason = '连续繁忙两分钟，增加一档';
    }
    let concurrency = Math.min(adaptive, quotaCap);
    if (effectiveMode === 'slow') { concurrency = Math.min(channels, ceiling); busySince = 0; reason = '人工低速保护'; }
    else if (protection) reason = '5 小时额度保护';
    else if (adaptive >= ceiling && !live.limited && !(lastLimitedAt && now - lastLimitedAt < 120000)) reason = '已达允许上限';
    return { concurrency, adaptiveConcurrency: adaptive, adjustedAt, lastLimitedAt, busySince,
        plannedAt: now, shortProtection: protection, concurrencyReason: reason,
        concurrencyCeiling: ceiling, limited: !!live.limited };
}
module.exports = { concurrencyCeiling, resetAllowed, quotaLink, weeklyWaterline, weeklyPace, chooseMode, chooseConcurrency };

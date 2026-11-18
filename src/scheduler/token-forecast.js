'use strict';

const { windowsOf } = require('./planner');
const { beijingMidnight } = require('../lib/util');
const HOUR = 3600000, MINUTE = 60000;
function cutoff(now) {
    return beijingMidnight(now) + 18 * HOUR;
}

// Both windows fund the same requests. Only refill the window that actually
// crosses a natural reset, and only count throughput deliverable before cutoff.
function deliverable(short, week, rates, now, end) {
    const windows = [short, week].map(w => ({
        left: Math.max(0, 100 - w.used) * rates[w.type], full: 100 * rates[w.type],
        next: w.resetAt, period: w.hours * HOUR
    }));
    let total = 0;
    for (let at = now; at < end;) {
        const next = Math.min(end, ...windows.map(w => w.next));
        const amount = Math.min(rates.tokensPerHour * (next - at) / HOUR, ...windows.map(w => w.left));
        total += amount;
        for (const w of windows) {
            w.left -= amount;
            if (next === w.next) { w.left = w.full; w.next += w.period; }
        }
        at = next;
    }
    return Math.round(total);
}

function observedRates(samples) {
    const last = samples.at(-1);
    for (const first of samples) {
        const ms = last.at - first.at, quotaMs = last.quotaAt - first.quotaAt;
        if (ms < 5 * MINUTE || Math.abs(quotaMs - ms) > ms / 4) continue;
        const tokens = last.tokens - first.tokens;
        const sd = last.short.used - first.short.used, wd = last.week.used - first.week.used;
        if (!(tokens > 0 && sd >= 2)) continue;
        // CREDIT budgets have an official common unit. V2 needs observed
        // deltas in both windows, as its percentages have no published ratio.
        const perShort = tokens / sd;
        const linked = last.short.meter === 'CREDIT_LIMIT' && last.week.meter === last.short.meter &&
            last.short.quota > 0 && last.week.quota > 0;
        // With whole-percent V2 readings a displayed 0 or 1 point change can
        // hide up to one more point. Use that upper burn bound until the
        // weekly signal is larger, so rounding cannot inflate the estimate.
        const weekDelta = wd < 2 ? wd + 1 : wd;
        return {
            fiveHour: perShort,
            week: linked ? perShort * last.week.quota / last.short.quota : tokens / weekDelta,
            tokensPerHour: tokens * HOUR / ms
        };
    }
    return null;
}
function median(values) {
    const sorted = values.sort((a, b) => a - b), mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function recordSample(histories, name, point) {
    let history = (histories.get(name) || []).filter(h => point.at - h.at <= HOUR);
    const prev = history.at(-1);
    const changedWindow = prev && ['short', 'week'].some(k =>
        point[k].used < prev[k].used || Math.abs(point[k].resetAt - prev[k].resetAt) > MINUTE);
    if (prev && (changedWindow || prev.day !== point.day || prev.group !== point.group || point.tokens < prev.tokens)) history = [];
    if (!history.length || point.at > history.at(-1).at) history.push(point);
    histories.set(name, history);
    return observedRates(history);
}

function createForecast() {
    const histories = new Map();
    let latest = null;
    function observe(accounts, usage, policies, snapshot, now) {
        const at = Date.parse(snapshot.generated_at), end = cutoff(now);
        if (now >= end || !Number.isFinite(at) || at > now + MINUTE || now - at > 5 * MINUTE ||
            !(Date.parse(snapshot.day_start) <= now && now < Date.parse(snapshot.day_end))) return;
        const names = accounts.map(a => a.name).sort((a, b) => b.length - a.length);
        const totals = new Map();
        for (const r of snapshot.rows) {
            const name = names.find(n => typeof r.account_name === 'string' && r.account_name.startsWith(n));
            if (name && Number.isFinite(r.total_tokens) && r.total_tokens >= 0) totals.set(name, (totals.get(name) || 0) + r.total_tokens);
        }
        const coding = accounts.filter(a => (a.platform || 'glm') === 'glm' && !policies.some(p => p.name === a.name && p.role === 'paid'));
        for (const name of histories.keys()) if (!coding.some(a => a.name === name)) histories.delete(name);
        const entries = [], groups = new Map();
        for (const account of coding) {
            const u = usage[accounts.indexOf(account)];
            if (!u || u.name !== account.name || !u.success || !Number.isFinite(u.cachedAt) || Math.abs(u.cachedAt - at) > 5 * MINUTE) continue;
            const ws = windowsOf(u), short = ws.find(w => w.type === 'fiveHour'), week = ws.find(w => w.type === 'week');
            if (!short || !week || ![short, week].every(w => Number.isFinite(w.used) && w.used >= 0)) continue;
            if ([short, week].some(w => w.used >= 100 && w.resetAt >= end)) {
                entries.push({ zero: true }); continue;
            }
            // An unopened rolling window may omit its first reset timestamp.
            for (const w of [short, week]) if (!Number.isFinite(w.resetAt) && w.used === 0) w.resetAt = now + w.hours * HOUR;
            if (!(short.resetAt > now && week.resetAt > now)) continue;
            const group = JSON.stringify([!!account.teamEdition, u.data.level, short.meter, week.meter, short.quota, week.quota]);
            const point = { at, quotaAt: u.cachedAt, short, week, group, day: snapshot.day_start, tokens: totals.get(account.name) || 0 };
            const rates = recordSample(histories, account.name, point);
            if (rates && u.data.level) {
                if (!groups.has(group)) groups.set(group, []);
                groups.get(group).push(rates);
            }
            entries.push({ short, week, group, rates });
        }
        let tokens = 0, covered = 0, byTier = 0, zero = 0;
        for (const entry of entries) {
            if (entry.zero) { covered++; zero++; continue; }
            let rates = entry.rates;
            if (!rates) {
                const peers = groups.get(entry.group);
                if (!peers || peers.length < 2) continue;
                rates = {
                    fiveHour: median(peers.map(r => r.fiveHour)),
                    week: median(peers.map(r => r.week)),
                    tokensPerHour: median(peers.map(r => r.tokensPerHour))
                };
                byTier++;
            }
            tokens += deliverable(entry.short, entry.week, rates, now, end);
            covered++;
        }
        const estimated = covered > zero || (covered > 0 && covered === coding.length);
        latest = { sampledAt: at, until: end, total: coding.length, covered, byTier, tokens: estimated ? tokens : null };
    }
    function result(now) {
        return latest && latest.until === cutoff(now) && now < latest.until && now - latest.sampledAt < 5 * MINUTE ? latest : null;
    }
    return { observe, result };
}
module.exports = { createForecast, cutoff };

'use strict';

// Weighted routing picks among accounts that still have a free slot, so weights
// decide who is served first while more than one account can take a request.
const { FLASH_LEAD } = require('./adaptation');
const MAX_WEIGHT = 10, MIN_WEIGHT = 0.1;
// The relay's weight range is 0.1–10, so preference is a ratio rather than a
// strict priority. While a high-speed account can still take traffic, the rest
// of the primary pool keeps at most this share of its combined weight.
const FAST_YIELD = 0.25;
const IMMEDIATE = ['protecting', 'cooldown', 'slow'];
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const tenth = n => Math.round(n * 10) / 10;
const total = (list, pick) => list.reduce((n, x) => n + pick(x), 0);

// A high-speed row burns on purpose: an administrator's explicit request, or an
// automatic carrier holding a verified weekly card. Spending the whole 5h window
// costs it nothing the card or the natural short reset does not restore, so it
// is neither throttled nor capped for its own protection. An upstream limit
// suspends the status; see chooseConcurrency for the cautious way back.
function fastBurn(row, limited) {
    if (row.role !== 'primary' || limited) return false;
    return (row.modeSource === 'manual' && row.effectiveMode === 'burst') ||
        (row.accelerationReason === 'reset-card' && row.accelerationActive === true);
}

// Only rows that carry primary traffic on their own channels take part; a row
// reduced to a replacement route exports no native weight at all.
const burns = row => row.fast && row.nativeChannels;

// An explicit manual burn outranks every automatic calculation in its pool.
function capAtManualBurn(rows) {
    const manual = row => burns(row) && row.modeSource === 'manual';
    const peak = Math.max(0, ...rows.filter(manual).map(r => r.raw || 0));
    return !peak ? rows : rows.map(r => r.role === 'primary' && !manual(r) ? { ...r, raw: Math.min(r.raw || 0, peak) } : r);
}

// Smooth ordinary transitions only: protection, cooldown and a manual burn apply
// at once. Rows without a score stay at zero and never get here.
function smooth(row, target, previous) {
    const old = previous[row.name];
    const immediate = IMMEDIATE.includes(row.state) || (row.fast && row.modeSource === 'manual');
    return !immediate && old && old.weight > 0 && row.role === 'primary' ? 0.65 * old.weight + 0.35 * target : target;
}

// Once every high-speed account is saturated the relay skips it and the others
// share all remaining requests, so only their proportion among themselves matters.
function yieldToHighSpeed(scored) {
    const primary = scored.filter(e => e.weight > 0 && e.row.role === 'primary');
    const fastWeight = total(primary.filter(e => burns(e.row)), e => e.weight);
    const others = new Set(primary.filter(e => !burns(e.row)));
    const otherWeight = total([...others], e => e.weight), budget = fastWeight * FAST_YIELD;
    if (!(fastWeight > 0) || otherWeight <= budget) return scored;
    return scored.map(e => others.has(e)
        ? { ...e, weight: Math.max(MIN_WEIGHT, tenth(e.weight * budget / otherWeight)), yielded: true } : e);
}

function weeklyDiscount(lead) {
    if (!(lead > 0)) return 1;
    if (lead < FLASH_LEAD) return 0.25;
    return 0.1 * FLASH_LEAD / lead;
}

// The short window and remaining time rank accounts within their weekly budget.
function targetWeights(rows, previous) {
    const capped = capAtManualBurn(rows);
    const peak = Math.max(1, ...capped.map(r => r.raw || 0));
    const rounded = capped.map(row => {
        const target = row.raw ? clamp(10 * row.raw / peak, MIN_WEIGHT, MAX_WEIGHT) : 0;
        const lead = row.mode === 'auto' && row.nativeChannels ? row.weeklyPace?.workAheadPct : null;
        // Release old weights immediately across a reset or a waterline crossing.
        const oldLead = previous[row.name]?.weeklyPace?.workAheadPct;
        const smoothWithinBudget = target > 0 && !(lead > 0) && !(lead != null && oldLead > 0);
        const weight = smoothWithinBudget ? smooth(row, target, previous) : target;
        return { row, lead, weight: tenth(weight), yielded: false };
    });
    const preferred = rounded.filter(({ row, lead, weight }) => weight > 0 && lead != null && lead <= 0 &&
        !row.limited && !row.shortProtection && row.state !== 'cooldown');
    const reference = Math.min(MAX_WEIGHT, ...preferred.map(e => e.weight));
    // If all usable primaries are ahead, compare their discounts to the least
    // overdrawn peer. This keeps the relay's 0.1 precision for reserve budgets.
    const primary = rounded.filter(e => e.weight > 0 && e.row.role === 'primary' && e.row.nativeChannels);
    const best = primary.length ? Math.max(...primary.map(e => weeklyDiscount(e.lead))) : 1;
    for (const e of primary) {
        if (!(e.lead > 0)) continue;
        e.weight = Math.max(MIN_WEIGHT, tenth(Math.min(reference, e.weight) * weeklyDiscount(e.lead) / best));
    }
    return Object.fromEntries(yieldToHighSpeed(rounded).map(({ row, weight, yielded }) => [row.name, { weight, yielded }]));
}

module.exports = { fastBurn, targetWeights };

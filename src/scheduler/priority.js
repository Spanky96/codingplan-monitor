'use strict';

// Weighted routing picks among accounts that still have a free slot, so weights
// decide who is served first while more than one account can take a request.
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

// Target weight of every row for one round: the largest score maps to the relay
// maximum. Returns a fresh { name: { weight, yielded } } map; rows are untouched.
function targetWeights(rows, previous) {
    const capped = capAtManualBurn(rows);
    const peak = Math.max(1, ...capped.map(r => r.raw || 0));
    const rounded = capped.map(row => ({ row, yielded: false, weight: row.raw
        ? tenth(smooth(row, clamp(10 * row.raw / peak, MIN_WEIGHT, MAX_WEIGHT), previous)) : 0 }));
    return Object.fromEntries(yieldToHighSpeed(rounded).map(({ row, ...target }) => [row.name, target]));
}

module.exports = { fastBurn, targetWeights };

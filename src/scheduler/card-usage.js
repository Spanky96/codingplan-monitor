'use strict';

// Reset cards are reported in Beijing wall time, also in UTC containers.
const BEIJING = 8 * 3600000, TYPES = ['week', 'fiveHour'];
const EMPTY = Object.freeze({ total: 0, week: 0, fiveHour: 0 });
const dayKey = ms => new Date(ms + BEIJING).toISOString().slice(0, 10);

function isSpent(entry, today) {
    return !!entry && entry.status === 'used' && TYPES.includes(entry.type) &&
        Number.isFinite(entry.at) && dayKey(entry.at) === today;
}

// Cards the monitor itself confirmed using on the given Beijing day, automatic
// and manual alike. Rejected and unconfirmed submissions are not counted: the
// official inventory decides whether a card is gone. Cards spent on the official
// console are unknown here and only show up as a smaller remaining count.
function usedToday(journal, now) {
    const today = dayKey(now);
    return Object.values(journal || {}).reduce((count, entry) => isSpent(entry, today)
        ? { ...count, [entry.type]: count[entry.type] + 1, total: count.total + 1 } : count, { ...EMPTY });
}

module.exports = { usedToday };

'use strict';

const { createHash } = require('node:crypto');
const { windowsOf } = require('../scheduler/planner');
const { beijingMidnight } = require('../lib/util');
const DAY = 86400000;

// Kept alongside the usage cache, keyed independently of the mutable list index.
function observeWeeklyUsage(records, account, usage) {
    const now = usage.cachedAt, day = beijingMidnight(now);
    if (!Array.isArray(usage.data?.limits) || !Number.isFinite(now)) return;
    const week = windowsOf(usage).find(w => w.type === 'week');
    if (!week || !Number.isFinite(week.used) || week.used < 0) return;
    const key = createHash('sha256').update(JSON.stringify([account.name, account.organization, account.project, !!account.teamEdition])).digest('hex');
    const old = records[key], used = Math.min(100, week.used);
    if (old && now < old.at) return;
    const reset = Number.isFinite(week.resetAt) ? week.resetAt : null;
    const sameWindow = old && old.meter === week.meter && old.quota === week.quota &&
        (old.reset === reset || (old.reset && reset && Math.abs(old.reset - reset) < 60000));
    let from = used, since = now, source = 'sample';
    const start = reset && reset - 7 * DAY;
    if (old && old.day === day && sameWindow && used >= old.used) {
        ({ from, since, source } = old);
    } else if (start && start >= day && start <= now && !(old?.day === day && sameWindow && used < old.used)) {
        from = 0; since = start; source = 'reset';
    } else if (now - day < 5 * 60000) {
        source = 'midnight';
    }
    records[key] = { day, at: now, meter: week.meter, quota: week.quota, reset, used, from, since, source };
    for (const [id, r] of Object.entries(records)) if (r.day < day - DAY) delete records[id];
    return { day, from, to: used, since, source };
}

function startMidnightSampling() {
    const { readAccounts } = require('./accounts');
    const { ensureUsageFetch } = require('./cache');
    async function sampleAll() {
        const accounts = readAccounts();
        const paid = new Set(require('../scheduler/store').read().config.accounts.filter(p => p.role === 'paid').map(p => p.name));
        let next = 0;
        await Promise.all([0, 1].map(async () => {
            while (next < accounts.length) {
                const i = next++, a = accounts[i];
                if ((a.platform || 'glm') === 'glm' && !paid.has(a.name)) {
                    await ensureUsageFetch(a, i, true).catch(() => {});
                }
            }
        }));
    }
    const schedule = () => {
        const now = Date.now(), midnight = beijingMidnight(now) + DAY;
        setTimeout(() => {
            schedule();
            sampleAll().catch(() => {}); // Subsequent successful reads record their actual baseline time.
        }, midnight - now).unref();
    };
    schedule();
}
module.exports = { observeWeeklyUsage, startMidnightSampling };

'use strict';
const { defaultChannelMode } = require('./channels');

// User slots include requests waiting for an account; account slots alone miss them.
// User-limit queues are deliberately excluded: more upstream slots cannot release them.
function poolDemand(snapshot, activity, policies, now) {
    const rows = snapshot.accounts || [];
    let assigned = 0, managed = 0;
    const matched = rows.map(a => ({ a, p: policies.filter(p => a.name.startsWith(p.name)).sort((a,b) => b.name.length-a.name.length)[0] }));
    const mixed = new Set(matched.filter(({ a }) => a.suggested_scheduling_mode === 'fallback').map(({ p }) => p));
    for (const { a, p } of matched) {
        const current = Math.max(0, a.current_concurrency || 0);
        assigned += current;
        if (!p || p.paused) continue;
        const mode = p.channelModes ? p.channelModes[a.id] || 'paused' : defaultChannelMode(p.role, a.suggested_scheduling_mode, mixed.has(p));
        if (mode !== 'paused' && (p.role === 'primary' || p.role === 'paid' || mode === 'fallback')) managed += current;
    }
    const fresh = activity && now - activity.at >= 0 && now - activity.at < 90000;
    const unassigned = fresh ? Math.max(0, activity.inUse - assigned) : 0;
    return { at: now, inFlight: managed + unassigned, managed, unassigned,
        source: fresh ? 'user-slots-minus-other-assigned' : 'account-slots',
        userInUse: fresh ? activity.inUse : null, userWaiting: fresh ? activity.waiting : null };
}
module.exports = { poolDemand };

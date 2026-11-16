'use strict';

// User slots include requests waiting for an account; account slots alone miss them.
// User-limit queues are deliberately excluded: more upstream slots cannot release them.
function poolDemand(snapshot, activity, policies, now) {
    const rows = snapshot.accounts || [];
    let assigned = 0, managed = 0;
    for (const a of rows) {
        const current = Math.max(0, a.current_concurrency || 0);
        assigned += current;
        const p = policies.filter(p => a.name.startsWith(p.name)).sort((a,b) => b.name.length-a.name.length)[0];
        const mode = p && (p.channelModes || {})[String(a.id)];
        if (p && !p.paused && (p.role === 'primary' || p.role === 'paid' || mode === 'fallback')) managed += current;
    }
    const fresh = activity && now - activity.at >= 0 && now - activity.at < 90000;
    const unassigned = fresh ? Math.max(0, activity.inUse - assigned) : 0;
    return { at: now, inFlight: managed + unassigned, managed, unassigned,
        source: fresh ? 'user-slots-minus-other-assigned' : 'account-slots',
        userInUse: fresh ? activity.inUse : null, userWaiting: fresh ? activity.waiting : null };
}
module.exports = { poolDemand };

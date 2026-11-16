'use strict';

// Explicit relay IDs keep native endpoints separate from optional replacement routes.
function channelModes(policy, live) {
    const channels = (live && live.channels) || [];
    const out = {};
    channels.forEach(channel => {
        const id = String(channel.id);
        out[id] = policy.channelModes ? (policy.channelModes[id] || 'paused')
            : policy.role === 'standard' || policy.role === 'dilution' ? (channel.suggestedMode || 'native') : 'native';
    });
    return out;
}
function channelCounts(policy, live) {
    const modes = channelModes(policy, live);
    const values = Object.values(modes);
    if (!values.length && live && live.count && !live.channels) {
        // Compatibility for older telemetry; enabling v2 requires channel-capable relay.
        return { modes, native: policy.role === 'dilution' ? 0 : live.count, fallback: policy.role === 'dilution' ? live.count : 0 };
    }
    return { modes, native: values.filter(v => v === 'native').length, fallback: values.filter(v => v === 'fallback').length };
}
function boundChannelCapacity(modes, capacities, ceiling) {
    const result = Object.fromEntries(Object.keys(capacities).map(id=>[id,0]));
    const ids = Object.keys(capacities).filter(id=>capacities[id]>0 && modes[id] && modes[id]!=='paused')
        .sort((a,b)=>(modes[b]==='native')-(modes[a]==='native') || Number(a)-Number(b));
    let remaining = ceiling;
    while (remaining > 0) {
        let added = false;
        for (const id of ids) if (remaining > 0 && result[id]<capacities[id]) {result[id]++;remaining--;added=true;}
        if (!added) break;
    }
    return result;
}
module.exports = { channelModes, channelCounts, boundChannelCapacity };

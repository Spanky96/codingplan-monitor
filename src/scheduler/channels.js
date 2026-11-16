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
module.exports = { channelModes, channelCounts };

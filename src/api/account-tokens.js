'use strict';
const config = require('../config');
const { httpGetJSON } = require('../lib/http');
let cache = null, cachedAt = 0, pending = null;

// A single relay aggregate is shared by the dashboard and the forecast sampler.
function snapshot(force = false) {
    const now = Date.now();
    if (!force && cache && now - cachedAt < 60000 && now < Date.parse(cache.day_end)) return Promise.resolve(cache);
    if (!pending) {
        const url = new URL(config.sub2apiBaseUrl.replace(/\/$/, '') + '/api/account-token-snapshot');
        if (config.relaySnapshotToken) url.searchParams.set('token', config.relaySnapshotToken);
        pending = httpGetJSON(url.toString(), 10000).then(envelope => {
            const data = envelope && envelope.code === 0 && envelope.data;
            if (!data || !Array.isArray(data.rows) || !Number.isFinite(Date.parse(data.day_start)) ||
                !Number.isFinite(Date.parse(data.day_end))) throw new Error('invalid account token snapshot');
            cache = data;
            cachedAt = Date.now();
            return data;
        }).finally(() => { pending = null; });
    }
    return pending;
}
module.exports = { snapshot };

'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');

function fixture() {
    let password = 'test-admin';
    const c = {
        Date, FEATURES: { relayEnabled: true }, API_PREFIX: '', capacityMap: {},
        accountsData: [{ name: 'glm1' }, { name: 'glm12' }, { name: 'MiniMax' }],
        document: { createElement: () => ({}), body: { appendChild() {} }, addEventListener() {} },
        localStorage: { getItem: () => password }, isAdmin: () => !!password,
        renderCards() {}, fetch: async () => ({ ok: true, json: async () => ({ accounts: [] }) })
    };
    vm.createContext(c);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/app/capacity.js'), 'utf8'), c);
    c.logout = () => { password = ''; };
    c.respond = accounts => { c.fetch = async () => ({ ok: true, json: async () => ({ accounts }) }); };
    return c;
}
function account(name, matched_key, current = 1, concurrency = 4) {
    return { name, matched_key, current_concurrency: current, concurrency, schedulable: true, status: 'active' };
}
test('missing relay weight matching keeps badges using the longest monitored prefix, including idle channels', async () => {
    const c = fixture();
    c.respond([account('glm12-main', 'glm12'), account('MiniMax-native', 'MiniMax'), account('MiniMax-backup', 'MiniMax', 0, 0)]);
    await c.loadCapacity();
    c.respond([account('glm12-main'), account('MiniMax-native'), account('MiniMax-backup', undefined, 0, 0), account('Unrelated')]);
    await c.loadCapacity();
    assert.equal(c.capacityMap.glm1, undefined);
    assert.equal(c.capacityMap.glm12.current, 1);
    assert.equal(c.capacityMap.MiniMax.items.length, 2);
    assert.match(c.capacityBadgeHTML('MiniMax'), /1\|4/);
    assert.equal(Object.keys(c.capacityMap).length, 2);
});
test('invalid snapshots and outages preserve last values with a stale hint; recovery clears it', async () => {
    const c = fixture(); c.respond([account('glm1', 'glm1')]); await c.loadCapacity();
    c.fetch = async () => ({ ok: true, json: async () => ({}) }); await c.loadCapacity();
    assert.match(c.capacityBadgeHTML('glm1'), /刷新失败/);
    assert.match(c.capacityBadgeHTML('glm1'), /1\|4/);
    c.fetch = async () => { throw new Error('offline'); }; await c.loadCapacity();
    assert.equal(c.capacityMap.glm1.current, 1);
    c.respond([account('glm1', 'glm1', 0, 0)]); await c.loadCapacity();
    assert.doesNotMatch(c.capacityBadgeHTML('glm1'), /刷新失败/);
    assert.match(c.capacityBadgeHTML('glm1'), /0\|0/);
    c.respond([]); await c.loadCapacity(); assert.equal(c.capacityBadgeHTML('glm1'), '');
});
test('late responses cannot replace a newer snapshot or restore data after logout', async () => {
    const c = fixture(); let resolve;
    c.fetch = () => new Promise(r => { resolve = r; }); const old = c.loadCapacity();
    c.respond([account('glm1', 'glm1', 3)]); await c.loadCapacity();
    resolve({ ok: true, json: async () => ({ accounts: [account('glm1', 'glm1', 1)] }) }); await old;
    assert.equal(c.capacityMap.glm1.current, 3);
    c.fetch = () => new Promise(r => { resolve = r; }); const pending = c.loadCapacity();
    c.logout(); c.loadCapacity();
    resolve({ ok: true, json: async () => ({ accounts: [account('glm1', 'glm1')] }) }); await pending;
    assert.equal(Object.keys(c.capacityMap).length, 0); assert.equal(c.capacityBadgeHTML('glm1'), '');
});

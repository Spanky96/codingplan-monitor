'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
test('slow per-account usage reserves connections for dispatch and drains the queue after failures', async () => {
    const requests = [], updates = [];
    const c = { _viewMode: 'block', API_PREFIX: '', authHeaders: () => ({}),
        document: { querySelectorAll: () => [], getElementById: () => null },
        fetch: url => new Promise((resolve, reject) => requests.push({ url, resolve, reject })) };
    vm.createContext(c); vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/app/cards.js'), 'utf8'), c);
    c.updateCard = (i, data) => updates.push({ i, data });
    const jobs = Array.from({ length: 8 }, (_, i) => c.fillPendingCard(i, false));
    assert.equal(c.fillPendingCard(0, false), jobs[0]);
    await new Promise(setImmediate); assert.equal(requests.length, 2);
    requests[0].reject(new Error('provider timeout')); await jobs[0];
    assert.equal(requests.length, 3);
    for (let i = 1; i < jobs.length; i++) {
        requests[i].resolve({ json: async () => ({ index: i }) }); await jobs[i];
        assert.ok(c._pendingFillActive <= 2);
    }
    assert.equal(updates.length, 7); assert.equal(c._pendingFillActive, 0);
    assert.equal(Object.keys(c._pendingFills).length, 0);
});

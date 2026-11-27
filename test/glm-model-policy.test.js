'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { targets, validate } = require('../src/scheduler/glm-model-policy');
const now = Date.parse('2026-11-23T08:00:00+08:00'); // Monday at the start of a work week
const accounts = [{name: 'managed'}, {name: 'unmanaged'}, {name: 'paid'}, {name: 'other', platform: 'minimax'}];
const state = {
    config: { enabled: true, staleAfterSeconds: 600, accounts: [{name:'managed',role:'primary'},{name:'paid',role:'paid'}] },
    plan: { generatedAt: now, rows: [{matched:1}], summary: {pressure: true} }
};
function decisions(mode, used, changes = {}, overrides = {}) {
    const s = { ...state, glmModelPolicy: {mode, flashAccounts:['unmanaged']}, ...changes };
    return { ...targets(s, accounts, i => ({
        name: accounts[i].name, cachedAt: now, success:true,
        data:{limits:[{type:'TOKENS_LIMIT',unit:6,percentage:used,nextResetTime:now + 7*86400000}]}, ...overrides
    }), now) };
}
test('all covers unmanaged coding plans, manual pins apply in auto and original releases both', () => {
    assert.deepEqual(decisions('all', 0, {config:{...state.config,enabled:false},plan:null}), {managed:true,unmanaged:true});
    assert.deepEqual(decisions('original', 100), {managed:false,unmanaged:false});
    assert.deepEqual(decisions('auto', 15, {plan:{...state.plan,summary:{pressure:false}}}), {managed:true,unmanaged:true});
});
test('automatic Flash uses the account’s exact five-point lead, including without pool pressure', () => {
    for (const changes of [{}, {plan:null}, {config:{...state.config,enabled:false}}]) {
        assert.equal(decisions('auto', 0, changes).managed, false);
        assert.equal(decisions('auto', 4.999, changes).managed, false);
        assert.equal(decisions('auto', 5, changes).managed, true);
        assert.equal(decisions('auto', 22, changes).managed, true);
    }
});
test('missing, expired and misattributed readings use Flash until a healthy sample confirms recovery', () => {
    for (const overrides of [{cachedAt:now-600001}, {name:'unmanaged'}, {success:false}, {data:{limits:[]}},
        {data:{limits:[{unit:6,percentage:1,nextResetTime:now-1}]}}])
        assert.equal(decisions('auto', 0, {}, overrides).managed,true);
    assert.equal(decisions('auto', 2, {plan:{...state.plan,generatedAt:now-180000}}).managed,false);
});
test('validate model controls independently of concurrency policy', () => {
    assert.deepEqual(validate({mode:'auto',flashAccounts:['unmanaged','unmanaged']},accounts,state.config), {mode:'auto',flashAccounts:['unmanaged']});
    for (const input of [{mode:'x',flashAccounts:[]},{mode:'all'},{mode:'auto',flashAccounts:['paid']},{mode:'all',flashAccounts:['other']}])
        assert.throws(()=>validate(input,accounts,state.config));
});

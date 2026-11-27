'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { plan } = require('../src/scheduler/planner');
const { targets } = require('../src/scheduler/glm-model-policy');
const { weeklyWaterline } = require('../src/scheduler/adaptation');
const H = 3600000, now = Date.parse('2026-11-27T15:58:19+08:00');

// Friday afternoon: the first account was drawing its 5h window faster;
// the second began its new weekly window that morning.
function fixture() {
    const accounts = [{name:'Ahead'}, {name:'Reset'}, {name:'Heavy'}];
    const config = { enabled: true, staleAfterSeconds:600, accounts: accounts.map(({name}) => ({
        name, role:'primary', mode:'auto', maxConcurrency:4, quotaScale:1, autoReset:false
    })) };
    const readings = [[28,30,'2026-12-03T14:18:42+08:00',0.4], [3,5,'2026-12-04T10:14:01+08:00',4.9],
        [63,66,'2026-12-03T11:03:03+08:00',1]];
    const usage = readings.map(([short, week, reset, hours], i) => ({
        name:accounts[i].name, success:true, cachedAt:now, data:{limits:[
            {unit:3,percentage:short,nextResetTime:now+hours*H}, {unit:6,percentage:week,nextResetTime:Date.parse(reset)}
        ]}
    }));
    return { accounts, config, usage, now,
        telemetry:Object.fromEntries(accounts.map(a => [a.name,{count:1,current:1,capacity:2}])),
        previous:{Ahead:{weight:9.4}, Reset:{weight:5.6}, Heavy:{weight:10,concurrency:4}} };
}
const byName = rows => Object.fromEntries(rows.map(r => [r.name,r]));

test('realistic rollover reverses the old weights in one plan and heavy overuse retains a single slot', () => {
    const p = fixture();
    let rows = byName(plan(p).rows);
    assert.ok(rows.Reset.weight > rows.Ahead.weight && rows.Ahead.weight >= rows.Heavy.weight);
    assert.ok(rows.Ahead.weight <= rows.Reset.weight / 10 + 0.05);
    assert.equal(rows.Heavy.concurrency, 1);
    assert.equal(rows.Heavy.effectiveMode,'auto');
    assert.match(rows.Heavy.reasons.join(' '), /超出工作水位/);
    p.config.accounts[2].paused = true;
    assert.equal(byName(plan(p).rows).Heavy.weight,0);
    p.config.accounts[2].paused = false;
    p.previous = rows;
    Object.assign(p.usage[2].data.limits[1], {percentage:0,nextResetTime:now+168*H});
    rows = byName(plan(p).rows);
    assert.ok(rows.Heavy.weight > rows.Ahead.weight);
    assert.equal(rows.Heavy.weeklyPace.workAheadPct,0);
});

test('model decisions match unrounded weekly progress and all-Flash overrides every account', () => {
    const p = fixture();
    const decide = mode => ({...targets({...p,glmModelPolicy:{mode,flashAccounts:[]}},p.accounts,i=>p.usage[i],now)});
    assert.deepEqual(decide('all'),{Ahead:true,Reset:true,Heavy:true});
    assert.deepEqual(decide('auto'),{Ahead:true,Reset:false,Heavy:true});
    const w=p.usage[0].data.limits[1], line=weeklyWaterline(w.nextResetTime,now);
    w.percentage=line+4.9999;
    assert.equal(decide('auto').Ahead,false);
    w.percentage=line+5;
    assert.equal(decide('auto').Ahead,true);
    w.percentage=line;
    assert.equal(decide('auto').Ahead,false);
    p.usage[0].cachedAt=now-H;
    assert.equal(decide('auto').Ahead,true);
});

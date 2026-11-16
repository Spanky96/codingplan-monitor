'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { plan } = require('../src/scheduler/planner');
const { resetAllowed, weeklyWaterline } = require('../src/scheduler/adaptation');
const H=3600000, NOW=Date.UTC(2026,10,16,6);
function fixture() {
    return { now:NOW, config:{accounts:[{name:'A',role:'primary',mode:'auto',autoReset:true,maxConcurrency:4,quotaScale:1}],staleAfterSeconds:600,resetWeekMinHours:24,resetMinRemainingMinutes:60},
        accounts:[{name:'A',platform:'glm',resetCards:{checkedAt:NOW,cards:[{type:'week',recordId:1,expireTime:NOW+200*H}]}}],
        usage:[{name:'A',platform:'glm',success:true,cachedAt:NOW,data:{limits:[
            {type:'TOKENS_LIMIT',unit:3,percentage:43,nextResetTime:NOW+3*H},
            {type:'TOKENS_LIMIT',unit:6,percentage:66,nextResetTime:NOW+96*H}]}}],
        telemetry:{A:{count:1,current:1,capacity:2,limited:false}} };
}
const row=p=>plan(p).rows[0];
test('glm1 case enters automatic high consumption, probes concurrency and never resets 66% quota',()=>{
    const p=fixture(), r=row(p);
    assert.equal(r.mode,'auto'); assert.equal(r.effectiveMode,'burst'); assert.equal(r.modeSource,'automatic');
    assert.equal(r.concurrency,3); assert.equal(r.reset,null); assert.ok(r.weeklyPace.projectedGapHours>48);
    assert.match(r.reasons[0],/自动高速/);
});
test('manual low ceilings remain binding even during automatic acceleration',()=>{
    const p=fixture();p.config.accounts[0].maxConcurrency=1;assert.equal(row(p).concurrency,1);
    p.config.accounts[0].maxConcurrency=2;assert.equal(row(p).concurrency,2);
    p.config.accounts[0].maxConcurrency=64;assert.ok(row(p).concurrency<=4);assert.equal(row(p).maxConcurrency,4);
});
test('5h factor slightly below one does not halve normal concurrency',()=>{
    const p=fixture();p.config.accounts[0].autoReset=false;
    assert.equal(row(p).concurrency,2);assert.equal(row(p).effectiveMode,'auto');
});
test('no permission, missing weekly stock, stale inventory, idle demand and limited upstream prevent promotion',()=>{
    for (const change of [
        p=>p.config.accounts[0].autoReset=false,
        p=>p.accounts[0].resetCards.cards=[],
        p=>p.accounts[0].resetCards.cards[0].type='fiveHour',
        p=>p.accounts[0].resetCards.checkedAt=NOW-16*60000,
        p=>p.telemetry.A.current=0,
        p=>p.telemetry.A.limited=true,
        p=>p.accounts[0].teamEdition=true,
        p=>p.accounts[0].resetCards.cards[0].expireTime=NOW+H
    ]) { const p=fixture();change(p);assert.equal(row(p).effectiveMode,'auto'); }
});
test('short scarcity, near natural reset, upcoming replenishment and healthy weekly pace hold auto mode',()=>{
    for (const change of [p=>p.usage[0].data.limits[0].percentage=90,
        p=>Object.assign(p.usage[0].data.limits[1],{percentage:96,nextResetTime:NOW+12*H}),
        p=>p.config.accounts[0].replenishAt=new Date(NOW+8*H).toISOString(),
        p=>p.usage[0].data.limits[1].percentage=43]) {
        const p=fixture();change(p);assert.equal(row(p).effectiveMode,'auto');
    }
});
test('glm5 surplus catches up without reset permission or cards, within the configured cap',()=>{
    const p=fixture();p.config.accounts[0].autoReset=false;p.config.accounts[0].maxConcurrency=2;
    p.accounts[0].resetCards={cards:[]};
    Object.assign(p.usage[0].data.limits[0],{percentage:21,nextResetTime:NOW+4*H});
    Object.assign(p.usage[0].data.limits[1],{percentage:16,nextResetTime:NOW+91*H});
    const r=row(p);assert.equal(r.effectiveMode,'burst');assert.equal(r.accelerationReason,'surplus');
    assert.equal(r.concurrency,2);assert.equal(r.reset,null);assert.match(r.modeReason,/补进度/);
    assert.ok(r.accelerationFactor>=1.5&&r.accelerationFactor<=4);
    p.usage[0].data.limits[1].percentage=100;assert.equal(row(p).reset,null);
});
test('surplus hysteresis releases when progress catches up and does not leak to card acceleration',()=>{
    const p=fixture();p.config.accounts[0].autoReset=false;p.usage[0].data.limits[1].percentage=5;
    p.previous={A:row(p)};assert.equal(p.previous.A.accelerationReason,'surplus');
    p.usage[0].data.limits[1].percentage=14;assert.equal(row(p).effectiveMode,'burst');
    p.usage[0].data.limits[1].percentage=17;assert.equal(row(p).effectiveMode,'auto');
    p.config.accounts[0].autoReset=true;p.usage[0].data.limits[1].percentage=56;
    assert.equal(row(p).effectiveMode,'auto'); // 13pp ahead must not reuse card hysteresis.
});
test('catch-up uses the visible work-time waterline and does not invent weekend deficits',()=>{
    assert.equal(weeklyWaterline(NOW+96*H,NOW),20);
    const p=fixture();p.config.accounts[0].autoReset=false;p.usage[0].data.limits[1].percentage=25;
    assert.equal(row(p).effectiveMode,'auto'); // Above 20% work waterline, below 43% calendar progress.
    assert.equal(weeklyWaterline(NOW+96*H,NOW-30*H),weeklyWaterline(NOW+96*H,NOW-18*H));
});
test('surplus acceleration obeys short-window safety, demand, manual modes and upstream cooldown',()=>{
    for(const change of [p=>p.usage[0].data.limits[0].percentage=95,
        p=>p.telemetry.A.current=0,p=>p.telemetry.A.limited=true,
        p=>p.usage[0].data.limits[1].nextResetTime=null,
        p=>p.usage[0].cachedAt=NOW-601000]) {
        const p=fixture();p.config.accounts[0].autoReset=false;p.usage[0].data.limits[1].percentage=5;
        change(p);assert.notEqual(row(p).effectiveMode,'burst');
    }
    const p=fixture();p.usage[0].data.limits[1].percentage=16;p.config.accounts[0].mode='slow';
    assert.equal(row(p).effectiveMode,'slow');
});
test('near-deadline surplus drains without a card, while glm13 waits for natural recovery',()=>{
    const p=fixture();p.config.accounts[0].autoReset=false;
    Object.assign(p.usage[0].data.limits[1],{percentage:66,nextResetTime:NOW+18*H});
    assert.equal(row(p).accelerationReason,'surplus');assert.equal(row(p).reset,null);
    p.config.accounts[0].autoReset=true;p.usage[0].data.limits[1].percentage=100;
    assert.equal(row(p).reset,null);assert.match(row(p).reasons.join('；'),/保留周卡/);
    p.usage[0].data.limits[1].percentage=99.5;assert.notEqual(row(p).effectiveMode,'burst');
    p.usage[0].data.limits[1].percentage=0;p.usage[0].data.limits[1].nextResetTime=NOW+168*H;
    assert.equal(row(p).effectiveMode,'auto');
});
test('automatic high consumption exits when the last card is spent or weekly usage resets',()=>{
    const p=fixture();p.previous={A:row(p)};
    p.accounts[0].resetCards.cards=[];assert.equal(row(p).effectiveMode,'auto');
    p.accounts[0].resetCards.cards=[{type:'week',recordId:2,expireTime:NOW+200*H}];
    p.usage[0].data.limits[1].percentage=0;p.usage[0].data.limits[1].nextResetTime=NOW+168*H;
    assert.equal(row(p).effectiveMode,'auto');
});
test('manual overrides stay explicit and low-speed permission never spends a card',()=>{
    const p=fixture();p.config.accounts[0].mode='burst';p.config.accounts[0].autoReset=false;
    p.accounts[0].resetCards.cards=[];assert.equal(row(p).effectiveMode,'burst');assert.equal(row(p).modeSource,'manual');
    p.config.accounts[0].mode='slow';p.config.accounts[0].autoReset=true;
    assert.equal(row(p).concurrency,1);assert.equal(resetAllowed(p.config.accounts[0],p.accounts[0]),false);
});
test('automatic mode resets only truly depleted quota and still waits near natural recovery',()=>{
    const p=fixture();p.usage[0].data.limits[1].percentage=100;assert.ok(row(p).reset);
    p.telemetry.A.current=0;assert.equal(row(p).reset,null);
    p.telemetry.A.current=1;p.usage[0].data.limits[1].nextResetTime=NOW+12*H;assert.equal(row(p).reset,null);
    p.usage[0].data.limits[1].nextResetTime=NOW+96*H;
    Object.assign(p.usage[0].data.limits[1],{usage:140000,currentValue:139999,remaining:1});assert.equal(row(p).reset,null);
});
test('a single busy reading cannot increase concurrency; consecutive busy samples can',()=>{
    const p=fixture();p.config.accounts[0].autoReset=false;p.telemetry.A.current=2;
    p.previous={A:{adaptiveConcurrency:2,concurrency:2,adjustedAt:NOW-300000}};
    assert.equal(row(p).concurrency,2);
    p.previous.A={...row(p),busySince:NOW-120000,plannedAt:NOW-30000};assert.equal(row(p).concurrency,3);
    p.previous.A.plannedAt=NOW-180000;assert.equal(row(p).concurrency,2);
});
test('saturation uses the executed capacity, avoiding a stale adaptive denominator',()=>{
    const p=fixture();p.config.accounts[0].autoReset=false;p.telemetry.A.current=1;
    p.previous={A:{adaptiveConcurrency:1,concurrency:1,busySince:NOW-120000,plannedAt:NOW-30000,adjustedAt:NOW-180000}};
    assert.equal(row(p).concurrency,2);
});
test('burst cannot bypass a rate-limit recovery period',()=>{
    const p=fixture();p.previous={A:{adaptiveConcurrency:4,concurrency:4,adjustedAt:NOW-180000}};
    p.telemetry.A.limited=true;const backed=row(p);assert.equal(backed.concurrency,2);
    p.previous={A:backed};p.telemetry.A.limited=false;p.now+=30000;
    assert.equal(row(p).concurrency,2);assert.match(row(p).concurrencyReason,/恢复观察/);
});
test('quota protection has separate enter and release thresholds',()=>{
    const p=fixture();p.config.accounts[0].autoReset=false;
    p.usage[0].data.limits[0].percentage=98;const protectedRow=row(p);assert.equal(protectedRow.concurrency,1);
    p.previous={A:protectedRow};p.usage[0].data.limits[0].percentage=65;
    assert.equal(row(p).shortProtection,1);
    p.previous={A:row(p)};p.usage[0].data.limits[0].percentage=43;
    assert.equal(row(p).shortProtection,0);assert.equal(row(p).concurrency,2);
});
test('official V3 CREDIT totals couple windows without multiplying peak billing twice',()=>{
    const p=fixture();
    Object.assign(p.usage[0].data.limits[0],{type:'CREDIT_LIMIT',usage:28000,currentValue:14000,remaining:14000});
    Object.assign(p.usage[0].data.limits[1],{type:'CREDIT_LIMIT',usage:140000,currentValue:70000,remaining:70000});
    let r=row(p);assert.equal(r.shortUsed,50);assert.equal(r.weeklyUsed,50);assert.equal(r.quotaLink.shortToWeekRatio,0.2);
    assert.equal(r.quotaLink.canFinishInCurrentShortWindow,false);
    p.usage[0].data.limits[1].currentValue=133000;p.usage[0].data.limits[1].remaining=7000;
    r=row(p);assert.equal(r.quotaLink.weeklyRemainingInShortPct,25);assert.equal(r.quotaLink.canFinishInCurrentShortWindow,true);
    p.usage[0].data.limits[1].type='TOKENS_LIMIT';assert.equal(row(p).quotaLink,null);
});
test('V2 percentages stay authoritative without guessed cross-window token ratios',()=>{
    const p=fixture();assert.equal(row(p).quotaLink,null);assert.equal(row(p).shortUsed,43);assert.equal(row(p).weeklyUsed,66);
});
test('official accelerated usage triggers proactive short-window protection after three samples',()=>{
    const p=fixture();p.previous={A:{cachedAt:NOW-60000,shortUsed:42,shortRatePerHour:100,shortRateSamples:3,shortResetAt:p.usage[0].data.limits[0].nextResetTime+10}};
    const r=row(p);assert.ok(r.shortForecastHours<0.75);assert.equal(r.effectiveMode,'auto');assert.ok(r.concurrency<=2);assert.match(r.reasons.join('；'),/提前收紧/);
    p.previous.A.shortRateSamples=0;assert.equal(row(p).shortForecastHours,undefined);
});
test('reset timestamp jitter preserves rates, a real new window clears them',()=>{
    const p=fixture();p.previous={A:{cachedAt:NOW-60000,shortUsed:42,shortRatePerHour:10,shortRateSamples:4,shortResetAt:p.usage[0].data.limits[0].nextResetTime+10}};
    assert.equal(row(p).shortRateSamples,5);assert.ok(row(p).shortRatePerHour>10);
    p.usage[0].data.limits[0].nextResetTime+=H;assert.equal(row(p).shortRateSamples,0);assert.equal(row(p).shortRatePerHour,0);
});

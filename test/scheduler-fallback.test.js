'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {assessFallback}=require('../src/scheduler/fallback');
const NOW=Date.UTC(2026,10,16,8),M=60000,H=60*M;
const config={fallbackWhen:'pressure',allowPaid:true,allowDilution:true};
function healthy(name,overrides={}) {
    return {name,role:'primary',nativeChannels:1,state:'balanced',raw:1,concurrency:2,maxConcurrency:4,
        observedConcurrency:1,shortUsed:60,weeklyUsed:20,shortRatePerHour:80,shortRateSamples:4,
        shortResetAt:NOW+3*H,weeklyResetAt:NOW+96*H,...overrides};
}
function fixture() {
    return {rows:[healthy('A'),healthy('B'),healthy('C'),healthy('D',{shortRatePerHour:5})],
        config:{...config},now:NOW,recentDemand:true};
}
function confirmed(p) { const previous=assessFallback(p);return assessFallback({...p,previous,now:p.now+M}); }
test('forecast capacity loss starts a small allocation after sustained evidence without waiting for every account to reach 85%',()=>{
    const p=fixture();const first=assessFallback(p);
    assert.equal(first.active,false);assert.equal(first.projectedCapacity,2);
    const next=confirmed(p);assert.equal(next.active,true);assert.equal(next.fraction,0.05);
    assert.match(next.reason,/45 分钟/);
});
test('near natural recovery replenishes projected capacity and can eliminate the need for substitution',()=>{
    const p=fixture();
    for(let i=0;i<2;i++)p.rows.push(healthy('recover'+i,{raw:0,state:'exhausted',shortUsed:100,shortResetAt:NOW+10*M,observedConcurrency:0}));
    assert.equal(confirmed(p).projectedCapacity,6);assert.equal(confirmed(p).active,false);
    p.rows.at(-1).weeklyUsed=100;p.rows.at(-1).weeklyResetAt=NOW+H;
    assert.equal(confirmed(p).projectedCapacity,4);assert.equal(confirmed(p).active,true);
});
test('brief transition gaps before natural reset do not turn on a fallback',()=>{
    const p=fixture();
    for(let i=0;i<3;i++)p.rows.push(healthy('recover'+i,{raw:0,state:'exhausted',shortUsed:100,shortResetAt:NOW+32*M,observedConcurrency:0}));
    assert.equal(confirmed(p).active,false);
});
test('immature forecasts and quota ending close to natural recovery do not cause early substitution',()=>{
    for(const change of [r=>r.shortRateSamples=2,r=>r.shortResetAt=NOW+35*M]) {
        const p=fixture();p.rows.forEach(change);assert.equal(confirmed(p).active,false);
    }
});
test('fresh samples, active demand, permission and pressure timing are required',()=>{
    for(const change of [p=>p.recentDemand=false,p=>p.config.fallbackWhen='exhausted',
        p=>{p.config.allowPaid=false;p.config.allowDilution=false;},
        p=>p.rows.forEach(r=>r.observedConcurrency=0)]) {
        const p=fixture();change(p);assert.equal(confirmed(p).active,false);
    }
    const p=fixture(),previous=assessFallback(p);
    assert.equal(assessFallback({...p,previous,now:NOW+2*M}).active,false);
});
test('sustained actual saturation uses executed capacity and allows 10%, quota-wide scarcity allows 15%',()=>{
    const p=fixture();p.rows.forEach(r=>{r.shortRatePerHour=0;r.observedConcurrency=2;});
    assert.equal(confirmed(p).fraction,0.10);
    p.rows.forEach(r=>r.shortUsed=90);assert.equal(assessFallback(p).fraction,0.15);
});
test('recovery observation prevents repeated on/off switching and releases after three minutes',()=>{
    const p=fixture();let previous=confirmed(p);assert.equal(previous.active,true);
    p.rows.forEach(r=>{r.shortRatePerHour=0;r.observedConcurrency=0;});
    for(let i=2;i<=4;i++){previous=assessFallback({...p,previous,now:NOW+i*M});assert.equal(previous.active,true);}
    previous=assessFallback({...p,previous,now:NOW+5*M});assert.equal(previous.active,false);
    p.config.allowDilution=false;p.config.allowPaid=false;
    assert.equal(assessFallback({...p,previous:confirmed(fixture()),now:NOW+2*M}).active,false);
});

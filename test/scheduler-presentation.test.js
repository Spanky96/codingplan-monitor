'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
function context() {
    const c={Date,localStorage:{getItem:()=>null},setInterval:()=>{},isAdmin:()=>true,
        FEATURES:{relayEnabled:true},esc:String,getAccMaxPct:a=>a.used||0};
    vm.createContext(c);
    for(const name of ['glm-model','scheduler']) vm.runInContext(fs.readFileSync(path.join(__dirname,'../public/js/app/'+name+'.js'),'utf8'),c);
    c.schedulerState={config:{enabled:true,allowPaid:true,allowDilution:true,accounts:[{name:'A',role:'primary',mode:'auto'}]},
        plan:{generatedAt:Date.now(),summary:{active:1,capacity:2},rows:[{name:'A',effectiveMode:'burst',state:'protecting'}]},
        observedAt:Date.now(),appliedFallback:{paid:false,dilution:false},resetCards:{total:3,week:2,fiveHour:1,checkedAccounts:2,accounts:3}};
    return c;
}
test('grouping follows the major mode while protection remains an account status',()=>{
    const c=context(),a={name:'A',platform:'glm'};
    assert.equal(c.scheduleCategory(a),'burst');
    c.schedulerState.plan.rows[0].state='cooldown';assert.equal(c.scheduleCategory(a),'burst');
    c.schedulerState.plan.rows[0].effectiveMode='auto';assert.equal(c.scheduleCategory(a),'balanced');
    c.schedulerState.config.accounts[0].mode='slow';assert.equal(c.scheduleCategory(a),'slow');
    a.used=100;assert.equal(c.scheduleCategory(a),'exhausted');
    a.used=99.95;assert.equal(c.scheduleCategory(a),'slow');
});
test('fallback summary distinguishes permission, standby, active and stale observations',()=>{
    const c=context();assert.equal(c.schedulerFallbackStatus('paid').label,'待命');
    assert.equal(c.schedulerFallbackStatus('dilution').label,'待命');
    c.schedulerState.config.allowPaid=false;assert.equal(c.schedulerFallbackStatus('paid').label,'未允许');
    c.schedulerState.appliedFallback.paid=true;assert.equal(c.schedulerFallbackStatus('paid').label,'已启用');
    c.schedulerState.observedAt=Date.now()-91000;assert.match(c.schedulerFallbackStatus('paid').label,/待确认/);
    assert.match(c.schedulerSummaryHTML(),/重置卡总数/);assert.match(c.schedulerSummaryHTML(),/周卡 2 张 · 5h 卡 1 张/);
});
test('peak indicator uses Beijing weekdays 14:00 inclusive to 18:00 exclusive, only in dashboard summary',()=>{
    const c=context();
    for(const [time,expected] of [['05:59:59',false],['06:00:00',true],['08:59:59',true],['09:00:00',true],['09:59:59',true],['10:00:00',false]]) {
        assert.equal(c.isGlmPeakNow(new Date('2026-11-16T'+time+'Z')),expected);
    }
    assert.equal(c.isGlmPeakNow(new Date('2026-11-21T06:00:00Z')),false);
    c.isGlmPeakNow=()=>true;
    assert.match(c.schedulerSummaryHTML(true),/智谱高峰/);
    assert.doesNotMatch(c.schedulerSummaryHTML(),/智谱高峰/);
    assert.doesNotMatch(c.glmFooterBadges({data:{limits:[]}}),/·高峰|plan-badge-peak/);
});

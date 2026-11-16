'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {poolDemand}=require('../src/scheduler/demand');
const {allocateBackupCapacity,assignBackupWeights}=require('../src/scheduler/backup-capacity');
const {assessFallback}=require('../src/scheduler/fallback');
const {boundChannelCapacity}=require('../src/scheduler/channels');
const NOW=Date.UTC(2026,10,16,8,22);
function fixture() {
    const rows=[{name:'Paid',role:'paid',raw:1,weight:10,nativeChannels:1,fallbackChannels:0,maxConcurrency:10,concurrency:2,reasons:[],channelModes:{93:'native'}},
        {name:'Mini',role:'standard',raw:1,weight:10,nativeChannels:2,fallbackChannels:1,maxConcurrency:30,concurrency:3,reasons:[],channelModes:{81:'native',82:'native',104:'fallback'}}];
    const telemetry={Paid:{channels:[{id:93,current:0,capacity:1,weight:0,enabled:false}]},Mini:{channels:[
        {id:81,current:0,capacity:1,weight:4.8,enabled:true},{id:82,current:0,capacity:1,weight:4.8,enabled:true},{id:104,current:1,capacity:1,weight:0.4,enabled:true}]}};
    return {rows,telemetry,assessment:{active:true,demand:12,capacity:7,capacityGap:8,fraction:0.10},
        config:{allowPaid:true,allowDilution:true},previous:{},now:NOW,hasPrimary:true};
}
test('unassigned user slots count toward demand, unrelated assigned work and user-limit queues do not',()=>{
    const snapshot={accounts:[{id:1,name:'GLM',current_concurrency:7},{id:2,name:'Other',current_concurrency:3},{id:81,name:'Mini-native',current_concurrency:2},{id:104,name:'Mini-backup',current_concurrency:1}]};
    const policies=[{name:'GLM',role:'primary'},{name:'Mini',role:'standard',channelModes:{81:'native',104:'fallback'}}];
    const d=poolDemand(snapshot,{at:NOW,inUse:18,waiting:30},policies,NOW);
    assert.equal(d.inFlight,13);assert.equal(d.unassigned,5);assert.equal(d.managed,8);
    assert.equal(poolDemand(snapshot,{at:NOW-91000,inUse:18},policies,NOW).inFlight,8);
});
test('seven executed slots do not hide twelve in-flight requests or the backup capacity gap',()=>{
    const rows=[{role:'primary',nativeChannels:1,raw:1,concurrency:7,observedConcurrency:7,shortUsed:70,weeklyUsed:30}];
    const p={rows,config:{fallbackWhen:'pressure',allowPaid:true},now:NOW,recentDemand:true,
        load:{at:NOW,inFlight:12,unassigned:5,source:'user-slots-minus-other-assigned'}};
    const a=assessFallback(p);const b=assessFallback({...p,now:NOW+60000,previous:a,load:{...p.load,at:NOW+60000}});
    assert.equal(b.demand,12);assert.equal(b.capacityGap,8);assert.equal(b.active,true);
});
test('paid probes and replacement slots supplement each other without granting idle native aliases equal shares',()=>{
    const p=fixture(),result=allocateBackupCapacity(p);
    assert.equal(result.paid,2);assert.equal(result.fallback,3);
    assert.deepEqual(p.rows[1].channelConcurrency,{81:1,82:1,104:3});assert.equal(p.rows[1].concurrency,5);
    const previous=Object.fromEntries(p.rows.map(r=>[r.name,r]));
    const next=fixture();next.previous=previous;next.now+=30000;
    assert.equal(allocateBackupCapacity(next).fallback,5);
    const same=fixture();same.previous=previous;same.now+=1000;
    assert.equal(allocateBackupCapacity(same).fallback,3);
});
test('capacity respects opt-outs, account ceilings, quota protection and rate-limit recovery',()=>{
    let p=fixture();p.config.allowPaid=false;allocateBackupCapacity(p);assert.equal(p.rows[0].backupCapacity,0);
    p=fixture();p.config.allowDilution=false;allocateBackupCapacity(p);assert.equal(p.rows[1].backupCapacity,0);
    p=fixture();p.rows[1].maxConcurrency=3;allocateBackupCapacity(p);assert.equal(p.rows[1].backupCapacity,1);
    p=fixture();p.rows[1].shortProtection=2;allocateBackupCapacity(p);assert.equal(p.rows[1].concurrency,1);assert.equal(p.rows[1].backupCapacity,0);
    p=fixture();p.rows[1].lastLimitedAt=NOW-60000;p.rows[1].concurrency=1;allocateBackupCapacity(p);assert.equal(p.rows[1].concurrency,1);
    p=fixture();p.rows[0].limited=true;allocateBackupCapacity(p);assert.equal(p.rows[0].backupCapacity,0);
});
test('real deficits raise offload weight beyond the preventive cap while preserving native availability',()=>{
    const p=fixture();p.rows.push({name:'GLM',role:'primary',raw:1,weight:7,nativeChannels:1,concurrency:7,maxConcurrency:7});
    const result=allocateBackupCapacity(p);assignBackupWeights(p.rows,p.assessment,result,true);
    assert.equal(p.rows[0].weight,2);assert.equal(p.rows[1].fallbackWeight,3);
    assert.ok(p.rows[1].nativeWeight>0);assert.ok(p.rows.every(r=>r.weight<=10));
    p.rows[2].weight=70;assignBackupWeights(p.rows,p.assessment,result,true);
    assert.ok(p.rows[0].weight<=10);assert.ok(p.rows[1].weight<=10);assert.ok(p.rows[2].weight>0);
});
test('real capacity deficits can consume ample reserve quota despite forecast pacing, but never bypass limits or near-exhaustion',()=>{
    const setup=()=>{const p=fixture();Object.assign(p.rows[1],{shortUsed:42,weeklyUsed:15,shortProtection:2,state:'protecting',effectiveMode:'auto'});return p;};
    let p=setup();allocateBackupCapacity(p);assert.equal(p.rows[1].backupCapacity,3);assert.equal(p.rows[1].nativeCapacity,2);assert.equal(p.rows[1].state,'balanced');
    p=setup();p.rows[1].shortUsed=85;allocateBackupCapacity(p);assert.equal(p.rows[1].backupCapacity,0);
    p=setup();p.rows[1].weeklyUsed=95;allocateBackupCapacity(p);assert.equal(p.rows[1].backupCapacity,0);
    p=setup();p.rows[1].limited=true;allocateBackupCapacity(p);assert.equal(p.rows[1].backupCapacity,0);
    p=setup();p.rows[1].lastLimitedAt=NOW-60000;p.rows[1].concurrency=1;allocateBackupCapacity(p);assert.equal(p.rows[1].concurrency,1);
    p=setup();p.rows[1].effectiveMode='slow';allocateBackupCapacity(p);assert.equal(p.rows[1].backupCapacity,0);
    p=setup();p.assessment.capacityGap=0;allocateBackupCapacity(p);assert.equal(p.rows[1].backupCapacity,0);
    p=setup();p.rows[1].raw=0;allocateBackupCapacity(p);assert.equal(p.rows[1].backupCapacity,0);
});
test('cleared pressure releases paid and replacement capacity while native endpoints remain available',()=>{
    const p=fixture();p.assessment.active=false;allocateBackupCapacity(p);assignBackupWeights(p.rows,p.assessment,{allocated:0},true);
    assert.equal(p.rows[0].weight,0);assert.equal(p.rows[1].fallbackWeight,0);
    assert.ok(p.rows[1].nativeWeight>0);assert.equal(p.rows[1].channelConcurrency[104],0);
});
test('export clamps a channel map immediately when an administrator lowers the pool ceiling',()=>{
    const modes={81:'native',82:'native',104:'fallback'};
    assert.deepEqual(boundChannelCapacity(modes,{81:1,82:1,104:6},3),{81:1,82:1,104:1});
    assert.deepEqual(boundChannelCapacity(modes,{81:1,82:1,104:6},0),{81:0,82:0,104:0});
});

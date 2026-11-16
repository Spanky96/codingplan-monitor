'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
const fs=require('node:fs'), os=require('node:os'), path=require('node:path');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'smart-reset-permission-'));
process.env.ACCOUNTS_FILE=path.join(dir,'accounts.json');
process.env.USAGE_CACHE_FILE=path.join(dir,'usage.json');
process.env.SCHEDULER_STATE_FILE=path.join(dir,'scheduler.json');
process.env.SUB2API_BASE_URL='';process.env.SCHEDULER_SYNC_TOKEN='';
fs.writeFileSync(process.env.USAGE_CACHE_FILE,'{}');
fs.writeFileSync(process.env.ACCOUNTS_FILE,JSON.stringify({accounts:[{name:'A',platform:'glm'}]}));
const store=require('../src/scheduler/store'), cache=require('../src/api/cache');
const http=require('../src/lib/http'), service=require('../src/scheduler/service');
const reset=require('../src/scheduler/reset-cards');
let calls=0, remaining=0, duringTelemetry=()=>{};
http.httpsGet=async()=>({code:200,data:{weekResets:[{recordId:1,grantType:'GLOBAL',expireTime:'2099-12-22 23:59:59',available:true}],fiveHourResets:[]}});
http.httpsRequest=async()=>{calls++;return {code:200,success:true};};
cache.ensureUsageFetch=async()=>({name:'A',platform:'glm',success:true,cachedAt:Date.now(),data:{limits:[
    {type:'CREDIT_LIMIT',unit:6,percentage:100,usage:140000,currentValue:140000-remaining,remaining,nextResetTime:Date.now()+96*3600000}]}});
service.telemetry=async()=>{duringTelemetry();};
service.compute=()=>({rows:[{name:'A',reset:{type:'week',recordId:1}}]});
service.afterReset=async()=>({synced:true});
function fixture(mode='auto',permission=true) {
    calls=0;remaining=0;duringTelemetry=()=>{};
    store.write({config:{...store.defaults,enabled:true,accounts:[{name:'A',role:'primary',mode,autoReset:permission,maxConcurrency:4}]},journal:{},events:[]});
}
test('automatic mode can execute an explicitly authorized depleted reset',async()=>{
    fixture();const result=await reset.use(0,'week',1,true);
    assert.equal(result.success,true);assert.equal(calls,1);
    const entry=Object.values(store.read().journal)[0];assert.equal(entry.automatic,true);assert.equal(entry.status,'used');
    await assert.rejects(reset.use(0,'week',1,true),/不会重复扣卡/);assert.equal(calls,1);
});
test('authorization is not inferred from high-consumption mode',async()=>{
    fixture('burst',false);await assert.rejects(reset.use(0,'week',1,true),/自动用卡已关闭/);assert.equal(calls,0);
});
test('slow mode pauses card execution while retaining stored permission',async()=>{
    fixture('slow',true);await assert.rejects(reset.use(0,'week',1,true),/自动用卡已关闭/);assert.equal(calls,0);
    assert.equal(store.read().config.accounts[0].autoReset,true);
});
test('fresh official remaining credit cancels a reset despite a rounded 100%',async()=>{
    fixture();remaining=1;await assert.rejects(reset.use(0,'week',1,true),/最新额度已恢复/);assert.equal(calls,0);
});
test('executor rejects a weekly reset when only the 5h window is exhausted, even with a stale approved plan',async()=>{
    const original=cache.ensureUsageFetch;
    try {
        for(const mode of ['auto','burst']) for(const meter of ['TOKENS_LIMIT','CREDIT_LIMIT']) {
            fixture(mode,true);
            cache.ensureUsageFetch=async()=>({name:'A',platform:'glm',success:true,cachedAt:Date.now(),data:{limits:[
                {type:meter,unit:3,percentage:100,nextResetTime:Date.now()+2*3600000},
                {type:meter,unit:6,percentage:80,nextResetTime:Date.now()+96*3600000,
                    ...(meter==='CREDIT_LIMIT'?{usage:140000,currentValue:112000,remaining:28000}:{})}
            ]}});
            await assert.rejects(reset.use(0,'week',1,true),/最新额度已恢复/);
            assert.equal(calls,0);assert.equal(Object.keys(store.read().journal).length,0);
            assert.equal(Object.keys(store.read().pendingResets||{}).length,0);
        }
    } finally { cache.ensureUsageFetch=original; }
});
test('permission revoked during async validation prevents the upstream POST',async()=>{
    fixture();duringTelemetry=()=>store.update(s=>{s.config.accounts[0].autoReset=false;});
    await assert.rejects(reset.use(0,'week',1,true),/自动重置已关闭/);assert.equal(calls,0);assert.equal(Object.keys(store.read().journal).length,0);
});
test.after(()=>fs.rmSync(dir,{recursive:true,force:true}));

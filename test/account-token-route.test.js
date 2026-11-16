'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
process.env.ADMIN_PASSWORD='account-token-test';process.env.SUB2API_BASE_URL='http://relay.test';process.env.RELAY_SNAPSHOT_TOKEN='snapshot-test';
const http=require('../src/lib/http');let calls=0,next,resolvePending;
http.httpGetJSON=async url=>{calls++;assert.match(url,/account-token-snapshot\?token=snapshot-test$/);if(next instanceof Error)throw next;return next;};
const register=require('../src/api/routes/relay');
function router(){const routes={};register({get:(route,...handlers)=>{routes[route]=handlers;}});return (authorized=true,force=false)=>new Promise(resolve=>{
 const req={headers:authorized?{'x-auth-password':'account-token-test'}:{},query:force?{force:'1'}:{},socket:{remoteAddress:'test'}};
 const res={code:200,set(){return this},status(c){this.code=c;return this},json(body){resolve({code:this.code,body});return this}};
 const hs=routes['/api/relay/account-tokens'];let i=0;const run=()=>hs[i++](req,res,run);run();
});}
function snapshot(end=Date.now()+10000){return {code:0,data:{day_start:new Date(Date.now()-10000).toISOString(),day_end:new Date(end).toISOString(),rows:[]}};}
test('account tokens require admin access, coalesce concurrent reads, expire across midnight and preserve errors',async()=>{
 const call=router(),before=calls;assert.equal((await call(false)).code,401);assert.equal(calls,before);
 next=new Promise(r=>{resolvePending=r});const a=call(),b=call();resolvePending(snapshot());
 const values=await Promise.all([a,b]);assert.equal(values[0].code,200);assert.equal(calls,before+1);
 await call();assert.equal(calls,before+1);
 next=snapshot(Date.now()-1);await call(true,true);const expired=calls;next=snapshot();await call();assert.equal(calls,expired+1);
 next=new Error('upstream failure');assert.equal((await call(true,true)).code,502);
 next={code:0,data:{rows:[]}};assert.equal((await call(true,true)).code,502);
});

'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
function fixture(){
 const c={Date,FEATURES:{relayEnabled:true},accountsData:[{name:'glm1'},{name:'glm12'},{name:'Mini'}],capacityMap:{glm1:{},glm12:{},Mini:{}},isAdmin:()=>true,esc:s=>s.replaceAll('<','&lt;').replaceAll('"','&quot;'),fmtTokensMB:n=>n>=1e6?(n/1e6).toFixed(1)+'M':String(n)};
 vm.createContext(c);vm.runInContext(fs.readFileSync(path.join(__dirname,'../public/js/app/account-tokens.js'),'utf8'),c);return c;
}
test('account totals combine aliases and actual-model rows without prefix collisions or unrelated users',()=>{
 const c=fixture();c.accountTokenData={day_start:new Date(Date.now()-1000).toISOString(),day_end:new Date(Date.now()+1000).toISOString(),rows:[
 {account_name:'glm1-main',model:'glm-5.3',total_tokens:127800000},
 {account_name:'glm12-main',model:'glm-5.3',total_tokens:5000000},
 {account_name:'Mini-native',model:'MiniMax-M3',total_tokens:1000000},
 {account_name:'Mini-fallback',model:'MiniMax-M3',total_tokens:2000000},
 {account_name:'Mini-new',model:'MiniMax-M4',total_tokens:3000000},
 {account_name:'unrelated',model:'glm-5.3',total_tokens:9000000}]};
 c.rebuildAccountTokens();assert.equal(c.accountTokenMap.glm1.total,127800000);assert.equal(c.accountTokenMap.glm12.total,5000000);
 assert.equal(c.accountTokenMap.Mini.total,6000000);assert.equal(c.accountTokenMap.Mini.models['MiniMax-M3'],3000000);
 assert.match(c.accountTokenBadgeHTML('glm1'),/今日Token glm-5.3 127.8M/);assert.match(c.accountTokenBadgeHTML('Mini'),/MiniMax-M4 3.0M/);
});
test('unknown and previous-day data are never presented as zero or as today; guests get no account statistics',()=>{
 const c=fixture();assert.match(c.accountTokenBadgeHTML('glm1'),/—/);assert.equal(c.accountTokenBadgeHTML('unmapped'),'');
 c.accountTokenData={day_start:new Date(Date.now()-1000).toISOString(),day_end:new Date(Date.now()+1000).toISOString(),rows:[]};c.rebuildAccountTokens();assert.match(c.accountTokenBadgeHTML('glm1'),/今日Token 0/);
 c.accountTokenData.day_end=new Date(Date.now()-1).toISOString();assert.match(c.accountTokenBadgeHTML('glm1'),/—/);
 c.isAdmin=()=>false;assert.equal(c.accountTokenBadgeHTML('glm1'),'');
});

'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
process.env.ADMIN_PASSWORD = 'relay-test';
process.env.SUB2API_BASE_URL = 'http://relay.example';
process.env.PRIVACY_EXTERNAL_HOSTS = 'lwai.05info.com';
let calls = 0;
require('../src/lib/http').httpGetJSON = async () => { calls++; return { code: 0, data: { users: [], rows: [] } }; };
const routes = {};
require('../src/api/routes/relay')({get: (path, ...handlers) => { routes[path] = handlers; }});
require('../src/api/routes/features')({get: (path, handler) => { routes[path] = [handler]; }});
function request(path, ip, headers = {}, query = {}) {
  return new Promise((resolve, reject) => {
    const req = { socket: {remoteAddress: ip}, headers, query };
    const res = { code: 200, headers: {}, status(c) {this.code=c; return this;}, set(k,v) {this.headers[k]=v; return this;}, json(body) {resolve({...this,body});} };
    try { routes[path][0](req,res); } catch (e) { reject(e); }
  });
}
test('LAN guests may read activity, ranking and chart; external visitors cannot read cached data', async () => {
  for (const path of ['/api/relay/activity','/api/relay/usage','/api/relay/usage-hourly']) {
    const guest = await request(path,'::ffff:192.168.0.35',{host:'192.168.0.20:8886'});
    assert.equal(guest.code,200);
    assert.equal(guest.headers['Cache-Control'],'private, no-store');
    const before=calls;
    for (const [ip,headers] of [
      ['8.8.8.8',{'x-forwarded-for':'192.168.0.35'}],
      ['172.18.0.1',{'x-forwarded-for':'192.168.0.35, 8.8.8.8'}],
      ['172.18.0.1',{host:'lwai.05info.com:8887'}],
      ['172.18.0.1',{'x-forwarded-host':'lwai.05info.com'}],
      ['',{}]
    ]) assert.equal((await request(path,ip,headers)).code,401);
    assert.equal(calls,before,'unauthorized requests never reach upstream');
    assert.equal((await request(path,'8.8.8.8',{'x-auth-password':'relay-test'})).code,200);
  }
  assert.equal((await request('/api/sub2api/capacity','192.168.0.35')).code,401);
});
test('viewer feature follows server authorization',async()=>{
  assert.equal((await request('/api/features','192.168.0.35')).body.relayViewerAllowed,true);
  assert.equal((await request('/api/features','8.8.8.8')).body.relayViewerAllowed,false);
  assert.equal((await request('/api/features','8.8.8.8',{'x-auth-password':'relay-test'})).body.relayViewerAllowed,true);
});
const ui = { activityUsageData: {comparison:{date:'2026-11-13'}}, escapeHtml: s=>String(s).replace(/"/g,'&quot;') };
vm.createContext(ui); vm.runInContext(fs.readFileSync('public/js/app/relay.js','utf8'),ui);
test('token color compares against the previous workday’s same-time relay usage, not its full-day total',()=>{
  const result = ui.activityTokenComparison(90e6,20e6,{total_tokens:120e6,same_time_tokens:60e6,external_tokens:10e6});
  // 站内今日 70M > 对比日此时 60M → 红，即使低于对比日全天 120M
  assert.equal(result.className,' token-more');
  assert.match(result.tooltip,/11-13 周五此时（站内） 60M/);
  assert.match(result.tooltip,/多 10M（16\.7%）/);
  assert.match(result.tooltip,/11-13 周五全天 120M/);
  assert.match(result.tooltip,/外部渠道仅整日统计/);
  // 无外部渠道时不带站内口径说明；110M 低于全天 120M 但高于此时 100M → 红
  assert.doesNotMatch(ui.activityTokenComparison(110e6,0,{total_tokens:120e6,same_time_tokens:100e6}).tooltip,/站内|外部/);
  assert.equal(ui.activityTokenComparison(110e6,0,{total_tokens:120e6,same_time_tokens:100e6}).className,' token-more');
  assert.equal(ui.activityTokenComparison(50e6,0,{total_tokens:120e6,same_time_tokens:60e6}).className,' token-less');
  assert.equal(ui.activityTokenComparison(60e6,0,{total_tokens:120e6,same_time_tokens:60e6}).className,'');
  assert.equal(ui.activityTokenComparison(0,0,{total_tokens:0,same_time_tokens:0}).className,'');
  assert.doesNotMatch(ui.activityTokenComparison(100,0,{total_tokens:0,same_time_tokens:0}).tooltip,/Infinity|NaN/);
});
test('rank movement supports up, down, equal, new and unavailable history',()=>{
  const user = {today:{total_tokens:90e6},comparison:{rank:6,total_tokens:120e6,same_time_tokens:60e6}};
  assert.match(ui.activityRankMovement(user,1),/rank-move changed up/);
  assert.match(ui.activityRankMovement(user,1),/>↑5</);
  assert.match(ui.activityRankMovement(user,1),/第 6 名 → 第 1 名，上升 5 位/);
  assert.match(ui.activityRankMovement(user,9),/rank-move changed down/);
  assert.match(ui.activityRankMovement(user,9),/>↓3</);
  assert.match(ui.activityRankMovement(user,6),/排名持平/);
  user.comparison.rank=0;
  assert.match(ui.activityRankMovement(user,1),/今日新上榜/);
  delete user.comparison;
  assert.match(ui.activityRankMovement(user,1),/历史排名暂不可用/);
});

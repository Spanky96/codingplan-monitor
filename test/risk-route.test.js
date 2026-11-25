'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'risk-route-'));
process.env.ACCOUNTS_FILE = path.join(tmp, 'accounts.json');
process.env.USAGE_CACHE_FILE = path.join(tmp, 'cache.json');
process.env.ADMIN_PASSWORD = 'test-risk-pwd';

// 线上真实形态:个人订阅账号(未勾选团队版),但 JWT 的 user_type 标的是 ENTERPRISE
const enterpriseJwt = 'h.' + Buffer.from('{"user_type":"ENTERPRISE"}').toString('base64') + '.s';
const personal = { name: 'personal', platform: 'glm', authorization: enterpriseJwt, organization: 'o', project: 'p' };

let upstream, calls;
const http = require('../src/lib/http');
http.httpsGet = async (url, headers) => {
    calls.push({ url, authorization: headers.authorization });
    return upstream;
};
const { readAccounts, writeAccounts } = require('../src/api/accounts');
const { RISK_TIPS } = require('../src/api/platforms/glm');
const express = require('express');
const app = express();
require('../src/api/routes/keys')(app, { zcodeReset: {} });
const server = app.listen(0);
const base = 'http://127.0.0.1:' + server.address().port;
const call = async () => {
    const r = await fetch(base + '/api/risk/0');
    return { status: r.status, body: await r.json() };
};
test.beforeEach(() => {
    writeAccounts([personal]); calls = [];
    upstream = { code: 200, msg: '操作成功', data: 9, success: true };
});
test.after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('personal account whose JWT says ENTERPRISE still gets its official risk level', async () => {
    const r = await call();
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { level: 9, text: '(9)' + RISK_TIPS[9], teamEdition: false });
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.endsWith('/api/biz/customer/risk/info'));
    assert.equal(calls[0].authorization, enterpriseJwt);
    assert.equal(readAccounts()[0].risk.level, 9);
    assert.equal(readAccounts()[0].risk.text, r.body.text);
    assert.ok(!JSON.stringify(r.body).includes(enterpriseJwt));
});
test('risk already lifted is cleared from the stored account', async () => {
    writeAccounts([{ ...personal, risk: { level: 9, text: '(9)old', checkedAt: 1 } }]);
    upstream = { code: 200, msg: '操作成功', data: 0, success: true };
    assert.deepEqual((await call()).body, { level: null, text: '', teamEdition: false });
    assert.equal(readAccounts()[0].risk, undefined);
});
test('team account is skipped without calling the official interface', async () => {
    writeAccounts([{ ...personal, teamEdition: true }]);
    assert.deepEqual((await call()).body, { level: null, text: '', teamEdition: true });
    assert.equal(calls.length, 0);
});
test('non-GLM account is skipped without calling the official interface', async () => {
    writeAccounts([{ ...personal, platform: 'qwen' }]);
    assert.deepEqual((await call()).body, { level: null, text: '', teamEdition: false });
    assert.equal(calls.length, 0);
});

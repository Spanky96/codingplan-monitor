'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var os = require('os');
var path = require('path');
var https = require('https');

var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glm-autorenew-'));
var accountsFile = path.join(tmpDir, 'accounts.json');
var cacheFile = path.join(tmpDir, 'usage-cache.json');

process.env.ACCOUNTS_FILE = accountsFile;
process.env.USAGE_CACHE_FILE = cacheFile;
process.env.ADMIN_PASSWORD = 'test-pwd';

fs.writeFileSync(accountsFile, JSON.stringify({ accounts: [] }));
fs.writeFileSync(cacheFile, '{}');

// 必须在 require api 前 stub https（api 顶层即引用 https）
var originalRequest = https.request;
var originalGet = https.get;

// 可按用例切换的两个上游响应
var trialCards = { code: 200, msg: '操作成功', data: { inviteCode: 'JT8NTJ6TC5', expireTime: '2026-10-28 10:00:00' } };
var subscriptionList = {
    code: 200,
    data: [{
        id: '638531',
        status: 'VALID',
        productName: 'GLM Coding Max',
        valid: '2026-10-28 10:00:00-2027-01-28 10:00:00',
        autoRenew: 1,
        nextRenewTime: '2026-10-28'
    }]
};

function respond(statusCode, body) {
    var listeners = { data: [], end: [] };
    var res = {
        statusCode: statusCode,
        on: function(ev, cb) {
            if (ev === 'data') listeners.data.push(cb);
            if (ev === 'end') listeners.end.push(cb);
            return res;
        }
    };
    process.nextTick(function() {
        var chunk = typeof body === 'string' ? body : JSON.stringify(body);
        listeners.data.forEach(function(cb) { cb(chunk); });
        listeners.end.forEach(function(cb) { cb(); });
    });
    return res;
}

function fakeRequest(opts, cb) {
    var pathName = opts.path || '/';
    var req = {
        on: function() { return req; },
        write: function() {},
        end: function() {
            if (pathName.indexOf('/api/biz/trial-cards/current-user') >= 0) {
                return cb(respond(200, trialCards));
            }
            if (pathName.indexOf('/api/biz/subscription/list') >= 0) {
                return cb(respond(200, subscriptionList));
            }
            return cb(respond(404, { msg: 'not found' }));
        }
    };
    return req;
}

// glm.js 里 httpsGet 调用形式：https.get(urlString, { headers }, cb)
https.request = fakeRequest;
https.get = function(urlOrOpts, optionsOrCb, maybeCb) {
    var opts;
    var cb;
    if (typeof urlOrOpts === 'string') {
        var u = new URL(urlOrOpts);
        var optionObj = (typeof optionsOrCb === 'object' && optionsOrCb) || {};
        cb = typeof optionsOrCb === 'function' ? optionsOrCb : maybeCb;
        opts = { hostname: u.hostname, path: u.pathname + u.search, method: 'GET', headers: optionObj.headers || {} };
    } else {
        opts = Object.assign({}, urlOrOpts, { method: 'GET' });
        cb = optionsOrCb;
    }
    var req = fakeRequest(opts, cb);
    // https.get 会自动 end
    process.nextTick(function() { req.end(); });
    return req;
};

// 在 stub 后加载 api（config 读 env）
delete require.cache[require.resolve('../src/config')];
delete require.cache[require.resolve('../src/api')];
var api = require('../src/api');

var glmAccount = { platform: 'glm', name: '测试', authorization: 'TOKEN_A', organization: 'org-1', project: 'proj-1' };

test('fetchGLMExpire 透传订阅列表的 autoRenew', async function() {
    subscriptionList.data[0].autoRenew = 1;
    var result = await api._fetchGLMExpire(glmAccount, 0);
    assert.equal(result.success, true);
    assert.equal(result.autoRenew, true);
    assert.equal(result.expireTime, '2026-10-28 10:00:00');
    assert.equal(result.inviteCode, 'JT8NTJ6TC5');
});

test('fetchGLMExpire 未开启自动续费时 autoRenew 为 false', async function() {
    subscriptionList.data[0].autoRenew = 0;
    var result = await api._fetchGLMExpire(glmAccount, 0);
    assert.equal(result.success, true);
    assert.equal(result.autoRenew, false);
});

test('fetchGLMExpire 积分制套餐回退订阅列表取到期时间并携带 autoRenew', async function() {
    trialCards.data = { inviteCode: 'JT8NTJ6TC5' }; // 无 expireTime(体验卡不支持)
    subscriptionList.data[0].autoRenew = 1;
    var result = await api._fetchGLMExpire(glmAccount, 0);
    assert.equal(result.success, true);
    assert.equal(result.autoRenew, true);
    assert.equal(result.expireTime, '2026-10-28 10:00:00'); // 取自 valid 起始段
});

test('fetchGLMExpire 订阅列表失败时软降级:到期照常,autoRenew 为 false', async function() {
    trialCards.data = { inviteCode: 'JT8NTJ6TC5', expireTime: '2026-10-28 10:00:00' };
    subscriptionList = { code: 500, msg: 'boom' };
    var result = await api._fetchGLMExpire(glmAccount, 0);
    assert.equal(result.success, true);
    assert.equal(result.autoRenew, false);
    assert.equal(result.expireTime, '2026-10-28 10:00:00');
});

test('glmActiveSubscription 优先取 VALID 订阅,无 VALID 兜底第一条', function() {
    var glm = require('../src/api/platforms/glm');
    var multi = { data: [
        { status: 'EXPIRED', autoRenew: 0 },
        { status: 'VALID', autoRenew: 1 }
    ] };
    assert.equal(glm.glmActiveSubscription(multi).autoRenew, 1);
    var noneValid = { data: [{ status: 'EXPIRED', autoRenew: 0 }, { status: 'CANCEL', autoRenew: 0 }] };
    assert.equal(glm.glmActiveSubscription(noneValid).status, 'EXPIRED');
    assert.equal(glm.glmActiveSubscription({ data: [] }), null);
    assert.equal(glm.glmActiveSubscription(null), null);
});

// 恢复 https,避免影响同进程其他测试文件
test('cleanup', function() {
    https.request = originalRequest;
    https.get = originalGet;
});

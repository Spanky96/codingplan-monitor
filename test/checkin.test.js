'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var os = require('os');
var path = require('path');
var https = require('https');

var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'checkin-'));
var accountsFile = path.join(tmpDir, 'accounts.json');
var cacheFile = path.join(tmpDir, 'usage-cache.json');

process.env.ACCOUNTS_FILE = accountsFile;
process.env.USAGE_CACHE_FILE = cacheFile;
process.env.ADMIN_PASSWORD = 'test-pwd';

fs.writeFileSync(accountsFile, JSON.stringify({ accounts: [] }));
fs.writeFileSync(cacheFile, '{}');

// ---- https stub(必须在 require api 前)----
var originalRequest = https.request;
var originalGet = https.get;
var callLog = [];
var statusMode = 'unchecked';   // status 接口:unchecked / checked / authfail
var postModes = {};             // 按 token 的签到 POST 行为:默认 ok,可设 conflict
var postedBy = {};              // 站点侧状态:POST 成功后 status 变已签(模拟真实站点)

function respond(statusCode, body) {
    var listeners = { data: [], end: [] };
    var res = {
        statusCode: statusCode,
        headers: {},
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

var STATUS_BODY = {
    eligible: true, punchedToday: false, todayDay: 1, monthLabel: '2026.11',
    checkedDays: [], cumulativeDays: 27, streakCurrent: 0,
    dailyReward: { todayBalanceCny: 0.1, todayNbPoints: 3, tomorrowBalanceCny: 0.1, tomorrowNbPoints: 6 },
    milestones: [{ code: 'days_5', label: '出勤 5 天', target: 5, achieved: false, statusText: '0 / 5' }]
};

function fakeRequest(opts, cb) {
    var method = (opts.method || 'GET').toUpperCase();
    var host = opts.hostname || opts.host || '';
    var pathName = opts.path || '/';
    var auth = (opts.headers && opts.headers.authorization) || '';
    var req = {
        on: function() { return req; },
        write: function() {},
        end: function() {
            callLog.push({ method: method, url: 'https://' + host + pathName, auth: auth });
            if (pathName.indexOf('/activity/v1/checkin/status') >= 0) {
                if (statusMode === 'authfail' || !/^Bearer TOK_/.test(auth)) {
                    return cb(respond(401, { message: 'unauthorized' }));
                }
                var body = Object.assign({}, STATUS_BODY, { punchedToday: statusMode === 'checked' || !!postedBy[auth] });
                return cb(respond(200, body));
            }
            if (pathName === '/activity/v1/checkin') {
                if (!/^Bearer TOK_/.test(auth)) return cb(respond(401, { message: 'unauthorized' }));
                if (postModes[auth] === 'conflict') return cb(respond(409, { detail: '今日已签到' }));
                postedBy[auth] = true;
                return cb(respond(200, { ok: true }));
            }
            if (pathName.indexOf('/api/v1/auth/me') >= 0) {
                if (!/^Bearer TOK_/.test(auth)) return cb(respond(401, { message: 'unauthorized' }));
                return cb(respond(200, { code: 0, data: { email: 'u@x.com', balance: 1 } }));
            }
            if (pathName.indexOf('/api/v1/subscriptions') >= 0) {
                if (!/^Bearer TOK_/.test(auth)) return cb(respond(401, { message: 'unauthorized' }));
                return cb(respond(200, { code: 0, data: [] }));
            }
            return cb(respond(404, { error: 'not found' }));
        }
    };
    return req;
}

https.request = fakeRequest;
https.get = function(urlOrOpts, optionsOrCb, maybeCb) {
    var opts, cb;
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
    process.nextTick(function() { req.end(); });
    return req;
};

delete require.cache[require.resolve('../src/config')];
delete require.cache[require.resolve('../src/api')];
var api = require('../src/api');

function writeAccounts(list) {
    fs.writeFileSync(accountsFile, JSON.stringify({ accounts: list }, null, 2));
}

function posts() { return callLog.filter(function(c) { return c.method === 'POST' && c.url.indexOf('/activity/v1/checkin') >= 0 && c.url.indexOf('status') < 0; }); }
function statusGets() { return callLog.filter(function(c) { return c.url.indexOf('/activity/v1/checkin/status') >= 0; }); }

// ---- 纯函数 ----

test('checkinDayKey uses Asia/Shanghai calendar day', function() {
    assert.equal(api._checkinDayKey(new Date('2026-11-01T12:00:00+08:00')), '2026-11-01');
    // UTC 10-31 20:00 = 北京 11-01 04:00,按站点时区应算 11-01
    assert.equal(api._checkinDayKey(new Date('2026-10-31T20:00:00Z')), '2026-11-01');
    assert.equal(api._checkinDayKey(new Date('2026-10-31T15:59:00Z')), '2026-10-31');
});

test('resolveCheckinUrl accepts absolute url and base-relative path', function() {
    var acc = { platform: 'sub2api', base_url: 'https://super-nb.me/' };
    assert.equal(api._resolveCheckinUrl(acc, 'https://other.example.com/activity/v1/checkin'), 'https://other.example.com/activity/v1/checkin');
    assert.equal(api._resolveCheckinUrl(acc, '/activity/v1/checkin'), 'https://super-nb.me/activity/v1/checkin');
    assert.equal(api._resolveCheckinUrl(acc, ''), null);
});

test('normalizeCheckinStatus maps super-nb shape and tolerates unknown shapes', function() {
    var n = api._normalizeCheckinStatus({
        punchedToday: true, streakCurrent: 3, cumulativeDays: 28, monthLabel: '2026.11',
        dailyReward: { todayBalanceCny: 0.1, todayNbPoints: 3, tomorrowNbPoints: 6 },
        milestones: [{ label: '出勤 5 天', statusText: '3 / 5', achieved: false }, null]
    });
    assert.equal(n.checkedInToday, true);
    assert.equal(n.streakCurrent, 3);
    assert.equal(n.todayNbPoints, 3);
    assert.equal(n.tomorrowNbPoints, 6);
    assert.deepEqual(n.milestones, [{ label: '出勤 5 天', statusText: '3 / 5', achieved: false }]);
    // 其他站点命名兜底 + 完全未知形状
    assert.equal(api._normalizeCheckinStatus({ checkedInToday: false }).checkedInToday, false);
    assert.equal(api._normalizeCheckinStatus({ foo: 1 }).checkedInToday, null);
    assert.equal(api._normalizeCheckinStatus(null).checkedInToday, null);
});

test('checkinConfigured requires checkin_url', function() {
    assert.equal(api._checkinConfigured({ checkin_url: '/x' }), true);
    assert.equal(api._checkinConfigured({ checkin_info_url: '/x' }), false);
    assert.equal(api._checkinConfigured(null), false);
});

// ---- 状态拉取 ----

test('fetchCheckinStatus never throws: auth failure returns error object', async function() {
    var st = await api._fetchCheckinStatus({ platform: 'sub2api', base_url: 'https://super-nb.me', authorization: 'Bearer BAD', checkin_info_url: '/activity/v1/checkin/status' }, 0);
    assert.equal(st.checkedInToday, null);
    assert.match(st.error, /HTTP 401/);
});

test('fetchSub2apiUsage embeds data.checkin and stays soft-fail', async function() {
    writeAccounts([{
        platform: 'sub2api', name: 'SUPER·NB', base_url: 'https://super-nb.me',
        authorization: 'Bearer TOK_A',
        checkin_url: '/activity/v1/checkin', checkin_info_url: '/activity/v1/checkin/status'
    }]);
    var acc = JSON.parse(fs.readFileSync(accountsFile, 'utf8')).accounts[0];
    postedBy['Bearer TOK_A'] = false;
    statusMode = 'checked';
    var result = await api._fetchSub2apiUsage(acc, 0);
    assert.equal(result.success, true);
    assert.equal(result.data.checkin.checkedInToday, true);
    assert.equal(result.data.checkin.todayNbPoints, 3);
    // 状态接口 401 且无账密:主数据成功,checkin 仅带 error
    statusMode = 'authfail';
    callLog = [];
    result = await api._fetchSub2apiUsage(acc, 0);
    assert.equal(result.success, true);
    assert.equal(result.data.checkin.checkedInToday, null);
    assert.match(result.data.checkin.error, /HTTP 401/);
});

// ---- 自动签到轮次 ----

test('runCheckinCycle: checked→skip POST; unchecked→POST then confirm; conflict 409→done; authfail→error retry', async function() {
    api._resetCheckinState();
    statusMode = 'unchecked'; postModes = {}; postedBy = {};
    writeAccounts([
        { platform: 'sub2api', name: 'A-已签', base_url: 'https://super-nb.me', authorization: 'Bearer TOK_A', checkin_url: '/activity/v1/checkin', checkin_info_url: '/activity/v1/checkin/status' },
        { platform: 'sub2api', name: 'B-未签', base_url: 'https://super-nb.me', authorization: 'Bearer TOK_B', checkin_url: '/activity/v1/checkin', checkin_info_url: '/activity/v1/checkin/status' },
        { platform: 'sub2api', name: 'C-无签到配置', base_url: 'https://super-nb.me', authorization: 'Bearer TOK_C' },
        { platform: 'sub2api', name: 'D-409冲突', base_url: 'https://super-nb.me', authorization: 'Bearer TOK_D', checkin_url: '/activity/v1/checkin' },
        { platform: 'sub2api', name: 'E-鉴权失效', base_url: 'https://super-nb.me', authorization: 'Bearer EXPIRED_E', checkin_url: '/activity/v1/checkin', checkin_info_url: '/activity/v1/checkin/status' }
    ]);
    // A 站点侧已签
    postedBy['Bearer TOK_A'] = true;
    // D 直接冲突
    postModes['Bearer TOK_D'] = 'conflict';
    callLog = [];
    var results = await api._runCheckinCycle();

    var byName = {};
    results.forEach(function(r) { byName[r.index] = r; });
    assert.equal(results.length, 4);                       // C 未配置签到,不参与
    assert.equal(byName[0].state, 'done');                 // A:已签跳过
    assert.match(byName[0].message, /已签到/);
    assert.equal(posts().filter(function(c) { return c.auth === 'Bearer TOK_A'; }).length, 0);
    assert.equal(byName[1].state, 'done');                 // B:POST 成功
    assert.match(byName[1].message, /签到成功/);
    assert.equal(posts().filter(function(c) { return c.auth === 'Bearer TOK_B'; }).length, 1);
    assert.equal(byName[3].state, 'done');                 // D:409 视为已完成
    assert.match(byName[3].message, /站点确认/);
    assert.equal(byName[4].state, 'error');                // E:token 失效,待下轮重试
    assert.match(byName[4].message, /HTTP 401/);

    // 第二轮(同一天):done 的幂等跳过(B/D 不再 POST),E 重试仍失败(仍会尝试 POST)
    callLog = [];
    results = await api._runCheckinCycle();
    assert.equal(results.length, 4);
    assert.equal(posts().filter(function(c) { return c.auth === 'Bearer TOK_B' || c.auth === 'Bearer TOK_D'; }).length, 0);
    assert.equal(posts().filter(function(c) { return c.auth === 'Bearer EXPIRED_E'; }).length, 1);
    assert.equal(results.filter(function(r) { return r.skipped; }).length, 3);
    assert.equal(results.filter(function(r) { return r.state === 'error'; }).length, 1);
});

test.after(function() {
    https.request = originalRequest;
    https.get = originalGet;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
});

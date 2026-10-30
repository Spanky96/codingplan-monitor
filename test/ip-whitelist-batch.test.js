'use strict';

/* 批量 IP 白名单:
 * - planIpWhitelistChanges 纯函数:replace/append 两种模式的 diff、目标去重、边界输入
 * - applyIpWhitelist 执行器(注入 deps):先删后加的调用顺序、单条失败即中断、list 业务错误
 * - 路由层:参数校验分支(空账号/非智谱账号/非法 IP)、任务不存在 404
 * 校验失败分支不会启动后台任务(无外部网络调用)。 */

var test = require('node:test');
var assert = require('node:assert/strict');
var fs = require('node:fs');
var os = require('node:os');
var path = require('node:path');

var fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glm-usage-ipbatch-'));
process.env.ACCOUNTS_FILE = path.join(fixtureDir, 'accounts.json');
process.env.USAGE_CACHE_FILE = path.join(fixtureDir, 'usage-cache.json');
process.env.ADMIN_PASSWORD = 'test-pwd';
fs.writeFileSync(process.env.ACCOUNTS_FILE, JSON.stringify({
    accounts: [
        { name: 'glm-一号', platform: 'glm', authorization: 'jwt-1', organization: 'org-a', project: 'prj-a' },
        { name: 'glm-二号', platform: 'glm', authorization: 'jwt-2', organization: 'org-b', project: 'prj-b' },
        { name: 'minimax-别选我', platform: 'minimax', cookie: 'x' }
    ]
}));

var api = require('../src/api');
var plan = api._planIpWhitelistChanges;
var apply = api._applyIpWhitelist;
var runTask = api._runIpBatchTask;
var withTimeout = api._ipBatchWithTimeout;

function row(id, ip) { return { id: id, ipAddress: ip, createTime: '2026-10-30' }; }

// ============ planIpWhitelistChanges ============

test('replace mode removes unlisted ips and adds missing ones', function() {
    var p = plan([row(1, '1.1.1.1'), row(2, '2.2.2.2')], ['2.2.2.2', '3.3.3.3']);
    assert.deepEqual(p.toAdd, ['3.3.3.3']);
    assert.deepEqual(p.toRemove, [row(1, '1.1.1.1')]);
    assert.deepEqual(p.kept, ['2.2.2.2']);
});

test('append mode only adds missing ips, never removes', function() {
    var p = plan([row(1, '1.1.1.1'), row(2, '2.2.2.2')], ['2.2.2.2', '3.3.3.3'], 'append');
    assert.deepEqual(p.toAdd, ['3.3.3.3']);
    assert.deepEqual(p.toRemove, []);
    assert.deepEqual(p.kept, ['2.2.2.2']);
});

test('target list is deduped preserving order', function() {
    var p = plan([], ['3.3.3.3', '3.3.3.3', '4.4.4.4']);
    assert.deepEqual(p.toAdd, ['3.3.3.3', '4.4.4.4']);
});

test('empty rows means everything to add; empty diff means no-op', function() {
    assert.deepEqual(plan([], ['1.1.1.1']).toAdd, ['1.1.1.1']);
    var p = plan([row(1, '1.1.1.1')], ['1.1.1.1']);
    assert.deepEqual(p.toAdd, []);
    assert.deepEqual(p.toRemove, []);
    assert.deepEqual(p.kept, ['1.1.1.1']);
});

test('non-array inputs degrade to empty instead of throwing', function() {
    var p = plan(null, null);
    assert.deepEqual(p.toAdd, []);
    assert.deepEqual(p.toRemove, []);
    var q = plan([row(1, '1.1.1.1'), null, { id: 3 }], null);
    assert.deepEqual(q.toRemove, [row(1, '1.1.1.1')]);   // 无 ipAddress 的脏行不参与删除
});

// ============ applyIpWhitelist(注入 deps) ============

function recordingDeps(rows, opts) {
    var o = opts || {};
    var calls = [];
    return {
        calls: calls,
        gapMs: 0,
        opGapMs: 0,
        list: async function() { calls.push('list'); return { code: 200, rows: rows }; },
        remove: async function(acc, idx, id) {
            calls.push('remove:' + id);
            if (o.bizFailOnRemove === id) return { code: 500, msg: o.bizMsg || '删除被拒绝' };
            if (o.failOnRemove === id) throw new Error(o.failMsg || '删除失败');
            return { code: 200 };
        },
        add: async function(acc, idx, ip) {
            calls.push('add:' + ip);
            if (o.bizFailOnAdd === ip) return { code: 500, msg: o.bizMsg || 'IP 数量已达上限' };
            if (o.failOnAdd === ip) throw new Error(o.failMsg || '添加失败');
            return { code: 200 };
        }
    };
}

test('apply removes unlisted then adds missing, reporting actual ops', async function() {
    var d = recordingDeps([row(11, '1.1.1.1'), row(22, '2.2.2.2')]);
    var r = await apply({ name: 'a' }, 0, ['2.2.2.2', '3.3.3.3'], 'replace', d);
    assert.deepEqual(d.calls, ['list', 'remove:11', 'add:3.3.3.3']);
    assert.deepEqual(r.added, ['3.3.3.3']);
    assert.deepEqual(r.removed, ['1.1.1.1']);
    assert.deepEqual(r.kept, ['2.2.2.2']);
});

test('apply append mode never calls remove', async function() {
    var d = recordingDeps([row(11, '1.1.1.1')]);
    var r = await apply({ name: 'a' }, 0, ['2.2.2.2'], 'append', d);
    assert.deepEqual(d.calls, ['list', 'add:2.2.2.2']);
    assert.deepEqual(r.removed, []);
});

test('apply is a no-op when whitelist already matches targets', async function() {
    var d = recordingDeps([row(11, '1.1.1.1')]);
    var r = await apply({ name: 'a' }, 0, ['1.1.1.1'], 'replace', d);
    assert.deepEqual(d.calls, ['list']);
    assert.deepEqual(r.added, []);
    assert.deepEqual(r.removed, []);
});

test('apply aborts the account on single op failure', async() => {
    var d = recordingDeps([row(11, '1.1.1.1'), row(22, '2.2.2.2')], { failOnRemove: 11 });
    await assert.rejects(
        () => apply({ name: 'a' }, 0, ['2.2.2.2'], 'replace', d),
        /删除失败/
    );
    assert.deepEqual(d.calls, ['list', 'remove:11']);   // 失败后不再继续删 22/加新
});

test('apply surfaces official business error from list', async function() {
    var d = {
        gapMs: 0,
        list: async function() { return { code: 500, msg: '登录已过期' }; },
        remove: async function() { throw new Error('不应到达'); },
        add: async function() { throw new Error('不应到达'); }
    };
    await assert.rejects(
        () => apply({ name: 'a' }, 0, ['1.1.1.1'], 'replace', d),
        /登录已过期/
    );
});

test('apply rejects HTTP-200 body with non-200 business code on add/remove', async() => {
    var d = recordingDeps([row(11, '1.1.1.1')], { bizFailOnAdd: '2.2.2.2', bizMsg: 'IP 数量已达上限' });
    await assert.rejects(
        () => apply({ name: 'a' }, 0, ['2.2.2.2'], 'append', d),
        /IP 数量已达上限/
    );
    assert.deepEqual(d.calls, ['list', 'add:2.2.2.2']);   // 不能被计成成功
});

test('apply rejects business code on remove with fallback message', async() => {
    var d = recordingDeps([row(11, '1.1.1.1')], { bizFailOnRemove: 11 });
    await assert.rejects(
        () => apply({ name: 'a' }, 0, ['2.2.2.2'], 'replace', d),
        /删除被拒绝/
    );
});

// ============ withTimeout(挂起请求兜底,防 running 标志永久卡死) ============

test('withTimeout passes through fast responses', async() => {
    assert.equal(await withTimeout(Promise.resolve(42), 5000), 42);
});

test('withTimeout rejects when the request hangs', async() => {
    await assert.rejects(
        () => withTimeout(new Promise(function() { /* 永不 settle */ }), 30),
        /请求超时/
    );
});

// ============ runTask(任务执行器:指纹校验防账号错位 + 终态兜底) ============

function fakeTaskDeps() {
    return {
        gapMs: 0, opGapMs: 0,
        list: async function() { return { code: 200, rows: [] }; },
        add: async function() { return { code: 200 }; },
        remove: async function() { throw new Error('空 rows 不应有删除'); }
    };
}

function makeBatchItem(index, name, fp) {
    return { index: index, name: name, fp: fp, status: 'pending', added: null, removed: null, kept: null, error: null };
}

test('runTask executes matched account and reports ok', async() => {
    var task = {
        id: 't1', mode: 'append', ips: ['1.1.1.1'], status: 'running', done: 0, createdAt: Date.now(),
        items: [makeBatchItem(0, 'glm-一号', 'org-a/prj-a')]
    };
    await runTask(task, fakeTaskDeps());
    assert.equal(task.status, 'done');
    assert.equal(task.done, 1);
    assert.equal(task.items[0].status, 'ok');
    assert.deepEqual(task.items[0].added, ['1.1.1.1']);
});

test('runTask skips account whose slot was reassigned mid-task (fingerprint mismatch)', async() => {
    var task = {
        id: 't2', mode: 'replace', ips: ['1.1.1.1'], status: 'running', done: 0, createdAt: Date.now(),
        items: [makeBatchItem(0, 'glm-一号', 'org-other/prj-other')]   // 发起后 index 0 被换成了别的账号
    };
    var d = fakeTaskDeps();
    d.list = async function() { throw new Error('指纹不匹配不应发起任何外部请求'); };
    await runTask(task, d);
    assert.equal(task.items[0].status, 'error');
    assert.match(task.items[0].error, /账号列表已变化/);
    assert.equal(task.status, 'done');
});

// ============ 路由层(校验分支,不触发后台任务) ============

var registerApi = require('../src/api');

function captureRoutes() {
    var routes = {};
    var app = {};
    ['get', 'post', 'put', 'delete'].forEach(function(method) {
        app[method] = function(route) {
            routes[method + ' ' + route] = Array.prototype.slice.call(arguments, 1);
        };
    });
    registerApi(app);
    return routes;
}

function mockRes() {
    var r = { statusCode: 200, body: null };
    r.status = function(c) { r.statusCode = c; return r; };
    r.json = function(b) { r.body = b; return r; };
    return r;
}

function postHandler(routes) { return routes['post /api/ip-whitelist-batch'][2]; }   // [jsonParser, checkAuth, handler]

test('POST rejects when no account selected', function() {
    var res = mockRes();
    postHandler(captureRoutes())({ body: { indexes: [], ips: ['1.1.1.1'] } }, res);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /至少勾选一个账号/);
});

test('POST rejects non-glm or missing accounts', function() {
    var res = mockRes();
    postHandler(captureRoutes())({ body: { indexes: [0, 2, 9], ips: ['1.1.1.1'] } }, res);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /2, 9/);   // 2=minimax,9=越界;0 是合法 glm 账号
});

test('POST rejects invalid ip formats', function() {
    var routes = captureRoutes();
    var noIp = mockRes();
    postHandler(routes)({ body: { indexes: [0], ips: [] } }, noIp);
    assert.equal(noIp.statusCode, 400);
    assert.match(noIp.body.error, /至少填写一个目标 IP/);

    var bad = mockRes();
    postHandler(routes)({ body: { indexes: [0], ips: ['1.1.1.1', '999.1.1.1'] } }, bad);
    assert.equal(bad.statusCode, 400);
    assert.match(bad.body.error, /999\.1\.1\.1/);
});

test('GET unknown taskId returns 404', function() {
    var routes = captureRoutes();
    var handler = routes['get /api/ip-whitelist-batch/:taskId'][1];   // [checkAuth, handler]
    var res = mockRes();
    handler({ params: { taskId: '404' } }, res);
    assert.equal(res.statusCode, 404);
    assert.match(res.body.error, /任务不存在/);
});

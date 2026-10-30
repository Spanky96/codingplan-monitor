// 批量 IP 白名单(智谱账号域,仅管理员):勾选多账号,一键替换/追加目标 IP。
// 长任务(每账号 list→diff→逐条增删,操作间节流)→ 内存任务表 + 轮询进度,
// 避免单个 HTTP 请求挂起几十秒被反代/浏览器掐断。
var express = require('express');
var jsonParser = express.json();
var { httpsGet, httpsRequest } = require('../../lib/http');
var { readAccounts } = require('../accounts');
var { checkAuth } = require('../auth');
var {
    makeHeaders, ipWhitelistUrl, isValidIp, planIpWhitelistChanges, withGlmAuthRetry
} = require('../platforms/glm');

// 节流间隔,双层:账号内逐条增删之间 opGap(替换模式删 N 条是连发请求);
// 账号之间 gap 更长。批量对 bigmodel.cn 连发请求,拉大间隔降低风控概率
// (风控等级 6 = 短时间内发起大量重复请求,冻结 30 天)。deps 可注入供测试提速。
var ACCOUNT_GAP_MS = 400;
var OP_GAP_MS = 150;
// 单请求超时:httpsRequest 无超时、httpsGet 直连默认无超时;一个挂起请求会永久
// 卡住 running 标志(之后所有批量 POST 409),统一 Promise.race 兜底
var REQUEST_TIMEOUT_MS = 15000;
// 内存任务表:重启即丢(前端按 404 提示重新发起);只保留最近 MAX_TASKS 个
var MAX_TASKS = 5;

var tasks = new Map();
var taskSeq = 0;
var running = false;   // 同一时刻仅允许一个批量任务,防误双击叠加请求

function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

// 与单账号路由(keys.js)同口径:HTTP 200 但 body.code 非 200 也算失败
function assertBizOk(json, fallback) {
    if (json && json.code != null && json.code !== 200) throw new Error(json.msg || fallback);
}

function withTimeout(promise, ms) {
    var timeout = new Promise(function(_, reject) {
        setTimeout(function() { reject(new Error('请求超时(' + ms + 'ms)')); }, ms);
    });
    promise.catch(function() { /* 败者的 rejection 在此静默,避免 unhandledRejection */ });
    return Promise.race([promise, timeout]);
}

// glm 账号身份指纹(organization+project,请求头要素,稳定非密):任务执行时
// 校验该位置还是发起时的那个账号,错位则拒绝执行,避免 replace 删错别人白名单
function ipBatchAccountFingerprint(account) {
    return [account && account.organization, account && account.project].join('/');
}

// 真实外部依赖:三个操作均走 withGlmAuthRetry(401 自动重登回写)+ 超时兜底
var defaultDeps = {
    gapMs: ACCOUNT_GAP_MS,
    opGapMs: OP_GAP_MS,
    list: function(account, index) {
        return withTimeout(withGlmAuthRetry(account, index, function(acc) {
            return httpsGet(ipWhitelistUrl(acc, '/list'), makeHeaders(acc));
        }), REQUEST_TIMEOUT_MS);
    },
    add: function(account, index, ip) {
        return withTimeout(withGlmAuthRetry(account, index, function(acc) {
            return httpsRequest('POST', ipWhitelistUrl(acc), makeHeaders(acc), { ipAddress: ip });
        }), REQUEST_TIMEOUT_MS);
    },
    remove: function(account, index, id) {
        return withTimeout(withGlmAuthRetry(account, index, function(acc) {
            return httpsRequest('DELETE', ipWhitelistUrl(acc, '/' + id), makeHeaders(acc));
        }), REQUEST_TIMEOUT_MS);
    }
};

// 单账号执行:list → 变更计划 → 先删后加。任一单条失败(网络/超时/业务 code)
// 即中断该账号并抛错(已成功的操作保留,结果如实上报);deps 注入供测试。
async function applyIpWhitelist(account, index, targets, mode, deps) {
    var d = deps || defaultDeps;
    var opGap = d.opGapMs != null ? d.opGapMs : OP_GAP_MS;
    var json = await d.list(account, index);
    assertBizOk(json, '查询白名单失败');
    var plan = planIpWhitelistChanges((json && json.rows) || [], targets, mode);
    var removed = [];
    var added = [];
    // 操作序列先组装再统一执行,便于在每条之间插入节流(最后一条后不多等)
    var ops = [];
    plan.toRemove.forEach(function(row) {
        ops.push(async function() {
            assertBizOk(await d.remove(account, index, row.id), '删除失败');
            removed.push(row.ipAddress);
        });
    });
    plan.toAdd.forEach(function(ip) {
        ops.push(async function() {
            assertBizOk(await d.add(account, index, ip), '添加失败');
            added.push(ip);
        });
    });
    for (var i = 0; i < ops.length; i++) {
        if (i > 0) await sleep(opGap);
        await ops[i]();
    }
    return { added: added, removed: removed, kept: plan.kept };
}

// 任务视图:前端轮询拿到的就是这份(显式映射,不透出内部字段如账号指纹)
function taskView(task) {
    return {
        taskId: task.id,
        status: task.status,
        mode: task.mode,
        ips: task.ips,
        total: task.items.length,
        done: task.done,
        createdAt: task.createdAt,
        results: task.items.map(function(it) {
            return {
                index: it.index, name: it.name, status: it.status,
                added: it.added || [], removed: it.removed || [],
                keptCount: it.kept ? it.kept.length : 0, error: it.error
            };
        })
    };
}

// 超额清理:保留最近 MAX_TASKS 个非 running 任务(running 最多一个且必然最新)
function pruneTasks() {
    var overflow = tasks.size - MAX_TASKS;
    var iter = tasks.entries();
    while (overflow > 0) {
        var entry = iter.next();
        if (entry.done) break;
        if (entry.value[1].status === 'running') continue;   // 跳过,不占清理名额
        tasks.delete(entry.value[0]);
        overflow -= 1;
    }
}

// 后台串行执行:逐账号读盘解析 + 指纹校验(账号可能中途被增删/编辑,按 index
// 重取时错位则跳过),单账号失败落 items 继续;循环本身出错兜底终止任务。
async function runTask(task, deps) {
    var d = deps || defaultDeps;
    try {
        for (var k = 0; k < task.items.length; k++) {
            var it = task.items[k];
            it.status = 'running';
            try {
                var account = readAccounts()[it.index];
                if (!account) throw new Error('账号不存在(可能已被删除)');
                if ((account.platform || 'glm') !== 'glm') throw new Error('非智谱账号,不支持 IP 白名单');
                if (ipBatchAccountFingerprint(account) !== it.fp) {
                    throw new Error('账号列表已变化(该位置已是其他账号),为避免误操作已跳过,请重新发起');
                }
                var r = await applyIpWhitelist(account, it.index, task.ips, task.mode, d);
                it.status = 'ok';
                it.added = r.added;
                it.removed = r.removed;
                it.kept = r.kept;
            } catch (err) {
                it.status = 'error';
                it.error = err.message;
            }
            task.done = k + 1;
            if (k < task.items.length - 1) await sleep(d.gapMs);
        }
        task.status = 'done';
    } catch (outerErr) {
        // 循环本身出错(如 accounts.json 瞬时不可读):未完成账号标错并终止任务,
        // 保证任务总能到终态,前端轮询不会永远停在 running
        task.items.forEach(function(it) {
            if (it.status === 'pending' || it.status === 'running') {
                it.status = 'error';
                it.error = outerErr.message;
            }
        });
        task.status = 'done';
    } finally {
        running = false;
    }
}

module.exports = function(app) {
    // 发起批量任务:校验通过即返回 taskId,进度经 GET 轮询
    app.post('/api/ip-whitelist-batch', jsonParser, checkAuth, function(req, res) {
        var body = req.body || {};
        var accounts = readAccounts();
        var indexes = (Array.isArray(body.indexes) ? body.indexes : [])
            .map(function(v) { return parseInt(v, 10); })
            .filter(function(v, i, arr) { return Number.isInteger(v) && v >= 0 && arr.indexOf(v) === i; });
        var invalid = indexes.filter(function(i) {
            return !accounts[i] || (accounts[i].platform || 'glm') !== 'glm';
        });
        if (!indexes.length) return res.status(400).json({ error: '请至少勾选一个账号' });
        if (invalid.length) {
            return res.status(400).json({ error: '以下账号不存在或非智谱账号: ' + invalid.join(', ') });
        }
        var ips = (Array.isArray(body.ips) ? body.ips : [])
            .map(function(v) { return String(v || '').trim(); })
            .filter(function(v, i, arr) { return v && arr.indexOf(v) === i; });
        if (!ips.length) return res.status(400).json({ error: '请至少填写一个目标 IP' });
        var badIp = ips.find(function(ip) { return !isValidIp(ip); });
        if (badIp) {
            return res.status(400).json({ error: 'IP 格式不正确: ' + badIp + '(支持 IPv4 或 IPv4/CIDR)' });
        }
        var mode = body.mode === 'append' ? 'append' : 'replace';
        if (running) return res.status(409).json({ error: '已有批量任务在执行中,请等它完成后再发起' });

        var task = {
            id: String(++taskSeq), mode: mode, ips: ips,
            status: 'running', done: 0, createdAt: Date.now(),
            items: indexes.map(function(i) {
                return {
                    index: i, name: accounts[i].name,
                    fp: ipBatchAccountFingerprint(accounts[i]),   // 执行时校验账号未错位
                    status: 'pending', added: null, removed: null, kept: null, error: null
                };
            })
        };
        tasks.set(task.id, task);
        pruneTasks();
        running = true;
        runTask(task).catch(function() { /* runTask 自带终态兜底,此处仅防 unhandledRejection */ });
        res.json({ taskId: task.id, total: task.items.length });
    });

    // 查询任务进度(前端 1.2s 轮询;404 = 服务重启后内存任务丢失)
    app.get('/api/ip-whitelist-batch/:taskId', checkAuth, function(req, res) {
        var task = tasks.get(String(req.params.taskId || ''));
        if (!task) return res.status(404).json({ error: '任务不存在或已过期(服务重启后任务丢失,请重新发起)' });
        res.json(taskView(task));
    });
};

// 供单测注入:纯 diff 计划 + 可注入 deps 的单账号执行器/任务执行器 + 内部工具
module.exports._planIpWhitelistChanges = planIpWhitelistChanges;
module.exports._applyIpWhitelist = applyIpWhitelist;
module.exports._runIpBatchTask = runTask;
module.exports._withTimeout = withTimeout;
module.exports._ipBatchAccountFingerprint = ipBatchAccountFingerprint;

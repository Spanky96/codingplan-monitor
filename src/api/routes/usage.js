// 用量查询(秒回:新鲜缓存直接返回,缺失/强刷时先返回旧数据或 loading 骨架并后台抓取)
var { readAccounts } = require('../accounts');
var { ensureUsageFetch, getCached, getCachedLastKnown, usageForResponse, accountUsageShell } = require('../cache');
var { isHiddenFromGuest } = require('../auth');
var platforms = require('../platforms');

function getAccount(req) {
    var accounts = readAccounts();
    return accounts[parseInt(req.params.index)];
}

module.exports = function(app) {
    app.get('/api/usage', async function(req, res) {
        try {
            var accounts = readAccounts();
            var force = req.query.force === '1';
            var results = [];
            for (var i = 0; i < accounts.length; i++) {
                var account = accounts[i];
                if (!account || isHiddenFromGuest(req, account)) continue;

                var fresh = getCached(i);
                var lastKnown = getCachedLastKnown(i);

                // 非强制且缓存仍新鲜:直接返回,不触发抓取
                if (!force && fresh) {
                    results.push(usageForResponse(fresh));
                    continue;
                }

                // 需要刷新:后台启动(不 await),响应立刻带着旧数据或骨架返回
                ensureUsageFetch(account, i, force || !fresh).catch(function() { /* 单卡补齐时会再取错误结果 */ });

                if (lastKnown) {
                    var shown = usageForResponse(lastKnown);
                    results.push(Object.assign({}, shown, {
                        pending: true,
                        stale: !fresh,
                        refreshing: !!force
                    }));
                } else {
                    results.push(accountUsageShell(account, i));
                }
            }
            res.json(results);
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.get('/api/usage/:index', async function(req, res) {
        try {
            var i = parseInt(req.params.index);
            var account = getAccount(req);
            if (!account) return res.status(404).json({ error: '未找到账号' });
            if (isHiddenFromGuest(req, account)) return res.status(404).json({ error: '未找到账号' });
            var force = req.query.force === '1';
            if (!force) {
                var c = getCached(i);
                if (c) return res.json(usageForResponse(c));
            }
            // 等待后台抓取完成(与列表接口共享 inflight);完成后返回最终结果
            res.json(usageForResponse(await ensureUsageFetch(account, i, force)));
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

};

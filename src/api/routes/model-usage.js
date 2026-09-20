// 用量曲线:智谱当日/7/30 天、千问、MiniMax 与阶跃 7/30 天(阶跃纵轴为积分)。
var { readAccounts } = require('../accounts');
var { httpsGet } = require('../../lib/http');
var { isHiddenFromGuest } = require('../auth');
var platforms = require('../platforms');
var glm = require('../platforms/glm');

function getAccount(req) {
    var accounts = readAccounts();
    return accounts[parseInt(req.params.index)];
}

module.exports = function(app) {
    app.get('/api/model-usage/:index', async function(req, res) {
        try {
            var i = parseInt(req.params.index);
            var account = getAccount(req);
            if (!account) return res.status(404).json({ error: '未找到账号' });
            if (isHiddenFromGuest(req, account)) return res.status(404).json({ error: '未找到账号' });
            if ((account.platform || 'glm') === 'qwen') {
                var qwenChart = await platforms.fetchQwenModelUsage(account, req.query.period || '7d');
                return res.json({ data: qwenChart });
            }
            if ((account.platform || 'glm') === 'minimax') {
                var mmChart = await platforms.fetchMiniMaxModelUsage(account, req.query.period || '7d');
                return res.json({ data: mmChart });
            }
            if ((account.platform || 'glm') === 'stepfun') {
                var sfChart = await platforms.fetchStepfunModelUsage(account, i, req.query.period || '7d');
                return res.json({ data: sfChart });
            }
            if ((account.platform || 'glm') !== 'glm') {
                var platName = account.platform === 'sub2api' ? 'Sub2API' : (account.platform === 'huoli' ? '火狸' : (account.platform === 'volc' ? '火山' : (account.platform === 'telecomjs' ? '智云' : (account.platform === 'qwen' ? '千问' : (account.platform === 'minimax' ? 'MiniMax' : (account.platform === 'stepfun' ? '阶跃' : 'YesCode'))))));
                return res.json({ error: platName + ' 暂不支持用量曲线' });
            }
            var period = req.query.period || '7d';
            var now = new Date();
            var pad = function(n) { return n < 10 ? '0' + n : '' + n; };
            function fmtDate(d, hms) {
                return d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate()) + ' ' + hms;
            }
            var endDate = fmtDate(now, '23:59:59');
            var startD = new Date(now);
            if (period === '30d') {
                startD.setDate(startD.getDate() - 29);
            } else if (period !== 'today') { // 7d default
                startD.setDate(startD.getDate() - 6);
            }
            var startDate = fmtDate(startD, '00:00:00');
            var url = 'https://bigmodel.cn/api/monitor/usage/model-usage?startTime='
                + encodeURIComponent(startDate) + '&endTime=' + encodeURIComponent(endDate);
            // 团队版需带 type=2，否则拿到的是个人维度数据（与 quota/limit 口径一致）
            if (account.teamEdition) url += '&type=2';
            var json = await glm.withGlmAuthRetry(account, i, function(acc) {
                return httpsGet(url, glm.makeHeaders(acc));
            });
            res.json(json);
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

};

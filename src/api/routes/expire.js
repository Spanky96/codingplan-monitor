// 订阅到期时间(24h 缓存;非 glm 平台的到期由各平台接口自带,走 success:false)
var { readAccounts } = require('../accounts');
var { getExpireCached } = require('../cache');
var { isHiddenFromGuest } = require('../auth');
var platforms = require('../platforms');

function getAccount(req) {
    var accounts = readAccounts();
    return accounts[parseInt(req.params.index)];
}

module.exports = function(app) {
    app.get('/api/expire', async function(req, res) {
        try {
            var accounts = readAccounts();
            var force = req.query.force === '1';
            var results = await Promise.all(accounts.map(function(account, i) {
                if (isHiddenFromGuest(req, account)) return null;  // 游客跳过私有账号
                if (!force) { var c = getExpireCached(i); if (c) return c; }
                return platforms.fetchAccountExpire(account, i);
            }));
            res.json(results.filter(Boolean));
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.get('/api/expire/:index', async function(req, res) {
        try {
            var i = parseInt(req.params.index);
            var account = getAccount(req);
            if (!account) return res.status(404).json({ error: '未找到账号' });
            if (isHiddenFromGuest(req, account)) return res.status(404).json({ error: '未找到账号' });
            if (req.query.force !== '1') { var c = getExpireCached(i); if (c) return res.json(c); }
            res.json(await platforms.fetchAccountExpire(account, i));
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

};

// 签到路由:手动触发一轮自动签到(管理鉴权)。幂等——当日已完成的账号直接跳过。
var { checkAuth } = require('../auth');
var checkin = require('../checkin');

module.exports = function(app) {
    app.post('/api/checkin/run', checkAuth, async function(req, res) {
        try {
            res.json({ results: await checkin.runCheckinCycle() });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });
};

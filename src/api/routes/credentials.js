// 凭证导出接口(为中转站等内部系统同步最新登录态)。
// 默认关闭:仅当 .env 配置 CREDENTIALS_EXPORT=1 时注册路由,否则接口不存在。
// 背景:yescode 等平台官方 token 有效期缩短为 24h,本项目已支持账密自动重登并持续
// 刷新凭证;下游(中转站外部渠道)按账号名精确匹配拉取,避免各自维护登录。
// GET /api/credentials?password=<管理密码>&platform=yescode → { "账号名": "凭证" }
var config = require('../../config');
var { readAccounts } = require('../accounts');
var { clientIp, authBanState, authBanRecordFailure, authBanReset } = require('../auth');

var PASSWORD = config.adminPassword;

var CREDENTIAL_FIELDS = {
    yescode: 'cookie',
    sub2api: 'authorization',
    glm: 'authorization',
    huoli: 'authorization',
    volc: 'cookie',
    qwen: 'cookie',
    minimax: 'cookie',
    stepfun: 'cookie',
    telecomjs: 'satoken'
};

module.exports = function(app) {
    var CREDENTIAL_FIELDS = {
        yescode: 'cookie',
        sub2api: 'authorization',
        glm: 'authorization',
        huoli: 'authorization',
        volc: 'cookie',
        qwen: 'cookie',
        minimax: 'cookie',
        stepfun: 'cookie',
        telecomjs: 'satoken'
    };
    app.get('/api/credentials', function(req, res) {
        try {
            var cIp = clientIp(req);
            var cNow = Date.now();
            var cSt = authBanState(cIp, cNow);
            if (cSt.banned) {
                return res.status(429).json({ error: '密码连续错误次数过多，已封禁 ' + Math.ceil(cSt.retryAfterSec / 60) + ' 分钟，请稍后再试', retryAfterSec: cSt.retryAfterSec });
            }
            if (req.query.password !== PASSWORD) {
                authBanRecordFailure(cIp, cNow);
                return res.status(401).json({ error: 'unauthorized' });
            }
            authBanReset(cIp);
            var platform = req.query.platform || 'yescode';
            var field = CREDENTIAL_FIELDS[platform];
            if (!field) return res.status(400).json({ error: '不支持的平台: ' + platform });
            var out = {};
            readAccounts().forEach(function(acc) {
                if (!acc || (acc.platform || 'glm') !== platform) return;
                var cred = (acc[field] || '').trim();
                if (cred) out[acc.name] = cred;
            });
            res.json(out);
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

};

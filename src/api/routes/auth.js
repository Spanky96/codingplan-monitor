// 管理密码登录(含防爆破:连续 3 次错封 IP 15 分钟)
var express = require('express');
var jsonParser = express.json();
var config = require('../../config');
var { clientIp, authBanState, authBanRecordFailure, authBanReset } = require('../auth');

var PASSWORD = config.adminPassword;
var AUTH_FAIL_LIMIT = 3;

module.exports = function(app) {
    app.post('/api/auth', jsonParser, function(req, res) {
        var ip = clientIp(req);
        var now = Date.now();
        var st = authBanState(ip, now);
        if (st.banned) {
            return res.status(429).json({ success: false, error: '密码连续错误次数过多，已封禁 ' + Math.ceil(st.retryAfterSec / 60) + ' 分钟，请稍后再试', retryAfterSec: st.retryAfterSec });
        }
        if (req.body.password !== PASSWORD) {
            var after = authBanRecordFailure(ip, now);
            if (after.banned) {
                return res.status(429).json({ success: false, error: '密码连续错误 ' + AUTH_FAIL_LIMIT + ' 次，已封禁 15 分钟', retryAfterSec: after.retryAfterSec });
            }
            return res.json({ success: false, error: '密码错误，连续错误 ' + AUTH_FAIL_LIMIT + ' 次将封禁 15 分钟' });
        }
        authBanReset(ip);
        res.json({ success: true });
    });

};

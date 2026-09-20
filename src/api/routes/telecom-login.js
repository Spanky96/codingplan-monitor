// 智云自助登录:手机号核对后由用户扫码,成功后自动更新 satoken 并刷新卡片。
// 会话由 telecomjs 模块管理(内存态,5 分钟过期);attempts 记录手机号核对失败次数。
var express = require('express');
var jsonParser = express.json();
var telecomjs = require('../../telecomjs');
var { readAccounts, writeAccounts } = require('../accounts');
var { clearCacheIndex, normalizeTelephone } = require('../cache');

var telecomPhoneAttempts = new Map();

module.exports = function(app) {
    app.post('/api/telecomjs/login/:index', jsonParser, async function(req, res) {
        try {
            var idx = parseInt(req.params.index);
            var accounts = readAccounts();
            var account = accounts[idx];
            if (!account) return res.status(404).json({ error: '未找到账号' });
            if (isHiddenFromGuest(req, account)) return res.status(404).json({ error: '未找到账号' });
            if ((account.platform || 'glm') !== 'telecomjs') {
                return res.status(400).json({ error: '该账号不是智云账号' });
            }
            var expectedTelephone = normalizeTelephone(account.phone);
            if (!/^1[3-9]\d{9}$/.test(expectedTelephone)) {
                return res.status(409).json({ error: '该账号未配置有效的管辖手机号，请联系管理员维护' });
            }
            var submittedTelephone = normalizeTelephone(req.body && req.body.telephone);
            var attemptKey = String(req.ip || req.socket.remoteAddress || '') + ':' + idx;
            var attempt = telecomPhoneAttempts.get(attemptKey);
            var now = Date.now();
            if (attempt && now - attempt.startedAt < 10 * 60 * 1000 && attempt.count >= 8) {
                return res.status(429).json({ error: '手机号核对失败次数过多，请 10 分钟后重试' });
            }
            if (submittedTelephone !== expectedTelephone) {
                if (!attempt || now - attempt.startedAt >= 10 * 60 * 1000) attempt = { count: 0, startedAt: now };
                attempt.count++;
                telecomPhoneAttempts.set(attemptKey, attempt);
                return res.status(403).json({ error: '手机号与该账号登记信息不一致' });
            }
            telecomPhoneAttempts.delete(attemptKey);
            var expectedName = account.name || '';
            var session = await telecomjs.startLogin({
                accountKey: idx + ':' + expectedName,
                telephone: expectedTelephone,
                onToken: async function(token) {
                    var latest = readAccounts();
                    var target = latest[idx];
                    if (!target || (target.platform || 'glm') !== 'telecomjs' || (target.name || '') !== expectedName
                        || normalizeTelephone(target.phone) !== expectedTelephone) {
                        throw new Error('账号信息已发生变化，请重新核对手机号');
                    }
                    target.satoken = token;
                    writeAccounts(latest);
                    clearCacheIndex(idx);
                }
            });
            res.json(session);
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.get('/api/telecomjs/login/:sessionId', function(req, res) {
        var session = telecomjs.getLogin(req.params.sessionId);
        if (!session) return res.status(404).json({ error: '登录会话不存在或已过期' });
        res.json(session);
    });

    app.get('/api/telecomjs/login/:sessionId/screenshot', async function(req, res) {
        try {
            var png = await telecomjs.getLoginScreenshot(req.params.sessionId);
            res.set('Cache-Control', 'no-store');
            res.type('png').send(png);
        } catch (err) { res.status(410).json({ error: err.message }); }
    });

    app.delete('/api/telecomjs/login/:sessionId', async function(req, res) {
        try {
            var found = await telecomjs.cancelLogin(req.params.sessionId);
            if (!found) return res.status(404).json({ error: '登录会话不存在或已过期' });
            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

};

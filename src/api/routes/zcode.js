'use strict';

const express = require('express');
const crypto = require('node:crypto');
const config = require('../../config');
const { readAccounts } = require('../accounts');
const { checkAuth } = require('../auth');
const { createService } = require('../../zcode/service');
const { ZcodeError } = require('../../zcode/protocol');

module.exports = function(app, service = createService()) {
    function noStore(req, res, next) { res.set('Cache-Control', 'no-store'); next(); }
    function bridgeAuth(req, res, next) {
        if (!config.zcodeBridgeToken) return res.status(503).json({ error: 'zcode_bridge_not_configured' });
        const expected = Buffer.from(config.zcodeBridgeToken);
        const supplied = Buffer.from(String(req.headers['x-zcode-bridge-token'] || ''));
        if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return res.status(401).json({ error: 'unauthorized' });
        next();
    }
    function failure(res, err) {
        const code = err instanceof ZcodeError && err.code !== 'HTTP 401' ? err.code : 'zcode_login_required';
        return res.status(502).json({ error: code });
    }
    app.post('/api/zcode/authorize', noStore, bridgeAuth, express.json({ limit: '4kb' }), async function(req, res) {
        try { res.json(await service.authorize(req.body || {})); } catch (err) { failure(res, err); }
    });
    app.get('/api/zcode/status/:index', noStore, checkAuth, function(req, res) {
        const account = readAccounts()[Number(req.params.index)];
        if (!account || (account.platform || 'glm') !== 'glm') return res.status(404).json({ error: '未找到智谱账号' });
        res.json({ configured: !!config.zcodeBridgeToken, ...service.status(account) });
    });
    app.post('/api/zcode/check/:index', noStore, checkAuth, async function(req, res) {
        try { res.json(await service.check(Number(req.params.index))); } catch (err) { failure(res, err); }
    });
};

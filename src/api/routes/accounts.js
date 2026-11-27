// 账号管理(增删改 + 整体排序;编辑表单不含 weightConfig,替换时保留原配置)
var express = require('express');
var jsonParser = express.json();
var { readAccounts, writeAccounts } = require('../accounts');
var { checkAuth } = require('../auth');
var { clearCache } = require('../cache');

function saveInventory(accounts) {
    writeAccounts(accounts);
    clearCache();
    if (require('../../scheduler/store').pruneRemoved(accounts)) {
        require('../../scheduler/service').push().catch(() => {});
    }
}

module.exports = function(app) {
    app.get('/api/accounts', checkAuth, function(req, res) {
        try { res.json(readAccounts()); } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.post('/api/accounts', jsonParser, checkAuth, function(req, res) {
        try {
            var accounts = readAccounts();
            accounts.push(req.body);
            saveInventory(accounts);
            res.json({ success: true, index: accounts.length - 1 });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.put('/api/accounts/:index', jsonParser, checkAuth, function(req, res) {
        try {
            var accounts = readAccounts();
            var idx = parseInt(req.params.index);
            if (!accounts[idx]) return res.status(404).json({ error: '未找到账号' });
            // 编辑账号表单不含 weightConfig,替换时保留原有权重配置
            if (accounts[idx].weightConfig && req.body && !('weightConfig' in req.body)) {
                req.body.weightConfig = accounts[idx].weightConfig;
            }
            if (accounts[idx].zcode && req.body && !('zcode' in req.body)) {
                req.body.zcode = accounts[idx].zcode;
            }
            accounts[idx] = req.body;
            saveInventory(accounts);
            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.put('/api/accounts', jsonParser, checkAuth, function(req, res) {
        try {
            if (!Array.isArray(req.body)) return res.status(400).json({ error: '参数必须是数组' });
            saveInventory(req.body);
            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.delete('/api/accounts/:index', checkAuth, function(req, res) {
        try {
            var accounts = readAccounts();
            var idx = parseInt(req.params.index);
            if (!accounts[idx]) return res.status(404).json({ error: '未找到账号' });
            accounts.splice(idx, 1);
            saveInventory(accounts);
            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

};

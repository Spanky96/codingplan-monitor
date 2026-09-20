// 控制台直达 URL(仅管理员):点击「控制台」链接时换取带登录凭据的跳转地址。
// 为什么单独接口:usage 缓存/ /api/usage 结果不含 authorization(公开接口不能吐凭证),
// 故管理员点击时经 checkAuth 保护的路由实时拼装,游客始终只拿得到纯官网链接。
var express = require('express');
var { readAccounts } = require('../accounts');
var { checkAuth } = require('../auth');

// 各平台控制台地址(后续其他平台要做「带凭据直达」时在此扩展)
var CONSOLE_URLS = {
    glm: 'https://bigmodel.cn/coding-plan'
};

module.exports = function(app) {
    app.get('/api/console-url/:index', checkAuth, function(req, res) {
        try {
            var i = parseInt(req.params.index);
            var accounts = readAccounts();
            var account = accounts[i];
            if (!account) return res.status(404).json({ error: '未找到账号' });
            var platform = account.platform || 'glm';
            var base = CONSOLE_URLS[platform];
            if (!base) return res.status(400).json({ error: '该平台暂不支持控制台直达' });
            // GLM 的 authorization(bare JWT)即官方登录 cookie bigmodel_token_production 的值
            var token = account.authorization;
            var url = token ? base + '?token=' + encodeURIComponent(token) : base;
            res.json({ url: url, hasToken: !!token, platform: platform });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });
};

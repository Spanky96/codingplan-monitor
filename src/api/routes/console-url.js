// 控制台直达 URL(仅管理员):点击「控制台」链接时换取带登录凭据的跳转地址。
// 为什么单独接口:usage 缓存/ /api/usage 结果不含 authorization(公开接口不能吐凭证),
// 故管理员点击时经 checkAuth 保护的路由实时拼装,游客始终只拿得到纯官网链接。
var express = require('express');
var { readAccounts } = require('../accounts');
var { checkAuth } = require('../auth');

// 各平台控制台地址(后续其他平台要做「带凭据直达」时在此扩展)
var CONSOLE_URLS = {
    glm: 'https://bigmodel.cn/coding-plan',
    minimax: 'https://platform.minimaxi.com/console/plan'
};

// 各平台凭据 → URL 参数:
// GLM 的 authorization(bare JWT)即官方登录 cookie bigmodel_token_production 的值;
// MiniMax 官方无 token 免登录,登录态就是整串浏览器 cookie,base64url 编码防止
// 分号/等号歧义,由油猴脚本解码后逐个写回 .minimaxi.com 域下的 cookie。
var CONSOLE_CREDENTIAL = {
    glm: function(account) {
        return account.authorization ? 'token=' + encodeURIComponent(account.authorization) : '';
    },
    minimax: function(account) {
        return account.cookie ? 'ck=' + Buffer.from(account.cookie, 'utf8').toString('base64url') : '';
    }
};

// 纯函数便于单测:平台未登记返回 null;有凭据拼参数,无凭据降级纯地址(hasToken:false)。
// 用 hasOwnProperty 守卫:'constructor'/'__proto__' 等平台名会命中原型链,
// 拿到 Function 基座或继承成员,产生垃圾 URL 甚至抛错,必须走未登记分支。
function buildConsoleUrl(platform, account) {
    if (!Object.prototype.hasOwnProperty.call(CONSOLE_URLS, platform)) return null;
    var base = CONSOLE_URLS[platform];
    var make = Object.prototype.hasOwnProperty.call(CONSOLE_CREDENTIAL, platform)
        ? CONSOLE_CREDENTIAL[platform] : null;
    var pair = make ? make(account || {}) : '';
    return { url: pair ? base + '?' + pair : base, hasToken: !!pair, platform: platform };
}

module.exports = function(app) {
    app.get('/api/console-url/:index', checkAuth, function(req, res) {
        try {
            var i = parseInt(req.params.index);
            var accounts = readAccounts();
            var account = accounts[i];
            if (!account) return res.status(404).json({ error: '未找到账号' });
            var platform = account.platform || 'glm';
            var built = buildConsoleUrl(platform, account);
            if (!built) return res.status(400).json({ error: '该平台暂不支持控制台直达' });
            res.json(built);
        } catch (err) { res.status(500).json({ error: err.message }); }
    });
};

module.exports._buildConsoleUrl = buildConsoleUrl;

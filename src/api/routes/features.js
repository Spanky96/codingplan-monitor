// 功能开关(公开,无鉴权):前端据此决定中转站面板等可选功能是否渲染。
// 只暴露布尔值与网关地址字符串,绝不暴露 token / 密码。
var config = require('../../config');
var privacy = require('../privacy');

module.exports = function(app) {
    app.get('/api/features', function(req, res) {
        // privacyForced 随请求方(内外网/是否管理员)变化,禁止任何缓存
        res.set('Cache-Control', 'no-store');
        res.json({
            relayEnabled: config.relayEnabled,
            modelsGatewayUrl: config.modelsGatewayUrl,
            privacyForced: privacy.forcedPrivacy(req)
        });
    });

};

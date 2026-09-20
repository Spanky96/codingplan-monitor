// 功能开关(公开,无鉴权):前端据此决定中转站面板等可选功能是否渲染。
// 只暴露布尔值与网关地址字符串,绝不暴露 token / 密码。
var config = require('../../config');

module.exports = function(app) {
    app.get('/api/features', function(req, res) {
        res.json({
            relayEnabled: config.relayEnabled,
            modelsGatewayUrl: config.modelsGatewayUrl
        });
    });

};

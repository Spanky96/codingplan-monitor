const path = require('path');
const express = require('express');
// config 内部会加载 .env,必须在 require('./api') 之前引入,确保 api.js 读到最终配置
const config = require('./config');
const api = require('./api');

const app = express();
const { port, host } = config;

// 前端面板与静态资源(usage.html → public/index.html,/js/echart/*)
app.use(express.static(path.join(__dirname, 'public')));

// 用量监控 API(路由前缀 /api/...)
api(app);

const server = app.listen(port, host, () => {
  console.log('用量监控已启动:');
  console.log('  本机访问:  http://localhost:' + port);
  if (config.adminPassword === '123456') {
    console.log('  ⚠️  正在使用默认密码,请在 .env 中设置 ADMIN_PASSWORD');
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error('端口 ' + port + ' 已被占用,可在 .env 修改 PORT 后重试');
  } else {
    console.error('启动失败:', err.message);
  }
  process.exit(1);
});

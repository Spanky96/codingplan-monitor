const path = require('path');
const express = require('express');
const api = require('./api');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

// 前端面板与静态资源(usage.html → public/index.html,/js/echart/*)
app.use(express.static(path.join(__dirname, 'public')));

// 用量监控 API(路由前缀 /api/...)
api(app);

const server = app.listen(PORT, HOST, () => {
  const usingEnvPwd = !!process.env.ADMIN_PASSWORD;
  console.log('用量监控已启动:');
  console.log('  本机访问:  http://localhost:' + PORT);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error('端口 ' + PORT + ' 已被占用,可用 PORT=4000 npm start 指定其他端口');
  } else {
    console.error('启动失败:', err.message);
  }
  process.exit(1);
});

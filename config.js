// 配置中心:集中加载 .env 并导出不可变配置对象。
// 业务代码(server.js / api.js)统一从这里读取,不再直接访问 process.env。
require('dotenv').config();

const path = require('path');

const config = {
  // 服务监听端口
  port: parseInt(process.env.PORT, 10) || 4000,
  // 监听地址,默认允许局域网访问
  host: process.env.HOST || '0.0.0.0',
  // 管理密码(账号增删改、Key 复制/创建/删除需校验)
  adminPassword: process.env.ADMIN_PASSWORD || '123456',
  // 账号数据文件路径:本地默认 ./accounts.json;Docker 内由 ACCOUNTS_FILE 指向挂载目录
  accountsFile: process.env.ACCOUNTS_FILE
    ? path.resolve(process.env.ACCOUNTS_FILE)
    : path.join(__dirname, 'accounts.json'),
  // 智云抓取使用的 Chrome/Chromium；留空时按操作系统常见路径自动发现
  telecomjsChromePath: process.env.TELECOMJS_CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH || '',
  // 运行环境
  nodeEnv: process.env.NODE_ENV || 'development',
};

// 冻结,避免运行时被意外修改(不可变模式)
Object.freeze(config);

module.exports = config;

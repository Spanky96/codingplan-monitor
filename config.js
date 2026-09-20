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
  // 账号凭证加密密钥(accounts.json 中密码/Cookie/Token 落盘前加密)。
  // 强烈建议显式配置(32 字节以上随机串):本地与服务器必须一致才能互拷数据;
  // 未配置时从 ADMIN_PASSWORD 派生(单环境自洽,但改管理密码会导致旧密文解不开)。
  // 解密的密钥不匹配时写读按明文兜底并告警,不会导致服务崩溃。
  accountSecret: process.env.ACCOUNT_SECRET || '',
  // 账号数据文件路径:本地默认 ./accounts.json;Docker 内由 ACCOUNTS_FILE 指向挂载目录
  accountsFile: process.env.ACCOUNTS_FILE
    ? path.resolve(process.env.ACCOUNTS_FILE)
    : path.join(__dirname, 'accounts.json'),
  // 智云抓取使用的 Chrome/Chromium；留空时按操作系统常见路径自动发现
  telecomjsChromePath: process.env.TELECOMJS_CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH || '',
  // sub2api 中转站服务地址（容量快照/用户活动快照代理用）。
  // 留空(默认)= 中转站集成整体关闭:容量胶囊、实时调度/今日Token 面板自动隐藏,
  // 对应代理路由返回 404。需中转站具备 weight-snapshot / user-activity-snapshot /
  // user-usage-snapshot 快照端点(sub2api 的 lwsub2api 分支提供)。
  sub2apiBaseUrl: (process.env.SUB2API_BASE_URL || '').trim().replace(/\/+$/, ''),
  // 上面地址是否已配置(派生只读标记,供路由 gating 与 /api/features 使用)
  relayEnabled: !!(process.env.SUB2API_BASE_URL || '').trim(),
  // 中转站用户活动快照的 token 门禁（对应中转站 ACTIVITY_SNAPSHOT_TOKEN，未配置则不带）
  relaySnapshotToken: process.env.RELAY_SNAPSHOT_TOKEN || '',
  // 模型调用页(models.html)的网关地址(OpenAI 兼容入口,含 /v1)。
  // 留空(默认)= 页面禁用并提示未配置;由 /api/features 注入前端
  modelsGatewayUrl: (process.env.MODELS_GATEWAY_URL || '').trim().replace(/\/+$/, ''),
  // 凭证导出接口 /api/credentials 开关(供中转站外部渠道同步登录态)。
  // 接受 1/true/yes;未配置则路由不注册
  credentialsExportEnabled: /^(1|true|yes)$/i.test((process.env.CREDENTIALS_EXPORT || '').trim()),
  // MiniMax 反向代理(/minimax/*)上游地址。留空(默认)= 代理关闭,返回 404
  minimaxProxyUpstream: (process.env.MINIMAX_PROXY_UPSTREAM || '').trim().replace(/\/+$/, ''),
  // 运行环境
  nodeEnv: process.env.NODE_ENV || 'development',
};

// 冻结,避免运行时被意外修改(不可变模式)
Object.freeze(config);

module.exports = config;

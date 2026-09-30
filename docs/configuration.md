# 配置说明

通过 `.env` 文件配置,模板见 `.env.example`(`cp .env.example .env` 后生效)。`.env` 已加入 `.gitignore`,不会提交。所有项均有默认值。

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `4000` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址,默认允许局域网访问 |
| `ADMIN_PASSWORD` | `123456` | 管理密码(账号增删改、Key 复制/创建/删除需校验) |
| `ACCOUNT_SECRET` | 空 | 账号凭证加密密钥(AES-256-GCM)。建议 `openssl rand -base64 32` 生成,**本地与服务器保持一致**才能互拷 `accounts.json`;未配置时从 `ADMIN_PASSWORD` 派生(此后改管理密码会导致旧密文解不开,解不开时按明文兜底并告警) |
| `ACCOUNTS_FILE` | `./accounts.json` | 账号数据文件路径(Docker 持久化用,本地留空) |
| `NODE_ENV` | `development` | 运行环境 |
| `TELECOMJS_CHROME_PATH` | 自动发现 | 智云抓取所用 Chrome/Chromium 可执行文件路径 |
| `ZENMUX_PROXY_URL` | 空(直连) | ZenMux API 专用 HTTP CONNECT 代理,仅当服务器无法直连 zenmux.ai 时配置;Docker 访问宿主机代理示例 `http://host.docker.internal:7897` |
| `PRIVACY_MODE` | 空(`off`) | 隐私模式,对**非管理员**在服务端强制脱敏(账号名→「站点名+序号」别名,负责人/电话/备注与平台身份字段不下发,隐私开关锁定为开):`off`=不强制;`full`=全隐私(内外网访客一律强制,此档下中转站轮询 `/api/weights` 需带 `password` 才能拿真实账号名);`split`=内网无隐私/外网隐私(内网访问维持原状,外网访问强制且不可切换;别名 `external`/`lan-open`) |
| `PRIVACY_EXTERNAL_HOSTS` | 空 | `split` 模式的外网主机名(逗号分隔,如 `lwai.05info.com`):请求 Host 命中即判外网,内网用户走外网域名访问同样强制;建议外网反代同时透传 `X-Forwarded-For` 作为公网 IP 兜底判定 |

## 可选集成(中转站 / 模型调用页)

以下项均默认关闭,不配置不影响核心监控功能。用途与细节见 [relay-integration.md](relay-integration.md)。

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `SUB2API_BASE_URL` | 空(不启用) | sub2api 中转站地址;配置后启用容量胶囊与实时调度/今日Token 面板(需中转站具备 weight-snapshot / user-activity-snapshot / user-usage-snapshot 快照端点,lwsub2api 分支提供) |
| `RELAY_SNAPSHOT_TOKEN` | 空 | 中转站用户活动快照门禁,与中转站 `ACTIVITY_SNAPSHOT_TOKEN` 一致;留空表示中转站未开启门禁 |
| `MODELS_GATEWAY_URL` | 空(不启用) | 模型调用页(`models.html`)网关地址(OpenAI 兼容入口,含 `/v1`);配置后页面可用,留空禁用 |
| `CREDENTIALS_EXPORT` | 空(关闭) | 凭证导出接口 `/api/credentials` 开关(供中转站外部渠道同步登录态),接受 `1/true/yes`;留空则路由不注册 |
| `MINIMAX_PROXY_UPSTREAM` | 空(关闭) | MiniMax 反向代理 `/minimax/*` 上游地址(兼容保留,模型调用页已直连网关);留空则代理返回 404 |

## .env 示例

```env
PORT=4000
HOST=0.0.0.0
ADMIN_PASSWORD=my-secret
```

> 仍可用命令行 / 系统环境变量覆盖(`PORT=5000 npm start`),优先级:系统环境变量 > `.env` > 默认值。
> 浏览器验证通过后,密码保存在本地 `localStorage`,仅在当前浏览器生效。

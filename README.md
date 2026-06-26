# GLM 用量监控

多账号 API 用量监控面板,支持 **智谱 GLM(bigmodel.cn)**、**YesCode(co.yes.vg)**、**火狸(huolilink.com)** 三类账号,以卡片 + 用量曲线的形式集中展示额度消耗、订阅到期、API Key 管理。

## 效果展示

![GLM 用量监控面板](example.png)

## 项目结构

```
glm-usage/
├── server.js              # Express 入口:静态托管 + 挂载 api 中间件
├── api.js                 # 后端:账号凭证读写、用量/到期/Key 代理(5 分钟缓存)
├── accounts.json          # 账号凭证(运行时自动生成,敏感,.gitignore 已忽略)
├── package.json
└── public/
    ├── index.html         # 前端监控面板(原 usage.html)
    └── js/echart/
        └── echarts.min.js # 用量曲线依赖(本地,可离线)
```

## 快速开始

```bash
npm install
npm start
# 默认 http://localhost:3000
```

首次启动会自动创建空的 `accounts.json`,无需手动准备数据文件。打开页面后点击右上角 **「管理账号」**,逐个录入账号即可(支持粘贴浏览器 fetch / cURL 命令自动解析凭证),后端落盘到 `accounts.json`。

## 配置

通过环境变量配置,均有默认值:

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `3000` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址,默认允许局域网访问 |
| `ADMIN_PASSWORD` | `123456` | 管理密码(账号增删改、Key 复制/创建/删除需校验) |

示例:

```bash
PORT=4000 ADMIN_PASSWORD=my-secret npm start
```

> 浏览器验证通过后,密码保存在本地 `localStorage`,仅在当前浏览器生效。

## 账号类型与凭证

在面板右上角「管理账号」中添加,支持粘贴 fetch / cURL 命令自动解析。

| 平台 | 必填凭证 | 抓取方式 |
|------|----------|----------|
| 智谱 GLM | `authorization`(JWT)、`organization`、`project` | bigmodel.cn 任意请求头中的 `authorization` / `bigmodel-organization` / `bigmodel-project` |
| YesCode | `cookie` | co.yes.vg 请求中的完整 `Cookie` |
| 火狸 | `authorization`(Bearer)、可选 `huoli_email` + `huoli_password` | huolilink.com 请求头中的 `Authorization`;填了邮箱密码时 token 过期会自动重新登录 |

## 后端 API

`api.js` 以 `/api` 为前缀暴露以下接口(供前端 `index.html` 调用):

| 方法 | 路径 | 鉴权 | 说明 |
|------|------|------|------|
| POST | `/api/auth` | - | 校验管理密码 |
| GET  | `/api/usage` | - | 全部账号用量(5 分钟缓存,`?force=1` 强刷) |
| GET  | `/api/usage/:index` | - | 单账号用量 |
| GET  | `/api/keys/:index` | - | 智谱账号 API Key 列表 |
| GET  | `/api/keys/:index/copy/:apiKey` | ✅ | 复制 Key 明文 |
| POST | `/api/keys/:index` | ✅ | 创建 Key |
| DELETE | `/api/keys/:index/:apiKey` | ✅ | 删除 Key |
| GET  | `/api/accounts` | ✅ | 账号列表 |
| POST / PUT / DELETE | `/api/accounts[/:index]` | ✅ | 账号增改删 / 整体排序 |
| GET  | `/api/model-usage/:index?period=today\|7d\|30d` | - | 智谱用量曲线 |
| GET  | `/api/expire[/:index]` | - | 订阅到期时间(24 小时缓存) |

鉴权接口通过请求头 `X-Auth-Password` 传递管理密码。

## 前端功能

- 卡片视图:各账号额度进度、紧张度(实际用量 vs 理论进度)、重置时间、订阅到期倒计时
- 站点筛选(全部 / 智谱 / YesCode / 火狸)+ 紧张度排序
- 详情弹窗:负责人信息、余额、消费周期、API Key 表格、用量曲线(echarts)
- 深色模式(从按钮处径向扩散动画)+ 隐私模式(隐藏账号名)
- 账号管理:拖拽排序、粘贴 fetch/cURL 快速导入

## 注意事项

- `accounts.json` 含明文凭证,切勿提交到公开仓库(已加入 `.gitignore`);删除后重新启动会自动重建空文件。
- 所有对 bigmodel.cn / co.yes.vg / huolilink.com 的请求由服务端代理转发,浏览器不直接持有凭证。
- 凭证(JWT / Cookie / Token)会过期,失败时面板显示「请求失败」;智谱需重新抓 token,YesCode 需重抓 Cookie,火狸若配了邮箱密码会自动续登。

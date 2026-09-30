# 开发指南

## 项目结构

```
glm-usage/
├── src/                        # 后端源码(按域拆分)
│   ├── server.js               # Express 入口:静态托管 + 挂载 api 中间件
│   ├── config.js               # 配置中心:加载 .env 并导出不可变配置
│   ├── weights.js              # 权重评分纯函数(供 /api/weights 与中转站)
│   ├── telecomjs.js            # 智云抓取(Chromium 执行瑞数挑战)
│   ├── minimax-proxy.js        # MiniMax 反向代理(env gating)
│   ├── lib/                    # 无业务依赖的基础件
│   │   ├── http.js             #   HTTP 助手(超时/JSON/非 2xx 抛错)
│   │   ├── crypto.js           #   凭证加解密(AES-256-GCM)
│   │   └── util.js             #   通用小工具(补零等)
│   └── api/
│       ├── index.js            # 中间件组装:按域注册路由 + 单测导出
│       ├── accounts.js         # accounts.json 读写(凭证自动加解密)
│       ├── auth.js             # 管理密码防爆破 + 鉴权中间件
│       ├── cache.js            # 用量缓存(5min TTL/落盘/防抖写/去重抓取)
│       ├── platforms/          # 各平台适配器(新增平台在此登记)
│       │   ├── index.js        #   平台分派 fetchAccountUsage / fetchAccountExpire
│       │   ├── glm.js          #   智谱(bigmodel.cn)
│       │   ├── yescode.js      #   YesCode(co.yes.vg)
│       │   ├── sub2api.js      #   Sub2API 中转站(任意部署站点)
│       │   ├── volc.js         #   火山(AgentPlan / CodingPlan)
│       │   ├── qwen.js         #   千问(platform.qianwenai.com)
│       │   ├── minimax.js      #   MiniMax(platform.minimaxi.com)
│       │   ├── stepfun.js      #   阶跃星辰(platform.stepfun.com)
│       │   └── telecom.js      #   智云(token.telecomjs.com)
│       └── routes/             # HTTP 路由(按域拆分)
│           ├── auth.js         #   登录(防爆破)
│           ├── features.js     #   功能开关
│           ├── usage.js        #   用量查询(秒回 + 后台补齐)
│           ├── credentials.js  #   凭证导出(env gating)
│           ├── weights.js      #   权重接口 + 权重配置
│           ├── relay.js        #   中转站容量/实时面板快照代理
│           ├── keys.js         #   智谱 Keys / IP 白名单 / 风控 / 重置卡
│           ├── telecom-login.js#   智云扫码登录
│           ├── console-url.js  #   控制台免登录直达(智谱/MiniMax)
│           ├── accounts.js     #   账号管理 CRUD
│           ├── model-usage.js  #   用量曲线
│           └── expire.js       #   订阅到期
├── tempermonkey/main.js        # 控制台免登录油猴脚本(智谱/MiniMax)
├── accounts.json               # 账号凭证(运行时自动生成,敏感,.gitignore 已忽略)
├── .env.example                # 环境变量模板(复制为 .env 后生效,.gitignore 已忽略)
├── Dockerfile                  # 容器镜像构建(node:22-alpine)
├── docker-compose.yml          # 一键编排(.env 注入 + ./data 数据持久化)
├── package.json
├── test/                       # 单元测试(node --test,本地跑,不入库)
├── docs/                       # 文档
│   ├── assets/                 #   各平台 logo
│   └── *.md                    #   配置 / 部署 / 平台 / API / 中转站集成
└── public/
    ├── index.html              # 前端监控面板(结构 + 样式)
    ├── js/                     # 前端脚本(按职责拆分)
    └── js/echart/echarts.min.js# 用量曲线依赖(本地,可离线)
```

## 新增平台

平台适配器集中在 `src/api/platforms/`,新增平台只需:

1. 在 `src/api/platforms/` 新建 `<platform>.js`,导出 `fetchXxxUsage(account, index)`(可选 `fetchXxxModelUsage` 用量曲线);
2. 在 `src/api/platforms/index.js` 的 `fetchAccountUsage` 分派中登记;
3. 前端卡片渲染与站点筛选在 `public/js/` 对应位置补充平台标识。

适配器约定:输入为 `accounts.json` 中的一条账号记录(凭证字段已自动解密),输出统一卡片数据结构;凭据失效时抛错,由缓存层与前端展示「请求失败」。非 glm 平台的到期信息由各自接口自带、前端直接渲染,无需实现 `fetchAccountExpire`。

## 技术栈与约定

- Node.js ≥ 22.12 + Express,前端为原生 HTML/JS + ECharts(本地内置,可离线);
- 唯一运行时依赖数据文件为 `accounts.json`(凭证 AES-256-GCM 加密落盘,密钥见 [configuration.md](configuration.md));
- 单元测试用内置 `node --test`,放在 `test/` 目录(不入库),`npm test` 运行。

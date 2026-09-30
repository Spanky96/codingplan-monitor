# 后端 API

`src/api/` 以 `/api` 为前缀暴露以下接口(供前端 `index.html` 调用)。鉴权接口通过请求头 `X-Auth-Password` 传递管理密码。

## 接口一览

| 方法 | 路径 | 鉴权 | 说明 |
|------|------|------|------|
| POST | `/api/auth` | - | 校验管理密码 |
| GET  | `/api/features` | - | 功能开关上报(`relayEnabled` / `modelsGatewayUrl` / `privacyForced`),前端据此决定可选集成功能是否渲染与隐私强制态;响应随请求方(内外网/是否管理员)变化,已禁缓存 |
| GET  | `/api/usage` | - | 全部账号用量(秒回:新鲜缓存直接返回,缺失/强刷时先返回旧数据或 loading 骨架并后台抓取;前端再按卡补齐);隐私强制态下账号名为别名,不含负责人/电话/备注与平台身份字段 |
| GET  | `/api/usage/:index` | - | 单账号用量(可 join 列表触发的进行中抓取);隐私强制态同上脱敏 |
| GET  | `/api/keys/:index` | ✅ | 智谱账号 API Key 列表 |
| GET  | `/api/keys/:index/copy/:apiKey` | ✅ | 复制 Key 明文 |
| POST | `/api/keys/:index` | ✅ | 创建 Key |
| DELETE | `/api/keys/:index/:apiKey` | ✅ | 删除 Key |
| GET / POST / DELETE | `/api/ip-whitelist/:index[...]` | ✅ | 智谱 IP 白名单查看 / 添加(支持 IPv4 与 CIDR)/ 删除 |
| GET  | `/api/risk/:index` | - | 智谱风控/异常提示(仅个人版;每次打开详情刷新,结果持久化并同步用量缓存) |
| GET  | `/api/reset-cards/:index` | ✅ | 智谱重置卡列表(仅个人版 Coding Plan) |
| POST | `/api/reset-cards/:index/use` | ✅ | 使用一张重置卡(用前以官方最新列表校验有效性) |
| GET  | `/api/customer-id/:index` | ✅ | 智谱订阅 customerId(仅管理员,详情页展示+复制) |
| GET  | `/api/accounts` | ✅ | 账号列表 |
| POST / PUT / DELETE | `/api/accounts[/:index]` | ✅ | 账号增改删 / 整体排序 |
| GET  | `/api/model-usage/:index?period=today\|7d\|30d` | - | 用量曲线(智谱当日/7/30 天;千问、MiniMax、阶跃与 ZenMux 7/30 天,阶跃纵轴为积分,ZenMux 按模型明细) |
| GET  | `/api/expire[/:index]` | - | 订阅到期时间(24 小时缓存) |
| GET  | `/api/weights` | 可选密码 | 公开账号 token 分配权重(0~10,纯读缓存) |
| GET  | `/api/console-url/:index` | ✅ | 控制台免登录直达地址(智谱/MiniMax,配合油猴脚本) |
| GET  | `/api/relay/activity` | ✅ | 中转站实时调度快照(占用/排队 + 近跑模型,代理中转站 `/api/user-activity-snapshot`,10s 缓存);`SUB2API_BASE_URL` 未配置时返回 404 |
| GET  | `/api/relay/usage` | ✅ | 中转站今日用量榜单(站内 + 外部资源合并、按模型明细,代理 `/api/user-usage-snapshot`,4 分钟缓存,`force=1` 旁路);`SUB2API_BASE_URL` 未配置时返回 404 |
| GET  | `/api/credentials` | ✅ | 凭证导出(按平台返回 `{账号名: 凭证}`,供中转站外部渠道同步登录态);**默认关闭**,`.env` 配置 `CREDENTIALS_EXPORT=1` 后才注册 |

## 权重接口(`/api/weights`)

为中转站提供 token 分配权重:返回 `{ "账号名": 权重, ... }`,**权重 0~10**,越高越宽裕、可多分配 token,0 = 已耗尽。

**缓存依赖(关键)**:接口纯读内存缓存评分,**绝不会因调用而向 bigmodel.cn 刷新**。缓存由「打开监控面板 → `/api/usage`」填充,5 分钟 TTL。

**默认权重兜底**:token 失效 / 无缓存时,该账号按其「默认权重」配置返回(而非跳过)。默认权重初值 1,可逐账号配置。

**密码分层**:
- 不带密码:`GET /api/weights` → 公开账号(`isPublic !== false`,未明确设为私有即默认公开)
- 带正确密码:`GET /api/weights?password=<ADMIN_PASSWORD>` → 全部账号
- 明细:`GET /api/weights?password=<PWD>&detail=1` → `{ weights, detail:[...], generatedAt, cacheTtlMs }`(需密码);智云明细额外包含 `remainingDays`、`averageDaily`、`capacityScore`、`codingPressure`、`timeMultiplier`、`peak`

**隐私模式下的脱敏**:`PRIVACY_MODE` 为 `full`,或 `split` 且请求来自外网(Host 命中 `PRIVACY_EXTERNAL_HOSTS` / 客户端 IP 为公网)时,不带密码请求返回的 key 为「站点名+序号」别名(与 `/api/usage` 的别名一致);带 `password` 即视为管理员,返回真实账号名——因此 `full` 档下中转站轮询本接口必须配置 password,否则无法按账号名匹配。

### 计算流程

1. **CodingPlan base(0~6)**:各平台按 5 小时、周、月等有效窗口的实际消耗速度与理论进度评分,取最紧张窗口;任一有效窗口耗尽则为 0
2. **余额兜底(YesCode / Sub2API)**:订阅额度耗尽但账号仍有可用余额(按量付费/推荐积分)时不整账号清零——耗尽窗口降为 1 分,并按余额量级(`≥$100/50/20/10/5` → `6/5/4/3/2`,其余 1)附加「余额」窗口;Sub2API 已过期的订阅不再作为约束,纯按余额打分。无余额且耗尽仍为 0
3. **智云 base**:`(账户余额 + 赠金) ÷ 近7日有消费日期的日均消费` 得到预计可用天数,按 `<7 / <14 / <30 / <60 / <90 / ≥90 天` 映射为容量分 `1~6`;再乘 CodingPlan 压力系数 `1 + (6 - CodingPlan平均基础分) / 6`,最后按中国时间 `14:00~18:00` 乘 `2`,其他时段乘 `0.5`。余额为 0 时恒为 0;有余额但暂无历史消费时容量分为 6
4. **策略**(在 base 上叠加,默认 B 倍率 ×1)
5. **兜底**:base 为 null 时直接用默认权重
6. **钳制**:最终结果统一 `clamp [0, 10]` 并保留 1 位小数

### 权重策略

每账号可配(管理员):

| 策略 | 含义 | 计算(base 已知时) |
|------|------|------|
| A 固定值 | 直接返回设定值 | `value` |
| B 倍率(默认 ×1) | 按倍率缩放 | `base × value` |
| C 最高值 | 上限钳制 | `min(base, value)` |
| D 固定加减 | 增减 | `base + value` |

### 配置接口

管理员(请求头 `X-Auth-Password`):
- `GET /api/weights/config` → `[{index, name, platform, config:{defaultWeight,strategy,value}, base, final}]`
- `PUT /api/weights/config/:index`,body `{defaultWeight?, strategy?, value?}`(任选提供)→ 写入该账号 `weightConfig`(存 `accounts.json`,编辑账号时自动保留)

### 前端展示

管理员登录后,每张卡片左上角显示 `W {最终权重}` 徽标(配色:0 红 / 1-3 橙 / 4-7 蓝 / 8-10 绿),点击弹出权重配置(默认权重 + 策略 + 策略值 + 实时预览),保存后徽标即时刷新;非管理员不显示。

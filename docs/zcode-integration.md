# ZCode Coding Plan 接入

个人智谱 Coding Plan 账号可以通过 ZCode 渠道转发模型请求。

## 链路

1. 原有 lwsub2api Anthropic / API Key 账号保存原 Key、分组、模型映射。
2. 在该账号编辑页开启“跟随 glm-usage 的 ZCode 配置”。
3. 每次模型请求前，中转站调用 glm-usage 的 `/api/zcode/authorize`，只发送账号名称、原 Key 的公开 ID、目标 URL、会话 ID，不发送提示词。
4. glm-usage 按名称匹配账号。中央开关关闭时明确返回 `enabled:false`，中转站使用原 Key。
5. 开启时，glm-usage 核对原 Key 所属账号，使用已有 `zcode-api-key` 的 ID 换取短期 Project Access Token，并向智谱申请签名材料。
6. glm-usage 为本次请求生成 Ed25519 签名与工作量证明，中转站替换鉴权头，仍向 `https://open.bigmodel.cn/api/anthropic/v1/messages` 转发。

只替换长期 `zcode-api-key` 不等同于完成此链路。`angusdevgo/ZCode2api` 的 Start / 活动渠道也不是这里使用的付费 Coding Plan 渠道。

## 配置

两端设置相同的随机 `ZCODE_BRIDGE_TOKEN`，不要复用管理密码或将其提交 Git。

glm-usage 的 `.env`：

```dotenv
ZCODE_BRIDGE_TOKEN=<随机共享密钥>
ZCODE_CLIENT_VERSION=3.18.2
```

lwsub2api 的 `deploy/.env`：

```dotenv
ZCODE_BRIDGE_URL=http://192.168.0.20:8886/api/zcode/authorize
ZCODE_BRIDGE_TOKEN=<相同随机共享密钥>
```

应用配置后重建或重启相应容器。共享密钥只用于服务之间的鉴权，管理界面不能读取。跨不可信网络时使用 HTTPS。

glm-usage 管理账号中的“启用 ZCode Coding Plan 接入”是中央开关。默认通过账号名称精确匹配；可填写“对应中转站账号名称”作为别名。中转站也可填写匹配名称，须与中央名称/别名一致。名称重复、原 Key 不属于该账号、目标地址不是官方 Anthropic 地址均拒绝签发。当前仅支持个人 Coding Plan。

2026-11-23，公司中转站的智谱账号已切回普通 API Key 接入，同时关闭了监控端的 ZCode 开关与中转站账号的跟随开关。以后如需为某个账号重新接入 ZCode，在两端为该账号开启对应开关即可。

中央开关开启时，卡片和列表中的智谱标识显示渐变与趋势图标，提示“智谱账号已启用 ZCode 接入”。前端通过 `zcodeEnabled` 读取开关状态。

“检查 ZCode 连接”会刷新短期凭证并检查签名，但不调用模型。没有 `zcode-api-key` 时，先用该账号登录官方 ZCode，再重试。检测不会创建或删除 API Key。

## 生命周期与故障

- PAT 与私钥只保存在 glm-usage 内存，提前 120–180 秒刷新；并发请求共享换证过程，每个转发尝试独立生成签名。
- PAT 不写入数据库、账号文件、浏览器或日志。中转站仅在本次请求内使用它。
- 中央开关明确关闭才会使用原 Key；开启但换证/签名失败则返回错误，避免将原渠道误记成 ZCode 成功。
- 若上游提前撤销了尚未到期的 PAT，可在 glm-usage 点击凭证检测强制刷新。当前不自动重放被上游拒绝的模型请求。
- glm-usage 的可用性成为所有开启“跟随”账号的转发依赖，包括中央关闭 ZCode 的账号：中转站仍须请求中央配置后才能决定使用原 Key。停用中转站账号的跟随开关可解除该依赖；glm-usage 故障时仅修改中央开关无法恢复转发。
- 原有 `count_tokens` 计数请求仍沿用原凭证；ZCode 切换针对模型生成请求与账号测试入口。

## 验证与回退

先选择 1–2 个有额度的账号，记录切换前官方用量，然后检查：

1. 管理员 `GET /api/zcode/status/:index` 的 `signedRequests` 增长；这是签发次数，不是模型成功次数。
2. 中转站日志出现 `[ZCode] signed account=...`，账号测试/真实转发成功，原分组与模型映射保持不变。
3. 在官方用量或积分明细中核对实际消耗。V2 账号可查看整数百分比，V3 账号可查看积分明细。

鉴权接口的 `benefitVerified` 固定为 `false`。实际计费以智谱的用量记录为准。

在项目根目录运行 `node scripts/zcode-pilot-report.js` 可输出当前已启用账号的脱敏 JSON 报告，包含签发状态、官方用量、小时明细及每百万输出 Token 的积分。Docker 部署也可执行 `docker exec -i -w /app codingplan-monitor node < scripts/zcode-pilot-report.js`。脚本只读，不生成模型请求、不修改账号、不使用重置卡。对照时须排除混合切换前后的小时、官方聚合延迟，以及模型/时段倍率差异。

日常回退：关闭 glm-usage 中央开关，下一次请求恢复原 Key。若 glm-usage 无法访问，关闭中转站账号的跟随开关。完整部署回退使用部署前保存的 Docker 镜像、环境配置和两个账号的配置快照，勿覆盖其他账号期间产生的新数据。

## 协议参考与验证

- [ZCode2api](https://github.com/angusdevgo/ZCode2api)：对比 Start 渠道，未用于本项目的付费链路。
- [公开签名协议参考](https://github.com/TriDefender/zcode-api/blob/master/src/proxy/client-signing.ts)：仅用于理解线上的字段与密码学协议；本项目使用 Node 内置 crypto 独立实现，无第三方运行依赖。

自动测试通过模拟智谱接口独立验证 HMAC、AES-GCM、Ed25519、POW、并发换证、到期刷新、账号变更、Key 归属、鉴权隔离、脱敏与故障关闭。中转站测试覆盖常规及透传两条 Anthropic 请求构造链路。

### 2026-11-17 工具调用与风险补充

两条渠道最终仍请求同一个官方 Anthropic messages 地址；ZCode 桥接只调整鉴权头，不新增消息格式转换。中转原有的消息清理规则继续生效，不代表智谱完整实现了 Anthropic 的所有原生工具和 beta 功能。

新增 Go 回归覆盖两种请求构造路径中的工具定义、并行 tool_use、tool_result（含错误结果和 Unicode）保持不变，以及完整 Forward 路径中流式 tool_use / input_json_delta / stop_reason 原样转发；相关测试通过。

另于 11:38 用同一已订阅账号做 GLM-5.3、GLM-5.3-Flash × 原渠道、ZCode 渠道的四组真实上游对照：每组先流式生成 add_numbers 工具调用，再回传结果并取得最终回答。8 次 HTTP 请求均为 200，四组工具参数和结果回传均成功。此处是很小的合成兼容性测试，单独保存于 evidence/20261117-zcode-tool-roundtrip.json。完整网关流式路径由 Go 测试覆盖；该小样本不等于全部客户端、全部工具类型或长时间运行均已验证。

尚存边界：官方客户端鉴权协议或活动规则可能改变；PAT 提前撤销后需手动刷新；真实运行尚未覆盖完整五小时凭证生命周期及更高并发。当前具备提前刷新和并发合并的自动化测试，不能替代持续线上观察。

### 详情页检查 ZCode 活动重置卡

管理员打开个人智谱账号详情，或点击重置卡区块的“刷新”，调用 `POST /api/reset-cards/:index/refresh`。这项操作独立于模型的 ZCode 开关，不要求额外填写凭证，也不消耗模型 Token。

模型 Project Access Token 不能用于重置卡接口。服务端使用已保存的智谱登录态，通过官方 `GET /api/auth/getAuthCode?appId=zcode` 和 `POST https://zcode.z.ai/api/v1/oauth/token` 获取同一账号的 ZCode 登录 JWT 与 BigModel 业务登录 JWT，仅在内存保留。随后查询 `/api/v1/coding-plan/reset/status`，在官方允许的间隔内调用 `/opportunity` 检查领取资格，确认发卡后再查询 status。查询本身不被当成领取成功；是否发卡由官方响应决定。

最终卡片清单仍读取 BigModel 的 `customer-package-reset/list`：它带有原有用卡流程所需的 recordId/grantType，ZCode status 只有到期时间，不能编造 ID 或简单相加两套列表。ZCode 请求失败时继续更新智谱清单；智谱清单请求失败时保留原有卡片，显示更新失败。若 ZCode 卡数多于智谱清单，则提示稍后刷新同步。

同账号并发请求合并；服务端 next_try_at 至少遵守五分钟间隔，成功或限流后至少十分钟再检查。超时重试复用原幂等键。重试时间与幂等键保存在账号文件同目录的 `zcode-reset-state.json`（0600，原子写入），重启后仍生效；该文件没有登录凭证。查卡失败也有退避，防止频繁打开详情反复登录。最近五分钟刚用过卡时延后资格检查。

此流程不调用重置核销 `/use`，不增加后台定时领取任务。现有手动用卡及用户已配置的自动调度用卡规则继续生效。原 GET `/api/reset-cards/:index` 仍只查询智谱清单；调度器查卡也不触发活动领取。

2026-11-17 12:52 首次真实接口验收：glm13 原有两张周卡，ZCode 查询成功，资格检查返回当前无新卡，最终仍两张；重复刷新和服务发布后的首次刷新均遵守已保存的下一次检查时间。管理员页面的自动检查及手动刷新已验证。完整 324 项测试通过，包含新发卡流程、并发、重启退避、超时幂等、账号切换、失败保留库存和接口鉴权。

# 平台接入与凭证

在面板右上角「管理账号」中添加账号,支持粘贴浏览器 fetch / cURL 命令**自动解析凭证**。各平台所需凭证与抓取方式如下。

## 各平台凭证

| 平台 | 必填凭证 | 抓取方式 |
|------|----------|----------|
| 智谱 GLM | `authorization`(JWT)、`organization`、`project`;可选 `glm_username` + `glm_password` | bigmodel.cn 任意请求头中的 `authorization` / `bigmodel-organization` / `bigmodel-project`;填了账号密码时 token 过期(401/403/405)会自动重新登录并回写 JWT |
| YesCode | `cookie` 与 `yescode_username` + `yescode_password` 至少一项(推荐账密) | co.yes.vg 请求中的完整 `Cookie`,或登录接口(auth/login)的 fetch(自动解析账密)。官方 Cookie 有效期仅 24h,配了账密后失效自动重登并回写,无需再手动抓 Cookie |
| Sub2API 中转站 | `base_url`;`authorization` 与 `sub2api_email` + `sub2api_password` 至少一项(推荐账密);可选 `alias` 站点别名 | 任意 sub2api 部署站点(如 super-nb.me / ai98pro.xyz)。粘贴登录接口或控制台请求的 fetch/cURL,自动识别站点并解析账密。并行抓取 `auth/me`(余额)、`subscriptions`(订阅)、`usage/dashboard/stats`(今日/累计 Token 与费用);卡片以余额 + 今日用量为主,过期超 3 天的订阅自动隐藏。token 24h 失效自动重登。旧火狸账号自动兼容(回退 huolilink.com 与 `huoli_*` 字段) |
| 火山(AgentPlan=火山A / CodingPlan=火山C) | `cookie`、`csrf`、可选 `web_id`、`planType` | console.volcengine.com 请求(用 cURL 复制带出完整 Cookie);添加账号时选套餐类型:AgentPlan 抓 `GetAgentPlanAFPUsage`,CodingPlan 抓 `GetCodingPlanUsage`。两者同一登录会话,Cookie/CSRF 共用 |
| 智云 | `satoken`、`phone` | 可手动填写 token.telecomjs.com 请求头中的 `Satoken`;认证失效时卡片会提供重新登录入口,用户核对账号登记手机号后使用官方二维码扫码登录,成功后自动回写。扫码页会自动勾选「一周内自动登录」(若未勾选)。后端通过 Chrome 执行页面及瑞数脚本并查询余额 |
| MiniMax | `cookie`、可选 `group_id` | platform.minimaxi.com 任意请求的完整 Cookie(含 `_token` 登录态);`group_id` 取请求头 `x-group-id`,留空时自动取 Cookie 中的 `minimax_group_id_v2`。套餐名称与到期时间从官方订阅接口解析,消息盒子权益通知兜底;5h 限额 / 周限额(均百分比)与视频赠送 / 视频周赠(均计数)从 `remains_percent` 接口解析 |
| 阶跃星辰 | `cookie`、可选 `stepfun_webid` | platform.stepfun.com 任意请求的完整 Cookie(建议 Copy as cURL,须含 `Oasis-Token` 双段 JWT 与 `_wafdytokenv1`);`webid` 取请求头 `oasis-webid`,留空时自动取 Cookie 中的 `Oasis-Webid`。抓 Connect RPC 接口:`GetStepPlanStatus`(套餐)、`QueryStepPlanRateLimit`(月度积分限额)、`QueryStepPlanUsages`(今日/曲线用量)、`QueryAccountBalance`(按量余额)、`GetCampaignInviteLink`+`ListCampaignInvites`+`GetCampaignStatus`(邀请活动:详情页展示邀请码/链接复制、邀请进度、邀请记录与奖励账本,已邀满时复制会提醒名额已用完)。access 段仅 30 分钟,过期自动用 refresh 段(~30 天,不轮换)续期并回写 Cookie 中的 `Oasis-Token` 段 |

## 控制台免登录直达(管理员)

管理员打开账号详情时,「控制台」链接经服务端 `/api/console-url` 实时生成带凭据的地址(目前支持智谱、MiniMax);配合 `tempermonkey/main.js` 油猴脚本,在目标页面加载前把凭据写入官方登录 Cookie,并抹掉地址栏凭据参数,实现一键免登录进官方控制台。

- 智谱:`https://bigmodel.cn/coding-plan?token=<urlencode(authorization)>`
- MiniMax:`https://platform.minimax.cn/console/plan?ck=<base64url(整串 cookie)>`(console 已迁移 minimax.cn,存储的 minimaxi.com 会话实测跨域通用)

无凭据参数时脚本不做任何操作,正常浏览不受影响。使用方式:在 Tampermonkey 中安装 `tempermonkey/main.js` 即可。

## 智云扫码登录

智云按量账号会出现在权重接口和权重配置中。扫码登录是内存中的临时会话,5 分钟后自动过期;创建会话前必须输入与账号 `phone` 字段一致的手机号。二维码由智云官方页面提供,本项目只保存最终返回的 `satoken`。

## 凭证过期与自动续期

凭证(JWT / Cookie / Token)会过期,失败时面板显示「请求失败」。各平台的处理方式:

| 平台 | 失效表现 | 自动处理 |
|------|----------|----------|
| 智谱 GLM | JWT 过期 | 配了 `glm_username`/`glm_password` 时 401/403/405 自动重登并回写 JWT;否则需重新抓 token |
| YesCode | 官方 Cookie 有效期仅 24h | 配了账密自动重登续期 |
| Sub2API | token 24h 失效 | 配了账密自动续登 |
| 火山 | Cookie/CSRF 过期 | 需重抓 Cookie/CSRF |
| 智云 | 认证失效 | 卡片提供重新登录入口,核对手机号后扫码,自动更新 Satoken(后端尽量勾选天翼「一周内自动登录」) |
| MiniMax | Cookie 过期 | 需重抓 Cookie |
| 阶跃星辰 | access 段仅 30 分钟 | 后端自动用 refresh 段(~30 天,不轮换)续期并回写(建议整段 Copy as cURL 保留 `_wafdytokenv1` 等 WAF 段);refresh 段过期后需重抄完整 Cookie |

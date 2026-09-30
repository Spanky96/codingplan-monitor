# 中转站集成(sub2api,可选)

监控面板的核心功能是各平台 Coding Plan 的用量监控,与 sub2api 中转站相关的能力均为**可选集成**——不配置任何环境变量时,这些功能不渲染、不轮询、路由不注册,面板只做纯监控。

## 功能总览

| 功能 | 开关 | 说明 |
|------|------|------|
| Sub2API 账号监控 | 无需配置(按账号添加) | 中转站本身作为一种「平台账号」接入,卡片以余额 + 今日用量为主,详见 [platforms.md](platforms.md) |
| 容量胶囊 + 实时面板 | `SUB2API_BASE_URL` | 管理员右侧常驻栏:实时调度(每个在跑调度一个色块,按实际调用模型分配颜色,15s 轮询)+ 今日 Token 排行(默认前 5,可展开;进度条按模型多色堆叠;站内 + 外部资源合并成完整榜单,5 分钟刷新,↻ 手动刷新) |
| 权重输出 | 无需配置 | `/api/weights` 向中转站提供 token 分配权重,详见 [api.md](api.md) |
| 凭证同步 | `CREDENTIALS_EXPORT=1` | `/api/credentials` 按平台返回 `{账号名: 凭证}`,供中转站外部渠道同步登录态;**默认关闭** |
| 模型调用页 | `MODELS_GATEWAY_URL` | `models.html` 网关地址(OpenAI 兼容入口,含 `/v1`)由服务端注入(只读);未配置时页面禁用并提示 |

## 中转站实时面板(管理员)

- **实时调度**:每个在跑调度一个色块,颜色按**实际调用模型**分配——`glm-5.3` 直连与 `glm-5.3 → glm-5.3-flash` 转发为两种颜色,悬浮显示映射,下方图例;15s 轮询,代理中转站 `/api/user-activity-snapshot`(10s 缓存)。
- **今日 Token 排行**:默认前 5,点「更多」展开全部;进度条按模型**多色堆叠**;站内 + `/admin/external-resources` 外部资源用量合并成完整榜单,外部部分带「外 N」徽标;5 分钟刷新一次,标题行 ↻ 手动刷新;代理 `/api/user-usage-snapshot`(4 分钟缓存,`force=1` 旁路)。
- **模型颜色按模型名固定分配**(哈希定槽 + 本地持久化,不随在线模型集合变化而漂移;亮/暗主题各一套已校验色阶)。
- 可折叠(状态记忆,折叠时卡片区占满),隐私模式下遮蔽用户名,窄屏自动堆叠到卡片下方;拉取失败保留最近数据并标红时间戳。
- 门禁:`RELAY_SNAPSHOT_TOKEN` 与中转站 `ACTIVITY_SNAPSHOT_TOKEN` 一致;留空表示中转站未开启门禁。
- 依赖中转站具备 weight-snapshot / user-activity-snapshot / user-usage-snapshot 快照端点(lwsub2api 分支提供)。

## 对接要点

- 中转站轮询 `/api/weights` 获取权重:不带密码拿公开账号,带 `?password=<ADMIN_PASSWORD>` 拿全部;`PRIVACY_MODE=full` 时**必须带 password** 才能拿到真实账号名(否则返回别名,无法匹配)。
- `/api/weights` 纯读缓存、绝不因调用触发上游刷新;缓存由面板 `/api/usage` 填充(5 分钟 TTL),因此中转站侧建议与监控面板部署在同一实例,或定期访问面板保持缓存温热。
- `/api/credentials` 与 `/api/relay/*` 均需管理密码(请求头 `X-Auth-Password`);带错误密码会计入防爆破(同一 IP 连续输错 3 次封禁 15 分钟),不带密码的轮询不受影响。

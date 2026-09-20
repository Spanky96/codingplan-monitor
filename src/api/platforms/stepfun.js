// ============ 阶跃星辰 StepFun 账号（platform.stepfun.com，Step 套餐）============
var { setCache } = require('../cache');
var { readAccounts, writeAccounts } = require('../accounts');
var { pad2 } = require('../../lib/util');

// stepfunRaw 就地定义(Connect 协议:需要响应状态码/响应头,与通用 http 助手形态不同)
var https = require('https');

// ============ 阶跃星辰 StepFun 账号（platform.stepfun.com，Step 套餐）============

// Connect RPC 协议：全部 POST JSON；请求字段 camelCase，响应 snake_case 且 int64 为字符串。
// 鉴权：Cookie Oasis-Token = "<accessJWT>...<refreshJWT>"（两段 JWT 用字面 ... 拼接），
// access 段仅 30 分钟有效；过期后调 PassportService/RefreshToken 用 refresh 段（约 30 天，
// 续期不轮换）换新，并只回写 Cookie 中的 Oasis-Token 段（保留 _wafdytokenv1 等 WAF 段）。

// webid 优先取账号字段；未填时从 Cookie 的 Oasis-Webid 兜底解析（同 minimaxGroupId 手法）
function stepfunWebid(account) {
    if (account.stepfun_webid) return String(account.stepfun_webid);
    var m = String(account.cookie || '').match(/Oasis-Webid=([^;\s]+)/);
    return m ? m[1] : '';
}

function stepfunHeaders(account) {
    return {
        'accept': '*/*',
        'content-type': 'application/json',
        'connect-protocol-version': '1',
        'cookie': account.cookie || '',
        'oasis-appid': '10300',
        'oasis-platform': 'web',
        'oasis-webid': stepfunWebid(account),
        'origin': 'https://platform.stepfun.com',
        'referer': 'https://platform.stepfun.com/',
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36'
    };
}

// 原始 Connect 请求：resolve {statusCode, json, text, headers}，非 2xx 也 resolve 由调用方分类。
// 不复用 httpsRequest：401 的 JSON 错误体是 token 刷新判断依据，
// RefreshToken 的 oasis-token 响应头是回写 Cookie 来源，两者都要求非 2xx / 响应头可见。
function stepfunRaw(path, headers, bodyObj) {
    return new Promise(function(resolve, reject) {
        var m = ('https://platform.stepfun.com' + path).match(/^https:\/\/([^\/]+)(\/.*)$/);
        if (!m) return reject(new Error('Invalid URL'));
        var bodyStr = bodyObj == null ? '{}' : JSON.stringify(bodyObj);
        var opts = {
            hostname: m[1], path: m[2], method: 'POST',
            headers: Object.assign({}, headers, {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(bodyStr)
            })
        };
        var req = https.request(opts, function(res) {
            var data = '';
            res.on('data', function(c) { data += c; });
            res.on('end', function() {
                var json = null;
                try { json = data ? JSON.parse(data) : null; } catch (e) { /* 保留 text */ }
                resolve({ statusCode: res.statusCode, json: json, text: data, headers: res.headers });
            });
        });
        req.on('error', reject);
        req.setTimeout(15000, function() { req.destroy(new Error('timeout')); });
        req.write(bodyStr);
        req.end();
    });
}

// 401 错误体分类：'expired'（access 过期，可刷新）/ 'embezzled'（webid 不匹配，配置错误）/ 'unauthenticated'
function stepfunAuthErrorKind(res) {
    if (!res || res.statusCode !== 401 || !res.json) return null;
    var msg = String(res.json.message || '');
    if (msg.indexOf('token is expired') !== -1) return 'expired';
    if (msg.indexOf('embezzled') !== -1) return 'embezzled';
    return 'unauthenticated';
}

// 单次业务调用：2xx 返回 json；400 且空 body 视为 WAF 瞬断重试一次；401 抛带 stepfunKind 的错。
async function stepfunCall(account, path, bodyObj) {
    var res = await stepfunRaw(path, stepfunHeaders(account), bodyObj);
    if (res.statusCode === 400 && !res.text) {
        res = await stepfunRaw(path, stepfunHeaders(account), bodyObj);
    }
    if (res.statusCode >= 200 && res.statusCode < 300 && res.json) return res.json;
    var msg = (res.json && res.json.message) || (res.text || '').slice(0, 200) || ('HTTP ' + res.statusCode);
    var err = new Error('阶跃请求失败: ' + msg);
    var kind = stepfunAuthErrorKind(res);
    if (kind === 'embezzled') err = new Error('阶跃 Cookie 与 webid 不匹配（oasis-token is embezzled），请重新完整复制 Cookie');
    err.stepfunKind = kind;
    throw err;
}

// 只替换 Cookie 串中的 Oasis-Token 段（保留 _wafdytokenv1 / Oasis-Webid 等其余段）；无该段则追加
function stepfunReplaceTokenCookie(cookie, newToken) {
    var s = String(cookie || '').trim();
    if (!s) return 'Oasis-Token=' + newToken;
    if (/(^|;\s*)Oasis-Token=/.test(s)) {
        return s.replace(/(^|;\s*)Oasis-Token=[^;]*/, function(m0, p) { return p + 'Oasis-Token=' + newToken; });
    }
    return s + '; Oasis-Token=' + newToken;
}

function saveStepfunCookie(index, newCookie) {
    try {
        var accounts = readAccounts();
        if (!accounts[index]) return;
        if ((accounts[index].platform || 'glm') !== 'stepfun') return;
        accounts[index].cookie = newCookie;
        writeAccounts(accounts);
    } catch (e) { /* ignore write errors */ }
}

// 用 refresh 段换新 access。新 Oasis-Token 优先取响应头 oasis-token（官方拼好的完整串），
// 兜底用 body 的 accessToken.raw + '...' + refreshToken.raw 自拼；回写文件并更新内存副本。
async function stepfunRefresh(account, index) {
    var res = await stepfunRaw('/passport/proto.api.passport.v1.PassportService/RefreshToken', stepfunHeaders(account), {});
    if (!(res.statusCode >= 200 && res.statusCode < 300) || !res.json) {
        throw new Error('阶跃 token 刷新失败（Cookie 可能已整体失效，需重新抓取完整 Cookie）: '
            + ((res.json && res.json.message) || ('HTTP ' + res.statusCode)));
    }
    var concat = res.headers && res.headers['oasis-token'];
    if (!concat && res.json.accessToken && res.json.refreshToken) {
        concat = res.json.accessToken.raw + '...' + res.json.refreshToken.raw;
    }
    if (!concat) throw new Error('阶跃 token 刷新响应缺少新 token');
    var newCookie = stepfunReplaceTokenCookie(account.cookie || '', concat);
    saveStepfunCookie(index, newCookie);
    // 本进程内后续请求立即用新 Cookie（accounts.json 也可能被其他写覆盖，以内存更新为准）
    account.cookie = newCookie;
    return newCookie;
}

// 同账号并发去重：多个接口同时 401 时合并为一次刷新（refresh 段不轮换，重复刷新无害，只是无谓请求/写盘）
function stepfunRefreshOnce(account, index) {
    if (!account._stepfunRefreshPromise) {
        account._stepfunRefreshPromise = stepfunRefresh(account, index).finally(function() {
            account._stepfunRefreshPromise = null;
        });
    }
    return account._stepfunRefreshPromise;
}

// 401（access 过期）时刷新后重试一次；其余错误原样抛出
async function withStepfunAuthRetry(account, index, requestFn) {
    try {
        return await requestFn(account);
    } catch (authErr) {
        if (!authErr || authErr.stepfunKind !== 'expired') throw authErr;
        await stepfunRefreshOnce(account, index);
        return await requestFn(account);
    }
}

// 阶跃秒级时间串（如 "1792467733"）→ 毫秒；"0"/缺省 → 0
function stepfunSecToMs(v) {
    var n = Number(v) || 0;
    return n > 0 ? n * 1000 : 0;
}

// 北京时间当日零点（毫秒）：+8h 对齐到日再折回，服务器任意时区下结果一致
function stepfunBeijingTodayStart(nowMs) {
    var shifted = nowMs + 8 * 3600000;
    return shifted - (shifted % 86400000) - 8 * 3600000;
}

// 手机号脱敏：保留前 3 后 4；位数不足返回 null（后端脱敏后再出接口）
function stepfunMaskMobile(mobile) {
    var s = String(mobile || '').trim();
    if (!/^\d{7,}$/.test(s)) return null;
    return s.slice(0, 3) + '****' + s.slice(-4);
}

// GetStepPlanStatus → 订阅摘要；无 subscription（未订阅）返回 null。
// activated_at/expired_at 为秒串；到期日期取北京日期（+8h 后取 UTC 日期，与 minimax 到期日同一手法）。
function parseStepfunPlanStatus(json) {
    var sub = json && json.subscription;
    if (!sub) return null;
    var def = (json && json.plan_definition) || {};
    var activatedMs = stepfunSecToMs(sub.activated_at);
    var expireMs = stepfunSecToMs(sub.expired_at);
    var d = expireMs ? new Date(expireMs + 8 * 3600000) : null;
    return {
        planName: sub.name || null,
        status: sub.status,
        statusText: sub.status === 1 ? '生效中' : '状态' + (sub.status != null ? sub.status : '?'),
        autoRenew: !!sub.auto_renew,
        activatedMs: activatedMs || null,
        expireMs: expireMs || null,
        expireDate: d ? d.getUTCFullYear() + '-' + pad2(String(d.getUTCMonth() + 1)) + '-' + pad2(String(d.getUTCDate())) : null,
        priceYuan: def.price != null ? (Number(def.price) || 0) / 100 : null,
        durationDays: def.duration_days || null,
        supportModels: Array.isArray(def.support_models) ? def.support_models.slice() : []
    };
}

// 剩余率（0~1，1=未使用）→ 已用百分比（0~100，保留 1 位小数）；非法输入返回 null
function stepfunLeftRateToPct(rate) {
    if (typeof rate !== 'number' || rate < 0) return null;
    return Math.round((1 - Math.min(1, rate)) * 1000) / 10;
}

// 月度积分窗：剩余率优先，兜底用订阅桶（type=1）的 Σ(total-residual)/Σtotal；
// 重置时间=套餐到期（续费换新周期），周期=激活→到期的真实时长。充值桶（type=2）单列一窗。
function stepfunCreditWindows(json, subscription) {
    var lim = (json && json.plan_credit_rate_limit) || {};
    var buckets = Array.isArray(lim.credit_buckets) ? lim.credit_buckets : [];
    var subBuckets = buckets.filter(function(b) { return Number(b && b.type) === 1; });
    var topupBuckets = buckets.filter(function(b) { return Number(b && b.type) === 2; });
    var resetMs = subscription && subscription.expireMs ? subscription.expireMs : null;
    var periodMs = (subscription && subscription.expireMs && subscription.activatedMs)
        ? Math.max(0, subscription.expireMs - subscription.activatedMs) : null;
    var sum = function(list, fn) {
        return list.reduce(function(a, b) { return a + fn(b); }, 0);
    };
    var pct = stepfunLeftRateToPct(lim.subscription_credit_left_rate);
    if (pct === null && subBuckets.length) {
        var total = sum(subBuckets, function(b) { return Number(b.credit_total) || 0; });
        var used = total - sum(subBuckets, function(b) { return Number(b.credit_residual) || 0; });
        if (total > 0) pct = Math.round((used / total) * 1000) / 10;
    }
    var windows = [];
    if (pct !== null) {
        var win = { label: '月度积分', usedPct: pct, resetMs: resetMs, periodMs: periodMs, segments: 0 };
        var quota = sum(subBuckets, function(b) { return Number(b.credit_total) || 0; });
        if (quota > 0) {
            win.used = quota - sum(subBuckets, function(b) { return Number(b.credit_residual) || 0; });
            win.quota = quota;
        }
        windows.push(win);
    }
    if (topupBuckets.length) {
        var tQuota = sum(topupBuckets, function(b) { return Number(b.credit_total) || 0; });
        var tUsed = tQuota - sum(topupBuckets, function(b) { return Number(b.credit_residual) || 0; });
        var tExpire = stepfunSecToMs(topupBuckets[0].expire_at);
        if (tQuota > 0) {
            windows.push({ label: '充值积分', usedPct: Math.round((tUsed / tQuota) * 1000) / 10, used: tUsed, quota: tQuota, resetMs: tExpire || null, periodMs: null, segments: 0 });
        }
    }
    return windows;
}

// QueryStepPlanRateLimit（+订阅摘要取真实周期）→ windows[]，契约与 MiniMax 一致
// （{label, usedPct 或 used+quota, resetMs, periodMs, segments}）。
// 零值陷阱：credit 制套餐（plan_family=2）的 5h/周字段恒 0 且 reset_time="0"，
// 语义是「无此窗口」而非「0% 剩余」——仅当对应 reset_time 非 "0" 时才生成 5h/周窗。
function parseStepfunRateLimit(json, subscription) {
    if (!json) return [];
    var windows = stepfunCreditWindows(json, subscription);
    var fiveHourReset = Number(json.five_hour_usage_reset_time) || 0;
    if (fiveHourReset > 0) {
        var pct5 = stepfunLeftRateToPct(json.five_hour_usage_left_rate);
        if (pct5 !== null) {
            windows.push({ label: '5h 限额', usedPct: pct5, resetMs: fiveHourReset * 1000, periodMs: 5 * 3600000, segments: 5 });
        }
    }
    var weeklyReset = Number(json.weekly_usage_reset_time) || 0;
    if (weeklyReset > 0) {
        var pct7 = stepfunLeftRateToPct(json.weekly_usage_left_rate);
        if (pct7 !== null) {
            windows.push({ label: '周限额', usedPct: pct7, resetMs: weeklyReset * 1000, periodMs: 7 * 86400000, segments: 7 });
        }
    }
    return windows;
}

// QueryStepPlanUsages → 按模型聚合（credit 降序）：{models:[{modelId,credits,calls}], totalCredits, totalCalls}
function parseStepfunUsages(json) {
    var records = (json && Array.isArray(json.records)) ? json.records : [];
    var map = {}, order = [];
    var totalCredits = 0, totalCalls = 0;
    records.forEach(function(r) {
        if (!r || !r.model_id) return;
        if (!Object.prototype.hasOwnProperty.call(map, r.model_id)) {
            map[r.model_id] = { modelId: r.model_id, credits: 0, calls: 0 };
            order.push(r.model_id);
        }
        map[r.model_id].credits += Number(r.credit_consumed) || 0;
        map[r.model_id].calls += Number(r.calls) || 0;
        totalCredits += Number(r.credit_consumed) || 0;
        totalCalls += Number(r.calls) || 0;
    });
    var models = order.map(function(k) { return map[k]; });
    models.sort(function(a, b) { return b.credits - a.credits; });
    return { models: models, totalCredits: totalCredits, totalCalls: totalCalls };
}

// QueryStepPlanUsages（多日窗口）→ 前端通用图表契约 {x_time, modelDataList, totalUsage}。
// 官方按「UTC 日桶 × 模型」聚合，record.from_time 即桶起点；标签换算北京日期（+8h 取日期）。
// 模型取并集保序、缺失日补 0；tokensUsage 装的是 credit 数值（该平台纵轴单位为积分）。
function parseStepfunModelUsage(json, days) {
    var records = (json && Array.isArray(json.records)) ? json.records : [];
    if (!records.length) return null;
    var byDay = {};
    var seen = {};
    var order = [];
    records.forEach(function(r) {
        if (!r || !r.model_id) return;
        var fromMs = Number(r.from_time) || 0;
        if (!fromMs) return;
        var d = new Date(fromMs + 8 * 3600000);
        var key = d.getUTCFullYear() + '-' + pad2(String(d.getUTCMonth() + 1)) + '-' + pad2(String(d.getUTCDate()));
        if (!byDay[key]) byDay[key] = {};
        if (!seen[r.model_id]) { seen[r.model_id] = true; order.push(r.model_id); }
        byDay[key][r.model_id] = (byDay[key][r.model_id] || 0) + (Number(r.credit_consumed) || 0);
    });
    var dayKeys = Object.keys(byDay).sort().slice(-(days || 7));
    if (!dayKeys.length) return null;
    var modelDataList = order.map(function(name) {
        return { modelName: name, tokensUsage: dayKeys.map(function(k) { return byDay[k][name] || 0; }) };
    });
    var total = 0;
    dayKeys.forEach(function(k) { Object.keys(byDay[k]).forEach(function(m) { total += byDay[k][m]; }); });
    return { x_time: dayKeys, modelDataList: modelDataList, totalUsage: { totalTokensUsage: total } };
}

// 阶跃用量曲线：近 N 天（北京日对齐）单次查询；pageSize 500 覆盖 30 天 × 模型并集上限。
async function fetchStepfunModelUsage(account, index, period) {
    var days = period === '30d' ? 30 : 7;
    var nowMs = Date.now();
    var startTime = stepfunBeijingTodayStart(nowMs) - (days - 1) * 86400000;
    var json = await withStepfunAuthRetry(account, index, function(acc) {
        return stepfunCall(acc, '/api/step.openapi.devcenter.Dashboard/QueryStepPlanUsages',
            { startTime: startTime, toTime: nowMs, page: 1, pageSize: 500 });
    });
    var chart = parseStepfunModelUsage(json, days);
    if (!chart) throw new Error('未获取到用量曲线数据（Cookie 可能已失效）');
    return chart;
}

// 阶跃邀请活动：邀请好友双方各得 15 天 plan，每人可邀请上限 invite_max_count 个；
// 新注册用户首次调用另有 15 天（REGISTER 奖励）。三个接口均软失败，无数据返回 undefined。
// invite 记录字段: invitee_masked_phone / invitee_nickname / reward_days / used_at(秒串)。
// reward 记录(GetCampaignStatus)字段: reward_type(1=新注册赠/4=邀请赠) / reward_days / status / activated_at / expired_at。
// 邀请链接为 https://platform.stepfun.com/?invite_code_v2=<code>（官方 short_link 同源）。
function parseStepfunCampaign(linkJson, invitesJson, statusJson) {
    var campaign = null;
    if (linkJson && linkJson.invite_code) {
        campaign = {
            inviteCode: String(linkJson.invite_code),
            inviteUrl: 'https://platform.stepfun.com/?invite_code_v2=' + encodeURIComponent(String(linkJson.invite_code)),
            inviteCount: Number(linkJson.invite_count) || 0,
            inviteMaxCount: Number(linkJson.invite_max_count) || 0,
            remainingRewardDays: Number(linkJson.remaining_reward_days) || 0,
            invites: [],
            rewards: []
        };
    }
    if (campaign && invitesJson && Array.isArray(invitesJson.invites)) {
        campaign.invites = invitesJson.invites.map(function(it) {
            if (!it) return null;
            return {
                nickname: it.invitee_nickname || null,
                maskedPhone: it.invitee_masked_phone || null,
                rewardDays: Number(it.reward_days) || 0,
                usedAtMs: stepfunSecToMs(it.used_at) || null
            };
        }).filter(Boolean);
    }
    if (campaign && statusJson && Array.isArray(statusJson.rewards)) {
        campaign.rewards = statusJson.rewards.map(function(r) {
            if (!r) return null;
            return {
                rewardDays: Number(r.reward_days) || 0,
                // reward_type: 1=新注册赠送 4=邀请赠送
                rewardType: r.reward_type === 1 ? 'register' : (r.reward_type === 4 ? 'invite' : 'other'),
                status: r.status,
                activatedMs: stepfunSecToMs(r.activated_at) || null,
                expiredMs: stepfunSecToMs(r.expired_at) || null
            };
        }).filter(Boolean);
    }
    return campaign; // 未拿到邀请码时返回 undefined（前端不渲染该节）
}

// 阶跃抓取：并行调 套餐状态（主，硬失败）+ 限额（软）+ 今日用量（软）+ 账号信息（软）+ 按量余额（软）+ 邀请活动（软）。
// 套餐状态 401（access 过期）时刷新 token 整体重试一次；限额失败 → usage 为 null → 卡片「待接入」。
// 今日窗口取北京时间当日零点 → now；金额字段官方为分，统一换算为元。
async function fetchStepfunUsage(account, index) {
    try {
        var planJson = await withStepfunAuthRetry(account, index, function(acc) {
            return stepfunCall(acc, '/api/step.openapi.devcenter.Dashboard/GetStepPlanStatus', {});
        });
        var subscription = parseStepfunPlanStatus(planJson);
        if (!subscription) throw new Error('未获取到套餐信息（该账号可能未订阅 Step 套餐）');

        var nowMs = Date.now();
        var ratePromise = withStepfunAuthRetry(account, index, function(acc) {
            return stepfunCall(acc, '/api/step.openapi.devcenter.Dashboard/QueryStepPlanRateLimit', {});
        }).catch(function() { return null; });
        var todayPromise = withStepfunAuthRetry(account, index, function(acc) {
            return stepfunCall(acc, '/api/step.openapi.devcenter.Dashboard/QueryStepPlanUsages',
                { startTime: stepfunBeijingTodayStart(nowMs), toTime: nowMs, page: 1, pageSize: 100 });
        }).catch(function() { return null; });
        var userPromise = withStepfunAuthRetry(account, index, function(acc) {
            return stepfunCall(acc, '/api/step.openapi.devcenter.Dashboard/UserInfo', {});
        }).catch(function() { return null; });
        var balancePromise = withStepfunAuthRetry(account, index, function(acc) {
            return stepfunCall(acc, '/api/step.openapi.devcenter.Dashboard/QueryAccountBalance', {});
        }).catch(function() { return null; });
        // 邀请活动三件套（软失败）：邀请链接/邀请记录/奖励账本
        var campaignPromise = Promise.all([
            withStepfunAuthRetry(account, index, function(acc) {
                return stepfunCall(acc, '/api/step.openapi.devcenter.Dashboard/GetCampaignInviteLink', {});
            }).catch(function() { return null; }),
            withStepfunAuthRetry(account, index, function(acc) {
                return stepfunCall(acc, '/api/step.openapi.devcenter.Dashboard/ListCampaignInvites', {});
            }).catch(function() { return null; }),
            withStepfunAuthRetry(account, index, function(acc) {
                return stepfunCall(acc, '/api/step.openapi.devcenter.Dashboard/GetCampaignStatus', {});
            }).catch(function() { return null; })
        ]);

        var usage = null;
        var windows = parseStepfunRateLimit(await ratePromise, subscription);
        if (windows.length) {
            var today = parseStepfunUsages(await todayPromise);
            usage = {
                windows: windows,
                today: today ? { credits: today.totalCredits, calls: today.totalCalls, models: today.models } : null
            };
        }
        var userJson = await userPromise;
        var user = userJson ? {
            uid: userJson.uid || null,
            nickname: userJson.nickname || null,
            mobileMasked: stepfunMaskMobile(userJson.mobile),
            payMode: userJson.payMode
        } : null;
        var balJson = await balancePromise;
        var balance = balJson ? {
            voucherYuan: (Number(balJson.voucher) || 0) / 100,
            balanceYuan: (Number(balJson.balance) || 0) / 100,
            costYesterdayYuan: (Number(balJson.cost_yesterday) || 0) / 100,
            costMonthYuan: (Number(balJson.cost_month) || 0) / 100
        } : null;
        var campaignParts = await campaignPromise;
        var campaign = parseStepfunCampaign(campaignParts[0], campaignParts[1], campaignParts[2]);

        var result = {
            index: index,
            name: account.name,
            platform: 'stepfun',
            responsiblePerson: account.responsiblePerson,
            phone: account.phone,
            notes: account.notes,
            isPublic: account.isPublic,
            data: {
                usage: usage,
                subscription: subscription,
                user: user,
                balance: balance,
                campaign: campaign
            },
            success: true,
            cachedAt: Date.now()
        };
        setCache(index, result);
        return result;
    } catch (err) {
        return {
            index: index,
            name: account.name,
            platform: 'stepfun',
            responsiblePerson: account.responsiblePerson,
            phone: account.phone,
            notes: account.notes,
            isPublic: account.isPublic,
            error: err.message,
            success: false
        };
    }
}


module.exports = {
    stepfunWebid: stepfunWebid,
    stepfunMaskMobile: stepfunMaskMobile,
    stepfunReplaceTokenCookie: stepfunReplaceTokenCookie,
    stepfunSecToMs: stepfunSecToMs,
    stepfunBeijingTodayStart: stepfunBeijingTodayStart,
    parseStepfunPlanStatus: parseStepfunPlanStatus,
    parseStepfunRateLimit: parseStepfunRateLimit,
    parseStepfunUsages: parseStepfunUsages,
    parseStepfunModelUsage: parseStepfunModelUsage,
    parseStepfunCampaign: parseStepfunCampaign,
    fetchStepfunUsage: fetchStepfunUsage,
    fetchStepfunModelUsage: fetchStepfunModelUsage
};

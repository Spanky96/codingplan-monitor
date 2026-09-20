// ============ MiniMax Token Plan 账号（platform.minimaxi.com）============
var { httpsGet } = require('../../lib/http');
var { setCache } = require('../cache');
var { pad2 } = require('../../lib/util');

// ============ MiniMax Token Plan 账号（platform.minimaxi.com）============

// group_id 优先取账号字段;未填时从 Cookie 的 minimax_group_id_v2 兜底解析
function minimaxGroupId(account) {
    if (account.group_id) return String(account.group_id);
    var m = String(account.cookie || '').match(/minimax_group_id_v2=(\d+)/);
    return m ? m[1] : '';
}

function minimaxHeaders(account) {
    return {
        'accept': 'application/json, text/plain, */*',
        'accept-language': 'zh-CN,zh;q=0.9',
        'cache-control': 'no-cache',
        'pragma': 'no-cache',
        'cookie': account.cookie || '',
        'origin': 'https://platform.minimaxi.com',
        'referer': 'https://platform.minimaxi.com/',
        'x-group-id': minimaxGroupId(account),
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36'
    };
}

function pad2(n) { return n.length < 2 ? '0' + n : n; }

// 从消息盒子(message_category=4)的权益发放通知解析订阅(兜底数据源,官方订阅接口无数据时使用):
// content 形如「您已成功获得 <b>Token Plan Max (1个月)</b> 权益。当前权益有效期截止至 <b>2026年08月30日</b>。」
// 取首个 <b> 内容为套餐名,\d{4}年\d{1,2}月\d{1,2}日 为到期日;多条通知时取 send_time 最新的一条。
// 注意:续费后盒子通知可能仍停留在上一周期,导致到期日滞后误标已过期,故仅作兜底。
// 解析不到返回 null(账号可能从未购买过 Token Plan)。
function parseMinimaxSubscription(json) {
    var infos = (json && Array.isArray(json.template_infos)) ? json.template_infos : [];
    var best = null;
    for (var i = 0; i < infos.length; i++) {
        var info = infos[i] || {};
        var tpl = info.template_info || {};
        var text = tpl.content || tpl.title || '';
        if (!text) continue;
        var dateMatch = text.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
        if (!dateMatch) continue;
        var sendTime = Number(info.send_time) || 0;
        if (best && sendTime <= best.notifiedAt) continue;
        var nameMatch = text.match(/<b>([\s\S]*?)<\/b>/);
        var planName = nameMatch ? nameMatch[1].replace(/<[^>]+>/g, '').trim() : null;
        var expireMs = new Date(+dateMatch[1], +dateMatch[2] - 1, +dateMatch[3], 23, 59, 59).getTime();
        best = {
            planName: planName,
            expireDate: dateMatch[1] + '-' + pad2(dateMatch[2]) + '-' + pad2(dateMatch[3]),
            expireMs: expireMs,
            notifiedAt: sendTime
        };
    }
    return best;
}

// 解析官方订阅接口(charge/combo/cycle_audio_resource_package)的 current_subscribe(权威到期来源):
// current_subscribe_end_time_ts 为北京时间次日零点(如 1788019200000 = 2026-08-30 00:00 CST,即 08-29 24 点到期),
// 加 8 小时后取 UTC 日期,保证服务器任意时区下格式化结果一致;无 current_subscribe 或缺 ts 返回 null。
function parseMinimaxSubscribeInfo(json) {
    var sub = json && json.current_subscribe;
    var endTs = Number(sub && sub.current_subscribe_end_time_ts) || 0;
    if (!endTs) return null;
    var d = new Date(endTs + 8 * 3600 * 1000);
    return {
        planName: sub.current_subscribe_title || null,
        expireDate: d.getUTCFullYear() + '-' + pad2(String(d.getUTCMonth() + 1)) + '-' + pad2(String(d.getUTCDate())),
        expireMs: endTs
    };
}

// 订阅到期合成:官方订阅接口优先,消息盒子权益通知兜底;官方套餐名缺失时借用通知中的套餐名。
function minimaxMergeSubscription(subJson, boxJson) {
    var official = parseMinimaxSubscribeInfo(subJson);
    var noticed = parseMinimaxSubscription(boxJson);
    if (!official) return noticed;
    if (official.planName || !noticed) return official;
    return Object.assign({}, official, { planName: noticed.planName });
}

// 「%」字符串 → 数字(保留 1 位小数);解析失败返回 null
function minimaxParsePercent(s) {
    if (s == null) return null;
    var m = String(s).match(/^(-?\d+(?:\.\d+)?)\s*%?$/);
    return m ? parseFloat(m[1]) : null;
}

// 模型名 + 周期 → 中文展示名;与官方 i18n 一致(5h 限额 / 周限额 / 视频赠送)
function minimaxWindowLabel(modelName, kind) {
    if (modelName === 'general') return kind === 'weekly' ? '周限额' : '5h 限额';
    if (modelName === 'video') return kind === 'weekly' ? '视频周赠' : '视频赠送';
    return modelName + (kind === 'weekly' ? ' 周用量' : ' 限额');
}

// 把单个模型行的 current_interval / current_weekly 字段归一化为窗口对象;
// 计数可用(>=0 且 quota>0)走 used/quota 路径,否则退回 usedPct 路径(quota 为 -1 表示无限额,按百分比展示)。
// 对齐 GLM:百分比窗口(general)渲染 5 等分进度条;计数窗口(video 每日)保持单条不带段。
function minimaxMakeWindow(modelName, kind, usedCount, totalCount, usedPct, startMs, endMs) {
    var label = minimaxWindowLabel(modelName, kind);
    var resetMs = Number(endMs) || null;
    var periodMs = (Number(endMs) || 0) > (Number(startMs) || 0) ? (Number(endMs) - Number(startMs)) : null;
    if (Number(usedCount) >= 0 && Number(totalCount) > 0) {
        return { label: label, used: Number(usedCount), quota: Number(totalCount), resetMs: resetMs, periodMs: periodMs };
    }
    var pct = minimaxParsePercent(usedPct);
    if (pct == null) return null;
    // 仅 general 文本模型返回周期窗口(5 等分),其他模型在周窗不入显示
    var segments = (modelName === 'general') ? 5 : 0;
    return { label: label, usedPct: pct, resetMs: resetMs, periodMs: periodMs, segments: segments };
}

// 解析 MiniMax 用量接口(remains_percent):
// 返回 windows 数组(可能为空);base_resp.status_code != 0 或 model_remains 缺失时返回 null。
// 只对外暴露 general(5h 限额 + 周限额,5 等分)与 video(每日赠送,计数);video 周窗不再展示。
// video 每日赠送打 weightExcluded=true:仅展示,不参与权重/紧张度(耗尽也不影响账号可用性)。
function parseMinimaxUsage(json) {
    if (!json || !json.base_resp || json.base_resp.status_code !== 0) return null;
    var models = Array.isArray(json.model_remains) ? json.model_remains : [];
    var windows = [];
    for (var i = 0; i < models.length; i++) {
        var m = models[i] || {};
        if (!m.model_name) continue;
        // video 仅暴露每日赠送(0/3),周窗不展示;赠送额度不参与权重/紧张度
        if (m.model_name === 'video') {
            var dailyW = minimaxMakeWindow('video', 'interval',
                m.current_interval_used_count, m.current_interval_total_count, m.current_interval_used_percent,
                m.start_time, m.end_time);
            if (dailyW) windows.push(Object.assign({}, dailyW, { weightExcluded: true }));
            continue;
        }
        var intervalW = minimaxMakeWindow(m.model_name, 'interval',
            m.current_interval_used_count, m.current_interval_total_count, m.current_interval_used_percent,
            m.start_time, m.end_time);
        if (intervalW) windows.push(intervalW);
        var weeklyW = minimaxMakeWindow(m.model_name, 'weekly',
            m.current_weekly_used_count, m.current_weekly_total_count, m.current_weekly_used_percent,
            m.weekly_start_time, m.weekly_end_time);
        if (weeklyW) windows.push(weeklyW);
    }
    return windows;
}

// 解析 MiniMax 用量曲线接口(token_plan/usage_summary):
// 官方按天返回 date_model_usage(含每日逐模型 token 明细),无参时覆盖较长历史,这里截取最近 N 天(7/30)。
// 归一化为前端通用图表契约(与智谱/千问一致):{ x_time, modelDataList:[{modelName,tokensUsage}], totalUsage }。
// 不同日期出现的模型取并集(保留首次出现顺序),缺失日补 0;base_resp.status_code != 0 或无数据返回 null。
// 逐模型取 input_token + output_token(净消耗);模型 total_token 含 cache_read 会重复计数,
// 各模型 input+output 之和恰等于当日 total_token,与官方 total_token_consumed 口径一致。
function parseMinimaxModelUsage(json, period) {
    if (!json || !json.base_resp || json.base_resp.status_code !== 0) return null;
    var days = period === '30d' ? 30 : 7;
    var all = Array.isArray(json.date_model_usage) ? json.date_model_usage : [];
    if (!all.length) return null;
    var win = all.slice(-days);
    var x_time = win.map(function(d) { return d && d.date ? d.date : ''; });
    var modelMap = {};
    var order = [];
    win.forEach(function(d, idx) {
        var models = (d && Array.isArray(d.models)) ? d.models : [];
        models.forEach(function(m) {
            if (!m || !m.model) return;
            if (!Object.prototype.hasOwnProperty.call(modelMap, m.model)) {
                modelMap[m.model] = new Array(win.length).fill(0);
                order.push(m.model);
            }
            modelMap[m.model][idx] = (Number(m.input_token) || 0) + (Number(m.output_token) || 0);
        });
    });
    var modelDataList = order.map(function(name) {
        return { modelName: name, tokensUsage: modelMap[name] };
    });
    var totalTokens = win.reduce(function(a, d) { return a + (Number(d && d.total_token) || 0); }, 0);
    return {
        x_time: x_time,
        modelDataList: modelDataList,
        totalUsage: { totalTokensUsage: totalTokens }
    };
}

// MiniMax 用量曲线抓取:调 usage_summary(官方支持 7/30 天口径,无参返回较长历史,由解析层截取)。
// 复用 /api/model-usage 契约;Cookie 失效或无数据时抛错交由前端提示。
async function fetchMiniMaxModelUsage(account, period) {
    var json = await httpsGet('https://www.minimaxi.com/backend/account/token_plan/usage_summary', minimaxHeaders(account));
    var chart = parseMinimaxModelUsage(json, period);
    if (!chart) throw new Error('未获取到用量曲线数据（Cookie 可能已失效）');
    return chart;
}

// MiniMax 抓取:并行调套餐消息盒子 + 用量接口(remains_percent) + 官方订阅接口(charge/combo)。
// 用量契约: data.usage.windows = [{ label, usedPct 或 used+quota, resetMs, periodMs, segments? }]
// 到期以官方订阅接口的 current_subscribe 为准,消息盒子通知兜底(续费后通知可能停留在上一周期)。
// 用量/订阅接口软失败(返回 null)→ 用量显示「待接入」占位、到期退回通知兜底;消息盒子失败则整体抛错(凭据失效)
async function fetchMiniMaxUsage(account, index) {
    try {
        var headers = minimaxHeaders(account);
        var boxPromise = httpsGet('https://www.minimaxi.com/backend/message/box?message_category=4&not_read=false', headers);
        var usagePromise = httpsGet('https://www.minimaxi.com/backend/account/token_plan/remains_percent', headers)
            .catch(function() { return null; });
        var subPromise = httpsGet('https://www.minimaxi.com/v1/api/openplatform/charge/combo/cycle_audio_resource_package?biz_line=2&cycle_type=3&resource_package_type=7', headers)
            .catch(function() { return null; });
        var boxJson = await boxPromise;
        if (!boxJson || !boxJson.base_resp || boxJson.base_resp.status_code !== 0) {
            throw new Error((boxJson && boxJson.base_resp && boxJson.base_resp.status_msg) || '请求失败（Cookie 可能已失效）');
        }
        var subscription = minimaxMergeSubscription(await subPromise, boxJson);
        var usageJson = await usagePromise;
        var usageWindows = parseMinimaxUsage(usageJson);
        var result = {
            index: index,
            name: account.name,
            platform: 'minimax',
            responsiblePerson: account.responsiblePerson,
            phone: account.phone,
            notes: account.notes,
            isPublic: account.isPublic,
            data: {
                usage: usageWindows != null ? { windows: usageWindows } : null,
                subscription: subscription
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
            platform: 'minimax',
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
    minimaxGroupId: minimaxGroupId,
    parseMinimaxSubscription: parseMinimaxSubscription,
    parseMinimaxSubscribeInfo: parseMinimaxSubscribeInfo,
    minimaxMergeSubscription: minimaxMergeSubscription,
    parseMinimaxUsage: parseMinimaxUsage,
    parseMinimaxModelUsage: parseMinimaxModelUsage,
    fetchMiniMaxUsage: fetchMiniMaxUsage,
    fetchMiniMaxModelUsage: fetchMiniMaxModelUsage
};

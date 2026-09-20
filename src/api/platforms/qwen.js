// ============ 千问 token plan 账号（platform.qianwenai.com）============
var { httpsPostForm } = require('../../lib/http');
var { setCache } = require('../cache');

// ============ 千问 token plan 账号（Token Plan 个人版）============

function qwenHeaders(account) {
    return {
        'accept': 'application/json, text/plain, */*',
        'accept-language': 'zh-CN,zh;q=0.9',
        'cache-control': 'no-cache',
        'pragma': 'no-cache',
        'cookie': account.cookie || '',
        'referer': 'https://platform.qianwenai.com/home/billing/subscription/token-plan-individual'
    };
}

// 把 {k:v} 编码成 application/x-www-form-urlencoded 字符串
function formEncode(fields) {
    return Object.keys(fields).map(function(k) {
        return encodeURIComponent(k) + '=' + encodeURIComponent(fields[k]);
    }).join('&');
}

// 千问用量接口 params（静态）
var QWEN_USAGE_PARAMS = {
    Api: 'zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage',
    Data: {
        cornerstoneParam: {
            domain: 'platform.qianwenai.com',
            consoleSite: 'QIANWENAI',
            console: 'ONE_CONSOLE',
            xsp_lang: 'zh-CN',
            protocol: 'V2',
            productCode: 'p_efm'
        }
    },
    V: '1.0'
};

// 千问订阅信息接口 params（静态）
var QWEN_SUB_PARAMS = {
    Api: 'zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/subscription',
    Data: {
        commodityCode: 'sfm_tokenplansolo_public_cn',
        cornerstoneParam: {
            domain: 'platform.qianwenai.com',
            consoleSite: 'QIANWENAI',
            console: 'ONE_CONSOLE',
            xsp_lang: 'zh-CN',
            protocol: 'V2',
            productCode: 'p_efm'
        }
    },
    V: '1.0'
};

// 千问 BroadScopeAspnGateway 网关请求体（usage / subscription 共用同一网关，仅 params 不同）
function qwenGatewayForm(apiPath, secToken) {
    return formEncode({
        product: 'sfm_bailian',
        action: 'BroadScopeAspnGateway',
        sec_token: secToken,
        region: 'cn-beijing',
        params: JSON.stringify(apiPath === 'subscription' ? QWEN_SUB_PARAMS : QWEN_USAGE_PARAMS)
    });
}

// 统一抓取：并行调用用量接口（5h/7d 百分比 + 重置时间）+ 订阅接口（真实到期/剩余天数/状态），订阅接口软失败
async function fetchQwenUsage(account, index) {
    try {
        var headers = qwenHeaders(account);
        var secToken = account.sec_token || '';
        var gatewayBase = 'https://cs-data.qianwenai.com/data/api.json?product=sfm_bailian&action=BroadScopeAspnGateway&api=';

        // 用量接口：百分比是 0~1 小数，需 ×100；同时取重置时间（毫秒时间戳）用于理论水位线与权重速率评分
        var usageUrl = gatewayBase + 'zeldaHttp.apikeyMgr.%2Ftokenplan%2Fpersonal%2Fapi%2Fv2%2Fusage';
        var usagePromise = httpsPostForm(usageUrl, headers, qwenGatewayForm('usage', secToken)).then(function(j) {
            var inner = j && j.data && j.data.DataV2 && j.data.DataV2.data && j.data.DataV2.data.data;
            if (!inner) return null;
            return {
                per5HourPercentage: typeof inner.per5HourPercentage === 'number' ? inner.per5HourPercentage * 100 : 0,
                per1WeekPercentage: typeof inner.per1WeekPercentage === 'number' ? inner.per1WeekPercentage * 100 : 0,
                per5HourResetTime: inner.per5HourResetTime || null,
                per1WeekResetTime: inner.per1WeekResetTime || null
            };
        });

        // 订阅接口：真实到期时间 endTime / 剩余天数 / 状态 / 自动续费 / 套餐规格
        var subUrl = gatewayBase + 'zeldaHttp.apikeyMgr.%2Ftokenplan%2Fpersonal%2Fapi%2Fv2%2Fsubscription';
        var subPromise = httpsPostForm(subUrl, headers, qwenGatewayForm('subscription', secToken)).then(function(j) {
            var inner = j && j.data && j.data.DataV2 && j.data.DataV2.data && j.data.DataV2.data.data;
            if (!inner) return null;
            return {
                instanceCode: inner.instanceCode || null,
                specCode: inner.specCode || null,
                remainingDays: typeof inner.remainingDays === 'number' ? inner.remainingDays : null,
                startTime: inner.startTime || null,
                endTime: inner.endTime || null,
                autoRenewFlag: !!inner.autoRenewFlag,
                status: inner.status || null
            };
        }).catch(function() { return null; });

        var usage = await usagePromise;
        var subscription = await subPromise;

        if (!usage) throw new Error('未获取到用量数据（Cookie / sec_token 可能已失效）');

        var result = {
            index: index,
            name: account.name,
            platform: 'qwen',
            responsiblePerson: account.responsiblePerson,
            phone: account.phone,
            notes: account.notes,
            isPublic: account.isPublic,
            data: { usage: usage, subscription: subscription },
            success: true,
            cachedAt: Date.now()
        };
        setCache(index, result);
        return result;
    } catch (err) {
        return {
            index: index,
            name: account.name,
            platform: 'qwen',
            responsiblePerson: account.responsiblePerson,
            phone: account.phone,
            notes: account.notes,
            isPublic: account.isPublic,
            error: err.message,
            success: false
        };
    }
}

// 千问用量曲线 usage_type -> 展示名
var QWEN_USAGE_TYPE_LABELS = {
    total_tokens: '总Token',
    input_tokens: '输入Token',
    output_tokens: '输出Token',
    cached_tokens: '缓存Token',
    web_search_count: '联网搜索'
};

// 解析千问用量曲线网关响应。两种「无数据」场景区分:
//   1) 登录失效:j.data.success=false(errorCode=BailianGateway.Login.NotLogined)、无 DataV2 → 抛错提示 Cookie
//   2) 时段内无调用:DataV2 结构正常但 originData 为空数组 → 返回空数据集,由前端展示友好空态
// 同时过滤 cumsum 聚合序列(points 长度与 x 轴不一致):它会让图例出现重复的「总Token」,
// 且其单点值会被总用量二次累加导致汇总翻倍。
function parseQwenModelUsageJson(j) {
    var dataV2 = j && j.data && j.data.DataV2;
    var dataWrap = dataV2 && dataV2.data;
    if (!dataWrap || dataWrap.success === false) {
        throw new Error('未获取到用量曲线数据（Cookie / sec_token 可能已失效）');
    }
    var originData = dataWrap.data && dataWrap.data.originData;
    if (!Array.isArray(originData) || !originData.length) {
        return { x_time: [], modelDataList: [], totalUsage: { totalTokensUsage: 0 } };
    }

    function pad(n) { return n < 10 ? '0' + n : '' + n; }
    function fmtTs(ts) {
        var dd = new Date(ts);
        return dd.getFullYear() + '-' + pad(dd.getMonth() + 1) + '-' + pad(dd.getDate()) + ' ' + pad(dd.getHours()) + ':' + pad(dd.getMinutes());
    }

    var x_time = (originData[0].points || []).map(function(p) { return fmtTs(p.timestamp); });
    var modelDataList = originData
        .filter(function(series) { return (series.points || []).length === x_time.length; })
        .map(function(series) {
            var ut = series.labels && series.labels.usage_type;
            return {
                modelName: QWEN_USAGE_TYPE_LABELS[ut] || ut || 'unknown',
                tokensUsage: (series.points || []).map(function(p) { return p.value || 0; })
            };
        });

    // totalUsage:取 total_tokens 系列求和(千问无调用次数,totalModelCallCount 留空由前端隐藏)
    var totalTokens = 0;
    modelDataList.forEach(function(m) {
        if (m.modelName === '总Token') {
            totalTokens = (m.tokensUsage || []).reduce(function(a, b) { return a + (b || 0); }, 0);
        }
    });

    return {
        x_time: x_time,
        modelDataList: modelDataList,
        totalUsage: { totalTokensUsage: totalTokens }
    };
}

// 千问用量曲线：按 period 取当日(每小时)/近7天/近30天(每日)的 model_usage,
// 转换为与智谱一致的图表格式 {x_time, modelDataList, totalUsage} 供前端 renderUsageChart 复用
async function fetchQwenModelUsage(account, period) {
    var secToken = account.sec_token || '';
    var headers = qwenHeaders(account);
    var now = Date.now();
    var d = new Date();
    var startOfToday = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    var step, startTime;
    if (period === 'today') {
        step = 3600;            // 每小时
        startTime = startOfToday;
    } else {
        step = 86400;           // 每天
        var days = period === '30d' ? 30 : 7;
        startTime = new Date(d.getFullYear(), d.getMonth(), d.getDate() - (days - 1)).getTime();
    }
    var params = {
        Api: 'zeldaEasy.bailian-telemetry.platform-model.getModelMonitorDataWithOss',
        Data: {
            reqDTO: {
                productMode: 'TokenPlanPersonal',
                startTime: startTime,
                endTime: now,
                step: step,
                metricFilters: [{ aggMethod: 'sum', metricName: 'model_usage' }]
            },
            cornerstoneParam: {
                domain: 'platform.qianwenai.com',
                consoleSite: 'QIANWENAI',
                console: 'ONE_CONSOLE',
                xsp_lang: 'zh-CN',
                protocol: 'V2',
                productCode: 'p_efm'
            }
        },
        V: '1.0'
    };
    var form = formEncode({
        product: 'sfm_bailian',
        action: 'BroadScopeAspnGateway',
        sec_token: secToken,
        region: 'cn-beijing',
        params: JSON.stringify(params)
    });
    var url = 'https://cs-data.qianwenai.com/data/api.json?product=sfm_bailian&action=BroadScopeAspnGateway&api=zeldaEasy.bailian-telemetry.platform-model.getModelMonitorDataWithOss';
    var j = await httpsPostForm(url, headers, form);
    return parseQwenModelUsageJson(j);
}


module.exports = {
    fetchQwenUsage: fetchQwenUsage,
    fetchQwenModelUsage: fetchQwenModelUsage,
    parseQwenModelUsageJson: parseQwenModelUsageJson
};

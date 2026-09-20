// ============ 火山账号（AgentPlan=火山A / CodingPlan=火山C，同一登录会话）============
var { httpsRequest } = require('../../lib/http');
var { setCache } = require('../cache');

// ============ 火山账号（AgentPlan=火山A / CodingPlan=火山C，同一登录会话）============

// AgentPlan（火山A）请求头
function volcHeaders(account) {
    var h = {
        'accept': 'application/json, text/plain, */*',
        'accept-language': 'zh',
        'cache-control': 'no-cache',
        'content-type': 'application/json',
        'pragma': 'no-cache',
        'cookie': account.cookie || '',
        'x-csrf-token': account.csrf || '',
        'referer': 'https://console.volcengine.com/ark/region:ark+cn-beijing/openManagement?LLM=%7B%7D&advancedActiveKey=agentPlan'
    };
    if (account.web_id) h['x-web-id'] = account.web_id;
    return h;
}

// CodingPlan（火山C）请求头
function volcCodingHeaders(account) {
    var h = {
        'accept': 'application/json, text/plain, */*',
        'accept-language': 'zh',
        'cache-control': 'no-cache',
        'content-type': 'application/json',
        'pragma': 'no-cache',
        'cookie': account.cookie || '',
        'x-csrf-token': account.csrf || '',
        'referer': 'https://console.volcengine.com/ark/region:cn-beijing/subscription/coding-plan'
    };
    if (account.web_id) h['x-web-id'] = account.web_id;
    return h;
}

// 统一抓取：按 account.planType 分派到 AgentPlan 或 CodingPlan 接口
async function fetchVolcUsage(account, index) {
    var isCoding = account.planType === 'coding';
    var planType = isCoding ? 'coding' : 'agent';
    try {
        var headers = isCoding ? volcCodingHeaders(account) : volcHeaders(account);
        var usageUrl = isCoding
            ? 'https://console.volcengine.com/api/top/ark/cn-beijing/2024-01-01/GetCodingPlanUsage'
            : 'https://console.volcengine.com/api/top/ark/cn-beijing/2024-01-01/GetAgentPlanAFPUsage';
        var subUrl = 'https://console.volcengine.com/api/top/ark/cn-beijing/2024-01-01/ListSubscribeTrade';
        var subBody = isCoding
            ? { ResourceTypes: ['CodingPlan'], ResourceNames: [''], BizInfos: ['lite', 'pro'] }
            : { ResourceTypes: ['AgentPlan'], ResourceNames: ['RealAgentPlanPersonal'], BizInfos: ['small', 'medium', 'large', 'max'] };

        var usagePromise = httpsRequest('POST', usageUrl, headers, {}).then(function(j) { return j && j.Result ? j.Result : null; });
        var subPromise = httpsRequest('POST', subUrl, headers, subBody).then(function(j) {
            return (j && j.Result && j.Result.InfoList && j.Result.InfoList[0]) || null;
        }).catch(function() { return null; });

        var usage = await usagePromise;
        var subscription = await subPromise;

        if (!usage) throw new Error('未获取到用量数据（可能是 Cookie/CSRF 已失效）');

        var result = {
            index: index,
            name: account.name,
            platform: 'volc',
            planType: planType,
            responsiblePerson: account.responsiblePerson,
            phone: account.phone,
            notes: account.notes,
            teamEdition: account.teamEdition || undefined,
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
            platform: 'volc',
            planType: planType,
            responsiblePerson: account.responsiblePerson,
            phone: account.phone,
            notes: account.notes,
            teamEdition: account.teamEdition || undefined,
            isPublic: account.isPublic,
            error: err.message,
            success: false
        };
    }
}


module.exports = { fetchVolcUsage: fetchVolcUsage };

// 平台分派:按 account.platform 路由到各平台适配器(新增平台只需在此登记)。
// 非 glm 平台的到期信息由各接口自带,统一返回 success:false 由前端从 data 渲染。
var { fetchGLMUsage, fetchGLMExpire } = require('./glm');
var { fetchYesCodeUsage } = require('./yescode');
var { fetchSub2apiUsage } = require('./sub2api');
var { fetchVolcUsage } = require('./volc');
var { fetchQwenUsage, fetchQwenModelUsage } = require('./qwen');
var { fetchMiniMaxUsage, fetchMiniMaxModelUsage } = require('./minimax');
var { fetchStepfunUsage, fetchStepfunModelUsage } = require('./stepfun');
var { fetchTelecomUsage } = require('./telecom');

// ============ 统一调度 ============

async function fetchAccountUsage(account, index) {
    var platform = account.platform || 'glm';
    if (platform === 'yescode') {
        return fetchYesCodeUsage(account, index);
    }
    if (platform === 'sub2api' || platform === 'huoli') {
        return fetchSub2apiUsage(account, index);
    }
    if (platform === 'volc') {
        return fetchVolcUsage(account, index);
    }
    if (platform === 'qwen') {
        return fetchQwenUsage(account, index);
    }
    if (platform === 'minimax') {
        return fetchMiniMaxUsage(account, index);
    }
    if (platform === 'stepfun') {
        return fetchStepfunUsage(account, index);
    }
    if (platform === 'telecomjs') {
        return fetchTelecomUsage(account, index);
    }
    return fetchGLMUsage(account, index);
}

async function fetchAccountExpire(account, index) {
    var platform = account.platform || 'glm';
    if (platform !== 'glm') {
        // 这些平台到期信息从各自接口获取，由前端渲染
        return { success: false, cachedAt: Date.now() };
    }
    return fetchGLMExpire(account, index);
}

function getAccount(req) {
    var accounts = readAccounts();
    return accounts[parseInt(req.params.index)];
}
module.exports = {
    fetchAccountUsage: fetchAccountUsage,
    fetchAccountExpire: fetchAccountExpire,
    fetchGLMUsage: fetchGLMUsage,
    fetchGLMExpire: fetchGLMExpire,
    fetchYesCodeUsage: fetchYesCodeUsage,
    fetchSub2apiUsage: fetchSub2apiUsage,
    fetchVolcUsage: fetchVolcUsage,
    fetchQwenUsage: fetchQwenUsage,
    fetchMiniMaxUsage: fetchMiniMaxUsage,
    fetchStepfunUsage: fetchStepfunUsage,
    fetchTelecomUsage: fetchTelecomUsage,
    fetchQwenModelUsage: fetchQwenModelUsage,
    fetchMiniMaxModelUsage: fetchMiniMaxModelUsage,
    fetchStepfunModelUsage: fetchStepfunModelUsage
};

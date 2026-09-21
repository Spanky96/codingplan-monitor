// API 中间件组装:按域注册路由。server.js 调用 api(app)。
// 新增平台 → src/api/platforms/<name>.js + platforms/index.js 登记;
// 新路由域 → src/api/routes/<name>.js 后在此追加一行。
var express = require('express');
var config = require('../config');

var registerAuth = require('./routes/auth');
var registerFeatures = require('./routes/features');
var registerUsage = require('./routes/usage');
var registerCredentials = require('./routes/credentials');
var registerWeights = require('./routes/weights');
var registerRelay = require('./routes/relay');
var registerKeys = require('./routes/keys');
var registerTelecomLogin = require('./routes/telecom-login');
var registerAccounts = require('./routes/accounts');
var registerModelUsage = require('./routes/model-usage');
var registerExpire = require('./routes/expire');
var registerConsoleUrl = require('./routes/console-url');

module.exports = function(app) {
    registerAuth(app);
    registerFeatures(app);
    registerUsage(app);
    // 凭证导出默认关闭:CredENTIALS_EXPORT=1 才注册(测试与功能开关依赖此行为)
    if (config.credentialsExportEnabled) registerCredentials(app);
    registerWeights(app);
    registerRelay(app);
    registerKeys(app);
    registerTelecomLogin(app);
    registerAccounts(app);
    registerModelUsage(app);
    registerExpire(app);
    registerConsoleUrl(app);
};

// 供单测覆盖的纯函数与内部状态(不走 HTTP 路由)。
// 约定:平台解析函数从对应平台模块导出;共享能力从 lib / accounts / auth / cache 导出。
module.exports._isGlmAuthError = require('./platforms/glm').isGlmAuthError;
module.exports._hasGlmLoginCredentials = require('./platforms/glm').hasGlmLoginCredentials;
module.exports._parseGlmResetCards = require('./platforms/glm').parseGlmResetCards;
module.exports._loginGlm = require('./platforms/glm').loginGlm;
module.exports._fetchGLMUsage = require('./platforms/glm').fetchGLMUsage;
module.exports._withGlmAuthRetry = require('./platforms/glm').withGlmAuthRetry;
module.exports._yescodeLogin = require('./platforms/yescode').yescodeLogin;
module.exports._fetchYesCodeUsage = require('./platforms/yescode').fetchYesCodeUsage;
module.exports._hasYescodeLoginCredentials = require('./platforms/yescode').hasYescodeLoginCredentials;
module.exports._loginSub2api = require('./platforms/sub2api').loginSub2api;
module.exports._fetchSub2apiUsage = require('./platforms/sub2api').fetchSub2apiUsage;
module.exports._sub2apiCreds = require('./platforms/sub2api').sub2apiCreds;
module.exports._sub2apiBaseUrl = require('./platforms/sub2api').sub2apiBaseUrl;
module.exports._parseQwenModelUsageJson = require('./platforms/qwen').parseQwenModelUsageJson;
module.exports._minimaxGroupId = require('./platforms/minimax').minimaxGroupId;
module.exports._parseMinimaxSubscription = require('./platforms/minimax').parseMinimaxSubscription;
module.exports._parseMinimaxSubscribeInfo = require('./platforms/minimax').parseMinimaxSubscribeInfo;
module.exports._minimaxMergeSubscription = require('./platforms/minimax').minimaxMergeSubscription;
module.exports._parseMinimaxUsage = require('./platforms/minimax').parseMinimaxUsage;
module.exports._parseMinimaxModelUsage = require('./platforms/minimax').parseMinimaxModelUsage;
var stepfun = require('./platforms/stepfun');
module.exports._stepfunWebid = stepfun.stepfunWebid;
module.exports._stepfunMaskMobile = stepfun.stepfunMaskMobile;
module.exports._stepfunReplaceTokenCookie = stepfun.stepfunReplaceTokenCookie;
module.exports._stepfunSecToMs = stepfun.stepfunSecToMs;
module.exports._stepfunBeijingTodayStart = stepfun.stepfunBeijingTodayStart;
module.exports._parseStepfunPlanStatus = stepfun.parseStepfunPlanStatus;
module.exports._parseStepfunRateLimit = stepfun.parseStepfunRateLimit;
module.exports._parseStepfunUsages = stepfun.parseStepfunUsages;
module.exports._parseStepfunModelUsage = stepfun.parseStepfunModelUsage;
module.exports._parseStepfunCampaign = stepfun.parseStepfunCampaign;
module.exports._fetchStepfunUsage = stepfun.fetchStepfunUsage;
module.exports._encryptSecret = require('../lib/crypto').encryptSecret;
module.exports._decryptSecretOrNull = require('../lib/crypto').decryptSecretOrNull;
module.exports._encryptAccounts = require('./accounts').encryptAccounts;
module.exports._decryptAccounts = require('./accounts').decryptAccounts;
module.exports._authBanState = require('./auth').authBanState;
module.exports._authBanRecordFailure = require('./auth').authBanRecordFailure;
module.exports._authBanReset = require('./auth').authBanReset;
module.exports._clientIp = require('./auth').clientIp;
module.exports._isPrivateIp = require('./privacy').isPrivateIp;
module.exports._isExternalRequest = require('./privacy').isExternalRequest;
module.exports._isAdminRequest = require('./privacy').isAdminRequest;
module.exports._forcedPrivacy = require('./privacy').forcedPrivacy;
module.exports._buildAliasMap = require('./privacy').buildAliasMap;
module.exports._maskUsageResult = require('./privacy').maskUsageResult;

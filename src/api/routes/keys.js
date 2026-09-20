// API Keys / IP 白名单 / 风控提示 / 重置卡——均属智谱账号域(仅管理员可操作)。
var express = require('express');
var jsonParser = express.json();
var { httpsGet, httpsRequest } = require('../../lib/http');
var { readAccounts, writeAccounts } = require('../accounts');
var { checkAuth, isAuthed, isHiddenFromGuest } = require('../auth');
var { clearCacheIndex } = require('../cache');
var platforms = require('../platforms');
var {
    makeHeaders, keysUrl, ipWhitelistUrl, riskInfoUrl, resetCardsUrl, resetCardUseUrl,
    RESET_CARD_USE_TYPES, RISK_TIPS, RISK_TIPS_FALLBACK, decodeJwtUserType,
    parseGlmResetCards, persistGlmResetCards, isValidIp, uuidV4, withGlmAuthRetry
} = platforms;

function getAccount(req) {
    var accounts = readAccounts();
    return accounts[parseInt(req.params.index)];
}

module.exports = function(app) {
    app.get('/api/keys/:index', checkAuth, async function(req, res) {
        try {
            var i = parseInt(req.params.index);
            var account = getAccount(req);
            if (!account) return res.status(404).json({ error: '未找到账号' });
            if (isHiddenFromGuest(req, account)) return res.status(404).json({ error: '未找到账号' });
            if ((account.platform || 'glm') !== 'glm') {
                return res.json([]);
            }
            var json = await withGlmAuthRetry(account, i, function(acc) {
                return httpsGet(keysUrl(acc, '?keyType=' + (acc.teamEdition ? 2 : 1)), makeHeaders(acc));
            });
            var keys = json.data || [];
            var accounts = readAccounts();
            accounts[i].keyCount = keys.length;
            writeAccounts(accounts);
            var c = usageCache[i];
            if (c && c.result) c.result.keyCount = keys.length;
            res.json(keys);
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.get('/api/keys/:index/copy/:apiKey', checkAuth, async function(req, res) {
        try {
            var i = parseInt(req.params.index);
            var account = getAccount(req);
            if (!account) return res.status(404).json({ error: '未找到账号' });
            var json = await withGlmAuthRetry(account, i, function(acc) {
                return httpsGet(keysUrl(acc, '/copy/' + req.params.apiKey), makeHeaders(acc));
            });
            res.json(json.data || {});
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.post('/api/keys/:index', jsonParser, checkAuth, async function(req, res) {
        try {
            var i = parseInt(req.params.index);
            var account = getAccount(req);
            if (!account) return res.status(404).json({ error: '未找到账号' });
            var json = await withGlmAuthRetry(account, i, function(acc) {
                return httpsRequest('POST', keysUrl(acc), makeHeaders(acc), { name: req.body.name, keyType: acc.teamEdition ? 2 : 1 });
            });
            res.json(json.data || {});
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.delete('/api/keys/:index/:apiKey', checkAuth, async function(req, res) {
        try {
            var i = parseInt(req.params.index);
            var account = getAccount(req);
            if (!account) return res.status(404).json({ error: '未找到账号' });
            await withGlmAuthRetry(account, i, function(acc) {
                return httpsRequest('DELETE', keysUrl(acc, '/' + req.params.apiKey), makeHeaders(acc));
            });
            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // ============ IP 白名单（智谱账号,查看与操作均需密码）============

    app.get('/api/ip-whitelist/:index', checkAuth, async function(req, res) {
        try {
            var i = parseInt(req.params.index);
            var account = getAccount(req);
            if (!account) return res.status(404).json({ error: '未找到账号' });
            if ((account.platform || 'glm') !== 'glm') return res.json([]);
            var json = await withGlmAuthRetry(account, i, function(acc) {
                return httpsGet(ipWhitelistUrl(acc, '/list'), makeHeaders(acc));
            });
            if (json && json.code != null && json.code !== 200) throw new Error(json.msg || '查询失败');
            res.json(json.rows || []);
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.post('/api/ip-whitelist/:index', jsonParser, checkAuth, async function(req, res) {
        try {
            var i = parseInt(req.params.index);
            var account = getAccount(req);
            if (!account) return res.status(404).json({ error: '未找到账号' });
            var ip = (req.body && req.body.ipAddress || '').trim();
            if (!isValidIp(ip)) return res.status(400).json({ error: 'IP 地址格式不正确,支持 IPv4 或 IPv4/CIDR,如 1.2.3.4 或 10.0.0.0/8' });
            var json = await withGlmAuthRetry(account, i, function(acc) {
                return httpsRequest('POST', ipWhitelistUrl(acc), makeHeaders(acc), { ipAddress: ip });
            });
            if (json && json.code != null && json.code !== 200) throw new Error(json.msg || '添加失败');
            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.delete('/api/ip-whitelist/:index/:id', checkAuth, async function(req, res) {
        try {
            var i = parseInt(req.params.index);
            var account = getAccount(req);
            if (!account) return res.status(404).json({ error: '未找到账号' });
            var json = await withGlmAuthRetry(account, i, function(acc) {
                return httpsRequest('DELETE', ipWhitelistUrl(acc, '/' + req.params.id), makeHeaders(acc));
            });
            if (json && json.code != null && json.code !== 200) throw new Error(json.msg || '删除失败');
            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // ============ 风控/异常提示（智谱个人版账号,查看与刷新均无需管理员）============

    app.get('/api/risk/:index', async function(req, res) {
        try {
            var i = parseInt(req.params.index);
            var account = getAccount(req);
            if (!account) return res.status(404).json({ error: '未找到账号' });
            if (isHiddenFromGuest(req, account)) return res.status(404).json({ error: '未找到账号' });
            // 仅智谱账号有风控接口;团队版(ENTERPRISE)不适用
            if ((account.platform || 'glm') !== 'glm') return res.json({ level: null, text: '', teamEdition: false });
            if (decodeJwtUserType(account.authorization) !== 'PERSONAL') {
                return res.json({ level: null, text: '', teamEdition: true });
            }
            var json = await withGlmAuthRetry(account, i, function(acc) {
                return httpsGet(riskInfoUrl(), makeHeaders(acc));
            });
            var level = (json && json.data != null) ? json.data : null;
            var text = '';
            if (level) text = `(${level})` + (RISK_TIPS[level] || RISK_TIPS_FALLBACK);

            // 每次打开详情刷新:有风险则记录,已解除则清除
            var accounts = readAccounts();
            if (accounts[i]) {
                if (text) {
                    accounts[i].risk = { level: level, text: text, checkedAt: Date.now() };
                } else {
                    delete accounts[i].risk;
                }
                writeAccounts(accounts);
                // 同步刷新内存用量缓存里的 risk,避免 /api/usage 仍返回旧值
                var c = usageCache[i];
                if (c && c.result) c.result.risk = text ? accounts[i].risk : undefined;
            }
            res.json({ level: level || null, text: text, teamEdition: false });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // ============ 重置卡(Coding Plan 个人版,仅管理员打开详情时加载)============

    app.get('/api/reset-cards/:index', checkAuth, async function(req, res) {
        try {
            var i = parseInt(req.params.index);
            var account = getAccount(req);
            if (!account) return res.status(404).json({ error: '未找到账号' });
            // 仅智谱个人版账号有重置卡;团队版(teamEdition)不适用。
            // 不用 JWT user_type 判断:部分个人订阅账号 JWT 也标 ENTERPRISE(见 weights.js 同款说明)
            if ((account.platform || 'glm') !== 'glm' || account.teamEdition) {
                return res.json({ cards: [] });
            }
            var json = await withGlmAuthRetry(account, i, function(acc) {
                return httpsGet(resetCardsUrl(), makeHeaders(acc));
            });
            var cards = parseGlmResetCards(json && json.data);
            // 每次打开详情刷新:有卡则记录数量与到期时间,无卡则清除(与风控同模式)
            persistGlmResetCards(i, cards);
            res.json({ cards: cards, checkedAt: Date.now() });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // 使用一张重置卡:先取最新列表校验该卡仍有效,再调官方 use 接口,成功后刷新本地缓存
    app.post('/api/reset-cards/:index/use', jsonParser, checkAuth, async function(req, res) {
        try {
            var i = parseInt(req.params.index);
            var account = getAccount(req);
            if (!account) return res.status(404).json({ error: '未找到账号' });
            if ((account.platform || 'glm') !== 'glm' || account.teamEdition) {
                return res.status(400).json({ error: '该账号不支持重置卡' });
            }
            var cardType = String((req.body && req.body.type) || '');
            var useType = RESET_CARD_USE_TYPES[cardType];
            var recordId = parseInt(req.body && req.body.recordId, 10);
            if (!useType || !Number.isInteger(recordId) || recordId <= 0) {
                return res.status(400).json({ error: '参数不正确,需要 type 与 recordId' });
            }
            // 用前校验:页面上的卡可能已被使用或过期,以官方最新列表为准
            var listJson = await withGlmAuthRetry(account, i, function(acc) {
                return httpsGet(resetCardsUrl(), makeHeaders(acc));
            });
            var stillValid = parseGlmResetCards(listJson && listJson.data).some(function(c) {
                return c.type === cardType && c.recordId === recordId;
            });
            if (!stillValid) return res.status(409).json({ error: '该重置卡已使用、已过期或不存在,请刷新后重试' });

            var json = await withGlmAuthRetry(account, i, function(acc) {
                return httpsRequest('POST', resetCardUseUrl(), makeHeaders(acc), {
                    targetType: 'PERSONAL',
                    resetType: useType,
                    recordId: recordId,
                    requestId: uuidV4()
                });
            });
            if (json && json.code != null && json.code !== 200) throw new Error(json.msg || '使用失败');

            // 使用成功后重取列表刷新缓存(该卡 available 置 false 即消失),并回传前端免二次请求
            var afterJson = await withGlmAuthRetry(account, i, function(acc) {
                return httpsGet(resetCardsUrl(), makeHeaders(acc));
            });
            var cards = parseGlmResetCards(afterJson && afterJson.data);
            persistGlmResetCards(i, cards);
            res.json({ success: true, cards: cards, checkedAt: Date.now() });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

};

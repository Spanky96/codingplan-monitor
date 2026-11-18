// API Keys / IP 白名单 / 风控提示 / 重置卡——均属智谱账号域(仅管理员可操作)。
var express = require('express');
var jsonParser = express.json();
var { httpsGet, httpsRequest } = require('../../lib/http');
var { readAccounts, writeAccounts } = require('../accounts');
var { checkAuth, isAuthed, isHiddenFromGuest } = require('../auth');
var { clearCacheIndex, patchCachedResult } = require('../cache');
var {
    makeHeaders, keysUrl, ipWhitelistUrl, riskInfoUrl, resetCardsUrl, resetCardUseUrl,
    subscriptionListUrl, RESET_CARD_USE_TYPES, RISK_TIPS, RISK_TIPS_FALLBACK, decodeJwtUserType,
    parseGlmResetCards, persistGlmResetCards, isValidIp, uuidV4, withGlmAuthRetry
} = require('../platforms/glm');

function getAccount(req) {
    var accounts = readAccounts();
    return accounts[parseInt(req.params.index)];
}

module.exports = function(app, options = {}) {
    const zcodeReset = options.zcodeReset || require('../../zcode/reset-cards').createResetService();
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
            patchCachedResult(i, { keyCount: keys.length });
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
                patchCachedResult(i, { risk: text ? accounts[i].risk : undefined });
            }
            res.json({ level: level || null, text: text, teamEdition: false });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // ============ 重置卡(Coding Plan 个人版,仅管理员打开详情时加载)============

    async function readResetCards(account, i) {
        var json = await withGlmAuthRetry(account, i, function(acc) {
            return httpsGet(resetCardsUrl(), makeHeaders(acc), { timeoutMs: 15000 });
        });
        if (!json || ![0, 200].includes(json.code) || !json.data ||
            !Array.isArray(json.data.fiveHourResets) || !Array.isArray(json.data.weekResets)) {
            throw new Error('获取智谱重置卡失败，请稍后重试');
        }
        var latest = readAccounts()[i];
        if (!latest || latest.name !== account.name || latest.authorization !== account.authorization ||
            latest.organization !== account.organization || latest.project !== account.project || latest.teamEdition !== account.teamEdition) {
            throw new Error('账号已变更，请重新打开详情');
        }
        var cards = parseGlmResetCards(json.data);
        persistGlmResetCards(i, cards);
        return { cards: cards, checkedAt: Date.now() };
    }

    app.get('/api/reset-cards/:index', checkAuth, async function(req, res) {
        res.set('Cache-Control', 'no-store');
        try {
            var i = parseInt(req.params.index);
            var account = getAccount(req);
            if (!account) return res.status(404).json({ error: '未找到账号' });
            // 仅智谱个人版账号有重置卡;团队版(teamEdition)不适用。
            // 不用 JWT user_type 判断:部分个人订阅账号 JWT 也标 ENTERPRISE(见 weights.js 同款说明)
            if ((account.platform || 'glm') !== 'glm' || account.teamEdition) {
                return res.json({ cards: [] });
            }
            res.json(await readResetCards(account, i));
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // Opening the admin detail may claim an available benefit, so use POST, not the read-only GET.
    app.post('/api/reset-cards/:index/refresh', checkAuth, async function(req, res) {
        res.set('Cache-Control', 'no-store');
        try {
            const i = Number(req.params.index);
            const account = Number.isInteger(i) && readAccounts()[i];
            if (!account) return res.status(404).json({ error: '未找到账号' });
            if ((account.platform || 'glm') !== 'glm' || account.teamEdition) return res.json({ cards: [] });
            let zcode;
            try { zcode = await zcodeReset.check(account, i); }
            catch (_) { zcode = { state: 'unavailable' }; }
            // ZCode status contains expiry times, but no recordId/grantType. The BigModel list is
            // authoritative for existing manual/automatic use, so never manufacture or merge IDs.
            const result = await readResetCards(account, i);
            const messages = {
                granted: 'ZCode 已发放重置卡，列表已更新。',
                not_eligible: '已检查 ZCode，当前没有可领取的新卡。',
                cooldown: '重置卡已更新，稍后会再次检查 ZCode 是否有新卡。',
                unavailable: '智谱重置卡已更新，ZCode 暂时无法检查，请稍后重试。'
            };
            let message = messages[zcode.state] || '';
            if (zcode.available && zcode.available.fiveHour + zcode.available.week > result.cards.length) {
                message = 'ZCode 显示的卡片正在同步到智谱，请稍后刷新。';
            }
            res.json({ ...result, zcode: { state: zcode.state, message, nextCheckAt: zcode.nextCheckAt || null } });
        } catch (_) { res.status(502).json({ error: '重置卡更新失败，请重新打开详情或稍后重试。' }); }
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
            var result = await require('../../scheduler/reset-cards').use(i, cardType, recordId);
            res.json(result);
        } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
    });

    // ============ 用户 ID（智谱订阅列表 customerId,仅管理员,详情页展示+复制）============

    app.get('/api/customer-id/:index', checkAuth, async function(req, res) {
        try {
            var i = parseInt(req.params.index);
            var account = getAccount(req);
            if (!account) return res.status(404).json({ error: '未找到账号' });
            if ((account.platform || 'glm') !== 'glm') return res.json({ customerId: null });
            // customerId 与账号绑定不变:accounts.json 已有则直接返回(?force=1 强制刷新)
            if (account.customerId && req.query.force !== '1') {
                return res.json({ customerId: account.customerId, cached: true });
            }
            var json = await withGlmAuthRetry(account, i, function(acc) {
                return httpsGet(subscriptionListUrl(), makeHeaders(acc));
            });
            var list = (json && json.data) || [];
            var active = (Array.isArray(list) ? list : []).find(function(s) { return s && s.status === 'VALID'; })
                || (Array.isArray(list) ? list[0] : null);
            var customerId = active && active.customerId != null ? String(active.customerId) : null;
            if (customerId) {
                var accounts = readAccounts();
                if (accounts[i]) {
                    accounts[i].customerId = customerId;
                    writeAccounts(accounts);
                }
                // 注意:不能 patchCachedResult——usage 缓存游客可读,customerId 仅管理员可见
            }
            res.json({ customerId: customerId });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

};

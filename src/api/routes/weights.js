// 权重接口(为中转站提供 token 分配权重,纯读缓存 + 默认兜底;绝不触发上游刷新)
// + 权重配置读写(管理员)。
var express = require('express');
var jsonParser = express.json();
var config = require('../../config');
var weights = require('../../weights');
var { readAccounts, writeAccounts } = require('../accounts');
var { buildWeightEntries, CACHE_TTL } = require('../cache');
var { checkAuth, clientIp, authBanState } = require('../auth');
var privacy = require('../privacy');

var PASSWORD = config.adminPassword;

module.exports = function(app) {
    app.get('/api/weights', function(req, res) {
        try {
            // 中转站等下游按账号名轮询本接口属常态（可不带密码），仅当带了错误密码才计入防爆破。
            // 计数已统一收敛到 privacy.isAdminRequest(下方 forcedPrivacy 内),此处只保留封禁拦截,
            // 避免同一次错误请求被记两遍(连续 3 次封 15 分钟的阈值不缩水)
            var authenticated = req.query.password === PASSWORD;
            if (!authenticated && req.query.password) {
                var wIp = clientIp(req);
                var wSt = authBanState(wIp, Date.now());
                if (wSt.banned) {
                    return res.status(429).json({ error: '密码连续错误次数过多，已封禁 ' + Math.ceil(wSt.retryAfterSec / 60) + ' 分钟，请稍后再试', retryAfterSec: wSt.retryAfterSec });
                }
            }
            var wantDetail = authenticated && req.query.detail === '1';
            var accounts = readAccounts();
            // 强制隐私(外网访客/全隐私)时 key 换账号别名(与 /api/usage 同一别名表),
            // 真实账号名不外发;中转站轮询请带 password(即视为管理员,拿真实账号名)。
            // 响应随请求方不同,禁止中间层缓存串号
            res.set('Cache-Control', 'no-store');
            var forceMask = privacy.forcedPrivacy(req);
            var aliasMap = forceMask ? privacy.buildAliasMap(accounts) : null;
            var result = {};
            var detail = [];
            var generatedAt = Date.now();
            var entries = buildWeightEntries(accounts, authenticated, generatedAt);
            for (var i = 0; i < entries.length; i++) {
                var entry = entries[i];
                var acc = entry.account;
                var cfg = weights.getWeightConfig(acc);
                var cached = entry.cached;                          // 纯读最近已知，绝不触发官方刷新
                var s = entry.score;
                var base = s ? s.weight : null;                      // token 失效/无缓存 → null → 走默认权重
                var final = weights.finalWeight(base, cfg);
                if (s && s.exhausted) final = 0;                     // 耗尽账号权重恒为 0,不受策略 A/D 复活
                result[forceMask ? aliasMap[entry.index] : acc.name] = final;
                if (wantDetail) {
                    detail.push({
                        index: entry.index, name: acc.name, platform: entry.platform, weight: final,
                        base: base, source: base === null ? 'default' : 'computed',
                        strategy: cfg.strategy, configValue: cfg.value, defaultWeight: cfg.defaultWeight,
                        score5h: s ? s.score5h : null, score7d: s ? s.score7d : null,
                        used5h: s ? s.used5h : null, used7d: s ? s.used7d : null,
                        theo5h: s ? s.theo5h : null, theo7d: s ? s.theo7d : null,
                        exhausted: s ? s.exhausted : false,
                        availableBalance: s && s.availableBalance != null ? s.availableBalance : null,
                        averageDaily: s && s.averageDaily != null ? s.averageDaily : null,
                        remainingDays: s && s.remainingDays != null ? s.remainingDays : null,
                        noConsumption: s ? !!s.noConsumption : false,
                        capacityScore: s && s.capacityScore != null ? s.capacityScore : null,
                        codingAverage: s && s.codingAverage != null ? s.codingAverage : null,
                        codingPressure: s && s.codingPressure != null ? s.codingPressure : null,
                        codingSampleSize: s && s.codingSampleSize != null ? s.codingSampleSize : null,
                        timeMultiplier: s && s.timeMultiplier != null ? s.timeMultiplier : null,
                        peak: s ? !!s.peak : false,
                        cachedAt: cached ? cached.cachedAt : null
                    });
                }
            }
            if (wantDetail) {
                res.json({ weights: result, detail: detail, generatedAt: generatedAt, cacheTtlMs: CACHE_TTL });
            } else {
                res.json(result);
            }
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // ---- sub2api 容量快照（代理拉取 + 5s 内存缓存）----
    // 供监控页渲染「当前调度中|总容量」胶囊；按 matched_key 聚合后悬浮可看
    // 指向同一权重的多个 sub2api 账号细分。sub2api 侧快照为内网开放数据。
    // 未配置 SUB2API_BASE_URL 时整体禁用(前端也不会轮询本接口)。
    var _sub2apiCapacityCache = { at: 0, data: null };
    app.get('/api/weights/config', checkAuth, function(req, res) {
        try {
            var accounts = readAccounts();
            var list = [];
            var entries = buildWeightEntries(accounts, true, Date.now());
            for (var i = 0; i < entries.length; i++) {
                var entry = entries[i];
                var acc = entry.account;
                var cfg = weights.getWeightConfig(acc);
                var s = entry.score;
                var base = s ? s.weight : null;
                var finalW = weights.finalWeight(base, cfg);
                if (s && s.exhausted) finalW = 0;                    // 耗尽账号权重恒为 0
                list.push({ index: entry.index, name: acc.name, platform: entry.platform, config: cfg, base: base, final: finalW, exhausted: s ? s.exhausted : false });
            }
            res.json(list);
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // 权重配置写入(管理员):{ defaultWeight, strategy, value } 任选提供
    app.put('/api/weights/config/:index', jsonParser, checkAuth, function(req, res) {
        try {
            var accounts = readAccounts();
            var idx = parseInt(req.params.index);
            if (!accounts[idx]) return res.status(404).json({ error: '未找到账号' });
            var cfg = weights.getWeightConfig(accounts[idx]);
            if (req.body && req.body.defaultWeight != null) cfg.defaultWeight = req.body.defaultWeight;
            if (req.body && req.body.strategy != null) cfg.strategy = req.body.strategy;
            if (req.body && req.body.value != null) cfg.value = req.body.value;
            cfg = weights.getWeightConfig({ weightConfig: cfg });   // 复用校验/兜底
            accounts[idx].weightConfig = cfg;
            writeAccounts(accounts);
            res.json({ success: true, index: idx, config: cfg });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

};

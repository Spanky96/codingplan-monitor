// ---- sub2api 容量快照 + 中转站实时面板快照(代理拉取 + 内存缓存)----
// 容量胶囊(5s 缓存):监控页渲染「当前调度中|总容量」;按 matched_key 聚合后悬浮可看
// 指向同一权重的多个 sub2api 账号细分。sub2api 侧快照为内网开放数据。
// 实时面板:活动快照(10s 缓存)与今日用量榜(4min 缓存,force=1 旁路),
// 均代理中转站快照端点;未配置 SUB2API_BASE_URL 时整体禁用(前端也不轮询)。
var config = require('../../config');
var { httpGetJSON } = require('../../lib/http');

var PASSWORD = config.adminPassword;
var SUB2API_BASE = config.sub2apiBaseUrl;
var RELAY_SNAPSHOT_TOKEN = config.relaySnapshotToken;

module.exports = function(app) {

    // ---- sub2api 容量快照（代理拉取 + 5s 内存缓存）----
    // 供监控页渲染「当前调度中|总容量」胶囊；按 matched_key 聚合后悬浮可看
    // 指向同一权重的多个 sub2api 账号细分。sub2api 侧快照为内网开放数据。
    // 未配置 SUB2API_BASE_URL 时整体禁用(前端也不会轮询本接口)。
    var _sub2apiCapacityCache = { at: 0, data: null };
    app.get('/api/sub2api/capacity', function(req, res) {
        try {
            if (!config.relayEnabled) return res.status(404).json({ error: 'SUB2API_BASE_URL 未配置,中转站功能未启用' });
            if (req.query.password !== PASSWORD) return res.status(401).json({ error: 'unauthorized' });
            var now = Date.now();
            if (_sub2apiCapacityCache.data && now - _sub2apiCapacityCache.at < 5000) {
                return res.json(_sub2apiCapacityCache.data);
            }
            var url = SUB2API_BASE.replace(/\/+$/, '') + '/api/weight-snapshot';
            httpGetJSON(url, 5000).then(function(envelope) {
                // sub2api 统一信封 {code:0, message, data:{generated_at, accounts:[...]}}
                var data = (envelope && envelope.code === 0 && envelope.data) ? envelope.data : null;
                if (!data || !Array.isArray(data.accounts)) {
                    return res.status(502).json({ error: 'unexpected sub2api snapshot shape' });
                }
                _sub2apiCapacityCache = { at: Date.now(), data: data };
                res.json(data);
            }).catch(function(err) {
                res.status(502).json({ error: 'sub2api snapshot fetch failed: ' + err.message });
            });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // ---- 用户实时活动快照(代理拉取 + 内存缓存,调度/用量两个端点)----
    // 调度快照(高频,15s 轮询):当前有占用/排队用户 + 近跑模型;
    // 用量榜单(低频,5 分钟轮询 + 手动刷新):今日站内+外部合并 + 按模型明细。
    // 数据来自中转站内网开放端点(可用 RELAY_SNAPSHOT_TOKEN 开启门禁)。
    var _relayActivityCache = { at: 0, data: null };
    function relaySnapshotUrl(path) {
        var url = SUB2API_BASE.replace(/\/+$/, '') + path;
        if (RELAY_SNAPSHOT_TOKEN) url += '?token=' + encodeURIComponent(RELAY_SNAPSHOT_TOKEN);
        return url;
    }
    app.get('/api/relay/activity', function(req, res) {
        try {
            if (!config.relayEnabled) return res.status(404).json({ error: 'SUB2API_BASE_URL 未配置,中转站功能未启用' });
            if (req.query.password !== PASSWORD) return res.status(401).json({ error: 'unauthorized' });
            var now = Date.now();
            if (_relayActivityCache.data && now - _relayActivityCache.at < 10000) {
                return res.json(_relayActivityCache.data);
            }
            httpGetJSON(relaySnapshotUrl('/api/user-activity-snapshot'), 8000).then(function(envelope) {
                // sub2api 统一信封 {code:0, message, data:{generated_at, users:[...]}}
                var data = (envelope && envelope.code === 0 && envelope.data) ? envelope.data : null;
                if (!data || !Array.isArray(data.users)) {
                    return res.status(502).json({ error: 'unexpected relay activity snapshot shape' });
                }
                _relayActivityCache = { at: Date.now(), data: data };
                res.json(data);
            }).catch(function(err) {
                res.status(502).json({ error: 'relay activity snapshot fetch failed: ' + err.message });
            });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    var _relayUsageCache = { at: 0, data: null };
    app.get('/api/relay/usage', function(req, res) {
        try {
            if (!config.relayEnabled) return res.status(404).json({ error: 'SUB2API_BASE_URL 未配置,中转站功能未启用' });
            if (req.query.password !== PASSWORD) return res.status(401).json({ error: 'unauthorized' });
            var now = Date.now();
            if (req.query.force !== '1' && _relayUsageCache.data && now - _relayUsageCache.at < 4 * 60 * 1000) {
                return res.json(_relayUsageCache.data);
            }
            httpGetJSON(relaySnapshotUrl('/api/user-usage-snapshot'), 15000).then(function(envelope) {
                var data = (envelope && envelope.code === 0 && envelope.data) ? envelope.data : null;
                if (!data || !Array.isArray(data.users)) {
                    return res.status(502).json({ error: 'unexpected relay usage snapshot shape' });
                }
                _relayUsageCache = { at: Date.now(), data: data };
                res.json(data);
            }).catch(function(err) {
                res.status(502).json({ error: 'relay usage snapshot fetch failed: ' + err.message });
            });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // 权重配置读取(管理员):每个账号的 weightConfig + 当前 base/final
};

'use strict';
const express = require('express');
const { checkAuth } = require('../auth');
const { readAccounts } = require('../accounts');
const store = require('../../scheduler/store');
const service = require('../../scheduler/service');
const modelPolicy = require('../../scheduler/glm-model-policy');
module.exports = function(app) {
    app.get('/api/scheduler', checkAuth, async function(req, res) {
        try {
            if (Date.now() - service.status().observedAt > 30000) {
                try { await service.telemetry(); } catch (_) { /* status still renders offline */ }
            }
            res.set('Cache-Control', 'no-store').json(service.status());
        }
        catch (e) { res.status(500).json({ error: e.message }); }
    });
    app.post('/api/scheduler/preview', checkAuth, async function(req, res) {
        try { await service.telemetry(); await service.cycle({ preview: true }); res.json(service.status()); }
        catch (e) { res.status(502).json({ error: e.message }); }
    });
    app.put('/api/scheduler/glm-models', express.json(), checkAuth, async function(req, res) {
        try {
            const policy = modelPolicy.validate(req.body, readAccounts(), store.read().config);
            const relay = await service.telemetry();
            if (relay.glm_flash_version !== 1 || !relay.weight_sync_enabled) throw new Error('请先升级中转站并开启权重同步');
            store.update(s => {
                s.glmModelPolicy = policy;
                if (!s.controllerId) s.controllerId = require('crypto').randomUUID();
            });
            store.event('glm-model', '智谱模型策略已保存：' + ({ all: '全部 Flash', auto: '自动降级', original: '原模型映射' })[policy.mode]);
            await service.push();
            res.json(service.status());
        } catch (e) { res.status(400).json({ error: e.message }); }
    });
    app.put('/api/scheduler', express.json(), checkAuth, async function(req, res) {
        try {
            let config = store.validate(req.body, readAccounts(), store.read().config);
            if (config.enabled) {
                const snapshot = await service.telemetry();
                if (snapshot.smart_scheduler_version !== 2) throw new Error('请先部署支持智能调度协议的中转站版本');
                if (!snapshot.weight_sync_enabled) throw new Error('请先在中转站启用权重同步，并将地址指向本监控服务');
                if (!service.status().syncConfigured) throw new Error('请在两个服务配置相同的 SCHEDULER_SYNC_TOKEN');
            }
            store.update(s => {
                // Telemetry yields to account edits; validate the inventory at commit time.
                config = store.validate(req.body, readAccounts(), s.config);
                s.config = config; s.configChangedAt = Date.now();
                if (!s.controllerId) s.controllerId = require('crypto').randomUUID();
            });
            store.event('config', config.enabled ? '智能调度配置已保存并启动' : '智能调度已停止，交还原权重策略');
            if (config.enabled) {
                service.persistPlan();
                await service.push();
                service.cycle().catch(() => {});
            } else await service.push();
            res.json({ ...service.status(), removedAccountCount: req.body.accounts.length - config.accounts.length });
        } catch (e) { res.status(400).json({ error: e.message }); }
    });
};

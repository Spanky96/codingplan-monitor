'use strict';
const express = require('express');
const { checkAuth } = require('../auth');
const { readAccounts } = require('../accounts');
const store = require('../../scheduler/store');
const service = require('../../scheduler/service');
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
    app.put('/api/scheduler', express.json(), checkAuth, async function(req, res) {
        try {
            const config = store.validate(req.body, readAccounts());
            if (config.enabled) {
                const snapshot = await service.telemetry();
                if (snapshot.smart_scheduler_version !== 2) throw new Error('请先部署支持智能调度协议的中转站版本');
                if (!snapshot.weight_sync_enabled) throw new Error('请先在中转站启用权重同步，并将地址指向本监控服务');
                if (!service.status().syncConfigured) throw new Error('请在两个服务配置相同的 SCHEDULER_SYNC_TOKEN');
            }
            store.update(s => {
                s.config = config; s.configChangedAt = Date.now();
                if (!s.controllerId) s.controllerId = require('crypto').randomUUID();
            });
            store.event('config', config.enabled ? '智能调度配置已保存并启动' : '智能调度已停止，交还原权重策略');
            if (config.enabled) {
                service.persistPlan();
                await service.push();
                service.cycle().catch(() => {});
            } else await service.push();
            res.json(service.status());
        } catch (e) { res.status(400).json({ error: e.message }); }
    });
};

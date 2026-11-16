'use strict';
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { concurrencyCeiling } = require('./adaptation');
const file = process.env.SCHEDULER_STATE_FILE || path.join(path.dirname(config.accountsFile), 'scheduler-state.json');
const defaults = { enabled: false, allowPaid: false, allowDilution: false, fallbackWhen: 'exhausted', accounts: [],
    staleAfterSeconds: 600, resetMinRemainingMinutes: 60, resetWeekMinHours: 24 };
function read() {
    if (!fs.existsSync(file)) return { config: { ...defaults }, journal: {}, events: [] };
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    ['maxResetsPerDay', 'reserveWeeklyCards', 'reserveFiveHourCards'].forEach(k => { if (data.config) delete data.config[k]; });
    return { ...data, config: { ...defaults, ...data.config }, journal: data.journal || {}, events: data.events || [] };
}
function write(data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = file + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(temp, file);
}
function update(fn) { const data = read(); fn(data); write(data); return data; }
function event(type, message, extra) {
    return update(data => { data.events.unshift({ at: Date.now(), type, message, ...extra }); data.events = data.events.slice(0, 100); });
}
function validate(input, accounts) {
    if (!input || !Array.isArray(input.accounts)) throw new Error('请选择参与账号');
    const names = new Set();
    const list = input.accounts.map(p => {
        const matches = accounts.filter(a => a.name === p.name);
        if (matches.length !== 1 || names.has(p.name)) throw new Error('账号名称必须存在且唯一：' + p.name);
        names.add(p.name);
        if (!['primary', 'paid', 'standard', 'dilution'].includes(p.role)) throw new Error('账号角色无效');
        const platform = matches[0].platform || 'glm';
        if (p.role === 'primary' && platform !== 'glm') throw new Error('主力池仅支持智谱 Coding Plan');
        // Paid placeholders may have no provider adapter (e.g. glm-智云-无锡).
        if (!Number.isInteger(p.maxConcurrency) || p.maxConcurrency < 1 || p.maxConcurrency > 64) throw new Error('并发上限须为 1–64');
        const scale = p.quotaScale == null ? 1 : Number(p.quotaScale);
        if (!Number.isFinite(scale) || scale < 0.1 || scale > 20) throw new Error('套餐容量系数须为 0.1–20');
        const mode = p.mode || 'auto';
        if (!['auto', 'slow', 'burst'].includes(mode)) throw new Error('调度模式无效');
        const replenishAt = p.replenishAt ? Date.parse(p.replenishAt) : null;
        if (p.replenishAt && !Number.isFinite(replenishAt)) throw new Error('预计补充额度时间无效');
        const channelModes = {};
        if (p.channelModes != null && (typeof p.channelModes !== 'object' || Array.isArray(p.channelModes))) throw new Error('渠道配置无效');
        for (const [id, route] of Object.entries(p.channelModes || {})) {
            if (!/^[1-9]\d*$/.test(id) || !['native', 'fallback', 'paused'].includes(route)) throw new Error('渠道配置无效');
            channelModes[id] = route;
        }
        return { name: p.name, role: p.role === 'dilution' ? 'standard' : p.role, mode, ...(p.channelModes == null ? {} : { channelModes }), maxConcurrency: concurrencyCeiling(p), quotaScale: scale,
            replenishAt: replenishAt ? new Date(replenishAt).toISOString() : null,
            autoReset: p.role === 'primary' && platform === 'glm' && !matches[0].teamEdition && p.autoReset === true,
            unmetered: p.role === 'paid' && p.unmetered === true, paused: p.paused === true };
    });
    if (input.enabled && !list.length) throw new Error('请至少选择一个账号');
    const fallbackWhen = input.fallbackWhen || 'exhausted';
    if (!['exhausted', 'pressure'].includes(fallbackWhen)) throw new Error('兜底时机无效');
    return { ...defaults, fallbackWhen, enabled: input.enabled === true, allowPaid: input.allowPaid === true,
        allowDilution: input.allowDilution === true, accounts: list };
}
module.exports = { read, write, update, event, validate, defaults };

'use strict';
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { types, accountType, roleFor } = require('./account-types');
const { concurrencyCeiling } = require('./adaptation');
const file = process.env.SCHEDULER_STATE_FILE || path.join(path.dirname(config.accountsFile), 'scheduler-state.json');
const defaults = { enabled: false, allowPaid: false, allowDilution: false, fallbackWhen: 'exhausted', accounts: [],
    staleAfterSeconds: 600, resetMinRemainingMinutes: 60, resetWeekMinHours: 24 };
function read() {
    if (!fs.existsSync(file)) return { config: { ...defaults }, journal: {}, events: [] };
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    ['maxResetsPerDay', 'reserveWeeklyCards', 'reserveFiveHourCards'].forEach(k => { if (data.config) delete data.config[k]; });
    // A legacy policy without the positive flag had no permission to spend.
    for (const p of data.config?.accounts || []) {
        if (p.autoReset == null) p.autoReset = false;
    }
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
// Account management and the scheduler write different files. Reconciliation is
// idempotent, and validate() repeats the membership check on every scheduler save.
function pruneRemoved(accounts) {
    if (!fs.existsSync(file)) return false;
    const state = read(), config = state.config;
    const live = new Set(accounts.map(a => a.name));
    const selected = config.accounts.filter(p => live.has(p.name));
    const removedTypes = Object.keys(config.accountTypes || {}).filter(name => !live.has(name));
    const pins = state.glmModelPolicy?.flashAccounts || [];
    const remainingPins = pins.filter(name => live.has(name));
    if (selected.length === config.accounts.length && !removedTypes.length && pins.length === remainingPins.length) return false;
    if (config.accounts.length && !selected.length) config.enabled = false;
    config.accounts = selected;
    removedTypes.forEach(name => { delete config.accountTypes[name]; });
    if (state.glmModelPolicy) state.glmModelPolicy.flashAccounts = remainingPins;
    write(state);
    return true;
}
function validate(input, accounts, previous = defaults) {
    if (!input || !Array.isArray(input.accounts)) throw new Error('请选择参与账号');
    if (input.accountTypes != null && (typeof input.accountTypes !== 'object' || Array.isArray(input.accountTypes))) throw new Error('账号类型配置无效');
    const names = new Set();
    const live = new Set(accounts.map(a => a.name));
    const selected = input.accounts.filter(p => {
        if (!p || typeof p.name !== 'string' || !p.name.trim()) throw new Error('缺少账号名称');
        // A console can stay open while the monitored inventory changes.
        return live.has(p.name);
    });
    const accountTypes = Object.fromEntries(accounts.map(a => {
        const hasType = input.accountTypes && Object.hasOwn(input.accountTypes, a.name);
        const policy = selected.find(p => p.name === a.name);
        const type = hasType ? input.accountTypes[a.name] : accountType(policy ? { accounts: [policy] } : previous, a);
        if (!types.includes(type)) throw new Error('账号类型无效：' + a.name);
        return [a.name, type];
    }));
    const list = selected.map(p => {
        const matches = accounts.filter(a => a.name === p.name);
        if (matches.length !== 1 || names.has(p.name)) throw new Error('账号名称重复：' + p.name);
        names.add(p.name);
        const explicitType = input.accountTypes && Object.hasOwn(input.accountTypes, p.name);
        if (!explicitType && !['primary', 'paid', 'standard', 'dilution'].includes(p.role)) throw new Error('账号角色无效');
        const role = roleFor(accountTypes[p.name], matches[0]);
        if (!explicitType && p.role === 'primary' && role !== 'primary') throw new Error('主力池仅支持智谱 Coding Plan');
        if (!Number.isInteger(p.maxConcurrency) || p.maxConcurrency < 1 || p.maxConcurrency > 64) throw new Error('并发上限须为 1–64');
        const scale = p.quotaScale == null ? 1 : Number(p.quotaScale);
        if (!Number.isFinite(scale) || scale < 0.1 || scale > 20) throw new Error('套餐容量系数须为 0.1–20');
        if (p.autoReset !== undefined && typeof p.autoReset !== 'boolean') throw new Error('用卡设置须为布尔值');
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
        return { name: p.name, role, mode, ...(p.channelModes == null ? {} : { channelModes }), maxConcurrency: concurrencyCeiling({ ...p, role }), quotaScale: scale,
            replenishAt: replenishAt ? new Date(replenishAt).toISOString() : null,
            autoReset: role === 'primary' && !matches[0].teamEdition && p.autoReset !== false,
            unmetered: role === 'paid' && p.unmetered === true, paused: p.paused === true };
    });
    const removedLast = !list.length && (input.accounts.length > 0 ||
        (previous.accounts.length > 0 && previous.accounts.every(p => !live.has(p.name))));
    if (input.enabled && !list.length && !removedLast) throw new Error('请至少选择一个账号');
    const fallbackWhen = input.fallbackWhen || 'exhausted';
    if (!['exhausted', 'pressure'].includes(fallbackWhen)) throw new Error('兜底时机无效');
    return { ...defaults, fallbackWhen, enabled: input.enabled === true && list.length > 0, accountTypes, allowPaid: input.allowPaid === true,
        allowDilution: input.allowDilution === true, accounts: list };
}
module.exports = { read, write, update, event, validate, pruneRemoved, defaults };

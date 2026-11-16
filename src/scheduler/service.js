'use strict';
const config = require('../config');
const store = require('./store');
const { plan, windowsOf, validCards, EXHAUSTED } = require('./planner');
const { readAccounts } = require('../api/accounts');
const cache = require('../api/cache');
const { concurrencyCeiling, resetAllowed } = require('./adaptation');
const { httpGetJSON } = require('../lib/http');
const { poolDemand } = require('./demand');
const { boundChannelCapacity } = require('./channels');

const LEASE_MS = 180000;
let running = null, timer = null, snapshot = null, snapshotAt = 0, integrationError = null, activity = null;
let lastPush = null;
const cardChecks = {};
function supportsCardInventory(account, policies) {
    return (account.platform || 'glm') === 'glm' && !account.teamEdition &&
        !policies.some(p => p.name === account.name && p.role === 'paid');
}
function matchKey(names, name) {
    return names.filter(n => n && name.startsWith(n)).sort((a, b) => b.length - a.length)[0];
}
async function telemetry() {
    if (!config.relayEnabled) throw new Error('请配置 SUB2API_BASE_URL');
    const activityUrl = config.sub2apiBaseUrl + '/api/user-activity-snapshot' + (config.relaySnapshotToken ? '?token=' + encodeURIComponent(config.relaySnapshotToken) : '');
    const [weights, users] = await Promise.allSettled([
        httpGetJSON(config.sub2apiBaseUrl + '/api/weight-snapshot', 8000), httpGetJSON(activityUrl, 8000)
    ]);
    if (users.status === 'fulfilled' && users.value.code === 0 && Array.isArray((users.value.data || {}).users)) {
        const list = users.value.data.users;
        activity = { at: Date.now(), inUse: list.reduce((n,u)=>n+Math.max(0,u.current_in_use||0),0), waiting: list.reduce((n,u)=>n+Math.max(0,u.waiting_in_queue||0),0) };
    } else activity = null;
    if (weights.status !== 'fulfilled') throw weights.reason;
    const envelope = weights.value;
    if (!envelope || envelope.code !== 0 || !envelope.data || !Array.isArray(envelope.data.accounts)) throw new Error('中转站容量响应无效');
    snapshot = envelope.data; snapshotAt = Date.now(); integrationError = null;
    return snapshot;
}
function aggregate(accounts) {
    const names = accounts.map(a => a.name), result = {};
    if (!snapshot || Date.now() - snapshotAt > 90000) return result;
    snapshot.accounts.forEach(a => {
        const key = matchKey(names, a.name);
        if (!key) return;
        const r = result[key] || (result[key] = { count: 0, current: 0, capacity: 0, limited: false, healthy: 0, channels: [] });
        r.channels.push({ id: a.id, name: a.name, platform: a.platform, suggestedMode: a.suggested_scheduling_mode || 'native', mode: a.scheduling_mode || null,
            current: a.current_concurrency || 0, capacity: a.concurrency || 0, weight: a.weight || 0, enabled: !!a.effective_schedulable });
        r.count++; r.current += a.current_concurrency || 0; r.capacity += a.concurrency || 0;
        r.limited = r.limited || !!a.rate_limited;
        r.demandAt = Math.max(r.demandAt || 0, a.recent_demand_at || 0);
        if (!a.upstream_blocked && a.status === 'active') r.healthy++;
        r.unavailable = r.healthy === 0;
    });
    return result;
}
function compute(state = store.read()) {
    const accounts = readAccounts();
    const usage = accounts.map((_, i) => cache.getCachedLastKnown(i));
    const previous = Object.fromEntries(((state.plan || {}).rows || []).map(r => [r.name, r]));
    const result = plan({ config: state.config, accounts, usage, telemetry: aggregate(accounts), previous,
        previousSummary: (state.plan || {}).summary || {}, load: snapshot ? poolDemand(snapshot, activity, state.config.accounts, Date.now()) : null, now: Date.now() });
    result.rows.forEach(r => {
        const pending = state.pendingResets && state.pendingResets[r.name];
        if (pending) {
            r.weight = 0; r.nativeWeight = 0; r.fallbackWeight = 0; r.share = 0; r.state = 'reset-verifying'; r.reset = null;
            r.reasons = ['重置已提交，等待官方额度恢复确认'];
        }
        r.resetVerifiedAt = ((state.verifiedResets || {})[r.name]) || 0;
    });
    const sum = result.rows.reduce((n, r) => n + r.weight, 0);
    result.rows.forEach(r => { r.share = sum ? Math.round(r.weight / sum * 1000) / 10 : 0; });
    result.summary.active = result.rows.filter(r => r.weight > 0).length;
    result.summary.unavailable = !result.summary.active;
    result.summary.capacity = result.rows.filter(r => r.weight > 0).reduce((n, r) => n + r.concurrency, 0);
    result.summary.paid = result.rows.some(r => r.role === 'paid' && r.weight > 0);
    result.summary.dilution = result.rows.some(r => r.fallbackWeight > 0);
    return result;
}
function persistPlan() {
    const state = store.read(), next = compute(state);
    const changed = next.rows.filter(r => {
        const before = ((state.plan || {}).rows || []).find(x => x.name === r.name);
        return before && (before.state !== r.state || before.concurrency !== r.concurrency || (before.weight > 0) !== (r.weight > 0));
    });
    store.update(s => {
        s.plan = next;
        if (s.config.enabled && changed.length) {
            s.events.unshift({ at: Date.now(), type: 'plan', message: changed.slice(0, 3).map(r =>
                r.name + '：权重 ' + r.weight + ' / 并发 ' + r.concurrency + '，' + r.reasons[0]
            ).join('；') + (changed.length > 3 ? '；另 ' + (changed.length - 3) + ' 个账号调整' : '') });
            s.events = s.events.slice(0, 100);
        }
    });
    return next;
}
function controls(state = store.read(), now = Date.now()) {
    if (!state.config.enabled) return {};
    const rows = (state.plan && state.plan.rows) || [];
    const fresh = state.plan && now - state.plan.generatedAt < LEASE_MS &&
        state.plan.generatedAt >= (state.configChangedAt || 0);
    const accounts = readAccounts();
    return Object.fromEntries(state.config.accounts.map(p => {
        const r = rows.find(r => r.name === p.name);
        const index = accounts.findIndex(a => a.name === p.name), u = cache.getCachedLastKnown(index);
        const unmetered = p.role === 'paid' && p.unmetered;
        const validUsage = unmetered || (u && u.name === p.name && u.success && now - u.cachedAt <= state.config.staleAfterSeconds * 1000);
        const exhausted = !unmetered && windowsOf(u).some(w => w.used >= EXHAUSTED);
        const pending = (state.pendingResets || {})[p.name];
        const usable = fresh && r && validUsage && !exhausted && !pending;
        const concurrency = fresh && r ? Math.min(r.concurrency, concurrencyCeiling(p)) : 1;
        return [p.name, { weight: usable ? (r.nativeWeight == null ? r.weight : r.nativeWeight) : 0, fallback_weight: usable ? (r.fallbackWeight || 0) : 0,
            ...(r && r.channelConcurrency ? { channel_concurrency: boundChannelCapacity(r.channelModes || {}, r.channelConcurrency, usable ? concurrency : 0) } : {}),
            channel_modes: r && r.channelModes ? r.channelModes : (p.channelModes || {}), concurrency,
            priority: r ? r.priority : 999, expires_at: new Date(fresh ? state.plan.generatedAt + LEASE_MS : now + LEASE_MS).toISOString() }];
    }));
}
function decision(name) {
    const state = store.read();
    if (!state.config.enabled || !state.config.accounts.some(p => p.name === name)) return null;
    const r = ((state.plan || {}).rows || []).find(r => r.name === name);
    const c = controls(state)[name];
    return { ...(r || { name, state: 'starting', reasons: ['等待首轮调度计划'] }), weight: c.weight + c.fallback_weight, managed: true };
}
async function push() {
    if (!config.relayEnabled || !config.schedulerSyncToken) {
        lastPush = { synced: false, at: Date.now(), message: '未配置即时同步通道，等待中转站轮询' };
        return lastPush;
    }
    try {
        const res = await fetch(config.sub2apiBaseUrl + '/api/smart-scheduling/sync', {
            method: 'POST', headers: { 'X-Scheduler-Token': config.schedulerSyncToken }, signal: AbortSignal.timeout(15000)
        });
        if (!res.ok) throw new Error('中转站同步返回 HTTP ' + res.status);
        const envelope = await res.json();
        if (envelope.code !== 0) throw new Error('中转站未确认同步成功');
        const state = store.read();
        if (state.controllerId && (!envelope.data || envelope.data.controller_id !== state.controllerId)) throw new Error('中转站的权重源未指向本监控服务，请检查权重同步地址');
        if (state.config.enabled && (!envelope.data || envelope.data.protocol_version !== 2 || !envelope.data.managed)) throw new Error('中转站尚未接管所选账号，请检查名称匹配和权重同步地址');
        lastPush = { synced: true, at: Date.now(), ...envelope.data };
        try { await telemetry(); } catch (_) { /* sync acknowledgment remains valid */ }
    } catch (e) { lastPush = { synced: false, at: Date.now(), message: e.message }; }
    return lastPush;
}
async function confirmPending() {
    const state = store.read(), accounts = readAccounts();
    Object.entries(state.pendingResets || {}).forEach(([name, pending]) => {
        const i = accounts.findIndex(a => a.name === name), u = cache.getCachedLastKnown(i);
        const w = windowsOf(u).find(w => w.type === pending.type);
        const decreased = w && pending.beforeUsed != null && w.used + 0.5 < pending.beforeUsed;
        const newWindow = w && Number.isFinite(w.resetAt) && pending.beforeResetAt && w.resetAt !== pending.beforeResetAt;
        const confirmedEmpty = w && pending.status === 'used' && w.used <= 1;
        if (u && u.name === name && u.cachedAt >= pending.at && w && w.used < EXHAUSTED && (decreased || newWindow || confirmedEmpty)) {
            store.update(s => {
                delete s.pendingResets[name];
                (s.verifiedResets || (s.verifiedResets = {}))[name] = Date.now();
            });
            store.event('reset-verified', name + '：已确认额度恢复');
        }
    });
}
async function afterReset(name, type, at) {
    store.update(s => {
        const pending = s.pendingResets || (s.pendingResets = {});
        if (!pending[name]) pending[name] = { type, at, status: 'used' };
    });
    const accounts = readAccounts(), i = accounts.findIndex(a => a.name === name);
    if (i < 0) return { synced: false, message: '账号已变更，待核对' };
    await cache.ensureUsageFetch(accounts[i], i, true);
    await confirmPending();
    if (store.read().config.enabled) persistPlan();
    const pending = (store.read().pendingResets || {})[name];
    if (pending) return { synced: false, message: '等待官方额度更新，将自动继续验证' };
    return push();
}
async function cycle({ preview = false } = {}) {
    if (running) return running;
    running = (async () => {
        let state = store.read();
        if (!state.config.enabled && !preview && !Object.keys(state.pendingResets || {}).length) return null;
        try { await telemetry(); } catch (e) { integrationError = e.message; }
        const accounts = readAccounts();
        const names = new Set(state.config.accounts.map(p => p.name).concat(Object.keys(state.pendingResets || {})));
        const jobs = accounts.map((a, i) => ({ a, i })).filter(j => names.has(j.a.name) || supportsCardInventory(j.a, state.config.accounts));
        // Only two official requests in flight; background operation does not depend on an open browser.
        let cursor = 0;
        await Promise.all([0, 1].map(async () => {
            while (cursor < jobs.length) {
                const { a, i } = jobs[cursor++];
                const u = cache.getCachedLastKnown(i);
                if (names.has(a.name) && (!u || u.name !== a.name || Date.now() - u.cachedAt >= 60000 || (state.pendingResets || {})[a.name])) {
                    try { await cache.ensureUsageFetch(a, i, true); } catch (_) { /* stale data becomes weight zero */ }
                }
                const p = state.config.accounts.find(p => p.name === a.name);
                const cardInterval = resetAllowed(p, a) ? 600000 : 1800000;
                if (supportsCardInventory(a, state.config.accounts) && Date.now() - Math.max(cardChecks[a.name] || 0, ((a.resetCards || {}).checkedAt || 0)) > cardInterval) {
                    cardChecks[a.name] = Date.now();
                    try { await require('./reset-cards').list(a, i); } catch (_) { /* no assumed cards */ }
                }
            }
        }));
        await confirmPending();
        let next = persistPlan();
        if (!preview && store.read().config.enabled) {
            // One reset at a time; the journal and pending confirmation prevent duplicate spending.
            const candidate = next.rows.filter(r => r.reset).sort((a, b) => b.resetDecision.benefit - a.resetDecision.benefit)[0];
            const confirmed = lastPush && lastPush.synced && lastPush.protocol_version === 2 && Date.now() - lastPush.at < LEASE_MS;
            if (candidate && confirmed) {
                try { await require('./reset-cards').use(candidate.index, candidate.reset.type, candidate.reset.recordId, true); }
                catch (e) {
                    const last = store.read().events[0];
                    const message = candidate.name + '：' + e.message;
                    if (!last || last.message !== message || Date.now() - last.at > 600000) store.event('reset-skipped', message);
                }
                next = persistPlan();
            }
            await push();
        } else if (!preview && Object.keys(state.pendingResets || {}).length) await push();
        return next;
    })().finally(() => { running = null; });
    return running;
}
function status() {
    const state = store.read(), accounts = readAccounts(), live = aggregate(accounts);
    // Inventory includes unselected accounts and accounts without spending permission.
    // Exclude expired cards; expose coverage so a missing snapshot is never called zero.
    const resetCards = { total: 0, week: 0, fiveHour: 0, checkedAccounts: 0, accounts: 0, oldestCheckedAt: null };
    accounts.filter(a => supportsCardInventory(a, state.config.accounts)).forEach(a => {
        resetCards.accounts++;
        const checkedAt = (a.resetCards || {}).checkedAt;
        if (!checkedAt) return;
        resetCards.checkedAccounts++;
        resetCards.oldestCheckedAt = Math.min(resetCards.oldestCheckedAt || checkedAt, checkedAt);
        validCards(a, Date.now()).forEach(c => { resetCards[c.type]++; resetCards.total++; });
    });
    let appliedFallback = null;
    if (snapshot && Date.now() - snapshotAt < 90000) {
        appliedFallback = { paid: false, dilution: false };
        snapshot.accounts.forEach(a => {
            const key = matchKey(accounts.map(a => a.name), a.name);
            const account = accounts.find(a => a.name === key);
            const p = state.config.accounts.find(p => p.name === key);
            const role = p ? p.role : account && (account.platform === 'telecomjs' || /智云/.test(account.name) ? 'paid' : (account.platform || 'glm') === 'glm' ? 'primary' : 'standard');
            const mode = a.scheduling_mode || (p && p.channelModes ? p.channelModes[String(a.id)] : role === 'standard' ? a.suggested_scheduling_mode : 'native');
            const active = a.effective_schedulable == null ? a.schedulable : a.effective_schedulable;
            if (active && (a.weight == null || a.weight > 0)) {
                if (role === 'paid') appliedFallback.paid = true;
                if (mode === 'fallback') appliedFallback.dilution = true;
            }
        });
    }
    return { config: state.config, plan: state.plan || null, events: state.events, lastPush, integrationError,
        appliedFallback, observedAt: snapshotAt, resetCards, channelCapacitySupported: !!(snapshot && snapshot.smart_channel_capacity_version >= 1),
        connected: !!snapshot && snapshot.smart_scheduler_version === 2 && Date.now() - snapshotAt < 90000,
        syncConfigured: !!config.schedulerSyncToken && config.relayEnabled,
        candidates: accounts.map((a, index) => ({ name: a.name, index, platform: a.platform || 'glm', teamEdition: !!a.teamEdition,
            cards: (a.resetCards || {}).count || 0, capacity: live[a.name] || null, channels: (live[a.name] || {}).channels || [] })) };
}
function start() {
    if (timer) return;
    timer = setInterval(() => cycle().catch(e => { integrationError = e.message; }), 30000);
    timer.unref();
    cycle().catch(e => { integrationError = e.message; });
}
module.exports = { start, cycle, controls, decision, status, telemetry, afterReset, push, persistPlan, aggregate, matchKey, LEASE_MS, compute };

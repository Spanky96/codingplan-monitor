'use strict';
const { readAccounts } = require('../api/accounts');
const glm = require('../api/platforms/glm');
const http = require('../lib/http');
const store = require('./store');
const { timestamp, windowsOf, EXHAUSTED } = require('./planner');
const cache = require('../api/cache');
const { resetAllowed } = require('./adaptation');
const locks = new Set();

function current(index, name) {
    const account = readAccounts()[index];
    if (!account || account.name !== name) throw new Error('账号列表已变更，请刷新后重试');
    return account;
}
async function list(account, index) {
    const json = await glm.withGlmAuthRetry(account, index, a =>
        http.httpsGet(glm.resetCardsUrl(), glm.makeHeaders(a), { timeoutMs: 15000 }));
    if (!json || (json.code != null && json.code !== 200)) throw new Error('获取重置卡失败');
    const cards = glm.parseGlmResetCards(json.data);
    current(index, account.name);
    glm.persistGlmResetCards(index, cards);
    return cards;
}
function dayKey(ms) { return new Date(ms + 8 * 3600000).toISOString().slice(0, 10); }

function checkManualPermission(state, name) {
    const policy = state.config.accounts.find(p => p.name === name);
    if (policy?.role === 'primary' && policy.autoReset === false) {
        throw Object.assign(new Error('此账号已勾选「不使用重置卡」'), { status: 409 });
    }
}
async function use(index, type, recordId, automatic = false) {
    const account = readAccounts()[index];
    if (!account) throw new Error('未找到账号');
    if ((account.platform || 'glm') !== 'glm' || account.teamEdition) throw new Error('该账号不支持重置卡');
    if (!glm.RESET_CARD_USE_TYPES[type] || !Number.isInteger(recordId) || recordId <= 0) throw new Error('参数不正确，需要 type 与 recordId');
    const key = JSON.stringify([account.name, type, recordId]);
    if (locks.has(account.name)) throw new Error('该账号正在使用重置卡');
    locks.add(account.name);
    try {
        let state = store.read();
        if (!automatic) checkManualPermission(state, account.name);
        if (state.journal[key]) throw Object.assign(new Error('此卡已提交过使用请求，请核对官方结果；不会重复扣卡'), { status: 409 });
        const cards = await list(account, index);
        const card = cards.find(c => c.type === type && c.recordId === recordId);
        if (!card || (card.expireTime && timestamp(card.expireTime) <= Date.now())) throw Object.assign(new Error('该重置卡已使用、已过期或不存在，请刷新后重试'), { status: 409 });
        state = store.read();
        if (automatic) {
            const policy = state.config.accounts.find(p => p.name === account.name);
            if (!state.config.enabled || !resetAllowed(policy, account)) throw new Error('自动用卡已关闭');

        }
        current(index, account.name);
        const fresh = await cache.ensureUsageFetch(current(index, account.name), index, true);
        const before = windowsOf(fresh).find(w => w.type === type);
        if (automatic && (!before || !before.depleted || before.used < EXHAUSTED ||
            before.resetAt - Date.now() <= state.config.resetMinRemainingMinutes * 60000)) {
            throw new Error('最新额度已恢复或临近自然重置，取消自动用卡');
        }
        if (automatic) {
            const controller = require('./service');
            await controller.telemetry();
            const latest = store.read();
            const active = latest.config.accounts.find(p => p.name === account.name);
            if (!latest.config.enabled || !resetAllowed(active, current(index, account.name))) throw new Error('自动重置已关闭');
            const decision = controller.compute(latest).rows.find(r => r.name === account.name);
            if (!decision || !decision.reset || decision.reset.type !== type || decision.reset.recordId !== recordId) {
                throw new Error(decision ? decision.reasons.join('；') : '用卡条件已变化，取消自动用卡');
            }
        }
        current(index, account.name);
        const requestId = glm.uuidV4();
        // Persist BEFORE sending. A timeout/restart leaves an uncertain entry, never an automatic retry.
        store.update(s => {
            if (!automatic) checkManualPermission(s, account.name);
            s.journal[key] = { at: Date.now(), account: account.name, type, recordId, requestId, automatic, status: 'pending' };
            (s.pendingResets || (s.pendingResets = {}))[account.name] = { type, at: Date.now(),
                beforeUsed: before ? before.used : null, beforeResetAt: before && Number.isFinite(before.resetAt) ? before.resetAt : null, status: 'submitted' };
        });
        let json;
        try {
            json = await glm.withGlmAuthRetry(account, index, a => http.httpsRequest('POST', glm.resetCardUseUrl(), glm.makeHeaders(a), {
                targetType: 'PERSONAL', resetType: glm.RESET_CARD_USE_TYPES[type], recordId, requestId,
                ...(card.grantType ? { grantType: card.grantType } : {})
            }, { timeoutMs: 20000 }));
            if (!json || json.success === false || (json.code != null && json.code !== 200)) throw new Error((json && json.msg) || '官方未确认使用成功');
        } catch (err) {
            const rejected = json && (json.success === false || (json.code != null && json.code !== 200));
            store.update(s => {
                s.journal[key].status = rejected ? 'rejected' : 'uncertain';
                if (rejected) delete s.pendingResets[account.name];
            });
            store.event(rejected ? 'reset-rejected' : 'reset-uncertain', account.name + (rejected ? '：官方拒绝用卡，保留原额度状态' : '：用卡结果待核对，已阻止自动重试'));
            throw err;
        }
        store.update(s => { s.journal[key].status = 'used'; s.pendingResets[account.name].status = 'used'; });
        store.event('reset-used', account.name + '：已使用' + (type === 'week' ? '周' : '5 小时') + '重置卡', { automatic });
        let after = cards.filter(c => !(c.type === type && c.recordId === recordId));
        try { after = await list(current(index, account.name), index); } catch (_) { /* use succeeded; refresh can retry later */ }
        current(index, account.name);
        glm.persistGlmResetCards(index, after);
        // Confirmation and immediate relay sync run in the shared controller, including manual resets.
        const recovery = await require('./service').afterReset(account.name, type, Date.now());
        return { success: true, cards: after, checkedAt: Date.now(), recovery };
    } finally { locks.delete(account.name); }
}
module.exports = { list, use, dayKey };

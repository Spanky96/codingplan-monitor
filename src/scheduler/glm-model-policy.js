'use strict';
const { windowsOf } = require('./planner');
const { accountType } = require('./account-types');
const { weeklyLead, FLASH_LEAD } = require('./adaptation');

const original = { mode: 'original', flashAccounts: [] };

function eligible(account, config) {
    return (account.platform || 'glm') === 'glm' && accountType(config, account) !== 'paid';
}

function validate(settings, accounts, config) {
    if (!settings || !['original', 'all', 'auto'].includes(settings.mode) || !Array.isArray(settings.flashAccounts))
        throw new Error('请选择有效的智谱模型策略和账号');
    const names = new Set(accounts.filter(a => eligible(a, config)).map(a => a.name));
    if (settings.flashAccounts.some(name => !names.has(name))) throw new Error('固定 Flash 仅适用于当前智谱套餐账号');
    return { mode: settings.mode, flashAccounts: [...new Set(settings.flashAccounts)] };
}

function automatic(state, account, index, getUsage, now) {
    const u = getUsage(index);
    // Permit the original mapping only on a trustworthy sample from this account.
    if (!u || !u.success || u.name !== account.name || !(u.cachedAt <= now && now - u.cachedAt <= state.config.staleAfterSeconds * 1000)) return true;
    const week = windowsOf(u).find(w => w.type === 'week');
    const lead = weeklyLead(week, now);
    return lead == null || lead >= FLASH_LEAD || week.used >= 100;
}

function targets(state, accounts, getUsage, now) {
    const settings = state.glmModelPolicy || original;
    const result = Object.create(null);
    accounts.forEach((a, i) => {
        if (!eligible(a, state.config)) return;
        result[a.name] = settings.mode === 'all' || (settings.mode === 'auto' &&
            (settings.flashAccounts.includes(a.name) || automatic(state, a, i, getUsage, now)));
    });
    return result;
}

module.exports = { original, eligible, validate, targets };

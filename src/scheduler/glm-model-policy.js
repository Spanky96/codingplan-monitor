'use strict';
const { windowsOf } = require('./planner');
const { accountType } = require('./account-types');
const { weeklyWaterline } = require('./adaptation');

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
    const { config, plan } = state;
    // Automatic pressure comes from the running scheduler. Without fresh telemetry
    // or quota, retain the last model on the relay until the next confirmed sample.
    if (!config.enabled) return false;
    if (!plan || !plan.summary || !plan.rows.some(r => r.matched) || plan.generatedAt < (state.configChangedAt || 0) ||
        now - plan.generatedAt >= 180000 || now < plan.generatedAt) return null;
    if (!plan.summary.pressure && !plan.summary.fallbackAssessment?.quotaPressure) return false;
    const u = getUsage(index);
    if (!u || !u.success || u.name !== account.name || !(u.cachedAt <= now && now - u.cachedAt <= config.staleAfterSeconds * 1000)) return null;
    const week = windowsOf(u).find(w => w.type === 'week');
    if (!week || !Number.isFinite(week.used) || week.used < 0 || week.used > 100 ||
        !(week.resetAt > now && week.resetAt <= now + 7 * 86400000)) return null;
    return week.used - weeklyWaterline(week.resetAt, now) >= 10;
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

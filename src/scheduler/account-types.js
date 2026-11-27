'use strict';

const types = ['subscription', 'dilution', 'paid'];

function accountType(config, account) {
    if (config.accountTypes && Object.hasOwn(config.accountTypes, account.name)) return config.accountTypes[account.name];
    const policy = config.accounts.find(p => p.name === account.name);
    if (policy) {
        if (policy.role === 'paid' || policy.role === 'dilution') return policy.role;
        if (policy.role === 'standard' && Object.values(policy.channelModes || {}).includes('fallback')) return 'dilution';
        return 'subscription';
    }
    return account.platform === 'telecomjs' ? 'paid' : 'subscription';
}

function roleFor(type, account) {
    if (type === 'subscription') return (account.platform || 'glm') === 'glm' ? 'primary' : 'standard';
    return type;
}

function editableConfig(config, accounts) {
    const names = new Set(accounts.map(a => a.name));
    return { ...config, accounts: config.accounts.filter(p => names.has(p.name)),
        accountTypes: Object.fromEntries(accounts.map(a => [a.name, accountType(config, a)])) };
}

module.exports = { types, accountType, roleFor, editableConfig };

// ============ 智云账号（token.telecomjs.com,真实浏览器执行瑞数挑战）============
var { setCache } = require('../cache');
var telecomjs = require('../../telecomjs');

// ============ 智云账号（真实浏览器执行瑞数挑战）============

async function fetchTelecomUsage(account, index) {
    try {
        var data = await telecomjs.fetchBalance(account.satoken);
        var result = {
            index: index,
            name: account.name,
            platform: 'telecomjs',
            responsiblePerson: account.responsiblePerson,
            notes: account.notes,
            isPublic: account.isPublic,
            data: data,
            success: true,
            cachedAt: Date.now()
        };
        setCache(index, result);
        return result;
    } catch (err) {
        return {
            index: index,
            name: account.name,
            platform: 'telecomjs',
            responsiblePerson: account.responsiblePerson,
            notes: account.notes,
            isPublic: account.isPublic,
            error: err.message,
            success: false
        };
    }
}


module.exports = { fetchTelecomUsage: fetchTelecomUsage };

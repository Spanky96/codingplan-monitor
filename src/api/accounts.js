// accounts.json 读写:落盘前对凭证字段加密,读取时自动解密(前端无感知)。
// 历史明文字段在下次保存该账号时自动转密文,无需迁移脚本。
var fs = require('fs');
var config = require('../config');
var { encryptSecret, decryptSecretOrNull } = require('../lib/crypto');

var glmAccountsFile = config.accountsFile;

// 需要加密落盘的凭证字段(密码类 + 登录态类)
var CREDENTIAL_SECRET_FIELDS = ['glm_password', 'yescode_password', 'sub2api_password', 'cookie', 'authorization', 'satoken'];

function decryptAccounts(accounts) {
    return accounts.map(function(acc) {
        if (!acc || typeof acc !== 'object') return acc;
        var out = Array.isArray(acc) ? acc.slice() : Object.assign({}, acc);
        CREDENTIAL_SECRET_FIELDS.forEach(function(f) {
            if (typeof out[f] !== 'string') return;
            var plain = decryptSecretOrNull(out[f]);
            if (plain !== null) out[f] = plain;
            // 非 enc:v1 前缀视为历史明文,原样保留(下次写盘自动转密文)
        });
        return out;
    });
}

function encryptAccounts(accounts) {
    return accounts.map(function(acc) {
        if (!acc || typeof acc !== 'object') return acc;
        var out = Array.isArray(acc) ? acc.slice() : Object.assign({}, acc);
        CREDENTIAL_SECRET_FIELDS.forEach(function(f) {
            if (typeof out[f] === 'string' && out[f]) out[f] = encryptSecret(out[f]);
        });
        return out;
    });
}

function readAccounts() {
    if (!fs.existsSync(glmAccountsFile)) {
        writeAccounts([]);
        return [];
    }
    var parsed = JSON.parse(fs.readFileSync(glmAccountsFile, 'utf8'));
    return decryptAccounts(parsed.accounts || []);
}
function writeAccounts(accounts) {
    fs.writeFileSync(glmAccountsFile, JSON.stringify({ accounts: encryptAccounts(accounts) }, null, 2));
}

module.exports = {
    CREDENTIAL_SECRET_FIELDS: CREDENTIAL_SECRET_FIELDS,
    readAccounts: readAccounts,
    writeAccounts: writeAccounts,
    encryptAccounts: encryptAccounts,
    decryptAccounts: decryptAccounts
};

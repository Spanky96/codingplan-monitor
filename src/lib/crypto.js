// 账号凭证加密(AES-256-GCM):密文格式 enc:v1:<iv>:<tag>:<data>。
// 密钥来源:env ACCOUNT_SECRET(推荐,本地与服务器一致才能互拷数据);
// 未配置时从 ADMIN_PASSWORD 派生。解不开返回 null,由调用方按明文兜底。
var crypto = require('crypto');
var config = require('../config');


// 密文格式: enc:v1:<iv_b64url>:<tag_b64url>:<data_b64url>
// 密钥来源: env ACCOUNT_SECRET(推荐,本地与服务器保持一致);未配置则从 ADMIN_PASSWORD 派生。
// 派生 salt 固定——secret 本身应由用户设为高熵随机串,固定 salt 保证跨进程/跨机器同一 key。
var CREDENTIAL_SECRET_FIELDS = ['glm_password', 'yescode_password', 'sub2api_password', 'cookie', 'authorization', 'satoken'];
var ENC_PREFIX = 'enc:v1:';

// 密钥惰性派生(进程内缓存;切换 secret 仅存在于测试场景)
var _accountKeyCache = { secret: null, key: null };
function accountSecretKey() {
    var secret = config.accountSecret || config.adminPassword;
    if (_accountKeyCache.key && _accountKeyCache.secret === secret) return _accountKeyCache.key;
    var key = crypto.scryptSync(String(secret), 'glm-usage-accounts-v1', 32);
    _accountKeyCache = { secret: secret, key: key };
    return key;
}

function encryptSecret(plaintext) {
    var s = String(plaintext);
    if (!s || s.indexOf(ENC_PREFIX) === 0) return s;   // 空值/已加密不重复加密
    var iv = crypto.randomBytes(12);
    var cipher = crypto.createCipheriv('aes-256-gcm', accountSecretKey(), iv);
    var data = Buffer.concat([cipher.update(s, 'utf8'), cipher.final()]);
    return ENC_PREFIX + iv.toString('base64url') + ':' + cipher.getAuthTag().toString('base64url') + ':' + data.toString('base64url');
}

// 解密失败(密钥不匹配/格式损坏)返回 null,由调用方决定是否按明文兜底
function decryptSecretOrNull(value) {
    if (typeof value !== 'string' || value.indexOf(ENC_PREFIX) !== 0) return null;
    try {
        var parts = value.slice(ENC_PREFIX.length).split(':');
        if (parts.length !== 3) return null;
        var decipher = crypto.createDecipheriv('aes-256-gcm', accountSecretKey(), Buffer.from(parts[0], 'base64url'));
        decipher.setAuthTag(Buffer.from(parts[1], 'base64url'));
        return Buffer.concat([decipher.update(Buffer.from(parts[2], 'base64url')), decipher.final()]).toString('utf8');
    } catch (e) { return null; }
}


module.exports = {
    encryptSecret: encryptSecret,
    decryptSecretOrNull: decryptSecretOrNull
};

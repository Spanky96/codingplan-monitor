'use strict';

// ZCode Coding Plan wire protocol. Credentials and signing keys stay in memory.
// Protocol reference: https://github.com/TriDefender/zcode-api/blob/master/src/proxy/client-signing.ts
// Independently implemented with Node crypto; no third-party runtime dependency.
const crypto = require('node:crypto');

class ZcodeError extends Error {
    constructor(code) { super(code); this.code = code; }
}

function kdf(secret, purpose) {
    return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(secret), Buffer.from('WD_CLIENT_SIGN_KDF_SALT'), Buffer.from(purpose), 32));
}

function handshakeRequest(token, keyId, now = Date.now()) {
    const nonce = crypto.randomBytes(16).toString('hex');
    const ts = String(now);
    const key = kdf(token, 'getSignKey_hmac');
    try {
        return { accessToken: token, nonce, ts, sig: crypto.createHmac('sha256', key)
            .update(['get_sign_key', keyId, ts, nonce].join('\n')).digest('base64') };
    } finally { key.fill(0); }
}

function decryptSigningKey(cipherText, token, keyId) {
    const key = kdf(token, 'ed25519_priv');
    let plain;
    try {
        if (typeof cipherText !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(cipherText)) throw new Error();
        const cipher = Buffer.from(cipherText, 'base64');
        if (cipher.length <= 28) throw new Error();
        const aes = crypto.createDecipheriv('aes-256-gcm', key, cipher.subarray(0, 12));
        aes.setAAD(Buffer.from(keyId));
        aes.setAuthTag(cipher.subarray(-16));
        plain = Buffer.concat([aes.update(cipher.subarray(12, -16)), aes.final()]);
        const der = Buffer.from(plain.toString('utf8'), 'base64');
        try {
            const privateKey = crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
            if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error();
            return privateKey;
        } finally { der.fill(0); }
    } catch (_) { throw new ZcodeError('zcode_signing_key_invalid'); }
    finally { key.fill(0); if (plain) plain.fill(0); }
}

function signingHeaders(material, sessionId, version, now = Date.now()) {
    const ts = String(now);
    const nonce = crypto.randomBytes(16).toString('hex');
    const seed = crypto.createHash('sha256').update([material.keyId, 'zcode', sessionId, ts].join('\n')).digest('hex').slice(0, 32);
    const prefix = crypto.randomBytes(12).toString('hex');
    let pow;
    // Expected work is 256 hashes. A hard bound prevents monopolizing the event loop.
    for (let i = 0; i < 65536; i++) {
        const candidate = prefix + i.toString(16).padStart(8, '0');
        if (crypto.createHash('sha256').update(seed + '\n' + candidate).digest()[0] === 0) { pow = candidate; break; }
    }
    if (!pow) throw new ZcodeError('zcode_signing_work_limit');
    const sig = crypto.sign(null, Buffer.from([material.keyId, ts, version, sessionId, nonce].join('\n')), material.privateKey);
    return {
        'Authorization': 'Bearer ' + material.token,
        'X-Client-Ts': ts,
        'X-Client-Version': version,
        'X-Client-Sig': sig.toString('base64'),
        'X-Session-Id': sessionId,
        'X-Client-Nonce': nonce,
        'X-App-Id': 'zcode',
        'X-Client-Pow': pow
    };
}

function parseProjectToken(data, keyId, now = Date.now()) {
    try {
        if (!data || data.enabled === false || data.enable === false || typeof data.accessToken !== 'string') throw new Error();
        const parts = data.accessToken.split('.');
        if (parts.length !== 3) throw new Error();
        const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
        if (claims.token_use !== 'project_access' || claims.api_key !== keyId || !Number.isFinite(claims.exp)) throw new Error();
        let expiresAt = claims.exp * 1000;
        if (data.expiresIn != null) {
            if (!Number.isFinite(Number(data.expiresIn)) || Number(data.expiresIn) <= 0) throw new Error();
            expiresAt = Math.min(expiresAt, now + Number(data.expiresIn) * 1000);
        }
        if (expiresAt <= now + 10000) throw new Error();
        return { token: data.accessToken, expiresAt };
    } catch (_) { throw new ZcodeError('zcode_project_token_invalid'); }
}

module.exports = { ZcodeError, handshakeRequest, decryptSigningKey, signingHeaders, parseProjectToken };

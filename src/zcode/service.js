'use strict';

const crypto = require('node:crypto');
const { ZcodeError, handshakeRequest, decryptSigningKey, signingHeaders, parseProjectToken } = require('./protocol');
const config = require('../config');
const { readAccounts } = require('../api/accounts');
const { withGlmAuthRetry } = require('../api/platforms/glm');

const UPSTREAM = 'https://open.bigmodel.cn';
const MESSAGES_PATH = '/api/anthropic/v1/messages';

function scope(account) {
    return crypto.createHash('sha256').update(JSON.stringify([
        account.organization, account.project, account.authorization, !!account.teamEdition
    ])).digest('hex');
}

function validateTarget(value) {
    let url;
    try { url = new URL(value); } catch (_) { throw new ZcodeError('zcode_invalid_upstream'); }
    if (url.origin !== UPSTREAM || url.username || url.password || url.hash ||
        url.pathname !== MESSAGES_PATH || (url.search && url.search !== '?beta=true')) {
        throw new ZcodeError('zcode_invalid_upstream');
    }
}

function validateAccount(account) {
    if (!account || (account.platform || 'glm') !== 'glm') throw new ZcodeError('zcode_account_not_glm');
    if (account.teamEdition) throw new ZcodeError('zcode_team_not_supported');
    if (!account.authorization || !account.organization || !account.project) throw new ZcodeError('zcode_login_required');
}

function relayName(account) { return String(account.zcode?.relayAccountName || account.name || '').trim(); }

function createService(options = {}) {
    const fetchImpl = options.fetch || globalThis.fetch;
    const accounts = options.readAccounts || readAccounts;
    const retryAuth = options.retryAuth || withGlmAuthRetry;
    const now = options.now || Date.now;
    const version = options.version || config.zcodeClientVersion;
    const cache = new Map();
    const pending = new Map();
    const stats = new Map();

    async function request(url, init) {
        let res;
        try {
            res = await fetchImpl(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(12000) });
        } catch (_) { throw new ZcodeError('zcode_upstream_unavailable'); }
        if (res.status === 401) throw new ZcodeError('HTTP 401'); // existing GLM login retry boundary
        if (!res.ok) throw new ZcodeError('zcode_upstream_http_' + res.status);
        let json;
        try { json = await res.json(); } catch (_) { throw new ZcodeError('zcode_upstream_invalid_json'); }
        if (String(json.code) === '401') throw new ZcodeError('HTTP 401');
        if (!['0', '200'].includes(String(json.code))) throw new ZcodeError('zcode_upstream_rejected');
        return json.data;
    }

    async function load(account, index) {
        return retryAuth(account, index, async function(a) {
            const requestScope = scope(a);
            const keyBase = 'https://bigmodel.cn/api/biz/v1/organization/' + encodeURIComponent(a.organization) +
                '/projects/' + encodeURIComponent(a.project) + '/api_keys';
            const bare = a.authorization.replace(/^Bearer\s+/i, '');
            const headers = { authorization: bare, 'bigmodel-organization': a.organization, 'bigmodel-project': a.project };
            const list = await request(keyBase + '?keyType=1', { headers });
            if (!Array.isArray(list)) throw new ZcodeError('zcode_key_list_invalid');
            const keys = list.filter(k => k.name === 'zcode-api-key');
            if (!keys.length) throw new ZcodeError('zcode_key_missing_login_in_zcode');
            if (keys.length !== 1 || typeof keys[0].apiKey !== 'string' || !keys[0].apiKey.trim()) throw new ZcodeError('zcode_key_ambiguous');
            const keyId = keys[0].apiKey;
            const data = await request(keyBase + '/' + encodeURIComponent(keyId) + '/access_tokens', {
                method: 'POST', headers: { ...headers, authorization: 'Bearer ' + bare, 'content-type': 'application/json' },
                body: JSON.stringify({ clientType: 'zcode', clientVersion: version })
            });
            const token = parseProjectToken(data, keyId, now());
            const signed = await request(UPSTREAM + '/api/paas/c1f3a7e2/v2/client', {
                method: 'POST', headers: { authorization: 'Bearer ' + token.token, 'content-type': 'application/json' },
                body: JSON.stringify(handshakeRequest(token.token, keyId, now()))
            });
            return { ...token, keyId, sourceKeyIds: list.map(k => k.apiKey),
                privateKey: decryptSigningKey(signed?.privateCipher, token.token, keyId),
                scope: requestScope, refreshAt: token.expiresAt - 120000 - crypto.randomInt(60001) };
        });
    }

    async function material(account, index) {
        validateAccount(account);
        const id = scope(account);
        const existing = cache.get(id);
        if (existing && existing.refreshAt > now()) return existing;
        if (pending.has(id)) return pending.get(id);
        cache.delete(id);
        // Evict expired and old login generations; tokens are never written to disk.
        const active = new Set(accounts().filter(Boolean).map(scope));
        for (const [key, value] of cache) if (!active.has(key) || value.expiresAt <= now()) cache.delete(key);
        const task = load(account, index).then(value => {
            const current = accounts()[index];
            if (!current || scope(current) !== value.scope) throw new ZcodeError('zcode_account_changed');
            if (cache.size >= 256) cache.delete(cache.keys().next().value);
            cache.set(value.scope, value);
            return value;
        }).finally(() => pending.delete(id));
        pending.set(id, task);
        return task;
    }

    function record(account, patch) {
        const key = String(account.organization) + ':' + String(account.project);
        const prev = stats.get(key) || { signedRequests: 0, errors: 0 };
        stats.set(key, { ...prev, ...patch });
        return stats.get(key);
    }

    function status(account) {
        const entry = cache.get(scope(account));
        return { enabled: account.zcode?.enabled === true, relayAccountName: relayName(account),
            ready: !!entry && entry.expiresAt > now(), expiresAt: entry?.expiresAt || null,
            ...(stats.get(String(account.organization) + ':' + String(account.project)) || { signedRequests: 0, errors: 0 }),
            benefitVerified: false };
    }

    async function authorize(input) {
        validateTarget(input.upstreamUrl);
        if (typeof input.accountName !== 'string' || !input.accountName.trim() || input.accountName.length > 200 ||
            typeof input.apiKeyId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(input.apiKeyId) ||
            typeof input.sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.sessionId)) {
            throw new ZcodeError('zcode_invalid_request');
        }
        const matched = accounts().map((account, index) => ({ account, index }))
            .filter(v => v.account && (v.account.platform || 'glm') === 'glm' && relayName(v.account) === input.accountName);
        if (matched.length !== 1) throw new ZcodeError('zcode_account_missing_or_ambiguous');
        const { account, index } = matched[0];
        if (account.zcode?.enabled !== true) return { enabled: false };
        try {
            const value = await material(account, index);
            if (!value.sourceKeyIds.includes(input.apiKeyId)) throw new ZcodeError('zcode_account_key_mismatch');
            const current = accounts()[index];
            if (!current || scope(current) !== value.scope || relayName(current) !== input.accountName || current.zcode?.enabled !== true) {
                throw new ZcodeError('zcode_account_changed');
            }
            const headers = signingHeaders(value, input.sessionId, version, now());
            record(account, { signedRequests: status(account).signedRequests + 1, lastSignedAt: now(), lastError: null });
            return { enabled: true, signed: true, expiresAt: value.expiresAt, headers };
        } catch (err) {
            const code = err instanceof ZcodeError && err.code !== 'HTTP 401' ? err.code : 'zcode_login_required';
            record(account, { errors: status(account).errors + 1, lastError: code, lastErrorAt: now() });
            throw new ZcodeError(code);
        }
    }

    async function check(index) {
        const account = accounts()[index];
        validateAccount(account);
        // An explicit admin check also recovers from an upstream-revoked PAT.
        cache.delete(scope(account));
        const value = await material(account, index);
        signingHeaders(value, crypto.randomUUID(), version, now());
        return { ...status(account), ready: true, expiresAt: value.expiresAt, keyName: 'zcode-api-key' };
    }

    return { authorize, check, status };
}

module.exports = { createService, validateTarget, relayName };

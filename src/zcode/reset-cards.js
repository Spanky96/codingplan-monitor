'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');
const { readAccounts } = require('../api/accounts');
const { withGlmAuthRetry } = require('../api/platforms/glm');

const BASE = 'https://zcode.z.ai/api/v1';
const MINUTE = 60000;
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const owner = a => digest([a.organization, a.project]);
const generation = a => digest([a.name, a.platform || 'glm', a.organization, a.project, a.authorization, !!a.teamEdition]);

class ResetError extends Error {
    constructor(kind) { super(kind); this.kind = kind; }
}

// Only retry deadlines and idempotency keys go to disk, never login credentials.
function fileState(file) {
    return {
        read() {
            try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
            catch (e) { if (e.code === 'ENOENT') return {}; throw new ResetError('state'); }
        },
        write(value) {
            const temp = file + '.' + process.pid + '.tmp';
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
            fs.renameSync(temp, file);
        }
    };
}

function tokenExpiry(token, now) {
    try {
        const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
        return Number.isFinite(claims.exp) ? claims.exp * 1000 : now + 5 * MINUTE;
    } catch (_) { throw new ResetError('auth'); }
}

function parseStatus(data, now) {
    if (!data || !Array.isArray(data.available_five_hour_resets) || !Array.isArray(data.available_week_resets)) {
        throw new ResetError('response');
    }
    function count(items) {
        if (items.some(x => !x || !Number.isFinite(x.expire_at))) throw new ResetError('response');
        return items.filter(x => x.expire_at > now).length;
    }
    return {
        fiveHour: count(data.available_five_hour_resets), week: count(data.available_week_resets),
        lastUsedAt: Math.max(data.latest_five_hour_reset_history?.used_at || 0, data.latest_week_reset_history?.used_at || 0)
    };
}

function createResetService(options = {}) {
    const fetchImpl = options.fetch || globalThis.fetch;
    const accounts = options.readAccounts || readAccounts;
    const retryAuth = options.retryAuth || withGlmAuthRetry;
    const now = options.now || Date.now;
    const state = options.state || fileState(path.join(path.dirname(config.accountsFile), 'zcode-reset-state.json'));
    const sessions = new Map();
    const pending = new Map();

    function current(account, index) {
        const a = accounts()[index];
        if (!a || generation(a) !== generation(account)) throw new ResetError('changed');
    }
    function schedule(account, patch) {
        const all = state.read();
        if (!all || typeof all !== 'object' || Array.isArray(all)) throw new ResetError('state');
        const id = owner(account);
        if (patch) {
            const active = new Set(accounts().filter(a => a && a.organization && a.project).map(owner));
            for (const key of Object.keys(all)) if (!active.has(key)) delete all[key];
            all[id] = patch;
            state.write(all);
        }
        return all[id] || {};
    }
    async function request(url, init = {}, allowDenied = false) {
        let response;
        try { response = await fetchImpl(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(12000) }); }
        catch (_) { throw new ResetError('temporary'); }
        if (response.status === 429) throw new ResetError('throttled');
        if (response.status === 401) throw new ResetError('auth');
        if (!response.ok) throw new ResetError(response.status >= 500 ? 'temporary' : 'rejected');
        let body;
        try { body = await response.json(); } catch (_) { throw new ResetError('response'); }
        if (body.code === 401) throw new ResetError('auth');
        if (allowDenied && body.code === 3301) {
            if (body.data?.granted !== false || !Number.isFinite(body.data.next_try_at) || body.data.next_try_at <= 0) {
                throw new ResetError('response');
            }
            return body.data;
        }
        if (![0, 200].includes(body.code)) throw new ResetError(body.code === 2007 ? 'temporary' : 'rejected');
        return body.data;
    }
    async function session(account, index, force = false) {
        current(account, index);
        const existing = sessions.get(generation(account));
        if (!force && existing && existing.expiresAt > now() + 2 * MINUTE) return existing;
        const result = await retryAuth(account, index, async a => {
            current(a, index);
            let code;
            try {
                code = await request('https://bigmodel.cn/api/auth/getAuthCode?appId=zcode', {
                    headers: { authorization: a.authorization.replace(/^Bearer\s+/i, '') }
                });
            } catch (e) {
                // Only a rejected BigModel login may trigger its existing password login recovery.
                if (e.kind === 'auth') throw new Error('HTTP 401');
                throw e;
            }
            if (typeof code?.authCode !== 'string' || !code.authCode) throw new ResetError('response');
            current(a, index);
            const tokens = await request(BASE + '/oauth/token', {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ provider: 'bigmodel', code: code.authCode,
                    redirect_uri: 'zcode://oauth/callback', state: crypto.randomUUID() })
            });
            if (typeof tokens?.token !== 'string' || !tokens.token || typeof tokens.bigmodel?.access_token !== 'string' || !tokens.bigmodel.access_token) {
                throw new ResetError('response');
            }
            current(a, index);
            return { headers: { authorization: 'Bearer ' + tokens.token,
                'X-Bigmodel-Authorization': tokens.bigmodel.access_token, 'Bigmodel-Target-Type': 'PERSONAL' },
                expiresAt: Math.min(tokenExpiry(tokens.token, now()), tokenExpiry(tokens.bigmodel.access_token, now())) };
        });
        current(account, index);
        if (result.expiresAt <= now() + 10000) throw new ResetError('auth');
        const active = new Set(accounts().filter(Boolean).map(generation));
        for (const [key, value] of sessions) if (!active.has(key) || value.expiresAt <= now()) sessions.delete(key);
        sessions.set(generation(account), result);
        return result;
    }

    async function run(account, index) {
        let status;
        let entry = schedule(account);
        // Failed login/status checks also back off, without disabling the BigModel inventory fallback.
        if (entry.retryAfter > now()) return { state: 'unavailable', nextCheckAt: entry.retryAfter };
        try {
            let auth = await session(account, index);
            async function readStatus() {
                current(account, index);
                return parseStatus(await request(BASE + '/coding-plan/reset/status', { headers: auth.headers }), now());
            }
            try { status = await readStatus(); }
            catch (e) {
                if (e.kind !== 'auth') throw e;
                auth = await session(account, index, true);
                status = await readStatus();
            }
            current(account, index);
            if (entry.nextCheckAt > now()) return { state: 'cooldown', available: status, nextCheckAt: entry.nextCheckAt };
            if (status.lastUsedAt > now() - 5 * MINUTE) {
                const nextCheckAt = Math.max(now() + 5 * MINUTE, status.lastUsedAt + 5 * MINUTE);
                schedule(account, { nextCheckAt });
                return { state: 'cooldown', available: status, nextCheckAt };
            }
            const idempotencyKey = /^[a-f0-9-]{36}$/.test(entry.idempotencyKey || '') ? entry.idempotencyKey : crypto.randomUUID();
            // Persist before sending so a process restart cannot immediately submit a second claim.
            entry = { nextCheckAt: now() + 10 * MINUTE, idempotencyKey };
            schedule(account, entry);
            current(account, index);
            const data = await request(BASE + '/coding-plan/reset/opportunity', {
                method: 'POST', headers: { ...auth.headers, 'content-type': 'application/json' },
                body: JSON.stringify({ idempotency_key: idempotencyKey })
            }, true);
            if (typeof data?.granted !== 'boolean' || (!data.granted && !Number.isFinite(data.next_try_at))) {
                throw new ResetError('response');
            }
            current(account, index);
            const nextCheckAt = data.granted ? now() + 10 * MINUTE : Math.max(data.next_try_at, now() + 5 * MINUTE);
            schedule(account, { nextCheckAt });
            if (data.granted) {
                // The claim is already confirmed; a delayed status read must not turn it into a failed claim.
                try { status = await readStatus(); } catch (_) { status = null; }
            }
            current(account, index);
            return { state: data.granted ? 'granted' : 'not_eligible', available: status, nextCheckAt };
        } catch (e) {
            if (e.kind === 'changed') throw e;
            if (e.kind === 'auth') sessions.delete(generation(account));
            const nextCheckAt = now() + (e.kind === 'temporary' ? 5 : 10) * MINUTE;
            // Transient/unknown outcomes reuse their key; rate limits and definitive rejections do not.
            const keepKey = ['temporary', 'response'].includes(e.kind) ? entry.idempotencyKey : undefined;
            try { schedule(account, { nextCheckAt, retryAfter: nextCheckAt, ...(keepKey ? { idempotencyKey: keepKey } : {}) }); } catch (_) { /* fallback remains available */ }
            return { state: e.kind === 'throttled' ? 'cooldown' : 'unavailable', available: status, nextCheckAt };
        }
    }

    async function check(account, index) {
        if (!account || (account.platform || 'glm') !== 'glm' || account.teamEdition) return { state: 'unsupported' };
        if (!account.authorization || !account.organization || !account.project) return { state: 'unavailable' };
        const key = owner(account);
        if (pending.has(key)) return pending.get(key);
        const task = run(account, index).finally(() => pending.delete(key));
        pending.set(key, task);
        return task;
    }
    return { check };
}

module.exports = { createResetService, parseStatus, fileState };

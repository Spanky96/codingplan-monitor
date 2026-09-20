// 管理密码防爆破(同一 IP 连续 3 次错封 15 分钟)+ 鉴权中间件 + 游客可见性。
var config = require('../config');
var PASSWORD = config.adminPassword;

// ============ 管理密码防爆破（连续失败 3 次封 IP 15 分钟）============

var AUTH_FAIL_LIMIT = 3;
var AUTH_BAN_MS = 15 * 60 * 1000;

// 内存封禁表 { ip: { fails, bannedUntil } }；重启清空（防爆破不需持久化）
var authBanTable = {};

// 客户端 IP：反代场景取 x-forwarded-for 首段，否则取 socket 地址（Docker 直连可用）
function clientIp(req) {
    var fwd = req.headers && req.headers['x-forwarded-for'];
    if (fwd) return String(fwd).split(',')[0].trim();
    return (req.socket && req.socket.remoteAddress) || (req.connection && req.connection.remoteAddress) || 'unknown';
}

// 惰性清理：过期封禁项清零计数，避免内存表无限增长（IP 量级很小，全扫可接受）
function authBanGc(now) {
    Object.keys(authBanTable).forEach(function(ip) {
        var e = authBanTable[ip];
        if (!e) return;
        if (e.bannedUntil && e.bannedUntil <= now) delete authBanTable[ip];
        else if (e.bannedUntil && now - e.bannedUntil > AUTH_BAN_MS) delete authBanTable[ip];
    });
}

// 查询某 IP 封禁状态：{ banned, retryAfterSec, fails }
function authBanState(ip, now) {
    authBanGc(now);
    var e = authBanTable[ip];
    if (!e || !e.bannedUntil || e.bannedUntil <= now) {
        return { banned: false, retryAfterSec: 0, fails: e ? e.fails : 0 };
    }
    return { banned: true, retryAfterSec: Math.ceil((e.bannedUntil - now) / 1000), fails: e.fails };
}

// 记录一次密码失败；达到上限时写入封禁截止时间。返回新的封禁状态
function authBanRecordFailure(ip, now) {
    authBanGc(now);
    var e = authBanTable[ip] || (authBanTable[ip] = { fails: 0, bannedUntil: 0 });
    if (e.bannedUntil && e.bannedUntil > now) return authBanState(ip, now);
    e.fails += 1;
    if (e.fails >= AUTH_FAIL_LIMIT) {
        e.bannedUntil = now + AUTH_BAN_MS;
    }
    return authBanState(ip, now);
}

// 密码正确后清零该 IP 的失败计数与封禁
function authBanReset(ip) {
    delete authBanTable[ip];
}

function checkAuth(req, res, next) {
    var ip = clientIp(req);
    var st = authBanState(ip, Date.now());
    if (st.banned) {
        return res.status(429).json({ error: '密码连续错误次数过多，已封禁 ' + Math.ceil(st.retryAfterSec / 60) + ' 分钟，请稍后再试', retryAfterSec: st.retryAfterSec });
    }
    if (req.headers['x-auth-password'] !== PASSWORD) {
        var after = authBanRecordFailure(ip, Date.now());
        if (after.banned) {
            return res.status(429).json({ error: '密码连续错误 ' + AUTH_FAIL_LIMIT + ' 次，已封禁 15 分钟', retryAfterSec: after.retryAfterSec });
        }
        return res.status(401).json({ error: '密码错误' });
    }
    authBanReset(ip);
    next();
}

// 是否已登录管理员(用于区分游客与管理员,决定 isPublic===false 账号是否可见)
function isAuthed(req) {
    return req.headers['x-auth-password'] === PASSWORD;
}

// 游客(未登录管理员)不可见 isPublic===false 的账号
function isHiddenFromGuest(req, account) {
    return !isAuthed(req) && account.isPublic === false;
}


module.exports = {
    clientIp: clientIp,
    authBanState: authBanState,
    authBanRecordFailure: authBanRecordFailure,
    authBanReset: authBanReset,
    checkAuth: checkAuth,
    isAuthed: isAuthed,
    isHiddenFromGuest: isHiddenFromGuest
};

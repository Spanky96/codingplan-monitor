// 隐私模式(服务端强制脱敏):非管理员 + 命中隐私策略时,/api/usage 与 /api/weights
// 不再外发真实账号名与负责人/电话/备注等身份信息,账号名替换为「站点名+序号」别名。
// 判定与脱敏不触碰用量缓存(脱敏结果一律生成新对象);仅 isAdminRequest 对错误的
// query 密码记防爆破计数(与 /api/auth、/api/weights 共用 auth.js 的封禁表)。
var config = require('../config');
var { clientIp, authBanState, authBanRecordFailure, authBanReset } = require('./auth');

var PASSWORD = config.adminPassword;

// ============ 内外网判定 ============

// 私网/回环地址段(RFC1918 + loopback + linkback + IPv6 本地)。
// 纯字符串前缀判断,零依赖;IPv4-mapped IPv6(::ffff:192.168.0.5)剥前缀后走 IPv4 规则。
function isPrivateIp(ip) {
    var s = String(ip || '').trim().toLowerCase();
    if (!s || s === 'unknown') return false;
    if (s.indexOf('::ffff:') === 0) s = s.slice(7);
    if (s === '::1' || s.indexOf('fc') === 0 || s.indexOf('fd') === 0 || s.indexOf('fe80:') === 0) return true;
    if (s.indexOf(':') >= 0) return false;   // 其余 IPv6 一律按公网处理
    var m = s.match(/^(\d{1,3})\.(\d{1,3})\./);
    if (!m) return false;
    var a = parseInt(m[1], 10), b = parseInt(m[2], 10);
    if (a === 10 || a === 127 || a === 192 && b === 168 || a === 172 && b >= 16 && b <= 31) return true;
    return a === 169 && b === 254;
}

// 请求 Host(剥端口、小写;含反代透传的 x-forwarded-host 首段)
function requestHosts(req) {
    var hosts = [];
    var push = function(h) {
        h = String(h || '').split(':')[0].trim().toLowerCase();
        if (h && hosts.indexOf(h) < 0) hosts.push(h);
    };
    push(req.headers && req.headers['x-forwarded-host'] && String(req.headers['x-forwarded-host']).split(',')[0]);
    push(req.headers && req.headers.host);
    return hosts;
}

// 地址链外网判定(隐私专用,比 auth.clientIp 的「XFF 首段」更抗伪造):
// 1) socket 对端已是公网 → 外网,无视任何 XFF(源 IP 不可伪造,头可伪造);
// 2) socket 为私网(多为反代/直连内网)时看 XFF:追加式反代会把真实客户端 IP 附在链尾,
//    因此链上任一段为公网即外网——伪造私网首段无法把真实公网段藏掉;全私网才判内网。
//    未知来源(无 socket 信息且无 XFF)保守判外网(宁可多脱敏)。
function isExternalByAddress(req) {
    var socketIp = (req.socket && req.socket.remoteAddress)
        || (req.connection && req.connection.remoteAddress) || '';
    var socketKnown = !!socketIp && socketIp !== 'unknown';
    if (socketKnown && !isPrivateIp(socketIp)) return true;
    var fwd = req.headers && req.headers['x-forwarded-for'];
    if (fwd) {
        var parts = String(fwd).split(',');
        for (var i = 0; i < parts.length; i++) {
            if (parts[i].trim() && !isPrivateIp(parts[i].trim())) return true;
        }
        return false;
    }
    return !socketKnown;   // 无任何来源信息 → 保守外网;socket 私网且无 XFF → 内网
}

// 外网请求判定:Host 命中 PRIVACY_EXTERNAL_HOSTS 短路优先(内网用户走外网域名也算外网,
// 且不受伪造 X-Forwarded-For 影响);否则按地址链兜底
function isExternalRequest(req) {
    var hosts = requestHosts(req);
    for (var i = 0; i < hosts.length; i++) {
        if (config.privacyExternalHosts.indexOf(hosts[i]) >= 0) return true;
    }
    return isExternalByAddress(req);
}

// 管理员请求:x-auth-password 头(前端)或 ?password=(中转站轮询 weights 用)二选一命中。
// query 密码是与 /api/weights、/api/auth 同款的显式认证尝试,走同一张防爆破表:
// 错误计数、连续 3 次封 15 分钟、封禁期内即使密码正确也按游客(防止经 privacyForced
// 反射差异无限爆破管理密码);头密码不计错(浏览器登录态会自动附带,密码改后旧值
// 不应触发封禁锁死登录),与既有 isAuthed 语义一致。
function isAdminRequest(req) {
    var header = (req.headers && req.headers['x-auth-password']) || '';
    if (header === PASSWORD) return true;
    var queryPassword = req.query && req.query.password;
    if (queryPassword == null || queryPassword === '') return false;
    var ip = clientIp(req);
    var now = Date.now();
    if (authBanState(ip, now).banned) return false;
    if (queryPassword === PASSWORD) {
        authBanReset(ip);
        return true;
    }
    authBanRecordFailure(ip, now);
    return false;
}

// 本次请求是否强制隐私(仅对非管理员生效)
function forcedPrivacy(req) {
    if (config.privacyMode === 'off') return false;
    if (config.privacyMode === 'full') return !isAdminRequest(req);
    return !isAdminRequest(req) && isExternalRequest(req);
}

// ============ 账号别名与脱敏 ============

// 站点中文标签:必须与 public/js/app/core.js 的 platformLabel 逐字保持一致(两侧注释互指,改则同改)
function platformLabel(platform) {
    if (platform === 'yescode') return 'YesCode';
    if (platform === 'sub2api') return 'Sub2API';
    if (platform === 'huoli') return '火狸';
    if (platform === 'volc') return '火山';
    if (platform === 'telecomjs') return '智云';
    if (platform === 'qwen') return '千问';
    if (platform === 'minimax') return 'MiniMax';
    if (platform === 'stepfun') return '阶跃星辰';
    return '智谱';
}

// 账号文件序 → 别名(跳过游客不可见的 isPublic===false 账号;平台内 1 起计数)。
// 这是 /api/usage 列表、单卡、/api/weights 三处别名一致性的唯一来源;
// 与前端 displayName(core.js)的隐私编号算法同构,前端强制态直接显示后端别名,不自行重算。
function buildAliasMap(accounts) {
    var seq = {};
    var map = {};
    (accounts || []).forEach(function(account, i) {
        if (!account || account.isPublic === false) return;
        var platform = account.platform || 'glm';
        seq[platform] = (seq[platform] || 0) + 1;
        map[i] = platformLabel(platform) + seq[platform];
    });
    return map;
}

// 平台 data 内的身份字段清洗:仅拷贝要改的嵌套容器,未涉及的对象保持原引用(响应序列化只读)
function maskPlatformData(platform, data) {
    if (!data || typeof data !== 'object') return data;
    if (platform === 'yescode') {
        if (data.username == null && data.email == null) return data;
        var yc = Object.assign({}, data);
        delete yc.username;
        delete yc.email;
        return yc;
    }
    if (platform === 'sub2api' || platform === 'huoli') {
        var me = data.me;
        if (!me || typeof me !== 'object' || (me.email == null && me.username == null)) return data;
        var d = Object.assign({}, data);
        d.me = Object.assign({}, me);
        delete d.me.email;
        delete d.me.username;
        return d;
    }
    if (platform === 'stepfun') {
        var out = data;
        var user = data.user;
        if (user && typeof user === 'object') {
            out = Object.assign({}, out);
            out.user = Object.assign({}, user);
            delete out.user.nickname;
            delete out.user.mobileMasked;
            delete out.user.uid;
        }
        var campaign = out.campaign;
        if (campaign && Array.isArray(campaign.invites)) {   // 好友昵称/手机号属第三方 PII
            out = Object.assign({}, out);
            out.campaign = Object.assign({}, campaign);
            delete out.campaign.invites;
        }
        return out;
    }
    return data;
}

// 用量结果脱敏(纯函数,生成新对象,绝不修改入参——入参可能就是缓存本体):
// name → 别名;删 responsiblePerson/phone/notes;按平台清洗 data 身份字段。
// 须包在 usageForResponse 外层调用(先补 resetRecommendation/删 phone,再脱敏)。
function maskUsageResult(result, alias) {
    if (!result || typeof result !== 'object') return result;
    var platform = result.platform || 'glm';
    var masked = Object.assign({}, result);
    if (alias) masked.name = alias;
    delete masked.responsiblePerson;
    delete masked.phone;
    delete masked.notes;
    if (masked.data !== undefined) masked.data = maskPlatformData(platform, masked.data);
    return masked;
}

module.exports = {
    isPrivateIp: isPrivateIp,
    isExternalRequest: isExternalRequest,
    isAdminRequest: isAdminRequest,
    forcedPrivacy: forcedPrivacy,
    platformLabel: platformLabel,
    buildAliasMap: buildAliasMap,
    maskUsageResult: maskUsageResult
};

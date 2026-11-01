// ============ 签到活动(中转站自定义模块,如 super-nb.me /activity/v1/checkin)============
// 账号配 checkin_url(POST 签到) + checkin_info_url(GET 状态) 即启用:
// - 用量抓取时顺带拉签到状态(软失败,入 data.checkin,卡片显示 今日已签到/未签到);
// - 定时器每 30 分钟对账,未签到则自动 POST(站点幂等:已签返回 409 视为完成)。
// 日期口径按站点时区 Asia/Shanghai(与站点「每天一次」的重置边界一致)。
var sub2api = require('./platforms/sub2api');

var CHECKIN_INTERVAL_MS = 30 * 60 * 1000;

// index -> { day: 'YYYY-MM-DD', state: 'done'|'error', message } 仅内存:
// 重启后首轮会重新对账,站点按「已签到」拒绝重复,天然幂等,无需落盘。
var checkinDone = {};
var _timer = null;

// Asia/Shanghai 的当日 key(en-CA locale 输出 YYYY-MM-DD)
function checkinDayKey(now) {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(now || new Date());
}

// 账号是否启用签到(配了签到接口即视为启用;信息接口可选,缺省时卡片不显示状态)
function checkinConfigured(account) {
    return !!(account && account.checkin_url);
}

// 站点地址解析:完整 URL 原样;以 / 开头的路径拼 base_url
function resolveCheckinUrl(account, value) {
    if (!value) return null;
    if (/^https?:\/\//i.test(value)) return value;
    return sub2api.sub2apiBaseUrl(account).replace(/\/+$/, '') + '/' + String(value).replace(/^\/+/, '');
}

// 归一化签到状态(容忍不同站点字段命名;识别不了 checkedInToday 时保持 null,前端显示为未知)
function normalizeCheckinStatus(json) {
    if (!json || typeof json !== 'object') return { checkedInToday: null };
    var checked = json.punchedToday;
    if (checked == null) checked = (json.checkedInToday != null) ? json.checkedInToday : json.checked_in_today;
    var dr = json.dailyReward || {};
    var milestones = Array.isArray(json.milestones)
        ? json.milestones.filter(function(m) { return m && m.label; }).map(function(m) {
            return { label: m.label, statusText: m.statusText || null, achieved: !!m.achieved };
        })
        : null;
    return {
        checkedInToday: (typeof checked === 'boolean') ? checked : null,
        streakCurrent: (json.streakCurrent != null) ? json.streakCurrent : json.streak_current,
        cumulativeDays: json.cumulativeDays != null ? json.cumulativeDays : json.cumulative_days,
        monthLabel: json.monthLabel || null,
        todayBalanceCny: dr.todayBalanceCny != null ? dr.todayBalanceCny : undefined,
        todayNbPoints: dr.todayNbPoints != null ? dr.todayNbPoints : undefined,
        tomorrowBalanceCny: dr.tomorrowBalanceCny != null ? dr.tomorrowBalanceCny : undefined,
        tomorrowNbPoints: dr.tomorrowNbPoints != null ? dr.tomorrowNbPoints : undefined,
        milestones: milestones,
        fetchedAt: Date.now()
    };
}

// 拉取签到状态(永不抛错:失败返回 {checkedInToday:null, error},供卡片显示 ✕)
async function fetchCheckinStatus(account, index) {
    try {
        var url = resolveCheckinUrl(account, account.checkin_info_url);
        if (!url) return { checkedInToday: null };
        var json = await sub2api.sub2apiGet(account, index, sub2api.sub2apiBaseUrl(account), url, {
            'accept': 'application/json'
        });
        return normalizeCheckinStatus(json);
    } catch (err) {
        return { checkedInToday: null, error: String((err && err.message) || err) };
    }
}

// 单账号执行一轮:状态已签→跳过;未签/状态未知→POST(409/已签到 视为完成)
async function runCheckinForAccount(account, index) {
    var status = account.checkin_info_url ? await fetchCheckinStatus(account, index) : null;
    if (status && status.checkedInToday === true) {
        return { state: 'done', message: '今日已签到', status: status };
    }
    var url = resolveCheckinUrl(account, account.checkin_url);
    try {
        var resp = await sub2api.sub2apiPost(account, index, sub2api.sub2apiBaseUrl(account), url, {
            'accept': 'application/json'
        }, {});
        var after = account.checkin_info_url ? await fetchCheckinStatus(account, index) : null;
        var reward = (after && after.todayNbPoints != null) ? '(+' + after.todayNbPoints + ' NB点)' : '';
        return { state: 'done', message: '签到成功' + reward, status: after || status, response: resp };
    } catch (err) {
        var msg = String((err && err.message) || err);
        // 站点幂等拒绝:HTTP 409 或 body 带「已签到」都算今日已完成
        if (/HTTP 409/.test(msg) || /已签到/.test(msg)) {
            return { state: 'done', message: '今日已签到(站点确认)', status: status };
        }
        throw err;
    }
}

// 全量对账:遍历启用签到的 sub2api 账号;当日已 done 的跳过(手动触发同样幂等)
async function runCheckinCycle() {
    var accounts = require('./accounts').readAccounts();
    var day = checkinDayKey();
    var results = [];
    for (var i = 0; i < accounts.length; i++) {
        var acc = accounts[i];
        if (!acc || (acc.platform !== 'sub2api' && acc.platform !== 'huoli') || !checkinConfigured(acc)) continue;
        var prev = checkinDone[i];
        if (prev && prev.day === day && prev.state === 'done') {
            results.push({ index: i, state: 'done', message: prev.message, skipped: true });
            continue;
        }
        try {
            var r = await runCheckinForAccount(acc, i);
            checkinDone[i] = { day: day, state: 'done', message: r.message };
            results.push(Object.assign({ index: i }, r));
        } catch (err) {
            var errMsg = String((err && err.message) || err);
            checkinDone[i] = { day: day, state: 'error', message: errMsg };
            results.push({ index: i, state: 'error', message: errMsg });
        }
    }
    return results;
}

// 服务进程内启动定时签到(server.js 调用;定时器 unref 不阻止退出,测试进程可正常结束)
function startCheckinScheduler(intervalMs) {
    if (_timer) return _timer;
    var run = function() {
        runCheckinCycle().catch(function(e) {
            console.error('[checkin] 自动签到轮次失败: ' + ((e && e.message) || e));
        });
    };
    _timer = setInterval(run, intervalMs || CHECKIN_INTERVAL_MS);
    if (typeof _timer.unref === 'function') _timer.unref();
    var first = setTimeout(run, 30 * 1000);
    if (typeof first.unref === 'function') first.unref();
    return _timer;
}

// 测试辅助:清空当日状态(仅测试引用)
function _resetCheckinState() {
    checkinDone = {};
}

module.exports = {
    checkinDayKey: checkinDayKey,
    checkinConfigured: checkinConfigured,
    resolveCheckinUrl: resolveCheckinUrl,
    normalizeCheckinStatus: normalizeCheckinStatus,
    fetchCheckinStatus: fetchCheckinStatus,
    runCheckinForAccount: runCheckinForAccount,
    runCheckinCycle: runCheckinCycle,
    startCheckinScheduler: startCheckinScheduler,
    _resetCheckinState: _resetCheckinState
};

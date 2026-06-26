var fs = require('fs');
var https = require('https');
var express = require('express');
var jsonParser = express.json();

var glmAccountsFile = __dirname + '/accounts.json';
var PASSWORD = process.env.ADMIN_PASSWORD || '123456';
var CACHE_TTL = 5 * 60 * 1000;

var usageCache = {};

function getCached(index) {
    var c = usageCache[index];
    return (c && Date.now() - c.time < CACHE_TTL) ? c.result : null;
}
function setCache(index, result) {
    usageCache[index] = { result: result, time: Date.now() };
}
function clearCache() { usageCache = {}; expireCache = {}; }

var EXPIRE_CACHE_TTL = 24 * 60 * 60 * 1000;
var expireCache = {};

function getExpireCached(index) {
    var c = expireCache[index];
    return (c && Date.now() - c.time < EXPIRE_CACHE_TTL) ? c.result : null;
}
function setExpireCache(index, result) {
    expireCache[index] = { result: result, time: Date.now() };
}

function readAccounts() {
    if (!fs.existsSync(glmAccountsFile)) {
        writeAccounts([]);
        return [];
    }
    return JSON.parse(fs.readFileSync(glmAccountsFile, 'utf8')).accounts;
}
function writeAccounts(accounts) {
    fs.writeFileSync(glmAccountsFile, JSON.stringify({ accounts: accounts }, null, 2));
}

function httpsGet(url, headers) {
    return new Promise(function(resolve, reject) {
        https.get(url, { headers: headers }, function(res) {
            var body = '';
            res.on('data', function(c) { body += c; });
            res.on('end', function() {
                if (res.statusCode < 200 || res.statusCode >= 300)
                    return reject(new Error('HTTP ' + res.statusCode + ': ' + body.slice(0, 200)));
                try { resolve(JSON.parse(body)); }
                catch (e) { reject(new Error('Invalid JSON: ' + body.slice(0, 200))); }
            });
        }).on('error', reject);
    });
}

function httpsRequest(method, url, headers, body) {
    return new Promise(function(resolve, reject) {
        var m = url.match(/^https:\/\/([^\/]+)(\/.*)$/);
        if (!m) return reject(new Error('Invalid URL'));
        var bodyStr = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : '';
        var opts = {
            hostname: m[1], path: m[2], method: method,
            headers: Object.assign({}, headers, bodyStr ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) } : {})
        };
        var req = https.request(opts, function(res) {
            var data = '';
            res.on('data', function(c) { data += c; });
            res.on('end', function() {
                if (res.statusCode < 200 || res.statusCode >= 300)
                    return reject(new Error('HTTP ' + res.statusCode + ': ' + data.slice(0, 200)));
                try { resolve(JSON.parse(data)); }
                catch (e) { reject(new Error('Invalid JSON: ' + data.slice(0, 200))); }
            });
        });
        req.on('error', reject);
        if (bodyStr) req.write(bodyStr);
        req.end();
    });
}

function checkAuth(req, res, next) {
    if (req.headers['x-auth-password'] !== PASSWORD)
        return res.status(401).json({ error: '密码错误' });
    next();
}

function makeHeaders(account) {
    return {
        'accept': 'application/json, text/plain, */*',
        'authorization': account.authorization,
        'bigmodel-organization': account.organization,
        'bigmodel-project': account.project,
    };
}

function keysUrl(account, suffix) {
    return 'https://bigmodel.cn/api/biz/v1/organization/' + account.organization
        + '/projects/' + account.project + '/api_keys' + (suffix || '');
}

// ============ GLM 账号 ============

async function fetchGLMUsage(account, index) {
    try {
        var json = await httpsGet('https://bigmodel.cn/api/monitor/usage/quota/limit', makeHeaders(account));
        var result = { index: index, name: account.name, platform: 'glm', responsiblePerson: account.responsiblePerson, phone: account.phone, notes: account.notes, keyCount: account.keyCount, data: json.data, success: true, cachedAt: Date.now() };
        setCache(index, result);
        return result;
    } catch (err) {
        return { index: index, name: account.name, platform: 'glm', responsiblePerson: account.responsiblePerson, phone: account.phone, notes: account.notes, keyCount: account.keyCount, error: err.message, success: false };
    }
}

async function fetchGLMExpire(account, index) {
    try {
        var json = await httpsGet('https://bigmodel.cn/api/biz/trial-cards/current-user', makeHeaders(account));
        var result = { expireTime: json.data && json.data.expireTime, inviteCode: json.data && json.data.inviteCode, success: true, cachedAt: Date.now() };
        setExpireCache(index, result);
        return result;
    } catch (err) {
        return { error: err.message, success: false, cachedAt: Date.now() };
    }
}

// ============ YesCode 账号 ============

async function fetchYesCodeUsage(account, index) {
    try {
        var headers = {
            'accept': 'application/json, text/plain, */*',
            'cookie': account.cookie || ''
        };
        var json = await httpsGet('https://co.yes.vg/api/v1/auth/profile', headers);
        var result = {
            index: index,
            name: account.name,
            platform: 'yescode',
            responsiblePerson: account.responsiblePerson,
            phone: account.phone,
            notes: account.notes,
            data: json.data || json,
            success: true,
            cachedAt: Date.now()
        };
        setCache(index, result);
        return result;
    } catch (err) {
        return {
            index: index,
            name: account.name,
            platform: 'yescode',
            responsiblePerson: account.responsiblePerson,
            phone: account.phone,
            notes: account.notes,
            error: err.message,
            success: false
        };
    }
}

// ============ 火狸 账号 ============

async function loginHuoli(email, password) {
    var json = await httpsRequest('POST', 'https://huolilink.com/api/v1/auth/login', {
        'accept': 'application/json, text/plain, */*',
        'accept-language': 'zh',
        'content-type': 'application/json'
    }, { email: email, password: password, user_type: 'personal' });
    if (json.code !== 0 || !json.data || !json.data.access_token) {
        throw new Error('火狸登录失败: ' + (json.message || '未知错误'));
    }
    return 'Bearer ' + json.data.access_token;
}

function saveHuoliToken(index, newAuth) {
    try {
        var accounts = readAccounts();
        if (accounts[index] && accounts[index].platform === 'huoli') {
            accounts[index].authorization = newAuth;
            writeAccounts(accounts);
        }
    } catch (e) { /* ignore write errors */ }
}

async function fetchHuoliUsage(account, index) {
    try {
        var headers = {
            'accept': 'application/json, text/plain, */*',
            'authorization': account.authorization || ''
        };
        var json;
        try {
            json = await httpsGet('https://huolilink.com/api/v1/subscriptions/active?timezone=Asia%2FShanghai', headers);
        } catch (authErr) {
            // 如果是 401 且有 email/password，自动重新登录
            if (authErr.message && authErr.message.indexOf('HTTP 401') >= 0 && account.huoli_email && account.huoli_password) {
                var newAuth = await loginHuoli(account.huoli_email, account.huoli_password);
                saveHuoliToken(index, newAuth);
                headers.authorization = newAuth;
                json = await httpsGet('https://huolilink.com/api/v1/subscriptions/active?timezone=Asia%2FShanghai', headers);
            } else {
                throw authErr;
            }
        }
        var result = {
            index: index,
            name: account.name,
            platform: 'huoli',
            responsiblePerson: account.responsiblePerson,
            phone: account.phone,
            notes: account.notes,
            data: json.data || json,
            success: true,
            cachedAt: Date.now()
        };
        setCache(index, result);
        return result;
    } catch (err) {
        return {
            index: index,
            name: account.name,
            platform: 'huoli',
            responsiblePerson: account.responsiblePerson,
            phone: account.phone,
            notes: account.notes,
            error: err.message,
            success: false
        };
    }
}

// ============ 统一调度 ============

async function fetchAccountUsage(account, index) {
    var platform = account.platform || 'glm';
    if (platform === 'yescode') {
        return fetchYesCodeUsage(account, index);
    }
    if (platform === 'huoli') {
        return fetchHuoliUsage(account, index);
    }
    return fetchGLMUsage(account, index);
}

async function fetchAccountExpire(account, index) {
    var platform = account.platform || 'glm';
    if (platform === 'yescode' || platform === 'huoli') {
        // 火狸到期信息从 subscriptions/active 接口的 expires_at 获取，由前端渲染
        return { success: false, cachedAt: Date.now() };
    }
    return fetchGLMExpire(account, index);
}

function getAccount(req) {
    var accounts = readAccounts();
    return accounts[parseInt(req.params.index)];
}

module.exports = function(app) {

    // 密码验证
    app.post('/api/auth', jsonParser, function(req, res) {
        res.json({ success: req.body.password === PASSWORD });
    });

    // ============ 用量查询 ============

    app.get('/api/usage', async function(req, res) {
        try {
            var accounts = readAccounts();
            var force = req.query.force === '1';
            res.json(await Promise.all(accounts.map(function(account, i) {
                if (!force) { var c = getCached(i); if (c) return c; }
                return fetchAccountUsage(account, i);
            })));
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.get('/api/usage/:index', async function(req, res) {
        try {
            var i = parseInt(req.params.index);
            var account = getAccount(req);
            if (!account) return res.status(404).json({ error: '未找到账号' });
            if (req.query.force !== '1') { var c = getCached(i); if (c) return res.json(c); }
            res.json(await fetchAccountUsage(account, i));
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // ============ API Keys（查看公开，操作需密码） ============

    app.get('/api/keys/:index', async function(req, res) {
        try {
            var i = parseInt(req.params.index);
            var account = getAccount(req);
            if (!account) return res.status(404).json({ error: '未找到账号' });
            if ((account.platform || 'glm') === 'yescode' || (account.platform || 'glm') === 'huoli') {
                return res.json([]);
            }
            var json = await httpsGet(keysUrl(account, '?keyType=1'), makeHeaders(account));
            var keys = json.data || [];
            var accounts = readAccounts();
            accounts[i].keyCount = keys.length;
            writeAccounts(accounts);
            var c = usageCache[i];
            if (c && c.result) c.result.keyCount = keys.length;
            res.json(keys);
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.get('/api/keys/:index/copy/:apiKey', checkAuth, async function(req, res) {
        try {
            var account = getAccount(req);
            if (!account) return res.status(404).json({ error: '未找到账号' });
            var json = await httpsGet(keysUrl(account, '/copy/' + req.params.apiKey), makeHeaders(account));
            res.json(json.data || {});
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.post('/api/keys/:index', jsonParser, checkAuth, async function(req, res) {
        try {
            var account = getAccount(req);
            if (!account) return res.status(404).json({ error: '未找到账号' });
            var json = await httpsRequest('POST', keysUrl(account), makeHeaders(account), { name: req.body.name, keyType: 1 });
            res.json(json.data || {});
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.delete('/api/keys/:index/:apiKey', checkAuth, async function(req, res) {
        try {
            var account = getAccount(req);
            if (!account) return res.status(404).json({ error: '未找到账号' });
            await httpsRequest('DELETE', keysUrl(account, '/' + req.params.apiKey), makeHeaders(account));
            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // ============ 账号管理（需密码） ============

    app.get('/api/accounts', checkAuth, function(req, res) {
        try { res.json(readAccounts()); } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.post('/api/accounts', jsonParser, checkAuth, function(req, res) {
        try {
            var accounts = readAccounts();
            accounts.push(req.body);
            writeAccounts(accounts);
            clearCache();
            res.json({ success: true, index: accounts.length - 1 });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.put('/api/accounts/:index', jsonParser, checkAuth, function(req, res) {
        try {
            var accounts = readAccounts();
            var idx = parseInt(req.params.index);
            if (!accounts[idx]) return res.status(404).json({ error: '未找到账号' });
            accounts[idx] = req.body;
            writeAccounts(accounts);
            clearCache();
            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.put('/api/accounts', jsonParser, checkAuth, function(req, res) {
        try {
            if (!Array.isArray(req.body)) return res.status(400).json({ error: '参数必须是数组' });
            writeAccounts(req.body);
            clearCache();
            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.delete('/api/accounts/:index', checkAuth, function(req, res) {
        try {
            var accounts = readAccounts();
            var idx = parseInt(req.params.index);
            if (!accounts[idx]) return res.status(404).json({ error: '未找到账号' });
            accounts.splice(idx, 1);
            writeAccounts(accounts);
            clearCache();
            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // ============ 用量曲线 ============

    app.get('/api/model-usage/:index', async function(req, res) {
        try {
            var account = getAccount(req);
            if (!account) return res.status(404).json({ error: '未找到账号' });
            if ((account.platform || 'glm') === 'yescode' || (account.platform || 'glm') === 'huoli') {
                return res.json({ error: (account.platform === 'huoli' ? '火狸' : 'YesCode') + ' 暂不支持用量曲线' });
            }
            var period = req.query.period || '7d';
            var now = new Date();
            var pad = function(n) { return n < 10 ? '0' + n : '' + n; };
            function fmtDate(d, hms) {
                return d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate()) + ' ' + hms;
            }
            var endDate = fmtDate(now, '23:59:59');
            var startD = new Date(now);
            if (period === '30d') {
                startD.setDate(startD.getDate() - 29);
            } else if (period !== 'today') { // 7d default
                startD.setDate(startD.getDate() - 6);
            }
            var startDate = fmtDate(startD, '00:00:00');
            var url = 'https://bigmodel.cn/api/monitor/usage/model-usage?startTime='
                + encodeURIComponent(startDate) + '&endTime=' + encodeURIComponent(endDate);
            var json = await httpsGet(url, makeHeaders(account));
            res.json(json);
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // ============ 订阅到期时间 ============

    app.get('/api/expire', async function(req, res) {
        try {
            var accounts = readAccounts();
            var force = req.query.force === '1';
            res.json(await Promise.all(accounts.map(function(account, i) {
                if (!force) { var c = getExpireCached(i); if (c) return c; }
                return fetchAccountExpire(account, i);
            })));
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.get('/api/expire/:index', async function(req, res) {
        try {
            var i = parseInt(req.params.index);
            var account = getAccount(req);
            if (!account) return res.status(404).json({ error: '未找到账号' });
            if (req.query.force !== '1') { var c = getExpireCached(i); if (c) return res.json(c); }
            res.json(await fetchAccountExpire(account, i));
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

};

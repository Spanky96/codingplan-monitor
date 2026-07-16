'use strict';

var childProcess = require('child_process');
var crypto = require('crypto');
var fs = require('fs');
var http = require('http');
var net = require('net');
var os = require('os');
var path = require('path');
var puppeteer = require('puppeteer-core');
var config = require('./config');

var COST_URL = 'https://token.telecomjs.com/finance/cost';
var COST_API_PATH = '/heimdall-product/cost-center/customer/card-with-time-range';
var LOGIN_URL = 'https://token.telecomjs.com/login';
var SMS_SEND_PATH = '/api/udp-platform/api/customer/auth/send-sms-code';
var SMS_LOGIN_PATH = '/api/udp-platform/api/customer/auth/sms-login';
var FETCH_TIMEOUT = 60 * 1000;
var LOGIN_TIMEOUT = 5 * 60 * 1000;
var browserPromise = null;
var chromeProcess = null;
var chromeProfile = null;
var fetchQueue = Promise.resolve();
var loginSessions = new Map();
var accountLoginSessions = new Map();

process.once('exit', function() {
    if (chromeProcess) chromeProcess.kill('SIGTERM');
});

function debug(message) {
    if (process.env.TELECOMJS_DEBUG === '1') console.log('[telecomjs] ' + message);
}

function delay(ms) {
    return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

function normalizeTelephone(value) {
    var phone = String(value || '').replace(/[\s()-]/g, '');
    if (phone.indexOf('+86') === 0) phone = phone.slice(3);
    else if (phone.indexOf('86') === 0 && phone.length === 13) phone = phone.slice(2);
    return phone;
}

function withTimeout(promise, timeout, message) {
    var timer;
    return Promise.race([
        promise,
        new Promise(function(resolve, reject) {
            timer = setTimeout(function() { reject(new Error(message)); }, timeout);
        })
    ]).finally(function() { clearTimeout(timer); });
}

function findChrome() {
    var candidates = [
        config.telecomjsChromePath,
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/google-chrome'
    ].filter(Boolean);
    for (var i = 0; i < candidates.length; i++) {
        if (fs.existsSync(candidates[i])) return candidates[i];
    }
    throw new Error('未找到 Chrome/Chromium，请设置 TELECOMJS_CHROME_PATH');
}

function getFreePort() {
    return new Promise(function(resolve, reject) {
        var server = net.createServer();
        server.unref();
        server.on('error', reject);
        server.listen(0, '127.0.0.1', function() {
            var port = server.address().port;
            server.close(function() { resolve(port); });
        });
    });
}

async function waitForDevTools(port) {
    var url = 'http://127.0.0.1:' + port + '/json/version';
    for (var i = 0; i < 75; i++) {
        try {
            await new Promise(function(resolve, reject) {
                http.get(url, function(res) {
                    res.resume();
                    res.statusCode === 200 ? resolve() : reject(new Error('HTTP ' + res.statusCode));
                }).on('error', reject);
            });
            return;
        } catch (e) { await delay(200); }
    }
    throw new Error('Chrome DevTools 启动超时');
}

async function launchBrowser() {
    var port = await getFreePort();
    chromeProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'glm-usage-telecom-'));
    var args = [
        '--remote-debugging-address=127.0.0.1',
        '--remote-debugging-port=' + port,
        '--user-data-dir=' + chromeProfile,
        '--no-first-run',
        '--start-minimized',
        'about:blank'
    ];
    if (process.platform === 'linux') args.push('--no-sandbox', '--disable-setuid-sandbox');

    chromeProcess = childProcess.spawn(findChrome(), args, { stdio: 'ignore' });
    chromeProcess.once('exit', function() {
        chromeProcess = null;
        browserPromise = null;
    });
    try {
        await waitForDevTools(port);
        var browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:' + port });
        browser.once('disconnected', function() { browserPromise = null; });
        debug('原生 Chrome 已启动');
        return browser;
    } catch (err) {
        if (chromeProcess) chromeProcess.kill('SIGTERM');
        chromeProcess = null;
        throw err;
    }
}

async function getBrowser() {
    if (!browserPromise) {
        browserPromise = launchBrowser().catch(function(err) {
            browserPromise = null;
            throw err;
        });
    }
    var browser = await browserPromise;
    if (!browser.connected) {
        browserPromise = null;
        return getBrowser();
    }
    return browser;
}

function unwrapCostResponse(json) {
    if (!json || typeof json !== 'object') throw new Error('智云返回了无效数据');
    var code = json.returncode != null ? Number(json.returncode) : Number(json.code);
    if (isFinite(code) && code !== 0 && code !== 200) {
        throw new Error('智云接口失败: ' + (json.message || json.msg || code));
    }
    var result = json.result || json.data;
    if (!result || typeof result.balance !== 'number') {
        throw new Error('智云未返回余额，satoken 可能已失效');
    }
    return result;
}

function apiError(json, fallback) {
    if (!json || typeof json !== 'object') return new Error(fallback || '智云返回了无效数据');
    var code = json.returncode != null ? Number(json.returncode) : Number(json.code);
    if (isFinite(code) && code !== 0 && code !== 200) {
        return new Error(json.message || json.msg || (fallback + ': ' + code));
    }
    return null;
}

function publicLoginSession(session) {
    if (!session) return null;
    return {
        id: session.id,
        status: session.status,
        mode: session.mode,
        message: session.message || '',
        createdAt: session.createdAt,
        expiresAt: session.expiresAt
    };
}

async function disposeLoginPage(session) {
    if (!session) return;
    if (session.pollTimer) clearInterval(session.pollTimer);
    session.pollTimer = null;
    if (session.expireTimer) clearTimeout(session.expireTimer);
    session.expireTimer = null;
    var page = session.page;
    var context = session.context;
    session.page = null;
    session.context = null;
    if (page) await page.close().catch(function() {});
    if (context) await context.close().catch(function() {});
}

function scheduleLoginRemoval(session) {
    if (!session || session.removalTimer) return;
    session.removalTimer = setTimeout(function() {
        loginSessions.delete(session.id);
        if (accountLoginSessions.get(session.accountKey) === session.id) {
            accountLoginSessions.delete(session.accountKey);
        }
    }, 2 * 60 * 1000);
    if (session.removalTimer.unref) session.removalTimer.unref();
}

async function completeLogin(session, token) {
    if (!session || session.status === 'success' || session.status === 'cancelled') return;
    token = String(token || '').trim();
    if (!token) throw new Error('智云登录成功但未返回 satoken');
    session.status = 'saving';
    session.message = '登录成功，正在更新鉴权';
    try {
        await session.onToken(token);
        session.status = 'success';
        session.message = '登录成功，satoken 已自动更新';
    } catch (err) {
        session.status = 'error';
        session.message = err.message || '自动更新 satoken 失败';
    }
    await disposeLoginPage(session);
    scheduleLoginRemoval(session);
}

async function pollLoginToken(session) {
    if (!session || session.checkingToken || session.status !== 'pending' || !session.page) return;
    session.checkingToken = true;
    try {
        var token = await session.page.evaluate(function() {
            return location.hostname === 'token.telecomjs.com' ? localStorage.getItem('token') : null;
        });
        if (token) await completeLogin(session, token);
    } catch (err) {
        // 天翼登录期间页面会跨域跳转，短暂无法读取 top page 属正常现象。
    } finally {
        session.checkingToken = false;
    }
}

async function cancelLogin(id, status, message) {
    var session = loginSessions.get(id);
    if (!session) return false;
    if (session.status === 'pending' || session.status === 'starting' || session.status === 'saving') {
        session.status = status || 'cancelled';
        session.message = message || '登录已取消';
    }
    await disposeLoginPage(session);
    scheduleLoginRemoval(session);
    return true;
}

async function startLogin(options) {
    options = options || {};
    if (!options.accountKey || typeof options.onToken !== 'function') throw new Error('缺少智云登录账号信息');
    var verifiedTelephone = normalizeTelephone(options.telephone);
    if (!/^1[3-9]\d{9}$/.test(verifiedTelephone)) throw new Error('缺少已核对的智云账号手机号');
    var oldId = accountLoginSessions.get(options.accountKey);
    if (oldId) await cancelLogin(oldId, 'cancelled', '已由新的登录会话替代');

    var now = Date.now();
    var session = {
        id: crypto.randomBytes(18).toString('hex'),
        accountKey: options.accountKey,
        telephone: verifiedTelephone,
        onToken: options.onToken,
        status: 'starting',
        mode: 'qr',
        message: '正在打开官方登录页',
        createdAt: now,
        expiresAt: now + LOGIN_TIMEOUT,
        context: null,
        page: null,
        checkingToken: false
    };
    loginSessions.set(session.id, session);
    accountLoginSessions.set(session.accountKey, session.id);

    try {
        var browser = await getBrowser();
        session.context = await browser.createBrowserContext();
        session.page = await session.context.newPage();
        await session.page.setViewport({ width: 800, height: 600, deviceScaleFactor: 1 });
        session.page.setDefaultTimeout(FETCH_TIMEOUT);
        session.page.setDefaultNavigationTimeout(FETCH_TIMEOUT);
        await session.page.evaluateOnNewDocument(function() {
            localStorage.removeItem('token');
            localStorage.removeItem('userInfo');
        });
        await session.page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: FETCH_TIMEOUT });
        await session.page.waitForSelector('iframe', { timeout: 35 * 1000 });
        await delay(1500);
        session.status = 'pending';
        session.message = '请扫码或使用短信验证码登录';
        session.pollTimer = setInterval(function() { pollLoginToken(session); }, 1000);
        if (session.pollTimer.unref) session.pollTimer.unref();
        session.expireTimer = setTimeout(function() {
            cancelLogin(session.id, 'expired', '二维码已过期，请重新打开登录');
        }, LOGIN_TIMEOUT);
        if (session.expireTimer.unref) session.expireTimer.unref();
        return publicLoginSession(session);
    } catch (err) {
        session.status = 'error';
        session.message = err.message || '智云登录页打开失败';
        await disposeLoginPage(session);
        scheduleLoginRemoval(session);
        throw err;
    }
}

function getLogin(id) {
    return publicLoginSession(loginSessions.get(id));
}

async function getLoginScreenshot(id) {
    var session = loginSessions.get(id);
    if (!session) throw new Error('登录会话不存在或已过期');
    if (!session.page || (session.status !== 'pending' && session.status !== 'starting')) {
        throw new Error(session.message || '登录会话已结束');
    }
    var iframe = await session.page.$('iframe');
    var box = iframe && await iframe.boundingBox();
    if (!box) throw new Error('官方登录二维码尚未就绪');
    return session.page.screenshot({
        type: 'png',
        clip: {
            x: Math.max(0, Math.floor(box.x)),
            y: Math.max(0, Math.floor(box.y)),
            width: Math.ceil(box.width),
            height: Math.ceil(box.height)
        }
    });
}

async function pageJsonRequest(session, pathName, body) {
    if (!session || !session.page || session.status !== 'pending') throw new Error('登录会话不存在或已结束');
    var response = await session.page.evaluate(function(input) {
        return new Promise(function(resolve, reject) {
            var xhr = new XMLHttpRequest();
            xhr.open('POST', input.path);
            xhr.setRequestHeader('Content-Type', 'application/json');
            xhr.onload = function() { resolve({ status: xhr.status, body: xhr.responseText }); };
            xhr.onerror = function() { reject(new Error('智云登录请求网络错误')); };
            xhr.send(JSON.stringify(input.body));
        });
    }, { path: pathName, body: body });
    if (response.status < 200 || response.status >= 300) {
        throw new Error('智云登录接口 HTTP ' + response.status);
    }
    try { return JSON.parse(response.body); }
    catch (err) { throw new Error('智云登录接口返回了无效 JSON'); }
}

async function sendSmsCode(id, telephone) {
    var session = loginSessions.get(id);
    telephone = normalizeTelephone(telephone);
    if (!/^1[3-9]\d{9}$/.test(telephone)) throw new Error('手机号格式不正确');
    if (!session || telephone !== session.telephone) throw new Error('手机号与当前登录会话不一致');
    var json = await pageJsonRequest(session, SMS_SEND_PATH, { telephone: telephone });
    var err = apiError(json, '验证码发送失败');
    if (err) throw err;
    session.mode = 'sms';
    session.message = '验证码已发送，请查收短信';
    return { success: true };
}

async function submitSmsCode(id, telephone, verifyCode) {
    var session = loginSessions.get(id);
    telephone = normalizeTelephone(telephone);
    verifyCode = String(verifyCode || '').trim();
    if (!/^1[3-9]\d{9}$/.test(telephone)) throw new Error('手机号格式不正确');
    if (!session || telephone !== session.telephone) throw new Error('手机号与当前登录会话不一致');
    if (!/^\d{4,8}$/.test(verifyCode)) throw new Error('短信验证码格式不正确');
    var json = await pageJsonRequest(session, SMS_LOGIN_PATH, { telephone: telephone, verifyCode: verifyCode });
    var err = apiError(json, '短信登录失败');
    if (err) throw err;
    var data = json.result || json.data || json;
    var token = data && (data.token || data.satoken || data.saToken);
    if (!token) throw new Error('短信登录成功但未返回 satoken');
    await completeLogin(session, token);
    if (session.status !== 'success') throw new Error(session.message || '自动更新 satoken 失败');
    return { success: true };
}

function formatDate(date) {
    function pad(value) { return value < 10 ? '0' + value : String(value); }
    return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
}

async function fetchBalanceNow(satoken) {
    if (!satoken) throw new Error('智云 satoken 不能为空');

    var browser = await getBrowser();
    var page = await browser.newPage();
    try {
        page.setDefaultTimeout(FETCH_TIMEOUT);
        page.setDefaultNavigationTimeout(FETCH_TIMEOUT);
        await page.evaluateOnNewDocument(function(token) {
            localStorage.setItem('token', token);
        }, satoken);

        // 第二次 200 页面只需要瑞数运行时，不加载业务 SPA，避免失效 token 触发 /login 重定向循环。
        await page.setRequestInterception(true);
        page.on('request', function(request) {
            var parsed;
            try { parsed = new URL(request.url()); } catch (e) { request.continue(); return; }
            if (parsed.hostname === 'token.telecomjs.com'
                && parsed.pathname.indexOf('/assets/') === 0
                && request.resourceType() === 'script') {
                request.abort();
            } else {
                request.continue();
            }
        });

        var seenChallenge = false;
        var challengePassed = new Promise(function(resolve, reject) {
            page.on('response', function(response) {
                var parsed;
                try { parsed = new URL(response.url()); } catch (e) { return; }
                if (parsed.hostname !== 'token.telecomjs.com' || parsed.pathname !== '/finance/cost') return;
                debug('费用页响应 ' + response.status());
                if (response.status() === 412) seenChallenge = true;
                else if (response.status() === 200) resolve();
                else if (seenChallenge && response.status() >= 400) {
                    reject(new Error('智云瑞数挑战失败: HTTP ' + response.status()));
                }
            });
        });
        challengePassed.catch(function() {});

        await withTimeout(
            page.goto(COST_URL, { waitUntil: 'domcontentloaded', timeout: FETCH_TIMEOUT }),
            FETCH_TIMEOUT,
            '智云页面打开超时'
        );
        await withTimeout(challengePassed, 30 * 1000, '智云瑞数挑战超时');
        await delay(1000);

        var end = new Date();
        var start = new Date(end);
        start.setDate(start.getDate() - 30);
        var raw = await withTimeout(
            page.evaluate(function(input) {
                function requestRange(startDate, endDate) {
                    return new Promise(function(resolve, reject) {
                        var xhr = new XMLHttpRequest();
                        xhr.open('POST', '/api/heimdall-product/cost-center/customer/card-with-time-range');
                        xhr.setRequestHeader('Content-Type', 'application/json');
                        xhr.setRequestHeader('Satoken', input.satoken);
                        xhr.onload = function() { resolve({ status: xhr.status, body: xhr.responseText }); };
                        xhr.onerror = function() { reject(new Error('智云余额请求网络错误')); };
                        xhr.send(JSON.stringify({ startDate: startDate, endDate: endDate, adminView: false }));
                    });
                }
                return requestRange(input.today, input.today).then(function(today) {
                    return requestRange(input.startDate, input.today).then(function(thirtyDays) {
                        return { today: today, thirtyDays: thirtyDays };
                    });
                });
            }, { satoken: satoken, today: formatDate(end), startDate: formatDate(start) }),
            20 * 1000,
            '等待智云余额接口超时'
        );
        debug('余额接口响应 今日=' + raw.today.status + '，近30日=' + raw.thirtyDays.status);
        if (raw.today.status < 200 || raw.today.status >= 300) throw new Error('智云今日消费接口 HTTP ' + raw.today.status);
        if (raw.thirtyDays.status < 200 || raw.thirtyDays.status >= 300) throw new Error('智云近30日消费接口 HTTP ' + raw.thirtyDays.status);
        var todayJson, thirtyDaysJson;
        try {
            todayJson = JSON.parse(raw.today.body);
            thirtyDaysJson = JSON.parse(raw.thirtyDays.body);
        } catch (e) { throw new Error('智云余额接口返回了无效 JSON'); }
        var todayData = unwrapCostResponse(todayJson);
        var data = unwrapCostResponse(thirtyDaysJson);
        data.todayConsumption = todayData.timeRangeConsumption || 0;
        data.thirtyDayConsumption = data.timeRangeConsumption || 0;
        data.consumptionRangeDays = 30;
        return data;
    } catch (err) {
        if (err && err.name === 'TimeoutError') {
            throw new Error('智云抓取超时，请检查 satoken 或 Chrome 是否能访问 token.telecomjs.com');
        }
        throw err;
    } finally {
        await withTimeout(page.close(), 5000, '关闭智云页面超时').catch(function() {});
    }
}

function fetchBalance(satoken) {
    var current = fetchQueue.then(function() { return fetchBalanceNow(satoken); });
    fetchQueue = current.catch(function() {});
    return current;
}

async function closeBrowser() {
    var activeIds = Array.from(loginSessions.keys());
    for (var i = 0; i < activeIds.length; i++) {
        await cancelLogin(activeIds[i], 'cancelled', '服务正在关闭');
    }
    if (browserPromise) {
        var pending = browserPromise;
        browserPromise = null;
        var browser = await pending.catch(function() { return null; });
        if (browser) await browser.close().catch(function() {});
    }
    if (chromeProcess) chromeProcess.kill('SIGTERM');
    chromeProcess = null;
}

module.exports = {
    fetchBalance: fetchBalance,
    startLogin: startLogin,
    getLogin: getLogin,
    getLoginScreenshot: getLoginScreenshot,
    sendSmsCode: sendSmsCode,
    submitSmsCode: submitSmsCode,
    cancelLogin: cancelLogin,
    _unwrapCostResponse: unwrapCostResponse,
    _closeBrowser: closeBrowser
};

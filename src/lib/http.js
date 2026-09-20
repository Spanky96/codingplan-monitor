// HTTP 助手:原生 https 请求封装(超时 + JSON 解析 + 非 2xx 抛错)。
// 自 src/api.js 拆出——所有平台适配器共用,无业务依赖。
var http = require('http');
var https = require('https');

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

// http/https 通用的 JSON GET（带超时），用于拉取 sub2api 容量快照。
function httpGetJSON(url, timeoutMs) {
    return new Promise(function(resolve, reject) {
        var mod = /^https:/.test(url) ? https : http;
        var req = mod.get(url, function(res) {
            var body = '';
            res.on('data', function(c) { body += c; });
            res.on('end', function() {
                if (res.statusCode < 200 || res.statusCode >= 300)
                    return reject(new Error('HTTP ' + res.statusCode + ': ' + body.slice(0, 200)));
                try { resolve(JSON.parse(body)); }
                catch (e) { reject(new Error('Invalid JSON: ' + body.slice(0, 200))); }
            });
        });
        req.on('error', reject);
        req.setTimeout(timeoutMs || 5000, function() { req.destroy(new Error('timeout')); });
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

// application/x-www-form-urlencoded 的 POST(千问等接口用 form 表单传参,含 params=<URL编码JSON> 字段)。
// httpsRequest 强制 JSON content-type 且 JSON.stringify,无法发送 form body,故单独实现。
function httpsPostForm(url, headers, formBody) {
    return new Promise(function(resolve, reject) {
        var m = url.match(/^https:\/\/([^\/]+)(\/.*)$/);
        if (!m) return reject(new Error('Invalid URL'));
        var opts = {
            hostname: m[1], path: m[2], method: 'POST',
            headers: Object.assign({}, headers, {
                'content-type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(formBody)
            })
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
        req.write(formBody);
        req.end();
    });
}


module.exports = { httpsGet: httpsGet, httpGetJSON: httpGetJSON, httpsRequest: httpsRequest, httpsPostForm: httpsPostForm };

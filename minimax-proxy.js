// MiniMax 反向代理:把同源请求 /minimax/* 透传到 sub2api 中转站,
// 由中转站按账号端点映射透传 https://api.minimaxi.com/*(原生端点透传)。
// 目的:规避浏览器直连中转站/官方 API 的跨域与证书问题。
// 默认关闭:.env 配置 MINIMAX_PROXY_UPSTREAM 后才启用,未配置时 /minimax/* 返回 404。
// (models 模型调用页现已直连网关地址,本代理为兼容保留)
// 安全:上游主机固定,不读取请求里的目标,避免成为开放代理 / SSRF。
'use strict';

const config = require('./config');
const UPSTREAM_ORIGIN = config.minimaxProxyUpstream;

// 不转发给上游的请求头(hop-by-hop / 代理语义;content-encoding 由 fetch 自行处理)
const STRIP_REQ = ['host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive',
  'expect', 'te', 'trailers', 'upgrade', 'proxy-authorization', 'proxy-authenticate',
  'content-encoding'];
// 不回传给浏览器的响应头(fetch 已解压,需避免与真实字节不一致的 content-length / encoding)
const STRIP_RES = ['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive'];

function pickHeaders(src, strip) {
  const out = {};
  Object.keys(src || {}).forEach((k) => { if (strip.indexOf(k.toLowerCase()) < 0) out[k] = src[k]; });
  return out;
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function proxy(req, res) {
  // 去掉 /minimax 前缀(保留 query),拼到上游
  const upPath = String(req.url).replace(/^\/minimax/, '') || '/';
  const upUrl = UPSTREAM_ORIGIN + upPath;
  const method = req.method;
  const hasBody = method !== 'GET' && method !== 'HEAD';

  readRawBody(req)
    .then((bodyBuf) => {
      const fetchOpts = { method, headers: pickHeaders(req.headers, STRIP_REQ) };
      if (hasBody) fetchOpts.body = bodyBuf; // 原始字节透传(multipart 边界完整保留)
      const ctrl = new AbortController();
      fetchOpts.signal = ctrl.signal;
      const timer = setTimeout(() => ctrl.abort(), 120000);
      return fetch(upUrl, fetchOpts).then(
        (up) => {
          clearTimeout(timer);
          res.status(up.status);
          up.headers.forEach((v, k) => { if (STRIP_RES.indexOf(k.toLowerCase()) < 0) res.setHeader(k, v); });
          return up.arrayBuffer().then((ab) => res.send(Buffer.from(ab)));
        },
        (e) => {
          clearTimeout(timer);
          if (!res.headersSent) res.status(502).json({ error: 'proxy_failed', message: String((e && e.name === 'AbortError') ? 'upstream timeout' : (e && e.message || e)) });
          else { try { res.end(); } catch (er) { /* 忽略 */ } }
        }
      );
    })
    .catch((e) => {
      if (!res.headersSent) res.status(400).json({ error: 'bad_request', message: String((e && e.message) || e) });
    });
}

module.exports = function (app) {
  if (!UPSTREAM_ORIGIN) {
    // 未配置上游:注册占位路由返回明确错误,避免误用
    const notConfigured = (req, res) => res.status(404).json({
      error: 'MINIMAX_PROXY_UPSTREAM 未配置,反向代理未启用'
    });
    app.all('/minimax', notConfigured);
    app.all('/minimax/*', notConfigured);
    return;
  }
  app.all('/minimax', proxy);
  app.all('/minimax/*', proxy);
};

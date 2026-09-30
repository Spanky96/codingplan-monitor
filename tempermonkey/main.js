// ==UserScript==
// @name         监控面板控制台自动登录(智谱/MiniMax)
// @namespace    glm-usage
// @version      1.1.2
// @description  配合 glm-usage 监控面板的「控制台」链接：智谱从 ?token= 读取 authorization 写入 bigmodel_token_production；MiniMax 从 ?ck= 读取整串 cookie(base64url) 逐个写回所在域。均在页面加载前完成，实现一键免登录进后台
// @author       spanky
// @match        https://bigmodel.cn/*
// @match        https://*.bigmodel.cn/*
// @match        https://minimaxi.com/*
// @match        https://*.minimaxi.com/*
// @match        https://minimax.cn/*
// @match        https://*.minimax.cn/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

// 原理：监控面板（管理员身份）打开账号详情时，「控制台」链接经服务端
// /api/console-url 实时换取为带凭据的地址，本脚本在该页任何脚本执行前（document-start）拦截：
//   智谱    https://bigmodel.cn/coding-plan?token=<urlencode(authorization)>
//   MiniMax https://platform.minimax.cn/console/plan?ck=<base64url(整串 cookie)>
// 处理流程：
//   1) 智谱：清空 bigmodel.cn 域下已可见的其他 cookie（残留登录态/测试态，避免串号），
//      写入本次 token 到 bigmodel_token_production（官方登录 cookie）。
//   2) MiniMax：官方无 token 免登录，登录态即浏览器 cookie —— base64url 解码出
//      整串 cookie，清空已可见的其他 cookie 后，把 name=value 逐个写回所在域
//      （console 已迁移 minimax.cn 且经 account.minimax.cn OAuth 门控；监控存储的
//      minimaxi.com 会话经线上实测对 minimax.cn 同样有效，会话跨域通用）。
//   3) 最后把地址栏上的凭据参数抹掉，避免泄露到历史记录与截图。
// 无凭据参数时脚本不做任何操作，正常浏览不受影响。

(function () {
    'use strict';

    var params = new URLSearchParams(location.search);

    // 地址栏抹除凭据参数，防止泄露到历史记录 / 分享链接
    function stripParams(names) {
        try {
            var clean = new URL(location.href);
            names.forEach(function (n) { clean.searchParams.delete(n); });
            history.replaceState(null, '', clean.pathname + clean.search + clean.hash);
        } catch (e) { /* 老浏览器忽略 */ }
    }

    // 清空当前域可见的其他 cookie（逐个过期删除；对父域再清一次，
    // 覆盖以 domain 属性写入的残留）。keep 里的名字不删（稍后马上覆写）。
    // document-start 阶段读不到全部历史 cookie 属正常（浏览器尚未注入），
    // 此时仅剩官方新写入态，无串号风险。
    function clearVisibleCookies(parentDomain, keep) {
        if (!document.cookie) return;
        document.cookie.split(';').forEach(function (pair) {
            var name = pair.split('=')[0].trim();
            if (!name || keep.indexOf(name) >= 0) return;
            document.cookie = name + '=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
            document.cookie = name + '=; expires=Thu, 01 Jan 1970 00:00:00 GMT; domain=.' + parentDomain + '; path=/';
        });
    }

    // ============ 智谱 bigmodel.cn:?token= ============
    if (/(^|\.)bigmodel\.cn$/.test(location.hostname)) {
        var token = params.get('token');
        if (token) {
            // 写入官方登录 cookie（max-age 30 天，与面板侧 token 量级匹配；
            // token 本身过期后官方会引导重新登录，属预期；@match 仅 https,Secure 可加）
            clearVisibleCookies('bigmodel.cn', ['bigmodel_token_production']);
            document.cookie = 'bigmodel_token_production=' + token
                + '; domain=.bigmodel.cn; path=/; max-age=2592000; SameSite=Lax; Secure';
            stripParams(['token']);
        }
        return;
    }

    // ============ MiniMax minimaxi.com / minimax.cn:?ck= ============
    // console 已迁移 minimax.cn 域;存储的会话跨两域通用,写到脚本所在域即可
    var mmHost = location.hostname.match(/minimaxi\.com$|minimax\.cn$/);
    if (!mmHost) return;
    var ck = params.get('ck');
    if (!ck) return;                         // 无凭据：正常访问，不动 cookie
    var mmDomain = mmHost[0];                // 父域:minimaxi.com 或 minimax.cn

    // 1) base64url → 标准 base64 → 解码为 UTF-8 整串 cookie，拆成 name=value 对
    //    （value 可能含中文/等号，须按字节解码，不能直接 atob 当文本用）
    var pairs;
    try {
        var b64 = ck.replace(/-/g, '+').replace(/_/g, '/');
        while (b64.length % 4) b64 += '=';
        var bin = atob(b64);
        var u8 = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
        var raw = new TextDecoder('utf-8').decode(u8);
        pairs = raw.split(';').map(function (p) { return p.trim(); })
            .filter(function (p) { return p.indexOf('=') > 0; });
    } catch (e) { return; }                  // 解码失败：不动 cookie，仅跳过本次登录

    // 2) 清残留（保留本次要写的 name，稍后覆写），3) 逐个原样写回所在域
    //    （pair 含 value 里的等号等特殊字符，直接透传；30 天过期与智谱侧量级一致）
    var names = pairs.map(function (p) { return p.split('=')[0].trim(); });
    clearVisibleCookies(mmDomain, names);
    pairs.forEach(function (pair) {
        document.cookie = pair + '; domain=.' + mmDomain + '; path=/; max-age=2592000; SameSite=Lax; Secure';
    });

    // 4) 地址栏抹除 ck 后整页 reload：导航请求发出时 cookie 尚未写入,若 console 由
    //    服务端按会话门控,当前文档已是登录页,带新 cookie 重载一次才能进入；
    //    ck 已抹掉,重载后本脚本无 ?ck= 直接返回,不会循环。
    //    (智谱分支不 reload:bigmodel 是客户端门控 SPA,现网验证无需重载,保持原行为)
    stripParams(['ck']);
    location.reload();
})();

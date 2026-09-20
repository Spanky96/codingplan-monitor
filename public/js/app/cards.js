// ============ 账号卡片(按平台分派渲染)============
    function renderCardHTML(i, acc) {
      var platform = acc.platform || 'glm';
      var btn = isAdmin() ? '<button class="card-refresh" id="refresh-' + i + '" onclick="refreshCard(' + i + ')" title="刷新">&#x21bb;</button>' : '';
      var pTag = platformTag(platform, acc.planType, acc.alias);
      var wBadge = weightBadgeHTML(acc.name, i);
      var capBadge = capacityBadgeHTML(acc.name);
      // 第一行：分类标签 + 用户名；第二行：权重徽标 + 容量胶囊（都空则不占行）
      var metaRow = (wBadge || capBadge) ? '<div class="card-title-row">' + wBadge + capBadge + '</div>' : '';
      var headerLeft = '<div class="card-header-left"><div class="card-title-row">' + pTag + '<h3>' + esc(displayName(acc, i)) + '</h3></div>' + metaRow + '</div>';

      // 列表秒开占位:慢账号(尤其智云)先出骨架,不挡住其它卡
      if (isUsagePending(acc)) {
        return '<div class="card" id="card-' + i + '"><div class="card-header">' + headerLeft
          + '<div class="card-header-right">' + btn + '<span class="card-status status-loading">加载中</span></div></div>'
          + '<div class="card-body">' + cardSkeletonBody() + '</div>'
          + '<div class="card-footer"><span class="cache-time">正在获取用量…</span><button class="detail-btn" onclick="showDetail(' + i + ')" disabled style="opacity:0.5">详情</button></div></div>';
      }

      if (!acc.success) {
        var relogin = isTelecomAuthError(acc) ? telecomReloginButton(i) : '';
        return '<div class="card" id="card-' + i + '"><div class="card-header">' + headerLeft
          + '<div class="card-header-right">' + btn + '<span class="card-status status-error">请求失败</span></div></div>'
          + '<div class="card-body"><p class="error-text">' + esc(acc.error||'未知错误') + '</p>' + relogin + '</div>'
          + '<div class="card-footer"><span></span><button class="detail-btn" onclick="showDetail(' + i + ')">详情</button></div></div>';
      }

      var cache = acc.cachedAt ? '<span class="cache-time">' + timeAgo(acc.cachedAt) + '</span>' : '';

      if (platform === 'telecomjs') {
        var td = acc.data || {};
        var tm = telecomMetrics(td, acc.cachedAt);
        function telecomRow(label, value, hint) {
          return '<div class="limit-row telecom-stat-row"><div class="limit-label"><span class="limit-name">' + label + '</span><span class="limit-value">' + value + '</span></div>'
            + '<div class="telecom-stat-hint">' + hint + '</div></div>';
        }
        var averageHint = tm.rangeDays > 0 ? '按 ' + tm.rangeDays + ' 个有消费日' : '暂无有消费日';
        var telecomBody = telecomRow('可用余额', '¥' + tm.available.toFixed(2), '账户 ¥' + tm.balance.toFixed(2) + ' · 赠金 ¥' + tm.gift.toFixed(2))
          + telecomRow('今日消费', '¥' + tm.today.toFixed(2), '昨日消费 ¥' + tm.yesterday.toFixed(2))
          + telecomRow('消耗速度', '¥' + tm.dailyRate.toFixed(2) + '/天', '今日折算 ¥' + tm.projectedToday.toFixed(2) + '/天 · ' + tm.averageLabel + ' ¥' + tm.avgDaily.toFixed(2) + '/天（' + averageHint + '）')
          + telecomRow('预计可用', telecomDaysText(tm.remainingDays), tm.rateBasis + ' ¥' + tm.dailyRate.toFixed(2) + '/天');
        var telecomStatusClass = tm.remainingDays != null && tm.remainingDays < 30 ? 'status-danger'
          : (tm.remainingDays != null && tm.remainingDays < 90 ? 'status-warn' : 'status-ok');
        return '<div class="card" id="card-' + i + '"><div class="card-header">' + headerLeft
          + '<div class="card-header-right">' + btn + '<span class="card-status ' + telecomStatusClass + '">' + telecomDaysText(tm.remainingDays) + '</span></div></div>'
          + '<div class="card-body">' + telecomBody + '</div>'
          + '<div class="card-footer"><div class="card-footer-left"><span class="level-badge">累计消费 ¥' + (+(td.totalConsumption || 0)).toFixed(2) + '</span>' + cache + '</div>'
          + '<button class="detail-btn" onclick="showDetail(' + i + ')">详情</button></div></div>';
      }

      if (platform === 'yescode') {
        var d = acc.data || {};
        var plan = d.subscription_plan || {};
        var bodyHtml = renderSpendRow('今日消费', yescodeDailySpent(d), plan.daily_balance || 0, d.last_daily_balance_add, 86400000)
          + renderSpendRow('本周消费', d.current_week_spend || 0, plan.weekly_limit || 0, d.last_week_reset, 7 * 86400000)
          + renderSpendRow('本月消费', d.current_month_spend || 0, plan.monthly_spend_limit || 0, d.last_month_reset, 30 * 86400000);
        var mpY = yescodeMaxPct(d);
        var planBadge = '<span class="level-badge">' + esc(plan.name || '-') + '</span>';
        var balanceBadge = (d.balance != null) ? '<span class="level-badge level-badge-ok">余额 $' + (+d.balance).toFixed(0) + '</span>' : '';
        var expHtmlY = '';
        if (d.subscription_expiry) {
          var expDate = new Date(d.subscription_expiry);
          var daysLeftY = Math.ceil((expDate - Date.now()) / 86400000);
          var expClsY = daysLeftY <= 10 ? 'expire-danger' : '';
          var expHintY = daysLeftY <= 0 ? '已过期' : daysLeftY + '天后到期';
          var expTxt = expDate.toLocaleDateString('zh-CN');
          expHtmlY = '<div class="expire-row" title="订阅到期"><span class="expire-label">订阅到期</span><span class="expire-value ' + expClsY + '">' + esc(expTxt) + '<span class="expire-hint">' + expHintY + '</span></span></div>';
        }
        return '<div class="card" id="card-' + i + '"><div class="card-header">' + headerLeft
          + '<div class="card-header-right">' + btn + '<span class="card-status ' + getStatusClass(mpY) + '">' + getStatusText(mpY) + '</span></div></div>'
          + '<div class="card-body">' + bodyHtml + '</div>' + expHtmlY
          + '<div class="card-footer"><div class="card-footer-left">' + planBadge + balanceBadge + cache + '</div>'
          + '<button class="detail-btn" onclick="showDetail(' + i + ')">详情</button></div></div>';
      }

      if (platform === 'sub2api' || platform === 'huoli') {
        var s2a = sub2apiUnpack(acc.data);
        var me = s2a.me, sub = s2a.sub, grp = (sub && sub.group) || {};
        var dailyUsed = (sub && sub.daily_usage_usd) || 0;
        var dailyLimit = grp.daily_limit_usd || 0;
        var weeklyUsed = (sub && sub.weekly_usage_usd) || 0;
        var weeklyLimit = grp.weekly_limit_usd || 0;
        var monthlyUsed = (sub && sub.monthly_usage_usd) || 0;
        var monthlyLimit = grp.monthly_limit_usd || 0;
        // 中转站重点看余额+今日用量:今日消费/今日Token/今日费用三件套,周/月仅在有额度时展示
        var st = s2a.stats;
        var bodyHtml = '';
        if (sub) {
          bodyHtml = renderSpendRow('今日消费', dailyUsed, dailyLimit, sub.daily_window_start, 86400000);
        }
        if (st) {
          bodyHtml += '<div class="limit-row"><div class="limit-label"><span class="limit-name">今日Token</span><span class="limit-value">' + fmtTokens(st.today_tokens) + '</span></div>'
            + '<div style="font-size:11px;color:var(--text-faint);margin-top:3px">输入 ' + fmtTokens(st.today_input_tokens) + ' · 输出 ' + fmtTokens(st.today_output_tokens) + ' · 缓存读 ' + fmtTokens(st.today_cache_read_tokens) + ' · 请求 ' + (st.today_requests || 0) + ' 次</div></div>';
          bodyHtml += '<div class="limit-row"><div class="limit-label"><span class="limit-name">今日费用</span><span class="limit-value">$' + (+st.today_cost || 0).toFixed(2) + ' / 实付 $' + (+st.today_actual_cost || 0).toFixed(2) + '</span></div>'
            + '<div style="font-size:11px;color:var(--text-faint);margin-top:3px">官方价折算 / 计费倍率后实付</div></div>';
        }
        if (sub && weeklyLimit > 0) bodyHtml += renderSpendRow('本周消费', weeklyUsed, weeklyLimit, sub.weekly_window_start, 7 * 86400000);
        if (sub && monthlyLimit > 0) bodyHtml += renderSpendRow('本月消费', monthlyUsed, monthlyLimit, sub.monthly_window_start, 30 * 86400000);
        if (!bodyHtml) {
          bodyHtml = '<div class="limit-row"><div class="limit-label"><span class="limit-name">订阅</span><span class="limit-value">暂无订阅 · 按量付费</span></div></div>';
        }
        var dPctH = dailyLimit > 0 ? Math.min(100, (dailyUsed / dailyLimit) * 100) : 0;
        var wPctH = weeklyLimit > 0 ? Math.min(100, (weeklyUsed / weeklyLimit) * 100) : 0;
        var mPctH = monthlyLimit > 0 ? Math.min(100, (monthlyUsed / monthlyLimit) * 100) : 0;
        var mpH = Math.max(dPctH, wPctH, mPctH);
        var planBadgeH = sub ? '<span class="level-badge">' + esc(grp.name || '-') + '</span>' : '';
        var balanceBadgeH = (me && me.balance != null) ? '<span class="level-badge level-badge-ok">余额 $' + (+me.balance).toFixed(2) + '</span>' : '';
        var expHtmlH = '';
        if (sub && sub.expires_at) {
          var expDateH = new Date(sub.expires_at);
          var daysLeftH = Math.ceil((expDateH - Date.now()) / 86400000);
          var expClsH = daysLeftH <= 10 ? 'expire-danger' : '';
          var expHintH = daysLeftH <= 0 ? '已过期' : daysLeftH + '天后到期';
          var expTxtH = expDateH.toLocaleDateString('zh-CN');
          expHtmlH = '<div class="expire-row" title="订阅到期"><span class="expire-label">订阅到期</span><span class="expire-value ' + expClsH + '">' + esc(expTxtH) + '<span class="expire-hint">' + expHintH + '</span></span></div>';
        }
        return '<div class="card" id="card-' + i + '"><div class="card-header">' + headerLeft
          + '<div class="card-header-right">' + btn + '<span class="card-status ' + getStatusClass(mpH) + '">' + getStatusText(mpH) + '</span></div></div>'
          + '<div class="card-body">' + bodyHtml + '</div>' + expHtmlH
          + '<div class="card-footer"><div class="card-footer-left">' + balanceBadgeH + planBadgeH + cache + '</div>'
          + '<button class="detail-btn" onclick="showDetail(' + i + ')">详情</button></div></div>';
      }

      if (platform === 'volc') {
        var isCoding = acc.planType === 'coding';
        var usage = (acc.data && acc.data.usage) || {};
        var sub = (acc.data && acc.data.subscription) || null;
        var bodyHtml, mpV, planBadgeV;
        if (isCoding) {
          bodyHtml = renderVolcCrow('5小时会话', volcCQuota(usage, 'session'), 5 * 3600000, 5)
            + renderVolcCrow('每周', volcCQuota(usage, 'weekly'), 7 * 86400000, 7)
            + renderVolcCrow('每月', volcCQuota(usage, 'monthly'), volcCodingMonthlyPeriodMs(acc), 0);
          mpV = volcCMaxPct(usage);
          planBadgeV = '<span class="level-badge">' + esc((sub && sub.BizInfo) || usage.Status || '-') + '</span>';
        } else {
          var five = usage.AFPFiveHour || {};
          var week = usage.AFPWeekly || {};
          var month = usage.AFPMonthly || {};
          bodyHtml = renderVolcRow('每5小时', five, 5 * 3600000, 5)
            + renderVolcRow('每周', week, 7 * 86400000, 7)
            + renderVolcRow('每月', month, 30 * 86400000, 0);
          mpV = volcMaxPct(usage);
          planBadgeV = '<span class="level-badge">' + esc(usage.PlanType || (sub && sub.BizInfo) || '-') + '</span>';
        }
        var expHtmlV = '';
        if (sub && sub.EndTime) {
          var expDateV = new Date(sub.EndTime);
          var daysLeftV = Math.ceil((expDateV - Date.now()) / 86400000);
          var expClsV = daysLeftV <= 10 ? 'expire-danger' : '';
          var expHintV = daysLeftV <= 0 ? '已过期' : daysLeftV + '天后到期';
          var expTxtV = expDateV.toLocaleDateString('zh-CN');
          expHtmlV = '<div class="expire-row" title="订阅到期"><span class="expire-label">订阅到期</span><span class="expire-value ' + expClsV + '">' + esc(expTxtV) + '<span class="expire-hint">' + expHintV + '</span></span></div>';
        }
        return '<div class="card" id="card-' + i + '"><div class="card-header">' + headerLeft
          + '<div class="card-header-right">' + btn + '<span class="card-status ' + getStatusClass(mpV) + '">' + getStatusText(mpV) + '</span></div></div>'
          + '<div class="card-body">' + bodyHtml + '</div>' + expHtmlV
          + '<div class="card-footer"><div class="card-footer-left">' + planBadgeV + cache + '</div>'
          + '<button class="detail-btn" onclick="showDetail(' + i + ')">详情</button></div></div>';
      }

      if (platform === 'qwen') {
        var qU = (acc.data && acc.data.usage) || {};
        var qS = (acc.data && acc.data.subscription) || null;
        var q5 = typeof qU.per5HourPercentage === 'number' ? qU.per5HourPercentage : 0;
        var q7 = typeof qU.per1WeekPercentage === 'number' ? qU.per1WeekPercentage : 0;
        var qR5 = qU.per5HourResetTime || 0;
        var qR7 = qU.per1WeekResetTime || 0;
        var mpQ = Math.max(q5, q7);
        var qBody = qwenRow('每5小时', q5, qR5, 5 * 3600000, 5) + qwenRow('每周', q7, qR7, 7 * 86400000, 7);
        var qPlanBadge = '<span class="level-badge">' + esc(qwenSpecName(qS && qS.specCode)) + '</span>';
        var qDaysBadge = (qS && qS.remainingDays != null) ? '<span class="level-badge level-badge-ok">剩余 ' + qS.remainingDays + '天</span>' : '';
        var qExpHtml = '';
        if (qS && qS.endTime) {
          var qExpDate = new Date(qS.endTime);
          var qDaysLeft = Math.ceil((qExpDate - Date.now()) / 86400000);
          var qExpCls = qDaysLeft <= 10 ? 'expire-danger' : '';
          var qExpHint = qDaysLeft <= 0 ? '已过期' : qDaysLeft + '天后到期';
          qExpHtml = '<div class="expire-row" title="订阅到期"><span class="expire-label">订阅到期</span><span class="expire-value ' + qExpCls + '">' + esc(qExpDate.toLocaleDateString('zh-CN')) + '<span class="expire-hint">' + qExpHint + '</span></span></div>';
        }
        return '<div class="card" id="card-' + i + '"><div class="card-header">' + headerLeft
          + '<div class="card-header-right">' + btn + '<span class="card-status ' + getStatusClass(mpQ) + '">' + getStatusText(mpQ) + '</span></div></div>'
          + '<div class="card-body">' + qBody + '</div>' + qExpHtml
          + '<div class="card-footer"><div class="card-footer-left">' + qPlanBadge + qDaysBadge + cache + '</div>'
          + '<button class="detail-btn" onclick="showDetail(' + i + ')">详情</button></div></div>';
      }

      if (platform === 'minimax') {
        var mU = (acc.data && acc.data.usage) || null;
        var mS = (acc.data && acc.data.subscription) || null;
        // 用量接口接入前仅展示套餐信息占位;接入后 usage.windows 自动渲染为进度行
        var mBody = mU
          ? minimaxUsageRows(mU)
          : '<div class="limit-row"><div class="limit-label"><span class="limit-name">用量</span><span class="limit-value" style="color:var(--text-faint)">待接入</span></div>'
            + '<div style="font-size:11px;color:var(--text-faint);margin-top:2px">用量接口对接中,当前仅展示套餐与到期信息</div></div>';
        var mpM = mU ? minimaxMaxPct(mU) : 0;
        var mStatusCls = getStatusClass(mpM), mStatusTxt = getStatusText(mpM);
        if (!mU) { mStatusCls = 'status-ok'; mStatusTxt = '正常'; }
        if (mS && mS.expireMs && mS.expireMs < Date.now()) { mStatusCls = 'status-danger'; mStatusTxt = '已过期'; }
        var mExpHtml = '';
        if (mS && mS.expireDate) {
          var mDaysLeft = Math.ceil((mS.expireMs - Date.now()) / 86400000);
          var mExpCls = mDaysLeft <= 10 ? 'expire-danger' : '';
          var mExpHint = mDaysLeft <= 0 ? '已过期' : mDaysLeft + '天后到期';
          mExpHtml = '<div class="expire-row" title="订阅到期"><span class="expire-label">订阅到期</span><span class="expire-value ' + mExpCls + '">' + esc(mS.expireDate) + '<span class="expire-hint">' + mExpHint + '</span></span></div>';
        }
        var mPlanBadge = '<span class="level-badge">' + esc((mS && mS.planName) || '无套餐记录') + '</span>';
        return '<div class="card" id="card-' + i + '"><div class="card-header">' + headerLeft
          + '<div class="card-header-right">' + btn + '<span class="card-status ' + mStatusCls + '">' + mStatusTxt + '</span></div></div>'
          + '<div class="card-body">' + mBody + '</div>' + mExpHtml
          + '<div class="card-footer"><div class="card-footer-left">' + mPlanBadge + cache + '</div>'
          + '<button class="detail-btn" onclick="showDetail(' + i + ')">详情</button></div></div>';
      }

      if (platform === 'stepfun') {
        var sfU = (acc.data && acc.data.usage) || null;
        var sfS = (acc.data && acc.data.subscription) || null;
        // 限额接口软失败时仅展示套餐信息占位；成功后 usage.windows 渲染为进度行（月度积分单条，同火山每月窗）
        var sfBody = sfU
          ? minimaxUsageRows(sfU) + stepfunTodayRow(sfU)
          : '<div class="limit-row"><div class="limit-label"><span class="limit-name">用量</span><span class="limit-value" style="color:var(--text-faint)">待接入</span></div>'
            + '<div style="font-size:11px;color:var(--text-faint);margin-top:2px">限额接口对接中，当前仅展示套餐与到期信息</div></div>';
        var sfP = sfU ? minimaxMaxPct(sfU) : 0;
        var sfStatusCls = getStatusClass(sfP), sfStatusTxt = getStatusText(sfP);
        if (!sfU) { sfStatusCls = 'status-ok'; sfStatusTxt = '正常'; }
        if (sfS && sfS.expireMs && sfS.expireMs < Date.now()) { sfStatusCls = 'status-danger'; sfStatusTxt = '已过期'; }
        var sfExpHtml = '';
        if (sfS && sfS.expireDate) {
          var sfDaysLeft = Math.ceil((sfS.expireMs - Date.now()) / 86400000);
          var sfExpCls = sfDaysLeft <= 10 ? 'expire-danger' : '';
          var sfExpHint = sfDaysLeft <= 0 ? '已过期' : sfDaysLeft + '天后到期';
          sfExpHtml = '<div class="expire-row" title="订阅到期"><span class="expire-label">订阅到期</span><span class="expire-value ' + sfExpCls + '">' + esc(sfS.expireDate) + '<span class="expire-hint">' + sfExpHint + '</span></span></div>';
        }
        var sfPlanBadge = '<span class="level-badge">' + esc((sfS && sfS.planName) || '无套餐') + '</span>'
          + (sfS && sfS.autoRenew ? '<span class="level-badge level-badge-ok">自动续费</span>' : '');
        return '<div class="card" id="card-' + i + '"><div class="card-header">' + headerLeft
          + '<div class="card-header-right">' + btn + '<span class="card-status ' + sfStatusCls + '">' + sfStatusTxt + '</span></div></div>'
          + '<div class="card-body">' + sfBody + '</div>' + sfExpHtml
          + '<div class="card-footer"><div class="card-footer-left">' + sfPlanBadge + cache + '</div>'
          + '<button class="detail-btn" onclick="showDetail(' + i + ')">详情</button></div></div>';
      }

      // GLM
      var limits = acc.data && acc.data.limits ? acc.data.limits : [];
      var hasWeekly = limits.some(function(l) { return l.unit === 6; });
      if (!hasWeekly) limits = limits.concat([{ type: 'TOKEN_LIMIT', unit: 6, _unlimited: true }]);
      // 固定顺序: TIME_LIMIT(MCP额度) → unit 3(Token每5小时) → unit 6(Token每周) → 其他
      var LIMIT_ORDER = { TIME_LIMIT: 0, 3: 1, 6: 2 };
      limits = limits.slice().sort(function(a, b) {
        var oa = a.type === 'TIME_LIMIT' ? 0 : (LIMIT_ORDER[a.unit] != null ? LIMIT_ORDER[a.unit] : 9);
        var ob = b.type === 'TIME_LIMIT' ? 0 : (LIMIT_ORDER[b.unit] != null ? LIMIT_ORDER[b.unit] : 9);
        return oa - ob;
      });
      var mp = maxPct(limits), level = levelLabel(acc);
      var expHtml = '';
      var exp = expireData[i];
      if (exp && exp.success && exp.expireTime) {
        var daysLeft = Math.ceil((new Date(exp.expireTime.replace(/-/g, '/')) - Date.now()) / 86400000);
        var expCls = daysLeft <= 10 ? 'expire-danger' : '';
        var expHint = daysLeft <= 0 ? '已过期' : daysLeft + '天后到期';
        expHtml = '<div class="expire-row" onclick="refreshExpire(' + i + ')" title="点击刷新"><span class="expire-label">订阅到期</span><span class="expire-value ' + expCls + '">' + esc(exp.expireTime) + '<span class="expire-hint">' + expHint + '</span></span></div>';
      }
      var keyBadge = isAdmin() && acc.keyCount != null ? '<span class="level-badge level-badge-ok">Key: ' + acc.keyCount + '个</span>' : '';
      var rcBadge = resetCardBadgeHTML(acc);
      var rBadge = riskBadgeHTML(acc);
      var resetBadge = resetBadgeHTML(acc);
      var resetClass = resetBadge ? ' reset-needed' : '';
      return '<div class="card' + resetClass + '" id="card-' + i + '"><div class="card-header">' + headerLeft
        + '<div class="card-header-right">' + btn + '<span class="card-status ' + getStatusClass(mp) + '">' + getStatusText(mp) + '</span></div></div>'
        + '<div class="card-body">' + limits.map(renderLimitRow).join('') + '</div>' + expHtml
        + '<div class="card-footer"><div class="card-footer-left"><span class="level-badge">' + level + '</span>' + glmFooterBadges(acc) + keyBadge + rcBadge + resetBadge + rBadge + cache + '</div>'
        + '<button class="detail-btn" onclick="showDetail(' + i + ')">详情</button></div></div>';
    }

// ============ List 视图：环形进度条与列表行 ============
    // ============ List 视图：环形进度条 ============

    function getRingColorClass(p) {
      return p >= EXHAUSTED_PCT ? 'ring-exhausted' : p < 50 ? '' : p < 80 ? 'ring-orange' : 'ring-red';
    }
    function getLimitShort(l) {
      if (l.type === 'TIME_LIMIT') return 'MCP';
      if (l.unit === 3) return '5小时';
      if (l.unit === 6) return '本周';
      return 'Token';
    }

    // 圆周上某比例位置的坐标：t∈[0,1] 从 3 点钟方向顺时针（与 SVG <circle> 描边起点一致）；
    // 整个 svg 上的 rotate(-90deg) 会统一把它转到「从顶部顺时针」，从而与 ring-fill 填充弧对齐。
    // viewBox 40×40，圆心 (20,20)
    function ringPoint(r, t) {
      var a = t * 2 * Math.PI;
      return { x: 20 + r * Math.cos(a), y: 20 + r * Math.sin(a) };
    }
    // 理论用量：按「周期起点」计算（yescode / huoli 的 lastReset/windowStart 即为起点）
    function theoPctFromStart(startIso, periodMs) {
      if (!startIso) return -1;
      var ms = new Date(startIso).getTime();
      if (isNaN(ms)) return -1;
      var elapsed = Date.now() - ms;
      return elapsed > 0 ? Math.min(100, (elapsed / periodMs) * 100) : -1;
    }
    // 理论用量：按「周期终点（重置时刻）」计算（glm nextResetTime / volc ResetTime）
    function theoPctFromEnd(endIso, periodMs) {
      if (!endIso) return -1;
      var ms = new Date(endIso).getTime();
      if (isNaN(ms)) return -1;
      var elapsed = Date.now() - (ms - periodMs);
      return elapsed > 0 ? Math.min(100, (elapsed / periodMs) * 100) : -1;
    }
    // 生成分段刻度 + 理论线（作为 SVG 子元素）
    function ringSegExtras(segments, theoPct) {
      var html = '';
      if (segments > 1) {
        for (var s = 1; s < segments; s++) {
          var ti = ringPoint(14, s / segments), to = ringPoint(19, s / segments);
          html += '<line class="ring-seg-tick" x1="' + ti.x.toFixed(2) + '" y1="' + ti.y.toFixed(2) + '" x2="' + to.x.toFixed(2) + '" y2="' + to.y.toFixed(2) + '"/>';
        }
      }
      if (theoPct != null && theoPct >= 0 && theoPct <= 100) {
        var thi = ringPoint(14.5, theoPct / 100), tho = ringPoint(19.5, theoPct / 100);
        html += '<line class="ring-theo" x1="' + thi.x.toFixed(2) + '" y1="' + thi.y.toFixed(2) + '" x2="' + tho.x.toFixed(2) + '" y2="' + tho.y.toFixed(2) + '"/>';
      }
      return html;
    }

    function renderRing(item) {
      var label = esc(item.label || '');
      if (item.unlimited) {
        return '<div class="ring-item" title="' + esc(item.title || (item.label + ' 无限额度')) + '">'
          + '<div class="ring">'
          + '<svg viewBox="0 0 40 40"><circle class="ring-track" cx="20" cy="20" r="17"></circle></svg>'
          + '<div class="ring-center"><span class="rc-label" style="visibility:hidden">.</span>'
          + '<span class="rc-pct" style="color:#52c41a">∞</span>'
          + '<span class="rc-label">无限</span></div></div></div>';
      }
      var pct = item.pct || 0;
      var cls = getRingColorClass(pct);
      var dashPct = Math.min(pct, 100);
      var pctShow = pct >= 100 ? '100%' : Math.round(pct) + '%';
      var extras = ringSegExtras(item.segments || 0, item.theoPct);
      var titleParts = [item.label, pctShow];
      if (item.value) titleParts.push(item.value);
      var title = item.title || titleParts.join(' ');
      if (item.theoPct != null && item.theoPct >= 0) title += ' · 理论 ' + Math.round(item.theoPct) + '%';
      var valueHtml = item.value ? '<span class="rc-value">' + esc(item.value) + '</span>' : '';
      return '<div class="ring-item" title="' + esc(title) + '">'
        + '<div class="ring" style="--pct:' + dashPct + '">'
        + '<svg viewBox="0 0 40 40">'
        + '<circle class="ring-track" cx="20" cy="20" r="17"></circle>'
        + '<circle class="ring-fill ' + cls + '" cx="20" cy="20" r="17"></circle>'
        + extras + '</svg>'
        + '<div class="ring-center">'
        + '<span class="rc-label">' + label + '</span>'
        + '<span class="rc-pct">' + pctShow + '</span>'
        + valueHtml + '</div></div></div>';
    }

    // 把任意平台账号的用量统一抽成「环」数组
    function getRings(acc) {
      if (!acc || !acc.success || !acc.data) return [];
      var plat = acc.platform || 'glm';
      var rings = [];
      function push(label, pct, value, extra) {
        var r = { label: label, pct: Math.max(0, Math.min(100, pct || 0)), value: value };
        if (extra) Object.keys(extra).forEach(function(k) { r[k] = extra[k]; });
        rings.push(r);
      }

      if (plat === 'yescode') {
        var d = acc.data || {}, plan = d.subscription_plan || {};
        var dq = plan.daily_balance || 0, ds = yescodeDailySpent(d);
        push('今日', dq > 0 ? (ds / dq) * 100 : 0, '$' + ds.toFixed(1) + '/$' + dq.toFixed(1), { theoPct: theoPctFromStart(d.last_daily_balance_add, 86400000), title: '今日消费 $' + ds.toFixed(2) + ' / $' + dq.toFixed(2) });
        var wl = plan.weekly_limit || 0, ws = d.current_week_spend || 0;
        push('本周', wl > 0 ? (ws / wl) * 100 : 0, '$' + ws.toFixed(1) + '/$' + wl.toFixed(1), { theoPct: theoPctFromStart(d.last_week_reset, 7 * 86400000), title: '本周消费 $' + ws.toFixed(2) + ' / $' + wl.toFixed(2) });
        var ml = plan.monthly_spend_limit || 0, ms = d.current_month_spend || 0;
        push('本月', ml > 0 ? (ms / ml) * 100 : 0, '$' + ms.toFixed(1) + '/$' + ml.toFixed(1), { theoPct: theoPctFromStart(d.last_month_reset, 30 * 86400000), title: '本月消费 $' + ms.toFixed(2) + ' / $' + ml.toFixed(2) });
        return rings;
      }

      if (plat === 'sub2api' || plat === 'huoli') {
        var s2aR = sub2apiUnpack(acc.data), sub = s2aR.sub || {}, grp = sub.group || {};
        var dU = sub.daily_usage_usd || 0, dL = grp.daily_limit_usd || 0;
        push('今日', dL > 0 ? (dU / dL) * 100 : 0, '$' + dU.toFixed(1) + '/$' + dL.toFixed(1), { theoPct: theoPctFromStart(sub.daily_window_start, 86400000), title: '今日消费 $' + dU.toFixed(2) + ' / $' + dL.toFixed(2) });
        var wU = sub.weekly_usage_usd || 0, wL = grp.weekly_limit_usd || 0;
        if (wL > 0) push('本周', (wU / wL) * 100, '$' + wU.toFixed(1) + '/$' + wL.toFixed(1), { theoPct: theoPctFromStart(sub.weekly_window_start, 7 * 86400000), title: '本周消费 $' + wU.toFixed(2) + ' / $' + wL.toFixed(2) });
        var mU = sub.monthly_usage_usd || 0, mL = grp.monthly_limit_usd || 0;
        if (mL > 0) push('本月', (mU / mL) * 100, '$' + mU.toFixed(1) + '/$' + mL.toFixed(1), { theoPct: theoPctFromStart(sub.monthly_window_start, 30 * 86400000), title: '本月消费 $' + mU.toFixed(2) + ' / $' + mL.toFixed(2) });
        return rings;
      }

      if (plat === 'volc') {
        var usage = (acc.data && acc.data.usage) || {};
        if (acc.planType === 'coding') {
          function volcCRing(label, level, periodMs, segments) {
            var item = volcCQuota(usage, level);
            var p = (item && typeof item.Percent === 'number') ? item.Percent : 0;
            var resetIso = item && item.ResetTimestamp ? new Date(item.ResetTimestamp * 1000).toISOString() : null;
            push(label, p, p.toFixed(1) + '%', { segments: segments, theoPct: theoPctFromEnd(resetIso, periodMs), title: label + ' ' + p.toFixed(1) + '%' });
          }
          volcCRing('5小时', 'session', 5 * 3600000, 5);
          volcCRing('本周', 'weekly', 7 * 86400000, 7);
          volcCRing('本月', 'monthly', volcCodingMonthlyPeriodMs(acc), 0);
        } else {
          function volcRing(label, bucket, periodMs, segments) {
            var q = (bucket && bucket.Quota) || 0, u = (bucket && bucket.Used) || 0;
            push(label, q > 0 ? (u / q) * 100 : 0, u.toFixed(1) + '/' + q, { segments: segments, theoPct: theoPctFromEnd(bucket && bucket.ResetTime, periodMs), title: label + ' ' + u.toFixed(2) + ' / ' + q });
          }
          volcRing('5小时', usage.AFPFiveHour, 5 * 3600000, 5);
          volcRing('本周', usage.AFPWeekly, 7 * 86400000, 7);
          volcRing('本月', usage.AFPMonthly, 30 * 86400000, 0);
        }
        return rings;
      }

      if (plat === 'qwen') {
        var qU = (acc.data && acc.data.usage) || {};
        var q5 = typeof qU.per5HourPercentage === 'number' ? qU.per5HourPercentage : 0;
        var q7 = typeof qU.per1WeekPercentage === 'number' ? qU.per1WeekPercentage : 0;
        push('5小时', q5, q5.toFixed(1) + '%', { segments: 5, theoPct: theoPctFromEnd(qU.per5HourResetTime, 5 * 3600000), title: '每5小时已用 ' + q5.toFixed(1) + '%' });
        push('本周', q7, q7.toFixed(1) + '%', { segments: 7, theoPct: theoPctFromEnd(qU.per1WeekResetTime, 7 * 86400000), title: '每周已用 ' + q7.toFixed(1) + '%' });
        return rings;
      }

      if (plat === 'minimax' || plat === 'stepfun') {
        var mws = (acc.data && acc.data.usage && acc.data.usage.windows) || [];
        mws.forEach(function(w) {
          var pct = typeof w.usedPct === 'number' ? w.usedPct : (w.quota > 0 ? ((w.used || 0) / w.quota) * 100 : 0);
          var val = typeof w.usedPct === 'number' ? pct.toFixed(1) + '%' : ((w.used || 0) + '/' + w.quota);
          var resetIso = w.resetMs ? new Date(w.resetMs).toISOString() : null;
          push(w.label || '额度', pct, val, { segments: w.segments || 0, theoPct: w.periodMs ? theoPctFromEnd(resetIso, w.periodMs) : -1, title: (w.label || '额度') + ' ' + val });
        });
        return rings;
      }

      if (plat === 'telecomjs') return rings;

      // GLM：与卡片一致的顺序（MCP额度 → 每5小时 → 每周 → 其他）
      var limits = acc.data && acc.data.limits ? acc.data.limits : [];
      var hasWeekly = limits.some(function(l) { return l.unit === 6; });
      if (!hasWeekly) limits = limits.concat([{ type: 'TOKEN_LIMIT', unit: 6, _unlimited: true }]);
      var LIMIT_ORDER = { TIME_LIMIT: 0, 3: 1, 6: 2 };
      limits = limits.slice().sort(function(a, b) {
        var oa = a.type === 'TIME_LIMIT' ? 0 : (LIMIT_ORDER[a.unit] != null ? LIMIT_ORDER[a.unit] : 9);
        var ob = b.type === 'TIME_LIMIT' ? 0 : (LIMIT_ORDER[b.unit] != null ? LIMIT_ORDER[b.unit] : 9);
        return oa - ob;
      });
      limits.forEach(function(l) {
        var label = getLimitShort(l);
        if (l._unlimited) { push(label, 0, '无限', { unlimited: true, title: getLimitLabel(l) + '（无限额度）' }); return; }
        var pct = l.percentage || 0;
        var segs = (l.unit === 3 || l.unit === 6) ? GLM_BAR_SEGMENTS : 0;
        var periodMs = l.unit === 3 ? GLM_PERIOD_5H_MS : GLM_PERIOD_WEEK_MS;
        var theo = segs > 0 ? glmTheoPct(l.nextResetTime, periodMs) : -1;
        // MCP 额度与积分额度有原始用量(current/usage)；其余 Token 限额只有百分比，与 pct 重复故不传 value
        var value = ((l.type === 'TIME_LIMIT' || l.type === 'CREDIT_LIMIT') && l.usage != null) ? ((l.currentValue || 0) + '/' + l.usage) : null;
        push(label, pct, value, { segments: segs, theoPct: theo, title: getLimitLabel(l) + ' ' + (value || pct + '%') });
      });
      return rings;
    }

    function getListExpireHtml(i, acc) {
      var platform = acc.platform || 'glm';
      var expTime = null, txt = '';
      if (platform === 'glm') {
        var exp = expireData[i];
        if (exp && exp.success && exp.expireTime) { expTime = exp.expireTime.replace(/-/g, '/'); txt = esc(exp.expireTime); }
      } else if (platform === 'yescode') {
        if (acc.data && acc.data.subscription_expiry) { expTime = acc.data.subscription_expiry; txt = esc(new Date(expTime).toLocaleDateString('zh-CN')); }
      } else if (platform === 'sub2api' || platform === 'huoli') {
        var s = sub2apiUnpack(acc.data).sub;
        if (s && s.expires_at) { expTime = s.expires_at; txt = esc(new Date(expTime).toLocaleDateString('zh-CN')); }
      } else if (platform === 'volc') {
        var sv = acc.data && acc.data.subscription;
        if (sv && sv.EndTime) { expTime = sv.EndTime; txt = esc(new Date(expTime).toLocaleDateString('zh-CN')); }
      } else if (platform === 'qwen') {
        var qs = acc.data && acc.data.subscription;
        if (qs && qs.endTime) { expTime = new Date(qs.endTime).toISOString(); txt = esc(new Date(expTime).toLocaleDateString('zh-CN')); }
      } else if (platform === 'minimax' || platform === 'stepfun') {
        var mSub = acc.data && acc.data.subscription;
        if (mSub && mSub.expireDate) { expTime = mSub.expireDate + 'T23:59:59'; txt = esc(mSub.expireDate); }
      }
      if (!expTime) return '';
      var days = Math.ceil((new Date(expTime) - Date.now()) / 86400000);
      var cls = days <= 10 ? 'expire-danger' : '';
      var hint = days <= 0 ? '已过期' : days + '天后';
      var click = platform === 'glm' ? ' onclick="event.stopPropagation(); refreshExpire(' + i + ')" title="订阅到期，点击刷新"' : ' title="订阅到期"';
      return '<span class="list-row-expire ' + cls + '"' + click + '>到期 ' + txt + ' (' + hint + ')</span>';
    }

    function getListBadges(acc) {
      var platform = acc.platform || 'glm';
      if (platform === 'yescode') {
        var d = acc.data || {}, plan = d.subscription_plan || {};
        var b = '<span class="level-badge">' + esc(plan.name || '-') + '</span>';
        if (d.balance != null) b += '<span class="level-badge level-badge-ok">余额 $' + (+d.balance).toFixed(0) + '</span>';
        return b;
      }
      if (platform === 'sub2api' || platform === 'huoli') {
        var s2aB = sub2apiUnpack(acc.data);
        var grp = ((s2aB.sub || {}).group) || {};
        var b2a = '';
        if (s2aB.me && s2aB.me.balance != null) b2a += '<span class="level-badge level-badge-ok">余额 $' + (+s2aB.me.balance).toFixed(2) + '</span>';
        if (s2aB.sub) b2a += '<span class="level-badge">' + esc(grp.name || '-') + '</span>';
        return b2a || '<span class="level-badge">-</span>';
      }
      if (platform === 'volc') {
        var usage = (acc.data && acc.data.usage) || {}, sub = (acc.data && acc.data.subscription) || null;
        var badge = acc.planType === 'coding'
          ? ((sub && sub.BizInfo) || usage.Status || '-')
          : (usage.PlanType || (sub && sub.BizInfo) || '-');
        return '<span class="level-badge">' + esc(badge) + '</span>';
      }
      if (platform === 'qwen') {
        var qSub = (acc.data && acc.data.subscription) || null;
        var b = '<span class="level-badge">' + esc(qwenSpecName(qSub && qSub.specCode)) + '</span>';
        if (qSub && qSub.remainingDays != null) b += '<span class="level-badge level-badge-ok">剩余 ' + qSub.remainingDays + '天</span>';
        return b;
      }
      if (platform === 'minimax' || platform === 'stepfun') {
        var mSub2 = (acc.data && acc.data.subscription) || null;
        return '<span class="level-badge">' + esc((mSub2 && mSub2.planName) || '无套餐记录') + '</span>';
      }
      if (platform === 'telecomjs') {
        var td = acc.data || {};
        var tm = telecomMetrics(td, acc.cachedAt);
        return '<span class="level-badge">余额 ¥' + tm.available.toFixed(2) + '</span>'
          + '<span class="level-badge">可用 ' + telecomDaysText(tm.remainingDays) + '</span>';
      }
      var level = levelLabel(acc);
      var b = '<span class="level-badge">' + level + '</span>';
      b += glmFooterBadges(acc);
      if (isAdmin() && acc.keyCount != null) b += '<span class="level-badge level-badge-ok">Key: ' + acc.keyCount + '个</span>';
      b += resetCardBadgeHTML(acc);
      b += resetBadgeHTML(acc);
      b += riskBadgeHTML(acc);
      return b;
    }

    function renderListRowHTML(i, acc) {
      var platform = acc.platform || 'glm';
      var refresh = isAdmin() ? '<button class="card-refresh list-row-refresh" id="refresh-' + i + '" onclick="event.stopPropagation(); refreshCard(' + i + ')" title="刷新">&#x21bb;</button>' : '';
      var pTag = platformTag(platform, acc.planType, acc.alias);
      var name = esc(displayName(acc, i));

      var leftBlock, middle, right;
      if (isUsagePending(acc)) {
        leftBlock = '<div class="list-row-left"><div class="list-row-title">' + pTag + '<h3>' + name + '</h3></div>'
          + '<div class="list-row-status"><span class="card-status status-loading">加载中</span></div></div>';
        middle = '<div class="list-rings"><div class="list-row-loading">'
          + '<div class="skel-line w80 h14"></div><div class="skel-line w60"></div></div></div>';
        right = '<div class="list-row-meta"><span class="cache-time">正在获取用量…</span></div>';
      } else if (!acc.success) {
        var errStatus = '<div class="list-row-status"><span class="card-status status-error">请求失败</span></div>';
        leftBlock = '<div class="list-row-left"><div class="list-row-title">' + pTag + '<h3>' + name + '</h3></div>' + errStatus + '</div>';
        middle = '<div class="list-rings"><div><span class="list-row-error">' + esc(acc.error || '未知错误') + '</span>'
          + (isTelecomAuthError(acc) ? telecomReloginButton(i) : '') + '</div></div>';
        right = '';
      } else {
        var mp = getAccMaxPct(acc);
        var rings = getRings(acc);
        var ringsHtml = platform === 'telecomjs'
          ? (function() { var tm = telecomMetrics(acc.data, acc.cachedAt); return '<span class="ring-value" style="text-align:left">今日 ¥' + tm.today.toFixed(2) + '　速度 ¥' + tm.dailyRate.toFixed(2) + '/天　预计可用 ' + telecomDaysText(tm.remainingDays) + '</span>'; })()
          : (rings.length ? rings.map(renderRing).join('') : '<span class="ring-value" style="text-align:left">暂无用量数据</span>');
        var okStatus = platform === 'telecomjs'
          ? '<div class="list-row-status"><span class="card-status status-ok">余额</span></div>'
          : '<div class="list-row-status"><span class="card-status ' + getStatusClass(mp) + '">' + getStatusText(mp) + '</span></div>';
        leftBlock = '<div class="list-row-left"><div class="list-row-title">' + pTag + '<h3>' + name + '</h3></div>' + okStatus + '</div>';
        middle = '<div class="list-rings">' + ringsHtml + '</div>';
        var cache = acc.cachedAt ? '<span class="cache-time">' + timeAgo(acc.cachedAt) + '</span>' : '';
        var expireHtml = getListExpireHtml(i, acc);
        right = '<div class="list-row-meta">' + getListBadges(acc) + cache + '</div>'
          + (expireHtml ? '<div class="list-row-meta">' + expireHtml + '</div>' : '');
      }

      var resetClass = acc.resetRecommendation && acc.resetRecommendation.needed ? ' reset-needed' : '';
      return '<div class="list-row' + resetClass + '" id="card-' + i + '" onclick="showDetail(' + i + ')" title="点击查看详情">'
        + leftBlock + middle + '<div class="list-row-right">' + right + '</div>' + refresh + '</div>';
    }

    function getAccMaxPct(acc) {
      if (!acc || isUsagePending(acc) || !acc.success || !acc.data) return -1;
      var plat = acc.platform || 'glm';
      if (plat === 'yescode') return yescodeMaxPct(acc.data);
      if (plat === 'volc') return acc.planType === 'coding'
        ? volcCMaxPct(acc.data && acc.data.usage)
        : volcMaxPct(acc.data && acc.data.usage);
      if (plat === 'qwen') {
        var qU = (acc.data && acc.data.usage) || {};
        var q5 = typeof qU.per5HourPercentage === 'number' ? qU.per5HourPercentage : 0;
        var q7 = typeof qU.per1WeekPercentage === 'number' ? qU.per1WeekPercentage : 0;
        return Math.max(q5, q7);
      }
      if (plat === 'minimax' || plat === 'stepfun') {
        return minimaxMaxPct(acc.data && acc.data.usage);
      }
      if (plat === 'sub2api' || plat === 'huoli') {
        var sub = sub2apiUnpack(acc.data).sub || {};
        var grp = sub.group || {};
        var dPct = (grp.daily_limit_usd || 0) > 0 ? Math.min(100, ((sub.daily_usage_usd || 0) / grp.daily_limit_usd) * 100) : 0;
        var wPct = (grp.weekly_limit_usd || 0) > 0 ? Math.min(100, ((sub.weekly_usage_usd || 0) / grp.weekly_limit_usd) * 100) : 0;
        var mPct = (grp.monthly_limit_usd || 0) > 0 ? Math.min(100, ((sub.monthly_usage_usd || 0) / grp.monthly_limit_usd) * 100) : 0;
        return Math.max(dPct, wPct, mPct);
      }
      if (plat === 'telecomjs') return 0;
      var limits = acc.data.limits || [];
      return maxPct(limits);
    }

    function applyFilterSort(data) {
      var arr = data.map(function(a, i) { return { acc: a, origIdx: (a && a.index != null) ? a.index : i }; });
      if (_filterPlatform !== 'all') {
        arr = arr.filter(function(x) { return (x.acc && x.acc.platform || 'glm') === _filterPlatform; });
      }
      if (_sortMode === 'tension-desc' || _sortMode === 'tension-asc') {
        var asc = _sortMode === 'tension-asc';
        arr.sort(function(a, b) {
          var pa = getAccMaxPct(a.acc), pb = getAccMaxPct(b.acc);
          // 请求失败的卡（pct = -1）始终排到最后
          if (pa < 0 && pb < 0) return a.origIdx - b.origIdx;
          if (pa < 0) return 1;
          if (pb < 0) return -1;
          if (pa !== pb) return asc ? (pa - pb) : (pb - pa);
          return a.origIdx - b.origIdx;
        });
      }
      if (_sortMode === 'weight-desc' || _sortMode === 'weight-asc') {
        var wasc = _sortMode === 'weight-asc';
        arr.sort(function(a, b) {
          var wa = (a.acc && weightsMap[a.acc.name] != null) ? weightsMap[a.acc.name] : -1;
          var wb = (b.acc && weightsMap[b.acc.name] != null) ? weightsMap[b.acc.name] : -1;
          // 无权重数据的卡(非管理员 / 未加载)排到最后
          if (wa < 0 && wb < 0) return a.origIdx - b.origIdx;
          if (wa < 0) return 1;
          if (wb < 0) return -1;
          if (wa !== wb) return wasc ? (wa - wb) : (wb - wa);
          return a.origIdx - b.origIdx;
        });
      }
      if (_sortMode === 'dispatch-desc' || _sortMode === 'dispatch-asc') {
        var dasc = _sortMode === 'dispatch-asc';
        arr.sort(function(a, b) {
          var ca = (a.acc && capacityMap[a.acc.name]) || null;
          var cb = (b.acc && capacityMap[b.acc.name]) || null;
          // 无容量快照的卡（未匹配 sub2api 账号 / 游客）排到最后
          if (!ca && !cb) return a.origIdx - b.origIdx;
          if (!ca) return 1;
          if (!cb) return -1;
          // 排序规则：当前调度中 → 总负载上限 → 权重（tiebreak 逐级下沉）
          if (ca.current !== cb.current) return dasc ? (ca.current - cb.current) : (cb.current - ca.current);
          if (ca.total !== cb.total) return dasc ? (ca.total - cb.total) : (cb.total - ca.total);
          var wa = weightsMap[a.acc.name] != null ? weightsMap[a.acc.name] : -1;
          var wb = weightsMap[b.acc.name] != null ? weightsMap[b.acc.name] : -1;
          if (wa !== wb) return dasc ? (wa - wb) : (wb - wa);
          return a.origIdx - b.origIdx;
        });
      }
      return arr;
    }

    // 按固定顺序展示用户实际拥有的站点，没添加的类型不显示
    var PLATFORM_ORDER = ['glm', 'yescode', 'sub2api', 'huoli', 'volc', 'telecomjs', 'qwen', 'minimax', 'stepfun'];
    function renderPlatformFilters(data) {
      var box = document.getElementById('platformFilters');
      if (!box) return;
      var have = {};
      (data || []).forEach(function(a) {
        var p = (a && a.platform) || 'glm';
        have[p] = true;
      });
      var html = PLATFORM_ORDER.filter(function(p) { return have[p]; })
        .map(function(p) {
          return '<button class="toolbar-btn" data-filter="' + p + '" onclick="setFilter(\'' + p + '\')">' + platformLabel(p) + '</button>';
        }).join('');
      // 当前选中的站点已不存在则回落到「全部」
      if (_filterPlatform !== 'all' && !have[_filterPlatform]) {
        _filterPlatform = 'all';
      }
      box.innerHTML = html;
      document.querySelectorAll('#platformFilterGroup [data-filter]').forEach(function(b) {
        b.classList.toggle('active', b.dataset.filter === _filterPlatform);
      });
    }

    function renderCards(data) {
      renderPlatformFilters(data);
      // 隐私模式下额外过滤非公开账号（后端已对非管理员过滤，此处双重保障）
      var visible = _privacyMode ? data.filter(function(a) { return a.isPublic !== false; }) : data;
      var grid = document.getElementById('cardGrid');
      var countEl = document.getElementById('toolbarCount');
      var isList = _viewMode === 'list';
      grid.className = isList ? 'list-grid' : 'card-grid';
      if (!visible || !visible.length) {
        grid.innerHTML = '<div class="empty">暂无账号数据<br><span style="font-size:12px;margin-top:8px;display:block">点击「管理账号」添加</span></div>';
        if (countEl) countEl.textContent = '';
        return;
      }
      var list = applyFilterSort(visible);
      if (countEl) countEl.textContent = '共 ' + list.length + ' / ' + data.length + ' 个账号';
      if (!list.length) {
        grid.innerHTML = '<div class="empty">当前筛选下无账号</div>';
        return;
      }
      grid.innerHTML = list.map(function(x) {
        return isList ? renderListRowHTML(x.origIdx, x.acc) : renderCardHTML(x.origIdx, x.acc);
      }).join('');
    }

    function setFilter(p) {
      _filterPlatform = p;
      document.querySelectorAll('#toolbar [data-filter]').forEach(function(b) {
        b.classList.toggle('active', b.dataset.filter === p);
      });
      if (accountsData.length) renderCards(accountsData);
    }

    function setSort(s) {
      if (s === 'tension') {
        // 已是紧张度排序则切换方向；否则首次进入按降序
        _sortMode = (_sortMode === 'tension-desc') ? 'tension-asc' : 'tension-desc';
      } else if (s === 'weight') {
        _sortMode = (_sortMode === 'weight-desc') ? 'weight-asc' : 'weight-desc';
      } else if (s === 'dispatch') {
        _sortMode = (_sortMode === 'dispatch-desc') ? 'dispatch-asc' : 'dispatch-desc';
      } else {
        _sortMode = 'default';
      }
      document.querySelectorAll('#toolbar [data-sort]').forEach(function(b) {
        var key = b.dataset.sort;
        var active = (key === 'default' && _sortMode === 'default')
          || (key === 'tension' && (_sortMode === 'tension-desc' || _sortMode === 'tension-asc'))
          || (key === 'weight' && (_sortMode === 'weight-desc' || _sortMode === 'weight-asc'))
          || (key === 'dispatch' && (_sortMode === 'dispatch-desc' || _sortMode === 'dispatch-asc'));
        b.classList.toggle('active', active);
      });
      var arrow = document.getElementById('tensionArrow');
      if (arrow) arrow.textContent = _sortMode === 'tension-asc' ? '▲' : '▼';
      var wArrow = document.getElementById('weightArrow');
      if (wArrow) wArrow.textContent = _sortMode === 'weight-asc' ? '▲' : '▼';
      var dArrow = document.getElementById('dispatchArrow');
      if (dArrow) dArrow.textContent = _sortMode === 'dispatch-asc' ? '▲' : '▼';
      if (accountsData.length) renderCards(accountsData);
    }

    function setViewMode(mode) {
      if (mode === _viewMode) return;
      _viewMode = mode;
      localStorage.setItem('usage_view', mode);
      document.querySelectorAll('#viewToggle .view-btn').forEach(function(b) {
        b.classList.toggle('active', b.dataset.view === mode);
      });
      var grid = document.getElementById('cardGrid');
      if (grid) grid.className = mode === 'list' ? 'list-grid' : 'card-grid';
      if (accountsData.length) renderCards(accountsData);
    }

    (function() {
      document.querySelectorAll('#viewToggle .view-btn').forEach(function(b) {
        b.classList.toggle('active', b.dataset.view === _viewMode);
      });
      var grid = document.getElementById('cardGrid');
      if (grid) grid.className = _viewMode === 'list' ? 'list-grid' : 'card-grid';
    })();

    // 按钮携带的是账号配置序号(acc.index),与 accountsData 数组槽位在
    // 存在未返回账号(隐藏/停用)时不一致;查账号一律经此转换,API 调用仍用配置序号
    function accAt(configIndex) { return accountsData[accountSlotIndex(configIndex)]; }

    function accountSlotIndex(accountIndex) {
      for (var k = 0; k < accountsData.length; k++) {
        var a = accountsData[k];
        if (!a) continue;
        if ((a.index != null ? a.index : k) === accountIndex) return k;
      }
      return accountIndex;
    }

    function updateCard(i, acc) {
      var slot = accountSlotIndex(i);
      accountsData[slot] = acc;
      var old = document.getElementById('card-' + i);
      if (old) {
        var html = _viewMode === 'list' ? renderListRowHTML(i, acc) : renderCardHTML(i, acc);
        var t = document.createElement('div'); t.innerHTML = html;
        old.parentNode.replaceChild(t.firstChild, old);
      }
    }

    // 后台补齐:列表接口秒回后,对 loading/pending 账号逐个等待 /api/usage/:index
    var _pendingFills = {};
    function fillPendingCard(index, force) {
      if (_pendingFills[index]) return _pendingFills[index];
      var btn = document.getElementById('refresh-' + index);
      if (btn) btn.classList.add('spinning');
      var url = API_PREFIX + '/api/usage/' + index + (force ? '?force=1' : '');
      var p = fetch(url, { headers: authHeaders() })
        .then(function(r) { return r.json(); })
        .then(function(acc) {
          updateCard(index, acc);
          if (document.getElementById('lastUpdated')) {
            document.getElementById('lastUpdated').textContent = '更新于 ' + new Date().toLocaleTimeString('zh-CN');
          }
          return acc;
        })
        .catch(function() {
          if (btn) btn.classList.remove('spinning');
        })
        .finally(function() {
          delete _pendingFills[index];
        });
      _pendingFills[index] = p;
      return p;
    }

    function refreshCard(index) {
      var btn = document.getElementById('refresh-' + index);
      if (btn) btn.classList.add('spinning');
      fetch(API_PREFIX + '/api/usage/' + index + '?force=1', { headers: authHeaders() })
        .then(function(r){return r.json()}).then(function(acc){updateCard(index,acc)}).catch(function(){if(btn)btn.classList.remove('spinning')});
    }

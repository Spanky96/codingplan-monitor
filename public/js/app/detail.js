    // ============ 详情弹窗 ============

    var _usageCharts = {};

    function fmtYesCodeDate(s) {
      if (!s) return '-';
      var d = new Date(s);
      if (isNaN(d)) return s;
      return d.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    }

    function renderYesCodeDetail(index, acc) {
      var d = acc.data || {};
      var plan = d.subscription_plan || {};
      var weekSpent = d.current_week_spend || 0;
      var weekLimit = plan.weekly_limit || 0;
      var monthSpent = d.current_month_spend || 0;
      var monthLimit = plan.monthly_spend_limit || 0;

      var html = '<div class="info-section"><div class="info-section-title">负责人信息</div><div class="info-grid">'
        + '<span class="info-label">负责人</span><span class="info-value">' + esc(acc.responsiblePerson||'-') + '</span>'
        + '<span class="info-label">电话</span><span class="info-value">' + esc(acc.phone||'-') + '</span>'
        + '<span class="info-label">备注</span><span class="info-value">' + esc(acc.notes||'-') + '</span>'
        + '</div></div>';

      html += '<div class="info-section"><div class="info-section-title">账号信息</div><div class="info-grid">'
        + '<span class="info-label">用户名</span><span class="info-value">' + esc(d.username||'-') + '</span>'
        + '<span class="info-label">邮箱</span><span class="info-value">' + esc(d.email||'-') + '</span>'
        + '<span class="info-label">套餐</span><span class="info-value">' + esc(plan.name||'-') + (plan.description ? ' <span style="color:var(--text-faint)">· ' + esc(plan.description) + '</span>' : '') + '</span>'
        + '<span class="info-label">价格</span><span class="info-value">' + (plan.price != null ? '$' + plan.price : '-') + '</span>'
        + '<span class="info-label">注册时间</span><span class="info-value">' + esc(fmtYesCodeDate(d.created_at)) + '</span>'
        + '<span class="info-label">订阅到期</span><span class="info-value">' + esc(fmtYesCodeDate(d.subscription_expiry)) + '</span>'
        + '<span class="info-label">官网</span><span class="info-value"><a href="https://co.yes.vg/" target="_blank" rel="noopener" style="color:var(--accent);text-decoration:none">https://co.yes.vg/ ↗</a></span>'
        + '</div></div>';

      html += '<div class="info-section"><div class="info-section-title">余额详情</div><div class="info-grid">'
        + '<span class="info-label">总余额</span><span class="info-value">$' + (+(d.balance||0)).toFixed(2) + '</span>'
        + '<span class="info-label">订阅余额</span><span class="info-value">$' + (+(d.subscription_balance||0)).toFixed(2) + '</span>'
        + '<span class="info-label">按量余额</span><span class="info-value">$' + (+(d.pay_as_you_go_balance||0)).toFixed(2) + '</span>'
        + '<span class="info-label">每日额度</span><span class="info-value">$' + (+(plan.daily_balance||0)).toFixed(2) + '</span>'
        + '</div></div>';

      var dailyLimit = plan.daily_balance || 0;
      var dailySpent = yescodeDailySpent(d);
      var dailyPct = dailyLimit > 0 ? Math.min(100, (dailySpent / dailyLimit) * 100) : 0;
      var dailyNext = d.last_daily_balance_add ? new Date(d.last_daily_balance_add).getTime() + 86400000 : null;
      var weekPct = weekLimit > 0 ? Math.min(100, (weekSpent / weekLimit) * 100) : 0;
      var monthPct = monthLimit > 0 ? Math.min(100, (monthSpent / monthLimit) * 100) : 0;
      var weekNext = d.last_week_reset ? new Date(d.last_week_reset).getTime() + 7*86400000 : null;
      var monthNext = d.last_month_reset ? new Date(d.last_month_reset).getTime() + 30*86400000 : null;

      html += '<div class="info-section"><div class="info-section-title">消费情况</div>'
        + '<div class="limit-row"><div class="limit-label"><span class="limit-name">今日已消费</span><span class="limit-value">$' + dailySpent.toFixed(2) + ' / $' + dailyLimit.toFixed(2) + ' (' + dailyPct.toFixed(1) + '%)</span></div>'
        + '<div class="limit-bar"><div class="limit-fill ' + getColorClass(dailyPct) + '" style="width:' + dailyPct + '%"></div></div>'
        + (dailyNext ? '<div style="font-size:11px;color:var(--text-faint);margin-top:3px">每日额度重置时间：' + fmtYesCodeDate(dailyNext) + '（每日0点 UTC+8）</div>' : '')
        + '</div>'
        + '<div class="limit-row"><div class="limit-label"><span class="limit-name">本周已消费</span><span class="limit-value">$' + weekSpent.toFixed(2) + ' / $' + weekLimit.toFixed(2) + ' (' + weekPct.toFixed(1) + '%)</span></div>'
        + '<div class="limit-bar"><div class="limit-fill ' + getColorClass(weekPct) + '" style="width:' + weekPct + '%"></div></div>'
        + (weekNext ? '<div style="font-size:11px;color:var(--text-faint);margin-top:3px">周配额重置时间：' + fmtYesCodeDate(weekNext) + '（每7天滚动）</div>' : '')
        + '</div>'
        + '<div class="limit-row"><div class="limit-label"><span class="limit-name">本月已消费</span><span class="limit-value">$' + monthSpent.toFixed(2) + ' / $' + monthLimit.toFixed(2) + ' (' + monthPct.toFixed(1) + '%)</span></div>'
        + '<div class="limit-bar"><div class="limit-fill ' + getColorClass(monthPct) + '" style="width:' + monthPct + '%"></div></div>'
        + (monthNext ? '<div style="font-size:11px;color:var(--text-faint);margin-top:3px">月度配额重置时间：' + fmtYesCodeDate(monthNext) + '（每30天滚动）</div>' : '')
        + '</div>'
        + '</div>';

      document.getElementById('modalBody').innerHTML = html;
    }

    function renderSub2apiDetail(index, acc) {
      var s2a = sub2apiUnpack(acc.data);
      var me = s2a.me, sub = s2a.sub || {}, grp = sub.group || {};
      var baseUrl = acc.baseUrl || acc.base_url || '';
      var dailyUsed = sub.daily_usage_usd || 0;
      var dailyLimit = grp.daily_limit_usd || 0;
      var weeklyUsed = sub.weekly_usage_usd || 0;
      var weeklyLimit = grp.weekly_limit_usd || 0;
      var monthlyUsed = sub.monthly_usage_usd || 0;
      var monthlyLimit = grp.monthly_limit_usd || 0;

      var html = '<div class="info-section"><div class="info-section-title">负责人信息</div><div class="info-grid">'
        + '<span class="info-label">负责人</span><span class="info-value">' + esc(acc.responsiblePerson||'-') + '</span>'
        + '<span class="info-label">电话</span><span class="info-value">' + esc(acc.phone||'-') + '</span>'
        + '<span class="info-label">备注</span><span class="info-value">' + esc(acc.notes||'-') + '</span>'
        + '</div></div>';

      html += '<div class="info-section"><div class="info-section-title">站点与账户</div><div class="info-grid">'
        + '<span class="info-label">站点别名</span><span class="info-value">' + esc(acc.alias || platformLabel(acc.platform || 'sub2api')) + '</span>'
        + '<span class="info-label">站点地址</span><span class="info-value">' + (baseUrl ? '<a href="' + esc(baseUrl) + '/" target="_blank" rel="noopener" style="color:var(--accent);text-decoration:none">' + esc(baseUrl) + ' ↗</a>' : '-') + '</span>'
        + '<span class="info-label">账号</span><span class="info-value">' + esc((me && (me.email || me.username)) || '-') + '</span>'
        + '<span class="info-label">余额</span><span class="info-value">' + ((me && me.balance != null) ? '$' + (+me.balance).toFixed(2) : '-') + '</span>'
        + '<span class="info-label">冻结余额</span><span class="info-value">' + ((me && me.frozen_balance != null) ? '$' + (+me.frozen_balance).toFixed(2) : '-') + '</span>'
        + '<span class="info-label">累计充值</span><span class="info-value">' + ((me && me.total_recharged != null) ? '$' + (+me.total_recharged).toFixed(2) : '-') + '</span>'
        + '<span class="info-label">并发</span><span class="info-value">' + ((me && me.concurrency != null) ? me.concurrency : '-') + '</span>'
        + '<span class="info-label">账户状态</span><span class="info-value">' + esc((me && me.status) || '-') + '</span>'
        + '</div></div>';

      if (s2a.stats) {
        var stD = s2a.stats;
        html += '<div class="info-section"><div class="info-section-title">用量统计</div><div class="info-grid">'
          + '<span class="info-label">今日请求</span><span class="info-value">' + (stD.today_requests || 0) + ' 次</span>'
          + '<span class="info-label">今日Token</span><span class="info-value">' + fmtTokens(stD.today_tokens) + '</span>'
          + '<span class="info-label">今日明细</span><span class="info-value" style="font-size:12px">输入 ' + fmtTokens(stD.today_input_tokens) + ' · 输出 ' + fmtTokens(stD.today_output_tokens) + ' · 缓存写 ' + fmtTokens(stD.today_cache_creation_tokens) + ' · 缓存读 ' + fmtTokens(stD.today_cache_read_tokens) + '</span>'
          + '<span class="info-label">今日费用</span><span class="info-value">$' + (+stD.today_cost || 0).toFixed(4) + ' / 实付 $' + (+stD.today_actual_cost || 0).toFixed(4) + '</span>'
          + '<span class="info-label">累计请求</span><span class="info-value">' + (stD.total_requests || 0) + ' 次</span>'
          + '<span class="info-label">累计Token</span><span class="info-value">' + fmtTokens(stD.total_tokens) + '</span>'
          + '<span class="info-label">累计费用</span><span class="info-value">$' + (+stD.total_cost || 0).toFixed(2) + ' / 实付 $' + (+stD.total_actual_cost || 0).toFixed(2) + '</span>'
          + '<span class="info-label">实时速率</span><span class="info-value">RPM ' + (stD.rpm || 0) + ' · TPM ' + fmtTokens(stD.tpm) + '</span>'
          + '<span class="info-label">平均耗时</span><span class="info-value">' + (stD.average_duration_ms != null ? Math.round(stD.average_duration_ms) + ' ms' : '-') + '</span>'
          + '</div></div>';
        var byPlat = (stD.by_platform || []).filter(function(p) { return p && (p.total_requests || p.today_requests); });
        if (byPlat.length) {
          html += '<div class="info-section"><div class="info-section-title">分平台统计</div><div class="info-grid">'
            + byPlat.map(function(p) {
                return '<span class="info-label">' + esc(p.platform) + '</span><span class="info-value" style="font-size:12px">累计 ' + (p.total_requests || 0) + ' 次 · ' + fmtTokens(p.total_tokens) + ' · 实付 $' + (+p.total_actual_cost || 0).toFixed(2) + '<br>今日 ' + (p.today_requests || 0) + ' 次 · ' + fmtTokens(p.today_tokens) + ' · 实付 $' + (+p.today_actual_cost || 0).toFixed(2) + '</span>';
              }).join('')
            + '</div></div>';
        }
      }

      if (sub) {
        html += '<div class="info-section"><div class="info-section-title">订阅信息</div><div class="info-grid">'
          + '<span class="info-label">套餐名称</span><span class="info-value">' + esc(grp.name||'-') + (grp.description ? ' <span style="color:var(--text-faint)">· ' + esc(grp.description) + '</span>' : '') + '</span>'
          + '<span class="info-label">平台</span><span class="info-value">' + esc(grp.platform||'-') + '</span>'
          + '<span class="info-label">倍率</span><span class="info-value">' + (grp.rate_multiplier != null ? grp.rate_multiplier + 'x' : '-') + '</span>'
          + '<span class="info-label">状态</span><span class="info-value">' + esc(sub.status||'-') + '</span>'
          + '<span class="info-label">开始时间</span><span class="info-value">' + esc(fmtYesCodeDate(sub.starts_at)) + '</span>'
          + '<span class="info-label">到期时间</span><span class="info-value">' + esc(fmtYesCodeDate(sub.expires_at)) + '</span>'
          + '<span class="info-label">支持模型</span><span class="info-value">' + ((grp.supported_models||[]).join(', ') || '-') + '</span>'
          + '</div></div>';
      }

      var dailyPct = dailyLimit > 0 ? Math.min(100, (dailyUsed / dailyLimit) * 100) : 0;
      var weeklyPct = weeklyLimit > 0 ? Math.min(100, (weeklyUsed / weeklyLimit) * 100) : 0;
      var monthlyPct = monthlyLimit > 0 ? Math.min(100, (monthlyUsed / monthlyLimit) * 100) : 0;
      var dailyNext = sub.daily_window_start ? new Date(sub.daily_window_start).getTime() + 86400000 : null;
      var weeklyNext = sub.weekly_window_start ? new Date(sub.weekly_window_start).getTime() + 7*86400000 : null;
      var monthlyNext = sub.monthly_window_start ? new Date(sub.monthly_window_start).getTime() + 30*86400000 : null;

      html += '<div class="info-section"><div class="info-section-title">消费情况</div>'
        + '<div class="limit-row"><div class="limit-label"><span class="limit-name">今日已消费</span><span class="limit-value">$' + dailyUsed.toFixed(2) + ' / $' + dailyLimit.toFixed(2) + ' (' + dailyPct.toFixed(1) + '%)</span></div>'
        + '<div class="limit-bar"><div class="limit-fill ' + getColorClass(dailyPct) + '" style="width:' + dailyPct + '%"></div></div>'
        + (dailyNext ? '<div style="font-size:11px;color:var(--text-faint);margin-top:3px">每日额度重置时间：' + fmtYesCodeDate(dailyNext) + '</div>' : '')
        + '</div>';
      if (weeklyLimit > 0) {
        html += '<div class="limit-row"><div class="limit-label"><span class="limit-name">本周已消费</span><span class="limit-value">$' + weeklyUsed.toFixed(2) + ' / $' + weeklyLimit.toFixed(2) + ' (' + weeklyPct.toFixed(1) + '%)</span></div>'
          + '<div class="limit-bar"><div class="limit-fill ' + getColorClass(weeklyPct) + '" style="width:' + weeklyPct + '%"></div></div>'
          + (weeklyNext ? '<div style="font-size:11px;color:var(--text-faint);margin-top:3px">周配额重置时间：' + fmtYesCodeDate(weeklyNext) + '</div>' : '')
          + '</div>';
      }
      if (monthlyLimit > 0) {
        html += '<div class="limit-row"><div class="limit-label"><span class="limit-name">本月已消费</span><span class="limit-value">$' + monthlyUsed.toFixed(2) + ' / $' + monthlyLimit.toFixed(2) + ' (' + monthlyPct.toFixed(1) + '%)</span></div>'
          + '<div class="limit-bar"><div class="limit-fill ' + getColorClass(monthlyPct) + '" style="width:' + monthlyPct + '%"></div></div>'
          + (monthlyNext ? '<div style="font-size:11px;color:var(--text-faint);margin-top:3px">月度配额重置时间：' + fmtYesCodeDate(monthlyNext) + '</div>' : '')
          + '</div>';
      }
      html += '</div>';

      document.getElementById('modalBody').innerHTML = html;
    }

    function renderVolcDetail(index, acc) {
      var usage = (acc.data && acc.data.usage) || {};
      var sub = (acc.data && acc.data.subscription) || null;
      var five = usage.AFPFiveHour || {};
      var daily = usage.AFPDaily || {};
      var week = usage.AFPWeekly || {};
      var month = usage.AFPMonthly || {};

      var html = '<div class="info-section"><div class="info-section-title">负责人信息</div><div class="info-grid">'
        + '<span class="info-label">负责人</span><span class="info-value">' + esc(acc.responsiblePerson||'-') + '</span>'
        + '<span class="info-label">电话</span><span class="info-value">' + esc(acc.phone||'-') + '</span>'
        + '<span class="info-label">备注</span><span class="info-value">' + esc(acc.notes||'-') + '</span>'
        + '</div></div>';

      html += '<div class="info-section"><div class="info-section-title">订阅信息</div><div class="info-grid">'
        + '<span class="info-label">套餐类型</span><span class="info-value">' + esc(usage.PlanType || (sub && sub.BizInfo) || '-') + '</span>'
        + '<span class="info-label">订阅状态</span><span class="info-value">' + esc(sub && sub.Status || '-') + '</span>'
        + '<span class="info-label">计费方式</span><span class="info-value">' + (sub && sub.PayType ? (sub.PayType === 'pre' ? '预付费' : sub.PayType) : '-') + '</span>'
        + '<span class="info-label">订阅周期</span><span class="info-value">' + esc(sub && sub.Period || '-') + '</span>'
        + '<span class="info-label">开始时间</span><span class="info-value">' + esc(fmtYesCodeDate(sub && sub.StartTime)) + '</span>'
        + '<span class="info-label">到期时间</span><span class="info-value">' + esc(fmtYesCodeDate(sub && sub.EndTime)) + '</span>'
        + '<span class="info-label">自动续费</span><span class="info-value">' + (sub ? (sub.EnableAutoRenew ? '是' : '否') : '-') + '</span>'
        + '<span class="info-label">官网</span><span class="info-value"><a href="https://console.volcengine.com/ark/region:ark+cn-beijing/openManagement?LLM=%7B%7D&advancedActiveKey=agentPlan" target="_blank" rel="noopener" style="color:var(--accent);text-decoration:none">火山引擎控制台 ↗</a></span>'
        + '</div></div>';

      function detailRow(label, bucket) {
        var quota = (bucket && bucket.Quota) || 0, used = (bucket && bucket.Used) || 0;
        var pct = quota > 0 ? Math.min(100, (used / quota) * 100) : 0;
        var resetTxt = bucket && bucket.ResetTime ? fmtYesCodeDate(bucket.ResetTime) : '-';
        return '<div class="limit-row"><div class="limit-label"><span class="limit-name">' + label + '</span><span class="limit-value">' + used.toFixed(2) + ' / ' + quota + ' (' + pct.toFixed(1) + '%)</span></div>'
          + '<div class="limit-bar"><div class="limit-fill ' + getColorClass(pct) + '" style="width:' + pct + '%"></div></div>'
          + '<div style="font-size:11px;color:var(--text-faint);margin-top:3px">额度重置时间：' + resetTxt + '</div>'
          + '</div>';
      }

      html += '<div class="info-section"><div class="info-section-title">额度使用情况（AFP）</div>'
        + detailRow('每5小时', five)
        + detailRow('每日', daily)
        + detailRow('每周', week)
        + detailRow('每月', month)
        + '</div>';

      document.getElementById('modalBody').innerHTML = html;
    }

    function renderVolcCDetail(index, acc) {
      var usage = (acc.data && acc.data.usage) || {};
      var sub = (acc.data && acc.data.subscription) || null;
      var session = volcCQuota(usage, 'session');
      var week = volcCQuota(usage, 'weekly');
      var month = volcCQuota(usage, 'monthly');

      var html = '<div class="info-section"><div class="info-section-title">负责人信息</div><div class="info-grid">'
        + '<span class="info-label">负责人</span><span class="info-value">' + esc(acc.responsiblePerson||'-') + '</span>'
        + '<span class="info-label">电话</span><span class="info-value">' + esc(acc.phone||'-') + '</span>'
        + '<span class="info-label">备注</span><span class="info-value">' + esc(acc.notes||'-') + '</span>'
        + '</div></div>';

      html += '<div class="info-section"><div class="info-section-title">订阅信息</div><div class="info-grid">'
        + '<span class="info-label">套餐类型</span><span class="info-value">' + esc((sub && sub.BizInfo) || '-') + '</span>'
        + '<span class="info-label">订阅状态</span><span class="info-value">' + esc(sub && sub.Status || usage.Status || '-') + '</span>'
        + '<span class="info-label">计费方式</span><span class="info-value">' + (sub && sub.PayType ? (sub.PayType === 'pre' ? '预付费' : sub.PayType) : '-') + '</span>'
        + '<span class="info-label">订阅周期</span><span class="info-value">' + esc(sub && sub.Period || '-') + '</span>'
        + '<span class="info-label">开始时间</span><span class="info-value">' + esc(fmtYesCodeDate(sub && sub.StartTime)) + '</span>'
        + '<span class="info-label">到期时间</span><span class="info-value">' + esc(fmtYesCodeDate(sub && sub.EndTime)) + '</span>'
        + '<span class="info-label">自动续费</span><span class="info-value">' + (sub ? (sub.EnableAutoRenew ? '是' : '否') : '-') + '</span>'
        + '<span class="info-label">官网</span><span class="info-value"><a href="https://console.volcengine.com/ark/region:cn-beijing/subscription/coding-plan" target="_blank" rel="noopener" style="color:var(--accent);text-decoration:none">火山引擎控制台 ↗</a></span>'
        + '</div></div>';

      function cDetailRow(label, item) {
        var realPct = (item && typeof item.Percent === 'number') ? item.Percent : 0;
        var pct = Math.min(100, realPct);
        var resetTxt = item && item.ResetTimestamp ? fmtYesCodeDate(item.ResetTimestamp * 1000) : '-';
        return '<div class="limit-row"><div class="limit-label"><span class="limit-name">' + label + '</span><span class="limit-value">已用 ' + realPct.toFixed(1) + '%</span></div>'
          + '<div class="limit-bar"><div class="limit-fill ' + getColorClass(pct) + '" style="width:' + pct + '%"></div></div>'
          + '<div style="font-size:11px;color:var(--text-faint);margin-top:3px">额度重置时间：' + resetTxt + '</div>'
          + '</div>';
      }

      html += '<div class="info-section"><div class="info-section-title">额度使用情况</div>'
        + cDetailRow('5小时会话', session)
        + cDetailRow('每周', week)
        + cDetailRow('每月', month)
        + '</div>';

      document.getElementById('modalBody').innerHTML = html;
    }

    function renderTelecomDetail(index, acc) {
      var d = acc.data || {};
      var tm = telecomMetrics(d, acc.cachedAt);
      function money(value) { return '¥' + (+(value || 0)).toFixed(2); }
      var html = '<div class="info-section"><div class="info-section-title">负责人信息</div><div class="info-grid">'
        + '<span class="info-label">负责人</span><span class="info-value">' + esc(acc.responsiblePerson||'-') + '</span>'
        + '<span class="info-label">电话</span><span class="info-value">' + esc(acc.phone||'-') + '</span>'
        + '<span class="info-label">备注</span><span class="info-value">' + esc(acc.notes||'-') + '</span>'
        + '</div></div>';
      html += '<div class="info-section"><div class="info-section-title">余额详情</div><div class="info-grid">'
        + '<span class="info-label">账户余额</span><span class="info-value">' + money(d.balance) + '</span>'
        + '<span class="info-label">赠金余额</span><span class="info-value">' + money(d.platformGiftBalance) + '</span>'
        + '<span class="info-label">累计充值</span><span class="info-value">' + money(d.totalRecharge) + '</span>'
        + '<span class="info-label">累计消费</span><span class="info-value">' + money(d.totalConsumption) + '</span>'
        + '<span class="info-label">今日消费</span><span class="info-value">' + money(tm.today) + '</span>'
        + '<span class="info-label">昨日消费</span><span class="info-value">' + money(tm.yesterday) + '</span>'
        + '<span class="info-label">今日折算速度</span><span class="info-value">' + money(tm.projectedToday) + '/天</span>'
        + '<span class="info-label">' + (tm.hasSevenDayStats ? '近7日消费' : '历史消费') + '</span><span class="info-value">' + money(tm.sevenDays) + '</span>'
        + '<span class="info-label">' + tm.averageLabel + '</span><span class="info-value">' + money(tm.avgDaily) + '/天（按 ' + tm.rangeDays + ' 个有消费日）</span>'
        + '<span class="info-label">预计可用</span><span class="info-value">' + telecomDaysText(tm.remainingDays) + '（' + tm.rateBasis + '）</span>'
        + '<span class="info-label">模型组</span><span class="info-value">' + (d.modelGroupCount != null ? d.modelGroupCount : '-') + '</span>'
        + '<span class="info-label">模型数</span><span class="info-value">' + (d.modelCount != null ? d.modelCount : '-') + '</span>'
        + '<span class="info-label">官网</span><span class="info-value"><a href="https://token.telecomjs.com/finance/cost" target="_blank" rel="noopener" style="color:var(--accent);text-decoration:none">智云费用中心 ↗</a></span>'
        + '</div></div>';
      document.getElementById('modalBody').innerHTML = html;
    }

    function renderQwenDetail(index, acc) {
      var sub = (acc.data && acc.data.subscription) || null;

      var html = '<div class="info-section"><div class="info-section-title">负责人信息</div><div class="info-grid">'
        + '<span class="info-label">负责人</span><span class="info-value">' + esc(acc.responsiblePerson||'-') + '</span>'
        + '<span class="info-label">电话</span><span class="info-value">' + esc(acc.phone||'-') + '</span>'
        + '<span class="info-label">备注</span><span class="info-value">' + esc(acc.notes||'-') + '</span>'
        + '</div></div>';

      html += '<div class="info-section"><div class="info-section-title">订阅信息</div><div class="info-grid">'
        + '<span class="info-label">套餐规格</span><span class="info-value">' + esc(qwenSpecName(sub && sub.specCode)) + '</span>'
        + '<span class="info-label">状态</span><span class="info-value">' + esc(qwenStatusText(sub && sub.status)) + '</span>'
        + '<span class="info-label">自动续费</span><span class="info-value">' + (sub ? (sub.autoRenewFlag ? '是' : '否') : '-') + '</span>'
        + '<span class="info-label">剩余天数</span><span class="info-value">' + (sub && sub.remainingDays != null ? sub.remainingDays + ' 天' : '-') + '</span>'
        + '<span class="info-label">开始时间</span><span class="info-value">' + esc(fmtYesCodeDate(sub && sub.startTime)) + '</span>'
        + '<span class="info-label">到期时间</span><span class="info-value">' + esc(fmtYesCodeDate(sub && sub.endTime)) + '</span>'
        + '<span class="info-label">实例编号</span><span class="info-value">' + esc((sub && sub.instanceCode) || '-') + '</span>'
        + '<span class="info-label">官网</span><span class="info-value"><a href="https://platform.qianwenai.com/home/billing/subscription/token-plan-individual" target="_blank" rel="noopener" style="color:var(--accent);text-decoration:none">千问控制台 ↗</a></span>'
        + '</div></div>';

      html += '<div class="info-section"><div class="info-section-title">用量曲线</div>'
        + '<div class="chart-controls">'
        + '<button class="period-btn active" id="period-today-' + index + '" onclick="loadUsageChart(' + index + ',\'today\')">当日</button>'
        + '<button class="period-btn" id="period-7d-' + index + '" onclick="loadUsageChart(' + index + ',\'7d\')">近7天</button>'
        + '<button class="period-btn" id="period-30d-' + index + '" onclick="loadUsageChart(' + index + ',\'30d\')">近30天</button>'
        + '<div class="chart-summary" id="chartSummary-' + index + '"></div>'
        + '</div>'
        + '<div class="chart-wrap"><div id="chartContainer-' + index + '" style="width:100%;height:320px"></div>'
        + '<div class="chart-loading" id="chartLoading-' + index + '"></div></div>'
        + '</div>';

      document.getElementById('modalBody').innerHTML = html;
    }

    function renderMiniMaxDetail(index, acc) {
      var sub = (acc.data && acc.data.subscription) || null;

      var html = '<div class="info-section"><div class="info-section-title">负责人信息</div><div class="info-grid">'
        + '<span class="info-label">负责人</span><span class="info-value">' + esc(acc.responsiblePerson||'-') + '</span>'
        + '<span class="info-label">电话</span><span class="info-value">' + esc(acc.phone||'-') + '</span>'
        + '<span class="info-label">备注</span><span class="info-value">' + esc(acc.notes||'-') + '</span>'
        + '</div></div>';

      var daysLeftTxt = '-';
      if (sub && sub.expireMs) {
        var dl = Math.ceil((sub.expireMs - Date.now()) / 86400000);
        daysLeftTxt = dl <= 0 ? '已过期' : dl + ' 天';
      }
      html += '<div class="info-section"><div class="info-section-title">订阅信息</div><div class="info-grid">'
        + '<span class="info-label">套餐</span><span class="info-value">' + esc((sub && sub.planName) || '无套餐记录') + '</span>'
        + '<span class="info-label">到期时间</span><span class="info-value">' + esc((sub && sub.expireDate) || '-') + '</span>'
        + '<span class="info-label">剩余天数</span><span class="info-value">' + daysLeftTxt + '</span>'
        + '<span class="info-label">权益发放时间</span><span class="info-value">' + esc(fmtYesCodeDate(sub && sub.notifiedAt)) + '</span>'
        + '<span class="info-label">官网</span><span class="info-value"><a href="https://platform.minimaxi.com/console/plan" target="_blank" rel="noopener" style="color:var(--accent);text-decoration:none">MiniMax 控制台 ↗</a></span>'
        + '</div></div>';

      // 用量曲线:官方 usage_summary 仅支持 7/30 天口径,与智谱/千问共用图表渲染
      html += '<div class="info-section"><div class="info-section-title">用量曲线</div>'
        + '<div class="chart-controls">'
        + '<button class="period-btn active" id="period-7d-' + index + '" onclick="loadUsageChart(' + index + ',\'7d\')">近7天</button>'
        + '<button class="period-btn" id="period-30d-' + index + '" onclick="loadUsageChart(' + index + ',\'30d\')">近30天</button>'
        + '<div class="chart-summary" id="chartSummary-' + index + '"></div>'
        + '</div>'
        + '<div class="chart-wrap"><div id="chartContainer-' + index + '" style="width:100%;height:320px"></div>'
        + '<div class="chart-loading" id="chartLoading-' + index + '"></div></div>'
        + '</div>';

      document.getElementById('modalBody').innerHTML = html;
    }

    // 阶跃详情：基本信息 / 订阅 / 今日模型用量 / 按量余额 / 用量曲线（积分）
    function renderStepfunDetail(index, acc) {
      var sub = (acc.data && acc.data.subscription) || null;
      var user = (acc.data && acc.data.user) || null;
      var usage = (acc.data && acc.data.usage) || null;
      var balance = (acc.data && acc.data.balance) || null;

      var html = '<div class="info-section"><div class="info-section-title">负责人信息</div><div class="info-grid">'
        + '<span class="info-label">负责人</span><span class="info-value">' + esc(acc.responsiblePerson||'-') + '</span>'
        + '<span class="info-label">电话</span><span class="info-value">' + esc(acc.phone||'-') + '</span>'
        + '<span class="info-label">备注</span><span class="info-value">' + esc(acc.notes||'-') + '</span>'
        + '</div></div>';

      html += '<div class="info-section"><div class="info-section-title">基本信息</div><div class="info-grid">'
        + '<span class="info-label">昵称</span><span class="info-value">' + esc((user && user.nickname) || '-') + '</span>'
        + '<span class="info-label">手机号</span><span class="info-value">' + esc((user && user.mobileMasked) || '-') + '</span>'
        + '<span class="info-label">UID</span><span class="info-value">' + esc((user && user.uid) || '-') + '</span>'
        + '</div></div>';

      var daysLeftTxt = '-';
      if (sub && sub.expireMs) {
        var dl = Math.ceil((sub.expireMs - Date.now()) / 86400000);
        daysLeftTxt = dl <= 0 ? '已过期' : dl + ' 天';
      }
      var priceTxt = (sub && sub.priceYuan != null) ? '¥' + sub.priceYuan + ' / ' + (sub.durationDays || '-') + '天' : '-';
      var modelsTxt = (sub && sub.supportModels && sub.supportModels.length) ? (sub.supportModels.length + ' 个（' + sub.supportModels.slice(0, 6).join('、') + (sub.supportModels.length > 6 ? ' 等' : '') + '）') : '-';
      html += '<div class="info-section"><div class="info-section-title">订阅信息（Step 套餐）</div><div class="info-grid">'
        + '<span class="info-label">套餐</span><span class="info-value">' + esc((sub && sub.planName) || '无套餐') + '</span>'
        + '<span class="info-label">价格</span><span class="info-value">' + priceTxt + '</span>'
        + '<span class="info-label">状态</span><span class="info-value">' + esc((sub && sub.statusText) || '-') + '</span>'
        + '<span class="info-label">自动续费</span><span class="info-value">' + ((sub && sub.autoRenew) ? '已开启' : '未开启') + '</span>'
        + '<span class="info-label">激活时间</span><span class="info-value">' + esc(fmtYesCodeDate(sub && sub.activatedMs)) + '</span>'
        + '<span class="info-label">到期时间</span><span class="info-value">' + esc((sub && sub.expireDate) || '-') + '</span>'
        + '<span class="info-label">剩余天数</span><span class="info-value">' + daysLeftTxt + '</span>'
        + '<span class="info-label">支持模型</span><span class="info-value">' + esc(modelsTxt) + '</span>'
        + '<span class="info-label">官网</span><span class="info-value"><a href="https://platform.stepfun.com/account-overview" target="_blank" rel="noopener" style="color:var(--accent);text-decoration:none">阶跃星辰控制台 ↗</a></span>'
        + '</div></div>';

      // 今日（北京时间）按模型积分消耗；月度窗的 used/quota 一并展示
      var today = (usage && usage.today) || null;
      var todayHtml = '<span class="info-label">今日消耗</span><span class="info-value" style="color:var(--text-faint)">当日暂无消耗</span>';
      if (today && today.models && today.models.length) {
        todayHtml = '<table style="width:100%;border-collapse:collapse;font-size:13px;white-space:nowrap">'
          + '<tr style="color:var(--text-faint);text-align:left;white-space:nowrap"><th style="padding:4px 8px;font-weight:500">模型</th><th style="padding:4px 8px;font-weight:500">Credits</th><th style="padding:4px 8px;font-weight:500">次数</th></tr>'
          + today.models.map(function(m) {
              return '<tr><td style="padding:4px 8px">' + esc(m.modelId) + '</td>'
                + '<td style="padding:4px 8px">' + esc(fmtStepfunCredits(m.credits)) + '</td>'
                + '<td style="padding:4px 8px">' + (m.calls || 0) + '</td></tr>';
            }).join('')
          + '<tr><td style="padding:4px 8px;font-weight:600">合计</td>'
            + '<td style="padding:4px 8px;font-weight:600">' + esc(fmtStepfunCredits(today.credits || 0)) + '</td>'
            + '<td style="padding:4px 8px;font-weight:600">' + (today.calls || 0) + '</td></tr>'
          + '</table>';
      }
      var quotaInfo = '';
      var monthlyWin = (usage && usage.windows || []).filter(function(w) { return w.quota > 0; })[0];
      if (monthlyWin) {
        quotaInfo = '<span class="info-label">月度积分</span><span class="info-value">' + esc(fmtStepfunCredits(monthlyWin.used)) + ' / ' + esc(fmtStepfunCredits(monthlyWin.quota)) + ' 已用</span>';
      }
      // 当日汇总（北京时间口径），明细表紧随其后
      var todaySumInfo = (today && today.credits != null)
        ? '<span class="info-label">当日消耗</span><span class="info-value">' + esc(fmtStepfunCredits(today.credits)) + ' Credits · ' + (today.calls || 0) + ' 次</span>'
        : '';
      html += '<div class="info-section"><div class="info-section-title">今日用量</div><div class="info-grid">'
        + quotaInfo + todaySumInfo + todayHtml + '</div>'
        // 口径备注:阶跃官方按 Credits 计费,非真实 Token 数(不同模型折算比例不同)
        // + '<div style="font-size:11px;color:var(--text-faint);margin-top:6px">注：以上为阶跃官方 Credits 计费口径，非真实 Token 用量；今日窗口按北京时间 00:00 起算</div></div>';

      // 按量付费侧（代金券/昨日/本月），软失败时不展示该节
      if (balance) {
        html += '<div class="info-section"><div class="info-section-title">按量付费余额</div><div class="info-grid">'
          + '<span class="info-label">代金券</span><span class="info-value">¥' + (+balance.voucherYuan).toFixed(2) + '</span>'
          + '<span class="info-label">余额合计</span><span class="info-value">¥' + (+balance.balanceYuan).toFixed(2) + '</span>'
          + '<span class="info-label">昨日消费</span><span class="info-value">¥' + (+balance.costYesterdayYuan).toFixed(2) + '</span>'
          + '<span class="info-label">本月消费</span><span class="info-value">¥' + (+balance.costMonthYuan).toFixed(2) + '</span>'
          + '</div></div>';
      }

      // 邀请活动：邀请码/链接（点击复制，满员提醒）、邀请进度、邀请记录与奖励账本
      var campaign = (acc.data && acc.data.campaign) || null;
      if (campaign && campaign.inviteUrl) {
        var full = campaign.inviteCount >= campaign.inviteMaxCount && campaign.inviteMaxCount > 0;
        html += '<div class="info-section"><div class="info-section-title">邀请活动</div><div class="info-grid">'
          + '<span class="info-label">我的邀请码</span><span class="info-value" style="font-weight:600;letter-spacing:.5px">' + esc(campaign.inviteCode) + '</span>'
          + '<span class="info-label">邀请进度</span><span class="info-value">' + campaign.inviteCount + ' / ' + campaign.inviteMaxCount + ' 人'
          + (campaign.remainingRewardDays ? '　还可领 ' + campaign.remainingRewardDays + ' 天' : '') + '</span>'
          + '</div>'
          // 卡片上整行展示链接 + 复制按钮，满员时按钮文案变化（点击仍可复制，但会提醒活动已无收益）
          + '<div style="display:flex;gap:8px;align-items:center;margin-top:6px">'
          + '<input class="form-input" id="sfInviteUrl-' + index + '" value="' + esc(campaign.inviteUrl) + '" readonly style="flex:1;font-size:12px" onclick="this.select()">'
          + '<button class="btn-primary" style="padding:6px 14px;font-size:12px" onclick="copyStepfunInvite(' + index + ')">' + (full ? '复制（已邀满）' : '复制链接') + '</button>'
          + '</div>'
          + '<div style="font-size:11px;color:var(--text-faint);margin-top:4px">好友通过链接注册，双方各得 15 天 plan；每人最多邀请 ' + campaign.inviteMaxCount + ' 人</div>';

        // 邀请记录
        if (campaign.invites && campaign.invites.length) {
          html += '<div style="margin-top:10px"><div style="font-size:12px;color:var(--text-faint);margin-bottom:4px">邀请记录</div><table style="width:100%;border-collapse:collapse;font-size:13px">'
            + '<tr style="color:var(--text-faint);text-align:left;white-space:nowrap"><th style="padding:4px 8px;font-weight:500">好友</th><th style="padding:4px 8px;font-weight:500">奖励</th><th style="padding:4px 8px;font-weight:500">注册时间</th></tr>'
            + campaign.invites.map(function(it) {
                return '<tr><td style="padding:4px 8px">' + esc(it.nickname || it.maskedPhone || '-') + '</td>'
                  + '<td style="padding:4px 8px">' + (it.rewardDays || 0) + ' 天</td>'
                  + '<td style="padding:4px 8px">' + esc(fmtYesCodeDate(it.usedAtMs)) + '</td></tr>';
              }).join('')
            + '</table></div>';
        } else {
          html += '<div style="font-size:12px;color:var(--text-faint);margin-top:10px">暂无邀请记录</div>';
        }

        // 奖励账本（新注册赠送 / 邀请赠送）
        if (campaign.rewards && campaign.rewards.length) {
          var typeName = { register: '新注册赠送', invite: '邀请赠送', other: '其他奖励' };
          html += '<div style="margin-top:10px"><div style="font-size:12px;color:var(--text-faint);margin-bottom:4px">奖励记录</div><table style="width:100%;border-collapse:collapse;font-size:13px">'
            + '<tr style="color:var(--text-faint);text-align:left;white-space:nowrap"><th style="padding:4px 8px;font-weight:500">类型</th><th style="padding:4px 8px;font-weight:500">天数</th><th style="padding:4px 8px;font-weight:500">生效时间</th><th style="padding:4px 8px;font-weight:500">到期时间</th></tr>'
            + campaign.rewards.map(function(r) {
                return '<tr><td style="padding:4px 8px">' + esc(typeName[r.rewardType] || r.rewardType) + '</td>'
                  + '<td style="padding:4px 8px">' + (r.rewardDays || 0) + ' 天</td>'
                  + '<td style="padding:4px 8px">' + esc(fmtYesCodeDate(r.activatedMs)) + '</td>'
                  + '<td style="padding:4px 8px">' + esc(fmtYesCodeDate(r.expiredMs)) + '</td></tr>';
              }).join('')
            + '</table></div>';
        }
        html += '</div>';
      }

      // 用量曲线：纵轴为积分（credit），复用通用图表渲染
      html += '<div class="info-section"><div class="info-section-title">用量曲线</div>'
        + '<div class="chart-controls">'
        + '<button class="period-btn active" id="period-7d-' + index + '" onclick="loadUsageChart(' + index + ',\'7d\')">近7天</button>'
        + '<button class="period-btn" id="period-30d-' + index + '" onclick="loadUsageChart(' + index + ',\'30d\')">近30天</button>'
        + '<div class="chart-summary" id="chartSummary-' + index + '"></div>'
        + '</div>'
        + '<div class="chart-wrap"><div id="chartContainer-' + index + '" style="width:100%;height:320px"></div>'
        + '<div class="chart-loading" id="chartLoading-' + index + '"></div></div>'
        + '</div>';

      document.getElementById('modalBody').innerHTML = html;
    }

    // 管理员点击 GLM「控制台」:先在用户手势中开窗(否则 fetch 后的 window.open 会被
    // 浏览器弹窗拦截),再经 /api/console-url 换取带 token 的地址;失败降级普通链接。
    function openGlmConsole(index) {
      var win = null;
      try { win = window.open('', '_blank'); } catch (e) { /* 弹窗被拦:下面降级 */ }
      var jump = function(url) { if (win) { try { win.location.href = url; } catch (e) { /* 跨域窗口忽略 */ } } };
      fetch(API_PREFIX + '/api/console-url/' + index, { headers: authHeaders() })
        .then(function(r) { return r.json(); })
        .then(function(d) {
          jump((d && d.url) || 'https://bigmodel.cn/coding-plan');
        })
        .catch(function() { jump('https://bigmodel.cn/coding-plan'); });
    }

    function showDetail(index) {
      // Dispose existing chart if any
      if (_usageCharts[_detailIndex]) { _usageCharts[_detailIndex].dispose(); delete _usageCharts[_detailIndex]; }
      _detailIndex = index;
      var acc = accAt(index);
      if (!acc) return;
      document.getElementById('modalTitle').textContent = displayName(acc, index) || ('账号 ' + (index + 1));

      if ((acc.platform || 'glm') === 'yescode') {
        renderYesCodeDetail(index, acc);
        document.getElementById('modalOverlay').classList.add('active');
        return;
      }

      if ((acc.platform || 'glm') === 'sub2api' || (acc.platform || 'glm') === 'huoli') {
        renderSub2apiDetail(index, acc);
        document.getElementById('modalOverlay').classList.add('active');
        return;
      }

      if ((acc.platform || 'glm') === 'volc') {
        if (acc.planType === 'coding') renderVolcCDetail(index, acc);
        else renderVolcDetail(index, acc);
        document.getElementById('modalOverlay').classList.add('active');
        return;
      }

      if ((acc.platform || 'glm') === 'telecomjs') {
        renderTelecomDetail(index, acc);
        document.getElementById('modalOverlay').classList.add('active');
        return;
      }

      if ((acc.platform || 'glm') === 'qwen') {
        renderQwenDetail(index, acc);
        document.getElementById('modalOverlay').classList.add('active');
        loadUsageChart(index, 'today');
        return;
      }

      if ((acc.platform || 'glm') === 'minimax') {
        renderMiniMaxDetail(index, acc);
        document.getElementById('modalOverlay').classList.add('active');
        loadUsageChart(index, '7d');
        return;
      }

      if ((acc.platform || 'glm') === 'stepfun') {
        renderStepfunDetail(index, acc);
        document.getElementById('modalOverlay').classList.add('active');
        loadUsageChart(index, '7d');
        return;
      }

      var admin = isAdmin();
      var createRow = admin
        ? '<div class="keys-create"><input id="newKeyName" placeholder="Key 名称"><button onclick="createKey(' + index + ')">创建</button></div>'
        : '';

      // 智谱控制台直达:管理员点击时经 /api/console-url(checkAuth 保护)换取
      // 带 authorization token 的跳转地址,油猴脚本读取 ?token= 写入
      // bigmodel_token_production cookie 后进入后台;游客只给普通链接。
      // 注意:usage 缓存里不含 authorization,不能在前端直接拼 token。
      var glmConsoleHref = 'https://bigmodel.cn/coding-plan';
      var glmConsoleHtml = admin
        ? '<a href="javascript:void(0)" onclick="openGlmConsole(' + index + ')" style="color:var(--accent);text-decoration:none">bigmodel.cn/coding-plan ↗</a>'
        : '<a href="' + esc(glmConsoleHref) + '" target="_blank" rel="noopener" style="color:var(--accent);text-decoration:none">bigmodel.cn/coding-plan ↗</a>';

      var html = '<div id="riskBanner-' + index + '">' + riskBannerHTML(acc) + '</div>'
        + '<div class="info-section"><div class="info-section-title">负责人信息</div><div class="info-grid">'
        + '<span class="info-label">负责人</span><span class="info-value">' + esc(acc.responsiblePerson||'-') + '</span>'
        + '<span class="info-label">电话</span><span class="info-value">' + esc(acc.phone||'-') + '</span>'
        + '<span class="info-label">备注</span><span class="info-value">' + esc(acc.notes||'-') + '</span>'
        + '</div></div>'
        + '<div class="info-section"><div class="info-section-title">控制台</div><div class="info-grid">'
        + '<span class="info-label">智谱 Coding Plan</span><span class="info-value">' + glmConsoleHtml + '</span>'
        + (admin
            ? '<span class="info-label">自动登录</span><span class="info-value" style="font-size:12px;color:var(--text-mute)">点击后自动换取带 token 的地址并打开，油猴脚本读取后写入 cookie 进入后台；未安装脚本时会跳到登录页，属正常现象</span>'
            : '')
        + '</div></div>'
        + '<div id="resetCards-' + index + '">' + resetCardsSectionHTML(acc, admin, index) + '</div>'
        + '<div class="detail-tabs">'
        + '<button class="detail-tab active" id="dtab-chart-' + index + '" onclick="switchDetailTab(\'chart\',' + index + ')">用量曲线</button>'
        + (admin ? '<button class="detail-tab" id="dtab-keys-' + index + '" onclick="switchDetailTab(\'keys\',' + index + ')">API Keys</button>' : '')
        + (admin ? '<button class="detail-tab" id="dtab-ip-' + index + '" onclick="switchDetailTab(\'ip\',' + index + ')">IP 白名单</button>' : '')
        + '</div>'
        + (admin ? '<div id="dpanel-keys-' + index + '" style="display:none">'
          + '<div class="keys-section"><div class="keys-header"><div class="keys-title">API Keys</div>' + createRow + '</div>'
          + '<div id="keysContainer" class="keys-loading">加载中...</div></div>'
          + '</div>' : '')
        + '<div id="dpanel-chart-' + index + '">'
        + '<div class="chart-controls">'
        + '<button class="period-btn active" id="period-today-' + index + '" onclick="loadUsageChart(' + index + ',\'today\')">当日</button>'
        + '<button class="period-btn" id="period-7d-' + index + '" onclick="loadUsageChart(' + index + ',\'7d\')">近7天</button>'
        + '<button class="period-btn" id="period-30d-' + index + '" onclick="loadUsageChart(' + index + ',\'30d\')">近30天</button>'
        + '<div class="chart-summary" id="chartSummary-' + index + '"></div>'
        + '</div>'
        + '<div class="chart-wrap"><div id="chartContainer-' + index + '" style="width:100%;height:320px"></div>'
        + '<div class="chart-loading" id="chartLoading-' + index + '"></div></div>'
        + '</div>'
        + (admin ? '<div id="dpanel-ip-' + index + '" style="display:none">'
          + '<div class="keys-section"><div class="keys-header"><div class="keys-title">IP 白名单</div>'
          + '<div class="keys-create"><input id="newIpAddr" placeholder="如 1.2.3.4 或 10.0.0.0/8" style="width:200px"><button onclick="addIpWhitelist(' + index + ')">添加</button></div>'
          + '</div>'
          + '<p style="font-size:12px;color:var(--text-mute);margin:-6px 0 12px">未配置时不限制 IP;添加后仅白名单内 IP 可调用本账号 API。</p>'
          + '<div id="ipContainer" class="keys-loading">点击「IP 白名单」标签加载...</div></div>'
          + '</div>' : '');

      document.getElementById('modalBody').innerHTML = html;
      document.getElementById('modalOverlay').classList.add('active');

      // 默认展示用量曲线;keys 相关仅管理员可见,不发起请求
      loadUsageChart(index, 'today');

      // 每次打开智谱个人版账号详情都刷新风控/异常状态:有风险则记录到 accounts.json,已解除则清除
      if ((acc.platform || 'glm') === 'glm') {
        fetch(API_PREFIX + '/api/risk/' + index, { headers: authHeaders() }).then(function(r){return r.json()}).then(function(r) {
          if (r.error) return;
          accAt(index).risk = r.text ? { level: r.level, text: r.text } : null;
          var rb = document.getElementById('riskBanner-' + index);
          if (rb) rb.innerHTML = riskBannerHTML(accAt(index));
          updateCard(index, accAt(index));
        }).catch(function() {});
      }

      // 管理员打开详情时才加载重置卡:有卡则记录数量,卡片外徽章随之更新;游客只看缓存
      if ((acc.platform || 'glm') === 'glm' && admin) {
        loadResetCards(index);
      }

      if (admin) {
        fetch(API_PREFIX + '/api/keys/' + index, { headers: authHeaders() }).then(function(r){return r.json()}).then(function(keys) {
          if (keys.error) { document.getElementById('keysContainer').innerHTML = '<p class="error-text">' + esc(keys.error) + '</p>'; return; }
          accAt(index).keyCount = keys.length || 0;
          updateCard(index, accAt(index));
          if (!keys.length) { document.getElementById('keysContainer').innerHTML = '<p style="color:var(--text-mute);font-size:13px">无 API Key</p>'; return; }
          renderKeysTable(index, keys, admin);
        }).catch(function(err) {
          document.getElementById('keysContainer').innerHTML = '<p class="error-text">加载失败: ' + esc(err.message) + '</p>';
        });
      }
    }

    function switchDetailTab(tab, idx) {
      ['keys', 'chart', 'ip'].forEach(function(p) {
        var panel = document.getElementById('dpanel-' + p + '-' + idx);
        var btn = document.getElementById('dtab-' + p + '-' + idx);
        if (panel) panel.style.display = p === tab ? '' : 'none';
        if (btn) btn.classList.toggle('active', p === tab);
      });
      if (tab === 'chart') {
        var container = document.getElementById('chartContainer-' + idx);
        if (container && !container._chartLoaded) loadUsageChart(idx, 'today');
      }
      if (tab === 'ip') {
        var ipC = document.getElementById('ipContainer');
        if (ipC && !ipC._ipLoaded) loadIpWhitelist(idx);
      }
    }

    // 图表空态:区分时段给出友好文案(无调用 ≠ Cookie 失效,后端已分开处理)
    var CHART_EMPTY_TEXT = {
      today: { title: '今日暂无调用记录', sub: '当日有模型调用后,这里会按小时展示用量曲线' },
      '7d': { title: '近 7 天暂无调用记录', sub: '产生用量后,这里会按天展示用量曲线' },
      '30d': { title: '近 30 天暂无调用记录', sub: '产生用量后,这里会按天展示用量曲线' }
    };

    function renderChartEmpty(idx, period) {
      var container = document.getElementById('chartContainer-' + idx);
      if (!container) return;
      if (_usageCharts[idx]) { _usageCharts[idx].dispose(); delete _usageCharts[idx]; }
      var sumEl = document.getElementById('chartSummary-' + idx);
      if (sumEl) sumEl.innerHTML = '';
      var txt = CHART_EMPTY_TEXT[period] || CHART_EMPTY_TEXT['7d'];
      container._chartLoaded = true;
      container.innerHTML = '<div class="chart-empty">'
        + '<div class="chart-empty-icon"><svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="M6 15l4-5 3.5 3L18 7"/></svg></div>'
        + '<div class="chart-empty-title">' + txt.title + '</div>'
        + '<div class="chart-empty-sub">' + txt.sub + '</div>'
        + '</div>';
    }

    function loadUsageChart(idx, period) {
      _chartPeriod[idx] = period;
      ['today', '7d', '30d'].forEach(function(p) {
        var btn = document.getElementById('period-' + p + '-' + idx);
        if (btn) btn.classList.toggle('active', p === period);
      });
      var loading = document.getElementById('chartLoading-' + idx);
      var container = document.getElementById('chartContainer-' + idx);
      if (!container) return;
      if (loading) { loading.textContent = '加载中...'; loading.style.display = 'flex'; }
      fetch(API_PREFIX + '/api/model-usage/' + idx + '?period=' + period, { headers: authHeaders() })
        .then(function(r) { return r.json(); })
        .then(function(resp) {
          if (resp.error) { if (loading) { loading.textContent = '加载失败: ' + resp.error; loading.style.display = 'flex'; } return; }
          var data = resp.data;
          if (!data || !data.x_time || !data.modelDataList || !data.x_time.length || !data.modelDataList.length) {
            if (loading) loading.style.display = 'none';
            renderChartEmpty(idx, period);
            return;
          }
          if (loading) loading.style.display = 'none';
          container._chartLoaded = true;
          renderUsageChart(idx, data, period);
        })
        .catch(function(err) { if (loading) { loading.textContent = '请求失败: ' + err.message; loading.style.display = 'flex'; } });
    }

    // 图表配色随主题切换:亮/暗沿用原冷暖,Claude 用暖陶土系
    var CHART_THEMES = {
      light: { txt: '#334155', line: '#94a3b8', split: '#e2e8f0', tipBg: 'rgba(255,255,255,.96)', tipBorder: '#e2e8f0',
               colors: ['#3b5bdb','#e03131','#9c36b5','#0c8599','#2f9e44','#e67700','#d6336c','#1971c2'] },
      dark: { txt: '#cbd5e1', line: '#475569', split: '#1e293b', tipBg: 'rgba(15,23,42,.96)', tipBorder: '#334155',
              colors: ['#74a8ff','#ff8787','#da77f2','#3bc9db','#69db7c','#ffa94d','#f783ac','#4dabf7'] },
      claude: { txt: '#3d3929', line: '#b9b09c', split: '#e8e2d2', tipBg: 'rgba(255,253,248,.97)', tipBorder: '#e0d8c4',
                colors: ['#c05b36','#8a6d3b','#5c7a4e','#46697d','#a04e6e','#7a6a9c','#3f7d71','#b0783f'] }
    };

    function renderUsageChart(idx, data, period) {
      var container = document.getElementById('chartContainer-' + idx);
      if (!container) return;
      renderUsageSummary(idx, data);
      if (_usageCharts[idx]) { _usageCharts[idx].dispose(); }
      var chart = echarts.init(container);
      _usageCharts[idx] = chart;
      var ct = CHART_THEMES[currentTheme()] || CHART_THEMES.light;
      var txtColor = ct.txt;
      var lineColor = ct.line;
      var splitColor = ct.split;
      var tipBg = ct.tipBg;
      var tipBorder = ct.tipBorder;

      var xData = data.x_time;
      var models = (data.modelDataList || []).filter(function(m) {
        return m.tokensUsage && m.tokensUsage.some(function(v) { return v > 0; });
      });
      var xLabels = xData.map(function(t) {
        if (period === 'today') return t.slice(11, 16);
        return t.slice(5, 13).replace(' ', '\n');
      });
      var interval = Math.max(0, Math.floor(xData.length / 14) - 1);
      var colors = ct.colors;

      chart.setOption({
        color: colors,
        tooltip: {
          trigger: 'axis',
          backgroundColor: tipBg,
          borderColor: tipBorder,
          textStyle: { color: txtColor },
          axisPointer: { type: 'cross', label: { backgroundColor: '#6a7985' } },
          formatter: function(params) {
            var time = xData[params[0].dataIndex];
            var html = '<div style="font-size:12px;font-weight:600;margin-bottom:4px">' + time + '</div>';
            var total = 0;
            params.forEach(function(p) {
              if (p.value > 0) { html += '<div>' + p.marker + p.seriesName + ': ' + fmtTokens(p.value) + '</div>'; total += p.value; }
            });
            if (params.length > 1 && total > 0) html += '<div style="border-top:1px solid ' + tipBorder + ';margin-top:4px;padding-top:4px;font-weight:500">合计: ' + fmtTokens(total) + '</div>';
            return html;
          }
        },
        legend: { data: models.map(function(m) { return m.modelName; }), bottom: 0, type: 'scroll', textStyle: { fontSize: 12, color: txtColor } },
        grid: { left: 64, right: 16, top: 16, bottom: 52 },
        xAxis: { type: 'category', data: xLabels, boundaryGap: false, axisLabel: { fontSize: 11, interval: interval, color: txtColor }, axisLine: { lineStyle: { color: lineColor } }, axisTick: { lineStyle: { color: lineColor } } },
        yAxis: { type: 'value', axisLabel: { fontSize: 11, color: txtColor, formatter: fmtTokens }, axisLine: { show: true, lineStyle: { color: lineColor } }, splitLine: { lineStyle: { color: splitColor } } },
        series: models.map(function(m, i) {
          var c = colors[i % colors.length];
          return { name: m.modelName, type: 'line', smooth: true, symbol: 'none', data: m.tokensUsage, itemStyle: { color: c }, lineStyle: { color: c, width: 2 } };
        })
      });

      window.addEventListener('resize', function() { _usageCharts[idx] && _usageCharts[idx].resize(); });
    }

    function fmtTokens(v) {
      if (v >= 1000000) return (v / 1000000).toFixed(1) + 'M';
      if (v >= 1000) return (v / 1000).toFixed(1) + 'K';
      return '' + v;
    }

    // 用量曲线顶部总量汇总：totalTokensUsage 统一换算为 M 单位
    function renderUsageSummary(idx, data) {
      var el = document.getElementById('chartSummary-' + idx);
      if (!el) return;
      var tu = (data && data.totalUsage) || {};
      var totalTokens = tu.totalTokensUsage || 0;
      // 阶跃纵轴为官方 Credits(非 Token),汇总单位随平台标注
      var acc = accAt(idx);
      var isCredits = acc && (acc.platform || 'glm') === 'stepfun';
      var unit = isCredits ? 'M credits' : 'M';
      var html = '<span>总用量</span>'
        + '<span class="sum-total">' + (totalTokens / 1000000).toFixed(2) + ' ' + unit + '</span>';
      if (tu.totalModelCallCount != null) {
        html += '<span class="sum-divider">·</span><span>调用 ' + tu.totalModelCallCount.toLocaleString() + '</span>';
      }
      el.innerHTML = html;
    }

    function renderKeysTable(idx, keys, admin) {
      var svgCopy = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>';
      var svgDel = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/></svg>';
      var adminCol = admin ? '<th style="width:72px">操作</th>' : '';
      var rows = keys.map(function(k) {
        var cls = k.isHidden ? ' class="key-hidden"' : '';
        var lastUse = k.lastUseTime || '-';
        var api = esc(k.apiKey || '');
        var copyBtn = admin ? '<button class="icon-btn" onclick="copySecret(this,' + idx + ',\'' + api + '\')" title="复制密钥">' + svgCopy + '</button>' : '';
        var delBtn = admin && !k.isHidden ? '<button class="icon-btn del-icon" onclick="deleteKey(this,' + idx + ',\'' + api + '\')" title="删除密钥">' + svgDel + '</button>' : '';
        var adminCell = admin ? '<td><div class="key-actions">' + copyBtn + delBtn + '</div></td>' : '';
        return '<tr' + cls + '><td>' + esc(k.name) + '</td><td class="mono">' + esc(k.secretKey) + '</td><td>' + lastUse + '</td>' + adminCell + '</tr>';
      }).join('');
      document.getElementById('keysContainer').innerHTML =
        '<table class="keys-table"><tr><th>名称</th><th>Secret Key</th><th>最后使用</th>' + adminCol + '</tr>' + rows + '</table>';
    }


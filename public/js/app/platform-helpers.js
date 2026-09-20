// ============ 平台渲染辅助(卡片行/环形/百分比,按平台)============
    // ============ 卡片渲染 ============

    function renderLimitRow(limit) {
      if (limit._unlimited) {
        return '<div class="limit-row"><div class="limit-label"><span class="limit-name">' + getLimitLabel(limit) + '</span><span class="limit-value" style="color:#52c41a">∞</span></div></div>';
      }
      var pct = limit.percentage || 0;
      var label = getLimitLabel(limit);
      var value = '已用 ' + pct + '%';
      if ((limit.type === 'TIME_LIMIT' || limit.type === 'CREDIT_LIMIT') && limit.usage != null) value = (limit.currentValue||0) + '/' + limit.usage + ' (' + pct + '%)';
      var reset = limit.nextResetTime ? '重置 ' + formatTime(limit.nextResetTime) : '';

      // Segmented bar for 5-hour (unit=3) and weekly (unit=6): both 5 segments (weekly limit = 5×5-hour limit)
      var segments = 0;
      if (limit.unit === 3 || limit.unit === 6) segments = GLM_BAR_SEGMENTS;

      if (segments > 0) {
        var segPct = 100 / segments;
        var segHtml = '';
        for (var i = 0; i < segments; i++) {
          var segStart = i * segPct;
          var segEnd = (i + 1) * segPct;
          var fillW = 0;
          if (pct >= segEnd) fillW = 100;
          else if (pct > segStart) fillW = ((pct - segStart) / segPct) * 100;
          segHtml += '<div class="seg"><div class="seg-fill ' + getColorClass(pct) + '" style="width:' + fillW + '%"></div></div>';
        }

        // Theoretical usage: based on nextResetTime; advances only inside work hours (Mon–Fri 08:00–18:00)
        var theoPct = -1;
        if (limit.nextResetTime) {
          var periodMs = limit.unit === 3 ? GLM_PERIOD_5H_MS : GLM_PERIOD_WEEK_MS;
          theoPct = glmTheoPct(limit.nextResetTime, periodMs);
        }

        var barHtml = '<div class="limit-bar-wrap"><div class="limit-bar-seg">' + segHtml + '</div>';
        if (theoPct >= 0) {
          barHtml += '<div class="theo-marker" style="left:' + theoPct + '%"></div>';
        }
        barHtml += '</div>';

        // Tension based on actual vs theoretical
        var tensionHtml = '';
        if (theoPct >= 0) {
          var ti = tensionInfo(pct, theoPct);
          tensionHtml = '<div class="tension-row"><span style="color:' + ti.color + ';font-weight:500">' + ti.text + '</span><span style="color:var(--text-faint)">理论 ' + theoPct.toFixed(0) + '%</span></div>';
        }

        return '<div class="limit-row"><div class="limit-label"><span class="limit-name">' + label + '</span><span class="limit-value">' + value + '</span></div>'
          + barHtml + tensionHtml
          + (reset ? '<div style="font-size:11px;color:var(--text-faint);margin-top:2px">' + reset + '</div>' : '')
          + '</div>';
      }

      // Default simple bar for other limits
      return '<div class="limit-row"><div class="limit-label"><span class="limit-name">' + label + '</span><span class="limit-value">' + value + '</span></div>'
        + '<div class="limit-bar"><div class="limit-fill ' + getColorClass(pct) + '" style="width:' + Math.min(pct,100) + '%"></div></div>'
        + (reset ? '<div style="font-size:11px;color:var(--text-faint);margin-top:3px">' + reset + '</div>' : '') + '</div>';
    }

    function platformTag(platform, planType, alias) {
      if (platform === 'yescode') return '<span class="platform-tag platform-yescode">YesCode</span>';
      if (platform === 'sub2api') return '<span class="platform-tag platform-sub2api">' + esc(alias || 'Sub2API') + '</span>';
      if (platform === 'huoli') return '<span class="platform-tag platform-huoli">火狸</span>';
      if (platform === 'volc') return planType === 'coding'
        ? '<span class="platform-tag platform-volcc">火山C</span>'
        : '<span class="platform-tag platform-volc">火山A</span>';
      if (platform === 'telecomjs') return '<span class="platform-tag platform-telecomjs">智云</span>';
      if (platform === 'qwen') return '<span class="platform-tag platform-qwen">千问</span>';
      if (platform === 'minimax') return '<span class="platform-tag platform-minimax">MiniMax</span>';
      if (platform === 'stepfun') return '<span class="platform-tag platform-stepfun">阶跃星辰</span>';
      return '<span class="platform-tag platform-glm">智谱</span>';
    }

    function renderSpendRow(label, spent, limit, lastReset, periodMs) {
      var pct = limit > 0 ? Math.min(100, (spent / limit) * 100) : 0;
      var pctRound = pct.toFixed(1).replace(/\.0$/, '');
      var value = '$' + (+spent).toFixed(2) + ' / $' + (+limit).toFixed(2) + ' (' + pctRound + '%)';
      var nextReset = lastReset ? new Date(lastReset).getTime() + periodMs : null;
      var resetTxt = nextReset ? '重置 ' + formatTime(nextReset) : '';

      var theoPct = -1;
      if (lastReset) {
        var elapsed = Date.now() - new Date(lastReset).getTime();
        if (elapsed > 0) theoPct = Math.min(100, (elapsed / periodMs) * 100);
      }

      var html = '<div class="limit-row"><div class="limit-label"><span class="limit-name">' + label + '</span><span class="limit-value">' + value + '</span></div>';
      html += '<div class="limit-bar-wrap"><div class="limit-bar"><div class="limit-fill ' + getColorClass(pct) + '" style="width:' + pct + '%"></div></div>';
      if (theoPct >= 0) html += '<div class="theo-marker" style="left:' + theoPct + '%"></div>';
      html += '</div>';

      if (theoPct >= 0) {
        var ti = tensionInfo(pct, theoPct);
        html += '<div class="tension-row"><span style="color:' + ti.color + ';font-weight:500">' + ti.text + '</span><span style="color:var(--text-faint)">理论 ' + theoPct.toFixed(0) + '%</span></div>';
      }

      if (resetTxt) html += '<div style="font-size:11px;color:var(--text-faint);margin-top:2px">' + resetTxt + '</div>';
      html += '</div>';
      return html;
    }

    function renderVolcRow(label, bucket, periodMs, segments) {
      var quota = (bucket && bucket.Quota) || 0;
      var used = (bucket && bucket.Used) || 0;
      var pct = quota > 0 ? Math.min(100, (used / quota) * 100) : 0;
      var pctRound = pct.toFixed(1).replace(/\.0$/, '');
      var value = used.toFixed(2) + ' / ' + quota + ' (' + pctRound + '%)';
      var resetMs = bucket && bucket.ResetTime ? new Date(bucket.ResetTime).getTime() : 0;
      var resetTxt = resetMs ? '重置 ' + formatTime(resetMs) : '';

      var theoPct = -1;
      if (resetMs) {
        var periodStart = resetMs - periodMs;
        var elapsed = Date.now() - periodStart;
        if (elapsed > 0) theoPct = Math.min(100, (elapsed / periodMs) * 100);
      }

      var html = '<div class="limit-row"><div class="limit-label"><span class="limit-name">' + label + '</span><span class="limit-value">' + value + '</span></div>';

      if (segments && segments > 0) {
        var segPct = 100 / segments;
        var segHtml = '';
        for (var i = 0; i < segments; i++) {
          var segStart = i * segPct;
          var segEnd = (i + 1) * segPct;
          var fillW = 0;
          if (pct >= segEnd) fillW = 100;
          else if (pct > segStart) fillW = ((pct - segStart) / segPct) * 100;
          segHtml += '<div class="seg"><div class="seg-fill ' + getColorClass(pct) + '" style="width:' + fillW + '%"></div></div>';
        }
        html += '<div class="limit-bar-wrap"><div class="limit-bar-seg">' + segHtml + '</div>';
      } else {
        html += '<div class="limit-bar-wrap"><div class="limit-bar"><div class="limit-fill ' + getColorClass(pct) + '" style="width:' + pct + '%"></div></div>';
      }

      if (theoPct >= 0) html += '<div class="theo-marker" style="left:' + theoPct + '%"></div>';
      html += '</div>';

      if (theoPct >= 0) {
        var ti = tensionInfo(pct, theoPct);
        html += '<div class="tension-row"><span style="color:' + ti.color + ';font-weight:500">' + ti.text + '</span><span style="color:var(--text-faint)">理论 ' + theoPct.toFixed(0) + '%</span></div>';
      }

      if (resetTxt) html += '<div style="font-size:11px;color:var(--text-faint);margin-top:2px">' + resetTxt + '</div>';
      html += '</div>';
      return html;
    }

    function volcMaxPct(usage) {
      var u = usage || {};
      var buckets = [u.AFPFiveHour, u.AFPWeekly, u.AFPMonthly];
      var max = 0;
      buckets.forEach(function(b) {
        var q = (b && b.Quota) || 0;
        var used = (b && b.Used) || 0;
        if (q > 0) max = Math.max(max, Math.min(100, (used / q) * 100));
      });
      return max;
    }

    // 火山C（CodingPlan）用量：QuotaUsage 数组，每项 { Level, Percent(已是百分数，如 2.6 = 2.6%), ResetTimestamp(unix秒) }
    function volcCQuota(usage, level) {
      var arr = (usage && usage.QuotaUsage) || [];
      for (var i = 0; i < arr.length; i++) {
        if (arr[i] && arr[i].Level === level) return arr[i];
      }
      return null;
    }
    // 火山C「月度」窗口实际周期：订阅首月窗口 ≈ [StartTime, EndTime]，实际约 32 天而非 30 天。
    // 若仍按 30 天反推窗口起点，会让起点落在未来 → elapsed<0 → 理论进度线不显示。故优先用订阅实际周期。
    function volcCodingMonthlyPeriodMs(acc) {
      var sub = (acc && acc.data && acc.data.subscription) || null;
      if (sub && sub.StartTime && sub.EndTime) {
        var start = new Date(sub.StartTime).getTime();
        var end = new Date(sub.EndTime).getTime();
        if (end > start) return end - start;
      }
      return 30 * 86400000;
    }
    function volcCMaxPct(usage) {
      var arr = (usage && usage.QuotaUsage) || [];
      var max = 0;
      arr.forEach(function(q) {
        var p = (q && typeof q.Percent === 'number') ? q.Percent : 0;
        max = Math.max(max, Math.min(100, p));
      });
      return max;
    }
    function renderVolcCrow(label, item, periodMs, segments) {
      var realPct = (item && typeof item.Percent === 'number') ? item.Percent : 0;
      var pct = Math.min(100, realPct);                       // 进度条宽度/颜色钳制到 100
      var pctRound = realPct.toFixed(1).replace(/\.0$/, '');  // 文本显示真实值（CodingPlan 允许超额，可能 >100%）
      var value = '已用 ' + pctRound + '%';
      var resetMs = item && item.ResetTimestamp ? item.ResetTimestamp * 1000 : 0;
      var resetTxt = resetMs ? '重置 ' + formatTime(resetMs) : '';

      var theoPct = -1;
      if (resetMs) {
        var periodStart = resetMs - periodMs;
        var elapsed = Date.now() - periodStart;
        if (elapsed > 0) theoPct = Math.min(100, (elapsed / periodMs) * 100);
      }

      var html = '<div class="limit-row"><div class="limit-label"><span class="limit-name">' + label + '</span><span class="limit-value">' + value + '</span></div>';

      if (segments && segments > 0) {
        var segPct = 100 / segments;
        var segHtml = '';
        for (var i = 0; i < segments; i++) {
          var segStart = i * segPct;
          var segEnd = (i + 1) * segPct;
          var fillW = 0;
          if (pct >= segEnd) fillW = 100;
          else if (pct > segStart) fillW = ((pct - segStart) / segPct) * 100;
          segHtml += '<div class="seg"><div class="seg-fill ' + getColorClass(pct) + '" style="width:' + fillW + '%"></div></div>';
        }
        html += '<div class="limit-bar-wrap"><div class="limit-bar-seg">' + segHtml + '</div>';
      } else {
        html += '<div class="limit-bar-wrap"><div class="limit-bar"><div class="limit-fill ' + getColorClass(pct) + '" style="width:' + pct + '%"></div></div>';
      }

      if (theoPct >= 0) html += '<div class="theo-marker" style="left:' + theoPct + '%"></div>';
      html += '</div>';

      if (theoPct >= 0) {
        var ti = tensionInfo(realPct, theoPct);
        html += '<div class="tension-row"><span style="color:' + ti.color + ';font-weight:500">' + ti.text + '</span><span style="color:var(--text-faint)">理论 ' + theoPct.toFixed(0) + '%</span></div>';
      }

      if (resetTxt) html += '<div style="font-size:11px;color:var(--text-faint);margin-top:2px">' + resetTxt + '</div>';
      html += '</div>';
      return html;
    }

    function yescodeDailySpent(d) {
      var plan = d.subscription_plan || {};
      var quota = plan.daily_balance || 0;
      if (quota <= 0) return 0;
      return Math.max(0, quota - (d.subscription_balance || 0));
    }

    function yescodeMaxPct(d) {
      var plan = d.subscription_plan || {};
      var dq = plan.daily_balance || 0;
      var dPct = dq > 0 ? Math.min(100, (yescodeDailySpent(d) / dq) * 100) : 0;
      var w = plan.weekly_limit > 0 ? Math.min(100, ((d.current_week_spend || 0) / plan.weekly_limit) * 100) : 0;
      var m = plan.monthly_spend_limit > 0 ? Math.min(100, ((d.current_month_spend || 0) / plan.monthly_spend_limit) * 100) : 0;
      return Math.max(dPct, w, m);
    }

    // sub2api 数据解包:新形状 {me, subscriptions, current, stats};旧 huoli 缓存为裸数组。
    // 注意 current 可能为 null(过期超 3 天已隐藏)——仅在旧缓存缺 current 键时才回退 subs[0]
    function sub2apiUnpack(d) {
      if (Array.isArray(d)) return { me: null, subs: d, sub: d[0] || null, stats: null };
      d = d || {};
      var subs = d.subscriptions || [];
      var sub = ('current' in d) ? (d.current || null) : (subs[0] || null);
      return { me: d.me || null, subs: subs, sub: sub, stats: d.stats || null };
    }

    // fmtTokens 定义在 detail.js(线上生效版本:无 B 分支),跨文件共享

    function telecomMetrics(d, cachedAt) {
      d = d || {};
      var balance = +(d.balance || 0);
      var gift = +(d.platformGiftBalance || 0);
      var available = Math.max(0, balance + gift);
      var today = +(d.todayConsumption || 0);
      var yesterday = +(d.yesterdayConsumption || 0);
      var hasSevenDayStats = d.sevenDayConsumption != null;
      var sevenDays = +(hasSevenDayStats ? d.sevenDayConsumption
        : (d.thirtyDayConsumption != null ? d.thirtyDayConsumption : (d.timeRangeConsumption || 0)));
      var rangeDays = +(d.consumptionRangeDays != null ? d.consumptionRangeDays : (hasSevenDayStats ? 0 : 30));
      var avgDaily = d.averageDailyConsumption != null
        ? +(d.averageDailyConsumption || 0)
        : (rangeDays > 0 ? sevenDays / rangeDays : 0);
      var now = new Date(cachedAt || Date.now());
      var elapsedSeconds = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
      var dayFraction = Math.max(1 / 24, elapsedSeconds / 86400);
      var projectedToday = today > 0 ? today / dayFraction : 0;
      var dailyRate = projectedToday > 0 ? projectedToday : avgDaily;
      var averageLabel = hasSevenDayStats ? '7日均' : '历史日均';
      return {
        balance: balance,
        gift: gift,
        available: available,
        today: today,
        projectedToday: projectedToday,
        avgDaily: avgDaily,
        dailyRate: dailyRate,
        rateBasis: projectedToday > 0 ? '按今日折算' : '按' + averageLabel,
        remainingDays: dailyRate > 0 ? available / dailyRate : null,
        yesterday: yesterday,
        sevenDays: sevenDays,
        rangeDays: rangeDays,
        averageLabel: averageLabel,
        hasSevenDayStats: hasSevenDayStats
      };
    }

    function telecomDaysText(days) {
      if (days == null || !isFinite(days)) return '暂无消耗';
      if (days < 1) return '不足 1 天';
      if (days >= 1000) return '超过 999 天';
      return Math.floor(days) + ' 天';
    }

    function isTelecomAuthError(acc) {
      if (!acc || (acc.platform || 'glm') !== 'telecomjs' || acc.success) return false;
      return /认证失败|无法访问系统资源|satoken.*(?:失效|过期)|未返回余额|超时|网络错误|\b401\b/i.test(acc.error || '');
    }

    function telecomReloginButton(index) {
      return '<div class="telecom-relogin-actions"><button class="btn-primary" onclick="event.stopPropagation();openTelecomLogin(' + index + ')">重新登录</button></div>';
    }

    function cardSkeletonBody() {
      return '<div class="card-loading-body">'
        + '<div class="skel-line w100 h14"></div>'
        + '<div class="skel-line w80"></div>'
        + '<div class="skel-line w60"></div>'
        + '<div class="skel-line w100"></div></div>';
    }

    function isUsagePending(acc) {
      return !!(acc && (acc.loading || acc.pending) && !acc.success && !acc.error);
    }

    // 千问套餐规格 -> 展示名
    function qwenSpecName(code) {
      if (!code) return '-';
      var map = { standard: 'Standard套餐', lite: 'Lite套餐', pro: 'Pro套餐' };
      return map[code] || code;
    }
    // 千问订阅状态 -> 中文
    function qwenStatusText(status) {
      var map = { VALID: '生效中', EXPIRED: '已过期', CANCELLED: '已取消' };
      return map[status] || status || '-';
    }
    // 千问用量行：分段进度条 + 理论水位线 + tension + 重置时间（结构与智谱/火山一致）
    function qwenRow(label, pct, resetMs, periodMs, segments) {
      pct = Math.max(0, Math.min(100, pct || 0));
      var pctRound = pct.toFixed(1).replace(/\.0$/, '');
      var value = '已用 ' + pctRound + '%';
      var resetTxt = resetMs ? '重置 ' + formatTime(resetMs) : '';
      var theoPct = -1;
      if (resetMs) {
        var elapsed = Date.now() - (resetMs - periodMs);
        if (elapsed > 0) theoPct = Math.min(100, (elapsed / periodMs) * 100);
      }
      var html = '<div class="limit-row"><div class="limit-label"><span class="limit-name">' + label + '</span><span class="limit-value">' + value + '</span></div>';
      if (segments && segments > 0) {
        var segPct = 100 / segments;
        var segHtml = '';
        for (var i = 0; i < segments; i++) {
          var segStart = i * segPct, segEnd = (i + 1) * segPct, fillW = 0;
          if (pct >= segEnd) fillW = 100;
          else if (pct > segStart) fillW = ((pct - segStart) / segPct) * 100;
          segHtml += '<div class="seg"><div class="seg-fill ' + getColorClass(pct) + '" style="width:' + fillW + '%"></div></div>';
        }
        html += '<div class="limit-bar-wrap"><div class="limit-bar-seg">' + segHtml + '</div>';
      } else {
        html += '<div class="limit-bar-wrap"><div class="limit-bar"><div class="limit-fill ' + getColorClass(pct) + '" style="width:' + pct + '%"></div></div>';
      }
      if (theoPct >= 0) html += '<div class="theo-marker" style="left:' + theoPct + '%"></div>';
      html += '</div>';
      if (theoPct >= 0) {
        var ti = tensionInfo(pct, theoPct);
        html += '<div class="tension-row"><span style="color:' + ti.color + ';font-weight:500">' + ti.text + '</span><span style="color:var(--text-faint)">理论 ' + theoPct.toFixed(0) + '%</span></div>';
      }
      if (resetTxt) html += '<div style="font-size:11px;color:var(--text-faint);margin-top:2px">' + resetTxt + '</div>';
      html += '</div>';
      return html;
    }

    // MiniMax 用量窗口行:后端归一化为 usage.windows = [{label, usedPct 或 used+quota, resetMs, periodMs, segments?}]
    // 百分比窗口复用 qwenRow;计数窗口(如视频赠送 0/3)按 quota 等分(每段=1 次),颜色按整体用量百分比
    function minimaxWindowRow(w) {
      if (typeof w.usedPct === 'number') {
        return qwenRow(w.label, w.usedPct, w.resetMs, w.periodMs, w.segments || 0);
      }
      var used = w.used || 0, quota = w.quota || 0;
      var pct = quota > 0 ? Math.min(100, (used / quota) * 100) : 0;
      var html = '<div class="limit-row"><div class="limit-label"><span class="limit-name">' + esc(w.label || '') + '</span><span class="limit-value">' + used + '/' + quota + '已用</span></div>';
      if (quota > 0) {
        // 计数窗口按 quota 等分(视频赠送 quota=3 → 3 段),前 used 段填满
        var colorClass = getColorClass(pct);
        var segHtml = '';
        for (var i = 0; i < quota; i++) {
          var fillW = i < used ? 100 : 0;
          segHtml += '<div class="seg"><div class="seg-fill ' + colorClass + '" style="width:' + fillW + '%"></div></div>';
        }
        html += '<div class="limit-bar-wrap"><div class="limit-bar-seg">' + segHtml + '</div></div>';
      } else {
        html += '<div class="limit-bar-wrap"><div class="limit-bar"><div class="limit-fill ' + getColorClass(pct) + '" style="width:' + pct + '%"></div></div></div>';
      }
      if (w.resetMs) html += '<div style="font-size:11px;color:var(--text-faint);margin-top:2px">重置 ' + formatTime(w.resetMs) + '</div>';
      html += '</div>';
      return html;
    }
    function minimaxUsageRows(usage) {
      var ws = (usage && Array.isArray(usage.windows)) ? usage.windows : [];
      return ws.map(minimaxWindowRow).join('');
    }
    function minimaxMaxPct(usage) {
      var ws = (usage && Array.isArray(usage.windows)) ? usage.windows : [];
      if (!ws.length) return 0;
      return Math.max.apply(null, ws.map(function(w) {
        if (w.weightExcluded) return 0; // 视频赠送等赠送额度不参与紧张度
        return typeof w.usedPct === 'number' ? w.usedPct : (w.quota > 0 ? Math.min(100, ((w.used || 0) / w.quota) * 100) : 0);
      }));
    }

    // 阶跃 credit 大数缩写：>=1e8 → x.xx亿，>=1e4 → x.x万，否则原样（如 2930）
    function fmtStepfunCredits(v) {
      var n = Number(v) || 0;
      if (n >= 1e8) { var y = (n / 1e8).toFixed(2); return y.replace(/\.?0+$/, '') + '亿'; }
      if (n >= 1e4) { var w = (n / 1e4).toFixed(1); return w.replace(/\.0$/, '') + '万'; }
      return String(n);
    }

    // 阶跃「今日积分」行：今日（北京时间）消耗 credit + 调用次数；无数据返回空串
    function stepfunTodayRow(usage) {
      var t = usage && usage.today;
      if (!t || t.credits == null) return '';
      var calls = t.calls ? ' · ' + t.calls + '次' : '';
      // 阶跃官方按 Credits 计费,非真实 Token——用 title 说明口径
      return '<div class="limit-row" title="阶跃官方 Credits 计费口径，非真实 Token 用量"><div class="limit-label"><span class="limit-name">今日积分</span>'
        + '<span class="limit-value">' + esc(fmtStepfunCredits(t.credits)) + calls + '</span></div></div>';
    }

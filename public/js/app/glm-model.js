    // ============ GLM 高峰/工时模型 ============
    var GLM_PERIOD_5H_MS = 5 * 3600000;      // 5小时窗口长度
    var GLM_PERIOD_WEEK_MS = 7 * 86400000;   // 每周窗口长度(滚动7天)
    var GLM_BAR_SEGMENTS = 5;                // 5小时=5段;每周=5个工作日，每格20% → 也是5段
    var GLM_PEAK_START_HOUR = 14;            // 摘要提示:工作日北京时间 14:00–18:00
    var GLM_PEAK_END_HOUR = 18;
    var GLM_WORK_START_HOUR = 8;             // 水位线仅在 周一至周五 08:00–18:00 推进
    var GLM_WORK_END_HOUR = 18;
    var GLM_WORK_SCAN_DAYS = 10;             // 窗口≤7天,逐日扫描上限(含首尾余量)

    // 摘要时段按北京时间判断，不依赖浏览器时区，也不参与用量核算。
    function isGlmPeakNow(now) {
      var beijing = new Date((now || new Date()).getTime() + 8 * 3600000);
      var hour = beijing.getUTCHours(), dow = beijing.getUTCDay();
      return dow >= 1 && dow <= 5 && hour >= GLM_PEAK_START_HOUR && hour < GLM_PEAK_END_HOUR;
    }

    // GLM 套餐版本:含 CREDIT_LIMIT → 积分制新版(V3);否则 TOKENS_LIMIT 老版(v2)
    function glmPlanKind(limits) {
      return (limits || []).some(function(l) { return l && l.type === 'CREDIT_LIMIT'; }) ? 'credit' : 'token';
    }

    // [startMs,endMs] 内落在「周一~周五 08:00–18:00」(本地时间)的毫秒数
    function glmWorkMsBetween(startMs, endMs) {
      if (!(endMs > startMs)) return 0;
      var d0 = new Date(startMs);
      var total = 0;
      for (var i = 0; i < GLM_WORK_SCAN_DAYS; i++) {
        var midnight = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate() + i).getTime(); // DST 安全的次日零点
        if (midnight > endMs) break;
        var dow = new Date(midnight).getDay();
        if (dow < 1 || dow > 5) continue; // 周末不推进
        var wStart = midnight + GLM_WORK_START_HOUR * 3600000;
        var wEnd = midnight + GLM_WORK_END_HOUR * 3600000;
        total += Math.max(0, Math.min(endMs, wEnd) - Math.max(startMs, wStart));
      }
      return total;
    }

    // GLM 理论水位:仅在工作时段内均匀推进(不按高峰加权);按重置时刻倒推窗口
    function glmTheoPct(resetTimeMs, periodMs) {
      if (!resetTimeMs) return -1;
      var resetMs = new Date(resetTimeMs).getTime(); // 兼容 epoch 数字与 ISO 字符串
      if (isNaN(resetMs)) return -1;
      var startMs = resetMs - periodMs;
      var now = Date.now();
      if (now <= startMs) return -1; // 与现有行为一致:未到窗口不画水位线
      var totalWork = glmWorkMsBetween(startMs, resetMs);
      if (totalWork <= 0) return Math.min(100, ((Math.min(now, resetMs) - startMs) / periodMs) * 100); // 窗口整段不在工作时段 → 退回线性
      var doneWork = glmWorkMsBetween(startMs, Math.min(now, resetMs));
      return Math.max(0, Math.min(100, (doneWork / totalWork) * 100));
    }

    // 卡片只保留套餐版本；高峰提示统一放在调度摘要。
    function glmFooterBadges(acc) {
      var kind = glmPlanKind((acc && acc.data && acc.data.limits) || []);
      var planTip = kind === 'credit' ? 'V3 积分制套餐:高峰按 100% 消耗积分,低峰按 50% 消耗' : 'v2 套餐:高峰时段按 3 倍消耗';
      var planLabel = kind === 'credit' ? 'V3' : 'v2';
      return '<span class="plan-badge" title="" data-tooltip="' + esc(planTip) + '" aria-label="' + planLabel + '" tabindex="0">' + planLabel + '</span>';
    }


    function glmWeeklyDay(limit, day) {
      var midnight = Math.floor((Date.now() + 8 * 3600000) / 86400000) * 86400000 - 8 * 3600000;
      if (limit.unit !== 6 || !day || day.day !== midnight || !Number.isFinite(day.from) ||
          !Number.isFinite(day.since) || day.since < midnight || day.since >= midnight + 86400000 || !Number.isFinite(day.to) || day.from < 0 || day.to > 100 || day.from > day.to) return null;
      var time = new Date(day.since + 8 * 3600000).toISOString().slice(11, 16);
      var label = day.source === 'reset' ? '重置后' : day.source === 'midnight' ? '今日' : time + ' 起';
      var cells = +((day.to - day.from) / 20).toFixed(2);
      return { from: day.from, to: day.to, label: label + ' ' + cells + ' 格',
        tip: '本轮周额度，北京时间 ' + time + ' 起的用量，' + (+day.from.toFixed(1)) + '% → ' +
          (+day.to.toFixed(1)) + '%，共 ' + cells + ' 格。每格为周额度的 20%。' };
    }

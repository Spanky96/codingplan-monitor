// State tooltip: recover only when every exhausted quota window has reset.
function quotaStatusHint(acc, now) {
  now = now == null ? Date.now() : now;
  if (!acc || !acc.success) return '';
  var d = acc.data || {}, p = acc.platform || 'glm', windows = [];
  if (p === 'glm') {
    windows = (d.limits || []).filter(function(w) { return !w._unlimited && (w.unit === 3 || w.unit === 6); }).map(function(w) {
      return { used: Number(w.percentage), reset: w.nextResetTime, label: w.unit === 3 ? '5 小时' : '周' };
    });
  } else if (d.usage && Array.isArray(d.usage.windows)) {
    windows = d.usage.windows.filter(function(w) { return !w.weightExcluded; }).map(function(w) {
      return { used: w.usedPct == null ? w.used / w.quota * 100 : w.usedPct, reset: w.resetMs, label: w.label || '额度' };
    });
  } else if (p === 'qwen') {
    var q = d.usage || {};
    windows = [{ used: q.per5HourPercentage, reset: q.per5HourResetTime, label: '5 小时' }, { used: q.per1WeekPercentage, reset: q.per1WeekResetTime, label: '周' }];
  }
  var exhausted = windows.filter(function(w) { return w.used >= 99.9; });
  if (exhausted.length) {
    var resets = exhausted.map(function(w) { return new Date(w.reset).getTime(); });
    if (resets.some(function(t) { return !isFinite(t) || t <= 0; })) return '已耗尽，恢复时间待确认。';
    var remaining = Math.max.apply(null, resets) - now;
    if (remaining <= 0) return '已到重置时间，等待官方更新额度。';
    var hours = remaining / 3600000;
    var duration = hours >= 24 ? (hours / 24).toFixed(1).replace(/\.0$/, '') + ' 天' : hours >= 1 ? Math.ceil(hours) + ' 小时' : Math.ceil(hours * 60) + ' 分钟';
    return '已耗尽（' + exhausted.map(function(w) { return w.label; }).join('、') + '），预计 '
      + new Date(Math.max.apply(null, resets)).toLocaleString('zh-CN') + ' 自然恢复，约还需 ' + duration + '。\n使用重置卡可提前恢复。';
  }
  var r = acc.resetRecommendation;
  if (r && r.needed) {
    var days = r.unavailableHours / 24;
    return '周用量 ' + Math.round(r.weeklyPct) + '%（理论 ' + Math.round(r.theoPct) + '%），按当前速度预计提前耗尽，届时约 '
      + (days >= 1 ? days.toFixed(1).replace(/\.0$/, '') + ' 天' : Math.ceil(r.unavailableHours) + ' 小时') + ' 不可用。';
  }
  return windows.length ? windows.map(function(w) { return w.label + '已用 ' + Math.round(w.used) + '%'; }).join('，') + '。' : '';
}
function quotaStatusAttrs(acc) {
  var hint = quotaStatusHint(acc);
  return hint ? ' tabindex="0" title="" data-tooltip="' + esc(hint) + '" aria-label="' + esc(hint) + '"' : '';
}

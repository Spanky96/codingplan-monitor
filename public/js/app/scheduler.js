// Smart scheduling console. Editable policy stays separate from polling status.
var schedulerState = null;
var schedulerDraft = null;
var schedulerBusy = false;
var scheduleGroupedView = localStorage.getItem('usage_schedule_grouped') === 'true';
var SCHEDULE_MODES = { auto: '自动均衡', slow: '低速保护', burst: '高速消耗' };
function schedulerModeLabel(policy, row) {
  if (policy.role !== 'primary') return SCHEDULE_ROLES[policy.role] || '其他模型';
  if (row && row.effectiveMode === 'burst' && row.modeSource === 'automatic') return '自动高速';
  return SCHEDULE_MODES[policy.mode || 'auto'] || '自动均衡';
}
function scheduleGroupsEnabled() {
  return isAdmin() && FEATURES.relayEnabled && scheduleGroupedView;
}
function toggleScheduleView() {
  if (!isAdmin() || !FEATURES.relayEnabled) return;
  scheduleGroupedView = !scheduleGroupedView;
  localStorage.setItem('usage_schedule_grouped', String(scheduleGroupedView));
  scheduleCategoryFilter = 'all';
  renderSchedulerSummary();
  renderCards(accountsData);
}
var SCHEDULE_STATES = { balanced: '均衡分流', protecting: '5h 保护', draining: '到期优先', burn: '用卡加速',
  slow: '低速保护', burst: '高速消耗',
  cooldown: '限流降速', exhausted: '额度耗尽', standby: '待命', fallback: '兜底中', paused: '手动暂停',
  stale: '数据过期', unmapped: '未匹配渠道', missing: '账号变更', refreshing: '确认自然重置',
  'reset-verifying': '验证重置', starting: '准备中' };
SCHEDULE_STATES['upstream-blocked'] = '上游异常';
var SCHEDULE_ROLES = { primary: 'Coding Plan', paid: '按量付费', standard: '其他模型' };

async function schedulerRequest(path, method, body) {
  var r = await fetch(API_PREFIX + '/api/scheduler' + (path || ''), {
    method: method || 'GET', headers: authHeaders(), cache: 'no-store',
    body: body == null ? undefined : JSON.stringify(body)
  });
  var data = await r.json();
  if (!r.ok || data.error) throw new Error(data.error || '调度服务暂不可用');
  return data;
}
function schedulerRow(name) {
  return schedulerState && schedulerState.config.enabled && schedulerState.plan
    ? schedulerState.plan.rows.find(function(r) { return r.name === name; }) : null;
}
function schedulingBadge(name) {
  var r = schedulerRow(name);
  if (!isAdmin()) return '';
  var policy = schedulerState && schedulerState.config.enabled && schedulerState.config.accounts.find(function(p) { return p.name === name; });
  if (!policy) return '<span class="schedule-badge" title="沿用原权重策略；权重设为 0 可只监控">未托管</span>';
  var label = schedulerModeLabel(policy, r);
  var state = r ? SCHEDULE_STATES[r.state] || r.state : '准备中';
  if (state !== label && !(r && (r.state === 'balanced' || r.state === 'burst'))) label += ' · ' + state;
  return '<span class="schedule-badge ' + (r && r.weight > 0 ? 'live' : '') + '" data-tooltip="' + esc(r ? r.reasons.join('；') : '等待首轮调度计划') + '">'
    + (scheduleGroupsEnabled() && r && r.weight > 0 ? '#' + r.priority + ' ' : '') + esc(label) + '</span>';
}
function schedulerName(name) {
  var a = accountsData.find(function(a) { return a.name === name; });
  return a ? displayName(a, a.index) : (_privacyMode ? '托管账号' : name);
}
function schedulerFallbackStatus(kind) {
  var c = schedulerState.config;
  var allowed = kind === 'paid' ? c.allowPaid : c.allowDilution;
  var actual = schedulerState.appliedFallback;
  var known = actual && Date.now() - schedulerState.observedAt < 90000;
  if (known && actual[kind]) return { label: '已启用', active: true, tip: '中转站已启用' + (allowed ? '' : '；当前配置未允许，请核对渠道') };
  if (!known) return { label: allowed ? '已允许 · 待确认' : '未允许 · 待确认', tip: '中转站状态尚未确认' };
  return { label: allowed ? '待命' : '未允许', tip: allowed ? '已允许，当前未触发兜底' : '未允许自动启用' };
}
function schedulerTokenForecastHTML(now) {
  var end = Math.floor((now + 8 * 3600000) / 86400000) * 86400000 + 10 * 3600000;
  if (now >= end) return '';
  var f = schedulerState.tokenForecast;
  var fresh = f && f.until === end && now - f.sampledAt < 300000;
  var known = fresh && f.covered > 0 && Number.isFinite(f.tokens);
  var label = '18:00 前预计可用 Token';
  var tip = '北京时间。按近期中转 Token 与各账号官方 5 小时、周额度的实际消耗估算，计入自然恢复，按近期吞吐折算到 18:00。未计入尚未使用的重置卡。';
  if (fresh) tip += ' 覆盖 ' + f.covered + '/' + f.total + ' 个 Coding Plan，其中 ' + f.byTier + ' 个参考同版本同档套餐。';
  var value = known ? '约 ' + fmtTokensMB(f.tokens) : '待采样';
  if (fresh && f.covered < f.total) label += ' · ' + f.covered + '/' + f.total;
  return '<div tabindex="0" data-tooltip="' + esc(tip) + '"><strong>' + value + '</strong><small>' + label + '</small></div>';
}
function schedulerSummaryHTML(showPeak) {
  if (!schedulerState) return '';
  var p = schedulerState.plan, c = schedulerState.config, s = p && p.summary;
  var fresh = p && Date.now() - p.generatedAt < 180000;
  var paid = schedulerFallbackStatus('paid'), dilution = schedulerFallbackStatus('dilution');
  var cards = schedulerState.resetCards;
  var inventoryKnown = cards && cards.checkedAccounts > 0;
  var cardTip = inventoryKnown ? '周卡 ' + cards.week + ' 张 · 5h 卡 ' + cards.fiveHour + ' 张；已记录 ' + cards.checkedAccounts + '/' + cards.accounts + ' 个账号，有效期内库存，含未授权使用的卡' : '尚未读取卡库存';
  if (inventoryKnown && cards.oldestCheckedAt) cardTip += '；最早采样 ' + new Date(cards.oldestCheckedAt).toLocaleString('zh-CN');
  var synced = schedulerState.lastPush && schedulerState.lastPush.synced && Date.now() - schedulerState.lastPush.at < 90000;
  var label = !c.enabled ? '尚未启动' : !fresh ? '等待计划更新' : !synced ? '等待中转站确认' : '正在托管';
  return '<div class="schedule-heading"><span class="schedule-orbit ' + (c.enabled && fresh && synced ? 'on' : '') + '"></span><div><b>智能调度</b><small>' + label + '</small></div>'
    + (showPeak && isGlmPeakNow(new Date()) ? '<span class="schedule-peak">智谱高峰</span>' : '') + '</div>'
    + '<div class="schedule-metrics"><div><strong>' + (c.enabled && s ? s.active : '—') + '</strong><small>参与调度</small></div>'
    + '<div><strong>' + (c.enabled && s ? s.capacity : '—') + '</strong><small>总并发预算</small></div>'
    + '<div data-tooltip="' + esc(cardTip) + '"><strong>' + (inventoryKnown ? cards.total : '—') + '</strong><small>重置卡总数' + (inventoryKnown && cards.checkedAccounts < cards.accounts ? ' · 已记录' : '') + '</small></div>'
    + (showPeak ? schedulerTokenForecastHTML(Date.now()) : '')
    + '<div class="' + (paid.active ? 'schedule-alert' : '') + '" title="' + esc(paid.tip) + '"><strong>' + paid.label + '</strong><small>按量付费</small></div>'
    + '<div class="' + (dilution.active ? 'schedule-alert' : '') + '" title="' + esc(dilution.tip) + '"><strong>' + dilution.label + '</strong><small>备用分流</small></div></div>';
}
function renderSchedulerSummary() {
  var btn = document.getElementById('schedulerBtn'), bar = document.getElementById('schedulerSummary');
  if (btn) btn.style.display = isAdmin() && FEATURES.relayEnabled ? '' : 'none';
  var view = document.getElementById('scheduleViewControls'), toggle = document.getElementById('scheduleViewToggle');
  if (view) view.style.display = isAdmin() && FEATURES.relayEnabled ? '' : 'none';
  if (toggle) {
    toggle.classList.toggle('active', !!scheduleGroupsEnabled());
    toggle.setAttribute('aria-pressed', String(!!scheduleGroupsEnabled()));
    toggle.title = scheduleGroupsEnabled() ? '返回全部账号通铺' : '按调度模式分类查看';
  }
  if (!bar) return;
  bar.style.display = scheduleGroupsEnabled() && schedulerState ? '' : 'none';
  bar.innerHTML = schedulerSummaryHTML(true);
  var live = document.getElementById('schedulerLiveSummary');
  if (live) live.innerHTML = schedulerSummaryHTML();
}
async function loadScheduler() {
  renderSchedulerSummary();
  if (!isAdmin() || !FEATURES.relayEnabled) return;
  try {
    schedulerState = await schedulerRequest();
    capacityFromScheduler(schedulerState);
    renderSchedulerSummary();
    if (accountsData.length) renderCards(accountsData);
    if (document.getElementById('schedulerOverlay').classList.contains('active')) renderSchedulerDecisions();
  } catch (_) { /* retain last status; expiry is visible */ }
}
async function openScheduler(focusName) {
  if (!isAdmin()) { requireAuth(function() { openScheduler(focusName); }); return; }
  var overlay = document.getElementById('schedulerOverlay');
  overlay.classList.add('active');
  document.getElementById('schedulerBody').innerHTML = '<div class="schedule-empty">正在读取调度配置…</div>';
  try {
    schedulerState = await schedulerRequest();
    schedulerDraft = JSON.parse(JSON.stringify(schedulerState.config));
    renderSchedulerForm();
    renderSchedulerSummary();
    if (focusName) {
      var at = schedulerState.candidates.findIndex(function(a) { return a.name === focusName; });
      var el = document.getElementById('schedule-account-' + at);
      if (el) { el.scrollIntoView({ block: 'center' }); el.classList.add('highlight'); }
    }
    // Read-only connection check; never applies settings or spends a card.
    schedulerRequest('/preview', 'POST').then(function(data) {
      schedulerState = data; renderSchedulerSummary(); renderSchedulerDecisions();
    }).catch(function(e) { schedulerFeedback(e.message); });
  } catch (e) { document.getElementById('schedulerBody').innerHTML = '<div class="schedule-empty">' + esc(e.message) + '</div>'; }
}
function schedulerDefaultRole(a) {
  return a.platform === 'telecomjs' || /智云/.test(a.name) ? 'paid' : (a.platform || 'glm') === 'glm' ? 'primary' : 'standard';
}
function schedulerLocalTime(iso) {
  var date = new Date(iso);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0,16);
}
function schedulerPolicy(a) {
  var p = schedulerDraft.accounts.find(function(p) { return p.name === a.name; }) || {
    name: a.name, role: schedulerDefaultRole(a), maxConcurrency: schedulerDefaultRole(a) === 'primary' ? 4 : Math.min(64, Math.max(2, a.capacity ? a.capacity.capacity : 4)),
    quotaScale: 1, mode: 'auto', autoReset: true, paused: false, unmetered: false
  };
  if (p.role === 'dilution') p.role = 'standard';
  if (!p.channelModes) {
    p.channelModes = {};
    (a.channels || []).forEach(function(ch) { p.channelModes[ch.id] = p.role === 'standard' ? (ch.suggestedMode || 'native') : 'native'; });
  }
  return p;
}
function schedulerChannelRows(a, p, i) {
  if (!(a.channels || []).length) return '';
  return '<details class="schedule-channels"><summary>渠道用途 · ' + a.channels.length + '</summary>' + a.channels.map(function(ch) {
    var mode = p.channelModes[ch.id] || 'paused';
    return '<label><span title="' + esc(_privacyMode ? '渠道 ' + ch.id : ch.name) + '">' + esc(_privacyMode ? '渠道 ' + ch.id : ch.name)
      + '</span><select aria-label="渠道 ' + ch.id + ' 用途" onchange="schedulerChannel(' + i + ',' + ch.id + ',this.value)">'
      + [['native','直接调用'],['fallback','备用分流'],['paused','暂停']].map(function(x) {
        return '<option value="' + x[0] + '"' + (mode === x[0] ? ' selected' : '') + '>' + x[1] + '</option>';
      }).join('') + '</select></label>';
  }).join('') + '</details>';
}
function schedulerChannel(i, id, value) {
  var p = schedulerPolicy(schedulerState.candidates[i]); p.channelModes[id] = value;
  schedulerField(i, 'channelModes', p.channelModes);
}
function renderSchedulerForm() {
  var c = schedulerDraft;
  var rows = schedulerState.candidates.map(function(a, i) {
    var p = schedulerPolicy(a), selected = c.accounts.some(function(p) { return p.name === a.name; });
    return '<div class="schedule-account ' + (selected ? 'selected' : '') + '" id="schedule-account-' + i + '">'
      + '<div class="schedule-account-title"><label><input type="checkbox" id="sa-pick-' + i + '" ' + (selected ? 'checked' : '') + ' onchange="schedulerPick(' + i + ',this.checked)"><b>' + esc(schedulerName(a.name)) + '</b></label><span>' + (selected ? '已选择' : '未托管 · 原权重') + '</span></div>'
      + '<div class="schedule-account-fields"><label>用途<select id="sa-role-' + i + '" onchange="schedulerField(' + i + ',\'role\',this.value)">'
      + Object.keys(SCHEDULE_ROLES).filter(function(role) { return role === 'paid' || (role === 'primary' && a.platform === 'glm') || role === 'standard'; }).map(function(role) {
        return '<option value="' + role + '"' + (p.role === role ? ' selected' : '') + '>' + SCHEDULE_ROLES[role] + '</option>';
      }).join('') + '</select></label>'
      + '<label>调度模式<select onchange="schedulerField(' + i + ',\'mode\',this.value)">' + [['auto','自动决策'],['slow','低速保护'],['burst','手动高速']].map(function(m) { return '<option value="' + m[0] + '"' + ((p.mode || 'auto') === m[0] ? ' selected' : '') + '>' + m[1] + '</option>'; }).join('') + '</select></label>'
      + '<label title="' + (p.role === 'primary' ? '智谱总并发最多 4；算法可在此上限内升降' : '同一账号所有渠道共享上限') + '">并发上限<input id="sa-cap-' + i + '" type="number" min="1" max="' + (p.role === 'primary' ? 4 : 64) + '" value="' + Math.min(p.maxConcurrency, p.role === 'primary' ? 4 : 64) + '" onchange="schedulerField(' + i + ',\'maxConcurrency\',Number(this.value))"></label>'
      + '<label title="套餐容量相对于其他账号的比例；同套餐保持 1">容量系数<input type="number" min="0.1" max="20" step="0.1" value="' + p.quotaScale + '" onchange="schedulerField(' + i + ',\'quotaScale\',Number(this.value))"></label></div>'
      + '<div class="schedule-account-options">'
      + (a.platform === 'glm' && !a.teamEdition && p.role === 'primary' ? '<label title="勾选后禁止用卡。未勾选时，调度可优先给此账号分流，额度耗尽后再评估用卡。低速模式暂停自动用卡。"><input type="checkbox" ' + (!p.autoReset ? 'checked' : '') + ' onchange="schedulerField(' + i + ',\'autoReset\',!this.checked)">不使用重置卡 <span>' + (p.mode === 'slow' ? '低速暂缓 · ' : '') + a.cards + ' 张</span></label>' : '')
      + '<label><input type="checkbox" ' + (p.paused ? 'checked' : '') + ' onchange="schedulerField(' + i + ',\'paused\',this.checked)">暂停此账号</label>'
      + (p.role === 'paid' ? '<label title="无法获取余额的占位账号需显式允许才可兜底"><input type="checkbox" ' + (p.unmetered ? 'checked' : '') + ' onchange="schedulerField(' + i + ',\'unmetered\',this.checked)">允许无余额数据的按量占位</label>' : '') + '</div>'
      + schedulerChannelRows(a, p, i)
      + '<details class="schedule-more"><summary>更多设置</summary><label class="schedule-replenish">预计额度补充<input type="datetime-local" value="' + (p.replenishAt ? schedulerLocalTime(p.replenishAt) : '') + '" onchange="schedulerField(' + i + ',\'replenishAt\',this.value ? new Date(this.value).toISOString() : null)"></label></details></div>';
  }).join('');
  document.getElementById('schedulerBody').innerHTML = ''
    + '<div class="schedule-live" id="schedulerLiveSummary">' + schedulerSummaryHTML() + '</div>'
    + '<div class="schedule-console"><section class="schedule-config"><div class="schedule-section-head"><h4>参与账号</h4><button class="schedule-link" onclick="schedulerSelectAll()">全选</button></div>'
    + '<div class="schedule-accounts">' + rows + '</div>'
    + '<div class="schedule-guards"><h4>备用策略</h4><label><input id="schedulePaid" type="checkbox" ' + (c.allowPaid ? 'checked' : '') + ' onchange="schedulerDraft.allowPaid=this.checked">允许按量付费兜底</label>'
    + '<label><input id="scheduleDilution" type="checkbox" ' + (c.allowDilution ? 'checked' : '') + ' onchange="schedulerDraft.allowDilution=this.checked">允许备用分流</label>'
    + '<label>兜底时机<select class="schedule-budget" style="width:auto" onchange="schedulerDraft.fallbackWhen=this.value"><option value="exhausted"' + (c.fallbackWhen !== 'pressure' ? ' selected' : '') + '>主力全部不可用时</option><option value="pressure"' + (c.fallbackWhen === 'pressure' ? ' selected' : '') + '>主力额度紧张时，小比例分流</option></select></label>'
    + '</div></section>'
    + '<section class="schedule-decisions"><div class="schedule-section-head"><h4>调度顺序</h4><span id="schedulePlanTime"></span></div><div id="scheduleDecisionRows"></div>'
    + '<div class="schedule-section-head"><h4>最近记录</h4></div><div id="scheduleEvents"></div></section></div>'
    + '<div class="schedule-notice" id="schedulerFeedback" role="status"></div>'
    + '<div class="schedule-footer"><span id="scheduleFooterHint">每 30 秒更新</span><div>'
    + (c.enabled ? '<button class="btn-default" onclick="saveScheduler(false)">停止托管</button>' : '<button class="btn-default" onclick="saveScheduler(false)">保存配置</button>')
    + '<button class="btn-primary" onclick="saveScheduler(true)">' + (c.enabled ? '应用调整' : '保存并启动') + '</button></div></div>';
  renderSchedulerDecisions();
}
function schedulerPick(i, checked) {
  var a = schedulerState.candidates[i], p = schedulerPolicy(a);
  schedulerDraft.accounts = schedulerDraft.accounts.filter(function(p) { return p.name !== a.name; });
  if (checked) schedulerDraft.accounts.push(p);
  document.getElementById('schedule-account-' + i).classList.toggle('selected', checked);
  document.querySelector('#schedule-account-' + i + ' .schedule-account-title>span').textContent = checked ? '已选择' : '未托管 · 原权重';
}
function schedulerField(i, field, value) {
  var a = schedulerState.candidates[i], p = schedulerPolicy(a);
  p[field] = value;
  if (!schedulerDraft.accounts.some(function(x) { return x.name === a.name; })) {
    schedulerDraft.accounts.push(p);
    document.getElementById('sa-pick-' + i).checked = true;
    document.getElementById('schedule-account-' + i).classList.add('selected');
    document.querySelector('#schedule-account-' + i + ' .schedule-account-title>span').textContent = '已选择';
  }
  if (field === 'role' || field === 'mode') {
    var top = document.querySelector('.schedule-accounts').scrollTop;
    renderSchedulerForm();
    document.querySelector('.schedule-accounts').scrollTop = top;
  }
}
function schedulerSelectAll() {
  schedulerState.candidates.forEach(function(a, i) {
    var el = document.getElementById('sa-pick-' + i);
    if (el) { el.checked = true; schedulerPick(i, true); }
  });
}
function schedulerFeedback(text, ok) {
  var el = document.getElementById('schedulerFeedback');
  if (el) { el.textContent = text; el.classList.toggle('success', !!ok); el.style.display = text ? 'block' : 'none'; }
}
async function saveScheduler(enabled) {
  if (schedulerBusy) return;
  schedulerBusy = true;
  document.querySelectorAll('#schedulerBody button').forEach(function(b) { b.disabled = true; });
  schedulerFeedback('正在保存并同步到中转站…', true);
  try {
    schedulerDraft.enabled = enabled;
    schedulerState = await schedulerRequest('', 'PUT', schedulerDraft);
    schedulerDraft = JSON.parse(JSON.stringify(schedulerState.config));
    renderSchedulerForm(); renderSchedulerSummary(); loadWeights(); loadCapacity();
    schedulerFeedback(schedulerState.lastPush && schedulerState.lastPush.synced ? '配置已保存，中转站已确认同步。' : '配置已保存。' + ((schedulerState.lastPush || {}).message || '等待中转站同步。'), true);
  } catch (e) { schedulerFeedback(e.message); }
  finally { schedulerBusy = false; document.querySelectorAll('#schedulerBody button').forEach(function(b) { b.disabled = false; }); }
}
function renderSchedulerDecisions() {
  var box = document.getElementById('scheduleDecisionRows');
  if (!box || !schedulerState) return;
  var plan = schedulerState.plan;
  document.getElementById('schedulePlanTime').textContent = plan ? timeAgo(plan.generatedAt) : '尚无计划';
  box.innerHTML = plan && plan.rows.length ? plan.rows.map(function(r) {
    return '<div class="schedule-decision ' + (r.weight ? '' : 'idle') + '"><span class="schedule-rank">' + String(r.priority).padStart(2, '0') + '</span><div class="schedule-decision-main"><div><b>'
      + esc(schedulerName(r.name)) + '</b><span class="schedule-state">' + esc(r.state === 'burst' && r.modeSource === 'automatic' ? '自动高速' : SCHEDULE_STATES[r.state] || r.state) + '</span></div><p>' + esc(r.reasons.join('；')) + '</p>'
      + '<div class="schedule-allocation"><i style="width:' + Math.max(0, Math.min(100, r.share)) + '%"></i></div><small>目标份额 ' + r.share + '% · 并发 ' + r.concurrency + '/' + r.maxConcurrency
      + (r.shortUsed == null ? '' : ' · 5h 已用 ' + Math.round(r.shortUsed) + '%') + (r.weeklyUsed == null ? '' : ' · 周已用 ' + Math.round(r.weeklyUsed) + '%')
      + (r.quotaLink ? ' · 一轮 5h ≈ ' + Math.round(r.quotaLink.shortToWeekRatio * 100) + '% 周额度' : '')
      + '</small></div><div class="schedule-weight"><strong>' + r.weight.toFixed(1) + '</strong><small>权重</small></div></div>';
  }).join('') : '<div class="schedule-empty">尚无调度计划</div>';

  var error = schedulerState.integrationError || (schedulerState.lastPush && !schedulerState.lastPush.synced ? schedulerState.lastPush.message : '');
  if (error) box.innerHTML += '<p class="schedule-warn">' + esc(error) + '</p>';
  document.getElementById('scheduleEvents').innerHTML = schedulerState.events.slice(0, 12).map(function(e) {
    return '<div class="schedule-event"><time>' + formatTime(e.at) + '</time><span>' + esc(_privacyMode ? e.type : e.message) + '</span></div>';
  }).join('') || '<div class="schedule-help">暂时没有操作记录</div>';
}
setInterval(function() { if (!document.hidden) loadScheduler(); }, 30000);

var scheduleCategoryFilter = 'all';
var SCHEDULE_CATEGORIES = { burst: '高速消耗', balanced: '均衡调度', slow: '低速保护', exhausted: '已耗尽', paid: '按量付费', minimax: 'MiniMax', reserve: '备用分流', other: '其他账号' };
function scheduleCategory(acc) {
  var p = schedulerState && schedulerState.config.accounts.find(function(p) { return p.name === acc.name; });
  var role = p ? p.role : schedulerDefaultRole(acc);
  if (role === 'paid') return 'paid';
  if (acc.platform === 'minimax') return 'minimax';
  if (p && p.channelModes && Object.values(p.channelModes).length && Object.values(p.channelModes).every(function(m) { return m !== 'native'; })) return 'reserve';
  if (getAccMaxPct(acc) >= 100) return 'exhausted';
  var r = schedulerRow(acc.name);
  if ((p && p.mode === 'slow') || (r && r.effectiveMode === 'slow')) return 'slow';
  if ((p && p.mode === 'burst') || (r && r.effectiveMode === 'burst')) return 'burst';
  return (acc.platform || 'glm') === 'glm' ? 'balanced' : 'other';
}
function setScheduleCategory(key) {
  scheduleCategoryFilter = key;
  renderCards(accountsData);
}
function filterScheduleCategories(list) {
  var box = document.getElementById('scheduleCategories');
  if (!box) return list;
  var show = scheduleGroupsEnabled();
  box.style.display = show ? '' : 'none';
  if (!show) return list;
  var counts = {};
  list.forEach(function(x) { var key = scheduleCategory(x.acc); counts[key] = (counts[key] || 0) + 1; });
  box.innerHTML = ['all'].concat(Object.keys(SCHEDULE_CATEGORIES)).map(function(key) {
    return '<button class="schedule-category ' + (scheduleCategoryFilter === key ? 'active' : '') + '" aria-pressed="' + (scheduleCategoryFilter === key) + '" onclick="setScheduleCategory(\'' + key + '\')">'
      + (key === 'all' ? '全部模式' : SCHEDULE_CATEGORIES[key]) + '<span>' + (key === 'all' ? list.length : counts[key] || 0) + '</span></button>';
  }).join('');
  return scheduleCategoryFilter === 'all' ? list : list.filter(function(x) { return scheduleCategory(x.acc) === scheduleCategoryFilter; });
}
function renderScheduleGroups(grid, list, isList) {
  if (!scheduleGroupsEnabled()) return false;
  grid.innerHTML = Object.keys(SCHEDULE_CATEGORIES).map(function(key) {
    var group = list.filter(function(x) { return scheduleCategory(x.acc) === key; });
    if (!group.length) return '';
    var hint = key === 'paid' || key === 'reserve' ? schedulerFallbackStatus(key === 'paid' ? 'paid' : 'dilution').label : group.length + ' 个账号';
    return '<div class="schedule-group-title category-' + key + '"><span></span><h3>' + SCHEDULE_CATEGORIES[key] + '</h3><small>' + hint + '</small></div>'
      + group.map(function(x) { return isList ? renderListRowHTML(x.origIdx, x.acc) : renderCardHTML(x.origIdx, x.acc); }).join('');
  }).join('');
  return true;
}

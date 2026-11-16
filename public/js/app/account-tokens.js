// Relay-recorded daily tokens. This never estimates official Coding Plan usage.
var accountTokenData = null, accountTokenError = false, accountTokenMap = {};
var accountTokenRequest = 0;

function aggregateAccountTokens(rows, names) {
  var result = Object.create(null);
  names = names.slice().sort(function(a, b) { return b.length - a.length; });
  (rows || []).forEach(function(row) {
    var name = names.find(function(n) { return typeof row.account_name === 'string' && row.account_name.indexOf(n) === 0; });
    if (!name || !Number.isFinite(row.total_tokens) || row.total_tokens < 0) return;
    var item = result[name] || (result[name] = { total: 0, models: Object.create(null) });
    var model = row.model || '未知模型';
    item.total += row.total_tokens;
    item.models[model] = (item.models[model] || 0) + row.total_tokens;
  });
  return result;
}
function rebuildAccountTokens() {
  accountTokenMap = aggregateAccountTokens(accountTokenData && accountTokenData.rows,
    accountsData.filter(function(a) { return a && a.name; }).map(function(a) { return a.name; }));
}
function accountTokenBadgeHTML(name) {
  if (!isAdmin() || !FEATURES.relayEnabled) return '';
  var item = accountTokenMap[name];
  if (!item && !capacityMap[name]) return '';
  var today = accountTokenData && Date.now() >= Date.parse(accountTokenData.day_start) && Date.now() < Date.parse(accountTokenData.day_end);
  var text = '—', tip = '今日Token ' + (accountTokenError ? '暂时无法读取' : '正在读取');
  if (today) {
    item = item || { total: 0, models: {} };
    text = fmtTokensMB(item.total);
    var models = Object.keys(item.models).sort(function(a, b) { return item.models[b] - item.models[a] || a.localeCompare(b); });
    tip = models.length === 1 ? '今日Token ' + models[0] + ' ' + fmtTokensMB(item.models[models[0]])
      : '今日Token' + (models.length ? '\n' + models.map(function(m) { return m + ' ' + fmtTokensMB(item.models[m]); }).join('\n') : ' 0');
    if (accountTokenError) tip += '\n刷新失败，显示最近一次统计';
  }
  return '<span class="account-token' + (accountTokenError ? ' stale' : '') + '" tabindex="0" data-tooltip="' + esc(tip) + '">' + text + '</span>';
}
function loadAccountTokens(force) {
  var requestId = ++accountTokenRequest, password = localStorage.getItem('glm_pwd');
  if (!password || !FEATURES.relayEnabled) { accountTokenData = null; accountTokenMap = {}; return; }
  return fetch(API_PREFIX + '/api/relay/account-tokens' + (force ? '?force=1' : ''), { headers: authHeaders(), cache: 'no-store' })
    .then(function(r) { if (!r.ok) throw new Error('Token statistics unavailable'); return r.json(); })
    .then(function(data) {
      if (requestId !== accountTokenRequest || password !== localStorage.getItem('glm_pwd')) return;
      if (!data || !Array.isArray(data.rows) || !Number.isFinite(Date.parse(data.day_start)) || !Number.isFinite(Date.parse(data.day_end))) throw new Error('Invalid token statistics');
      accountTokenData = data; accountTokenError = false; rebuildAccountTokens();
      if (accountsData.length) renderCards(accountsData);
    }).catch(function() {
      if (requestId !== accountTokenRequest || password !== localStorage.getItem('glm_pwd')) return;
      accountTokenError = true;
      if (accountsData.length) renderCards(accountsData);
    });
}

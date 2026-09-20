// ============ 全局状态与通用工具 ============
// 本文件(及后续 app/*.js)以普通 <script> 标签按序加载,函数声明进全局作用域,
// 供 HTML 内联 onclick 与跨文件调用(与拆分前单文件行为一致)。

    var accountsData = [];
    var expireData = [];
    var weightsMap = {};        // name → 最终权重(管理员,卡片左上角徽标)
    var weightsDetail = {};     // name → 明细(base/strategy/configValue/defaultWeight)
    var capacityMap = {};       // name → {current,total,items[]} sub2api 容量聚合(按权重键)
    var activityDispatchData = null;  // 中转站调度快照(占用/排队 + 近跑模型,15s 轮询)
    var activityUsageData = null;     // 中转站今日用量榜单(站内+外部+模型明细,5min 轮询)
    var _activityDispatchError = false;   // 最近一次调度快照拉取失败(保留旧数据)
    var _activityUsageError = false;      // 最近一次榜单拉取失败
    var _activityRankExpanded = false;   // 今日 Token 排行是否展开全部
    var _activityCollapsed = localStorage.getItem('usage_activity_collapsed') === 'true';
    var _weightEditIndex = -1;
    var _weightEditName = null;
    var UNIT_LABELS = { 3: '每5小时', 5: 'MCP月额度', 6: '每周' };
    var _pendingAuth = null;
    var _detailIndex = -1;
    var _chartPeriod = {};      // idx → 当前图表口径(today/7d/30d),主题切换重绘用
    var _filterPlatform = 'all';
    var _sortMode = 'default';
    var _privacyMode = localStorage.getItem('usage_privacy') === 'true';
    var _viewMode = localStorage.getItem('usage_view') === 'list' ? 'list' : 'block';
    var _telecomLoginSessionId = null;
    var _telecomLoginIndex = -1;
    var _telecomLoginPollTimer = null;
    var _telecomQrTimer = null;
    var _telecomQrObjectUrl = null;
    var _telecomLoginGeneration = 0;
    var _telecomQrLoading = false;
    var _telecomLoginHandled = false;

    // ============ Privacy Mode ============
    (function() {
      var btn = document.getElementById('privacyToggle');
      function syncIcon() {
        document.getElementById('eyeIcon').style.display = _privacyMode ? 'none' : '';
        document.getElementById('eyeOffIcon').style.display = _privacyMode ? '' : 'none';
        btn.classList.toggle('active', _privacyMode);
      }
      syncIcon();
      btn.addEventListener('click', function() {
        _privacyMode = !_privacyMode;
        localStorage.setItem('usage_privacy', _privacyMode);
        syncIcon();
        if (accountsData.length) renderCards(accountsData);
        if (_detailIndex >= 0 && document.getElementById('modalOverlay').classList.contains('active')) {
          var acc = accAt(_detailIndex);
          if (acc) document.getElementById('modalTitle').textContent = displayName(acc, _detailIndex);
        }
      });
    })();

    function esc(s) { return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

    // 卡片会裁剪内部内容，因此徽章说明统一渲染到 body 层的浮层中。
    (function initBadgeTooltip() {
      var tooltip = document.getElementById('badgeTooltip');
      var activeTarget = null;

      function positionTooltip(target) {
        var targetRect = target.getBoundingClientRect();
        var tooltipRect = tooltip.getBoundingClientRect();
        var gap = 7;
        var left = targetRect.left + (targetRect.width - tooltipRect.width) / 2;
        left = Math.max(8, Math.min(left, window.innerWidth - tooltipRect.width - 8));
        var top = targetRect.top - tooltipRect.height - gap;
        if (top < 8) top = targetRect.bottom + gap;
        tooltip.style.left = Math.round(left) + 'px';
        tooltip.style.top = Math.round(top) + 'px';
      }

      function showTooltip(target) {
        var text = target && target.getAttribute('data-tooltip');
        if (!text) return;
        activeTarget = target;
        tooltip.textContent = text;
        tooltip.classList.add('visible');
        positionTooltip(target);
      }

      function hideTooltip() {
        activeTarget = null;
        tooltip.classList.remove('visible');
      }

      document.addEventListener('mouseover', function(e) {
        var target = e.target.closest('[data-tooltip]');
        if (target && !target.contains(e.relatedTarget)) showTooltip(target);
      });
      document.addEventListener('mouseout', function(e) {
        var target = e.target.closest('[data-tooltip]');
        if (target && !target.contains(e.relatedTarget)) hideTooltip();
      });
      document.addEventListener('focusin', function(e) {
        var target = e.target.closest('[data-tooltip]');
        if (target) showTooltip(target);
      });
      document.addEventListener('focusout', function(e) {
        if (e.target.closest('[data-tooltip]')) hideTooltip();
      });
      window.addEventListener('resize', function() {
        if (activeTarget) positionTooltip(activeTarget);
      });
      window.addEventListener('scroll', hideTooltip, true);
    })();

    // 隐私模式：账号名称 → 站点名 + 站点内序号（按全局顺序，1 起）
    function platformLabel(platform) {
      if (platform === 'yescode') return 'YesCode';
      if (platform === 'sub2api') return 'Sub2API';
      if (platform === 'huoli') return '火狸';
      if (platform === 'volc') return '火山';
      if (platform === 'telecomjs') return '智云';
      if (platform === 'qwen') return '千问';
      if (platform === 'minimax') return 'MiniMax';
      if (platform === 'stepfun') return '阶跃星辰';
      return '智谱';
    }
    // 团队版 level 翻译：pro→团队标准版, max→团队高级版; 非团队版原样返回
    function levelLabel(acc) {
      var raw = (acc && acc.data && acc.data.level) ? acc.data.level : '-';
      if (!acc || !acc.teamEdition) return raw;
      if (raw === 'pro') return '团队标准版';
      if (raw === 'max') return '团队高级版';
      return raw;
    }
    // 风控/异常:卡片与列表用的小徽章,hover 显示完整文案;无风险返回空串
    function riskBadgeHTML(acc) {
      if (!acc || !acc.risk || !acc.risk.text) return '';
      var text = esc(acc.risk.text);
      return '<span class="risk-badge" title="" data-tooltip="' + text + '" aria-label="' + text + '" tabindex="0">&#x26a0;&#xfe0f; 异常</span>';
    }
    function resetBadgeHTML(acc) {
      var r = acc && acc.resetRecommendation;
      if (!r || !r.needed) return '';
      var unavailableDays = r.unavailableHours / 24;
      var duration = unavailableDays >= 2
        ? unavailableDays.toFixed(1).replace(/\.0$/, '') + ' 天'
        : Math.round(r.unavailableHours) + ' 小时';
      var title = '周用量 ' + Math.round(r.weeklyPct) + '%，理论 ' + Math.round(r.theoPct)
        + '%；按当前速度预计会在重置前提前耗尽，约 ' + duration + ' 无法使用';
      var text = esc(title);
      return '<span class="reset-badge" title="" data-tooltip="' + text + '" aria-label="' + text + '" tabindex="0">需要重置</span>';
    }
    // 重置卡(Coding Plan):卡片与列表徽章,hover 显示各卡到期时间;无有效卡返回空串
    function resetCardBadgeHTML(acc) {
      var rc = acc && acc.resetCards;
      if (!rc || !rc.count) return '';
      var lines = (rc.cards || []).map(function(c) {
        return (c.type === 'fiveHour' ? '5小时卡' : '周卡') + (c.expireTime ? ' · ' + c.expireTime + ' 到期' : '');
      });
      var tip = '有效重置卡 ' + rc.count + ' 张' + (lines.length ? ':\n' + lines.join('\n') : '');
      if (rc.checkedAt) tip += '\n检查于 ' + formatTime(rc.checkedAt);
      var text = esc(tip);
      return '<span class="resetcard-badge" title="" data-tooltip="' + text + '" aria-label="' + text + '" tabindex="0">重置卡×' + rc.count + '</span>';
    }
    // 详情页「重置卡」区块:有效卡数量 + 各卡到期时间;管理员每张卡可「使用」;无卡时仅管理员显示「无」
    function resetCardsSectionHTML(acc, admin, index) {
      var rc = acc && acc.resetCards;
      if (!rc || !rc.count) {
        return admin ? '<div class="info-section"><div class="info-section-title">重置卡</div>'
          + '<div class="info-grid"><span class="info-label">有效重置卡</span><span class="info-value">无</span></div></div>' : '';
      }
      var rows = (rc.cards || []).map(function(c, n) {
        var useBtn = (admin && index != null && c.recordId != null)
          ? '<button class="use-card-btn" onclick="useResetCard(this,' + index + ',\'' + esc(c.type) + '\',' + c.recordId + ')">使用</button>'
          : '';
        return '<span class="info-label">' + (c.type === 'fiveHour' ? '5小时重置卡' : '周重置卡') + ' ' + (n + 1) + '</span>'
          + '<span class="info-value">' + esc(c.expireTime || '-') + ' 到期 ' + useBtn + '</span>';
      }).join('');
      var checked = rc.checkedAt ? '<span class="info-label">检查时间</span><span class="info-value">' + esc(formatTime(rc.checkedAt)) + '</span>' : '';
      return '<div class="info-section"><div class="info-section-title">重置卡 · ' + rc.count + ' 张有效</div>'
        + '<div class="info-grid">' + rows + checked + '</div></div>';
    }
    // 风控/异常:详情页顶部横幅,展示完整提示文案;无风险返回空串
    function riskBannerHTML(acc) {
      if (!acc || !acc.risk || !acc.risk.text) return '';
      return '<div class="risk-banner"><span class="risk-icon">&#x26a0;&#xfe0f;</span><span>' + esc(acc.risk.text) + '</span></div>';
    }
    function displayName(acc, origIdx) {
      var name = (acc && acc.name) || '';
      if (!_privacyMode) return name;
      var platform = (acc && acc.platform) || 'glm';
      var seq = 0;
      for (var i = 0; i < accountsData.length; i++) {
        if (((accountsData[i] && accountsData[i].platform) || 'glm') === platform) seq++;
        if (i === origIdx) break;
      }
      return platformLabel(platform) + seq;
    }
    function getLimitLabel(l) {
      if (l.type === 'TIME_LIMIT') return 'MCP 调用额度';
      var kind = l.type === 'CREDIT_LIMIT' ? '积分' : 'Token';
      return kind + ' (' + (UNIT_LABELS[l.unit] || '周期' + l.unit) + ')';
    }
    // 实际已耗尽判定阈值：官方数据常停在 99.9x%，但额度实际已不可用，统一按 ≥99.9% 视为耗尽
    var EXHAUSTED_PCT = 99.9;
    function getColorClass(p) { return p >= EXHAUSTED_PCT ? 'fill-exhausted' : p < 50 ? 'fill-green' : p < 80 ? 'fill-orange' : 'fill-red'; }
    function getStatusClass(p) { return p >= EXHAUSTED_PCT ? 'status-exhausted' : p < 50 ? 'status-ok' : p < 80 ? 'status-warn' : 'status-danger'; }
    function getStatusText(p) { return p >= EXHAUSTED_PCT ? '耗尽' : p < 50 ? '正常' : p < 80 ? '注意' : '紧张'; }
    // 理论进度对照标签（实际用量 vs 理论进度）；耗尽判定优先于速率比，避免撑满进度条仍显示「偏快」
    function tensionInfo(pct, theoPct) {
      if (pct >= EXHAUSTED_PCT) return { text: '耗尽', color: '#c026d3' };
      if (pct <= 0) return { text: '暂无用量', color: 'var(--text-faint)' };
      var ratio = pct / theoPct;
      if (ratio <= 0.8) return { text: '充裕', color: '#52c41a' };
      if (ratio <= 1.3) return { text: '正常', color: 'var(--text-mute)' };
      if (ratio <= 2.0) return { text: '偏快', color: '#fa8c16' };
      return { text: '紧张', color: '#f5222d' };
    }
    function formatTime(ts) { return ts ? new Date(ts).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}) : '-'; }
    function maxPct(ls) { return ls && ls.length ? Math.max.apply(null, ls.map(function(l){return l.percentage||0})) : 0; }
    function timeAgo(ts) { if (!ts) return ''; var d = Date.now() - ts; if (d < 60000) return '刚刚'; if (d < 3600000) return Math.floor(d/60000) + '分钟前'; return new Date(ts).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'}); }
    function isAdmin() { return !!localStorage.getItem('glm_pwd'); }
    function authHeaders() { var h = {'Content-Type':'application/json'}; var p = localStorage.getItem('glm_pwd'); if (p) h['X-Auth-Password'] = p; return h; }

    // ============ 通用：需要管理员权限 ============

    function requireAuth(callback) {
      if (isAdmin()) { callback(); return; }
      _pendingAuth = callback;
      document.getElementById('pwdError').textContent = '';
      document.getElementById('pwdInput').value = '';
      document.getElementById('pwdOverlay').classList.add('active');
      setTimeout(function(){ document.getElementById('pwdInput').focus(); }, 100);
    }

    function clipCopy(text) {
      if (navigator.clipboard) return navigator.clipboard.writeText(text);
      var ta = document.createElement('textarea');
      ta.value = text; ta.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); document.body.removeChild(ta);
      return Promise.resolve();
    }

    // 复制阶跃邀请链接：先复制再判断——已邀满时提醒「复制仍成功，但活动名额已用完，
    // 新好友注册双方不再获得赠送」（官方邀请人数上限 3）。
    function copyStepfunInvite(index) {
      var acc = accAt(index);
      var c = acc && acc.data && acc.data.campaign;
      var url = (document.getElementById('sfInviteUrl-' + index) || {}).value
        || (c && c.inviteUrl) || '';
      if (!url) { alert('未获取到邀请链接'); return; }
      clipCopy(url).then(function() {
        if (c && c.inviteMaxCount > 0 && c.inviteCount >= c.inviteMaxCount) {
          alert('链接已复制。\n\n注意：你已邀满 ' + c.inviteMaxCount + ' 人，活动名额已用完；\n新好友通过此链接注册，双方不会获得 15 天赠送。');
        }
      });
    }


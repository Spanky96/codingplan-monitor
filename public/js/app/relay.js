    // ============ 中转站实时活动面板(内网访客 / 管理员) ============

    function canViewRelayActivity() {
      return FEATURES.relayEnabled && (FEATURES.relayViewerAllowed === true || isAdmin());
    }

    function activityApplyVisibility() {
      var panel = document.getElementById('activityPanel');
      if (!panel) return;
      var show = canViewRelayActivity();
      panel.style.display = show ? '' : 'none';
      if (!show) return;
      panel.classList.toggle('collapsed', _activityCollapsed);
      var tab = document.getElementById('activityExpandTab');
      if (tab) tab.style.display = _activityCollapsed ? '' : 'none';
    }

    function toggleActivityPanel() {
      _activityCollapsed = !_activityCollapsed;
      localStorage.setItem('usage_activity_collapsed', _activityCollapsed ? 'true' : 'false');
      activityApplyVisibility();
      if (!_activityCollapsed) loadActivityDispatch();   // 展开立即刷新一次
    }

    function toggleActivityRankExpand() {
      _activityRankExpanded = !_activityRankExpanded;
      renderActivityPanel();
    }

    function activityDisplayName(u) {
      if (_privacyMode) return '用户' + u.user_id;   // 隐私模式同样遮蔽中转站用户名
      return u.username || String(u.email || '').split('@')[0] || ('用户' + u.user_id);
    }

    // 大数缩写(≥1e9 → B,≥1e6 → M,≥1e3 → K):今日合计/折线图纵轴用。
    // fmtTokens 定义在 detail.js 且无 B 分支(全局共用,不改动它)
    function fmtTokensMB(v) {
      if (v >= 1e9) return (v / 1e9).toFixed(2).replace(/\.?0+$/, '') + 'B';
      if (v >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
      if (v >= 1e3) return (v / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
      return String(v);
    }

    function activityComparisonDate() {
      var comparison = activityUsageData && activityUsageData.comparison;
      if (!comparison) return '';
      // Read the weekday from the actual comparison date, independent of browser timezone.
      var day = new Date(comparison.date + 'T12:00:00Z').getUTCDay();
      return comparison.date + ' 周' + '日一二三四五六'.charAt(day);
    }

    function activityTokenDifference(current, previous, label) {
      var delta = current - previous;
      if (!delta) return label + '持平';
      var pct = previous > 0 ? '（' + (Math.abs(delta) / previous * 100).toFixed(1) + '%）' : '';
      return label + (delta > 0 ? '多 ' : '少 ') + fmtTokensMB(Math.abs(delta)) + pct;
    }

    function activityTokenComparison(current, external, previous) {
      if (!previous || !activityUsageData.comparison) return { className: '', tooltip: '今日消耗 ' + fmtTokensMB(current) + '\n历史对比暂不可用' };
      var hasExternal = external > 0 || previous.external_tokens > 0;
      var tooltip = '今日消耗 ' + fmtTokensMB(current)
        + '\n昨日（' + activityComparisonDate() + '）消耗 ' + fmtTokensMB(previous.total_tokens)
        + '\n' + activityTokenDifference(current, previous.total_tokens, '较昨日全天')
        + '\n昨日此时' + (hasExternal ? '（站内）' : '') + ' ' + fmtTokensMB(previous.same_time_tokens)
        + '\n' + activityTokenDifference(current - external, previous.same_time_tokens, hasExternal ? '站内较昨日此时' : '较昨日此时');
      if (hasExternal) tooltip += '\n外部渠道仅有整日统计，不参与同时段对比';
      return { className: current < previous.total_tokens ? ' token-less' : current > previous.total_tokens ? ' token-more' : '', tooltip: tooltip };
    }

    function activityRankMovement(user, rank) {
      var previous = user.comparison;
      if (!previous || !activityUsageData.comparison) return '<span class="rank-move" tabindex="0" data-tooltip="历史排名暂不可用">—</span>';
      var delta = previous.rank ? previous.rank - rank : 0;
      var label = !previous.rank ? '新' : delta > 0 ? '↑' + delta : delta < 0 ? '↓' + Math.abs(delta) : '—';
      var explanation = !previous.rank ? '昨日无用量，今日新上榜' : delta > 0 ? '排名上升 ' + delta + ' 位' : delta < 0 ? '排名下降 ' + Math.abs(delta) + ' 位' : '排名持平';
      var tooltip = activityTokenComparison(user.today.total_tokens, user.today.external_tokens || 0, previous).tooltip
        + '\n' + (previous.rank ? '昨日第 ' + previous.rank + ' 名 → 今日第 ' + rank + ' 名\n' : '') + explanation;
      return '<span class="rank-move' + (delta ? ' changed' : '') + '" tabindex="0" data-tooltip="' + escapeHtml(tooltip) + '">' + label + '</span>';
    }

    // 模型色板:亮/暗各一套 20 槽(OKLCH 生成,dataviz 六项校验通过:
    // 相邻 CVD ΔE 8.7/8.5、normal 21.6/20.2、色度带全过;暗色表面对比全 ≥3:1,
    // 亮色 9 槽 <3:1 走 relief 规则——图例色块旁始终有模型名文字,排行条有
    // tooltip 与榜单数字兜底。claude 主题复用亮色版)。灰色仅用于「未知模型」
    // ；超出固定色板的模型使用稳定 HSL 扩展色
    var ACTIVITY_COLORS_LIGHT = ['#e1789b', '#6b7f0c', '#e47f5b', '#8d5baf', '#d38e2e', '#127abe', '#aba22a', '#6669c1', '#58b670', '#b34d6a', '#19b5ae', '#926e0c', '#18aeda', '#9f549a', '#61a1f0', '#b65142', '#9691ee', '#448735', '#c381d2', '#a95f0c'];
    var ACTIVITY_COLORS_DARK = ['#d56c87', '#327522', '#d77157', '#904081', '#c28412', '#0f66ac', '#98991e', '#804797', '#4ba964', '#9b4808', '#16a7a1', '#5d54ac', '#16a2c3', '#a03b51', '#6091e4', '#5b6c09', '#9980dc', '#a23c42', '#b675c5', '#3d5eaf'];
    var ACTIVITY_MODEL_GRAY = '#94a3b8';
    // 模型名 → 色板槽位的持久分配表(localStorage),键名与页面其他本地键同风格;
    // v2:色板从 8 槽扩到 20 槽,旧分配表作废重分
    var ACTIVITY_SLOTS_KEY = 'usage_activity_model_slots_v2';

    function activityPalette() {
      return document.documentElement.classList.contains('dark')
        ? ACTIVITY_COLORS_DARK
        : ACTIVITY_COLORS_LIGHT;
    }

    // FNV-1a:模型名稳定哈希,同一名字在任何浏览器/任何时刻算出同一偏好槽
    function activityNameHash(s) {
      var h = 2166136261;
      s = String(s);
      for (var i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619) >>> 0;
      }
      return h >>> 0;
    }

    /* 核心模型钉槽:公司主力 glm-5.3(直连)深蓝、glm-5.3-flash(转发目标)青绿,
     * 一深一浅拉开区分度,优先于哈希分配(槽索引在亮/暗两套色板中同位对应);
     * 其余槽位照常哈希,钉住槽不参与空槽搜索自然被让出 */
    var ACTIVITY_PINNED_SLOTS = { 'glm-5.3': 5, 'glm-5.3-flash': 10 };

    /* 模型颜色 = 槽位解析,而非按当前集合排序定位:
     * 首次出现的模型按名字哈希拿偏好槽,被占则按固定顺序找空槽,分配结果
     * 持久化 —— 之后无论快照里出现/消失哪些其他模型,颜色都不再漂移
     * (旧实现按排序位次取色,集合一变全体换色)。哈希冲突的模型必然分到
     * 不同槽,直连/转发(glm-5.3 vs glm-5.3-flash)依旧异色;历史累计超
     * 20 种后新模型使用名字哈希生成扩展色，灰色仅表示未知模型。 */
    function activityModelColor(name) {
      name = String(name || '').trim().toLowerCase();
      if (!name || name === 'unknown' || name === '未知模型') return ACTIVITY_MODEL_GRAY;
      var pal = activityPalette();
      if (Object.prototype.hasOwnProperty.call(ACTIVITY_PINNED_SLOTS, name)) {
        return pal[ACTIVITY_PINNED_SLOTS[name]];
      }
      var map = {};
      try { map = JSON.parse(localStorage.getItem(ACTIVITY_SLOTS_KEY)) || {}; } catch (e) { map = {}; }
      if (!map || typeof map !== 'object') map = {};
      // 旧分配若占了钉住槽(会与 glm 蓝色撞色),剔除让它重新走下方空槽分配
      var pinnedVals = {};
      Object.keys(ACTIVITY_PINNED_SLOTS).forEach(function(k) { pinnedVals[ACTIVITY_PINNED_SLOTS[k]] = true; });
      Object.keys(map).forEach(function(k) {
        if (pinnedVals[map[k]]) delete map[k];
      });
      if (Object.prototype.hasOwnProperty.call(map, name)) {
        if (Number.isInteger(map[name]) && map[name] >= 0 && map[name] < pal.length) return pal[map[name]];
        delete map[name];
      }
      var used = {};
      Object.keys(pinnedVals).forEach(function(v) { used[v] = true; });   // 钉住槽不参与分配
      Object.keys(map).forEach(function(k) { used[map[k]] = true; });
      var slot = -1;
      var preferred = activityNameHash(name) % pal.length;
      if (!used[preferred]) slot = preferred;
      else {
        for (var i = 0; i < pal.length; i++) {
          if (!used[i]) { slot = i; break; }
        }
      }
      // The palette is not a lifetime cap. Additional models get deterministic,
      // theme-aware chromatic colors instead of silently becoming gray.
      if (slot < 0) {
        var hue = activityNameHash(name) % 360;
        var dark = document.documentElement.classList.contains('dark');
        return 'hsl(' + hue + ', ' + (dark ? 65 : 62) + '%, ' + (dark ? 67 : 42) + '%)';
      }
      map[name] = slot;
      try { localStorage.setItem(ACTIVITY_SLOTS_KEY, JSON.stringify(map)); } catch (e) { /* 忽略写入失败 */ }
      return pal[slot];
    }

    // 色块颜色 = 实际调用的模型(upstream 优先,未映射回退请求模型):
    // glm-5.3 直连与 glm-5.3 → glm-5.3-flash 转发是两个模型,两种颜色
    function activityEffectiveModel(m) {
      return m.upstream_model || m.model;
    }

    // 全局模型集 = 调度实际模型 ∪ 榜单模型明细;颜色由 activityModelColor
    // 按模型名稳定分配,同一模型在色块/图例/堆叠条中颜色始终一致
    function activityColorMap() {
      var models = {};
      (((activityDispatchData || {}).users) || []).forEach(function(u) {
        (u.recent_models || []).forEach(function(m) { if (m && m.model) models[activityEffectiveModel(m)] = true; });
      });
      (((activityUsageData || {}).users) || []).forEach(function(u) {
        (u.models || []).forEach(function(m) { if (m && m.model) models[m.model] = true; });
      });
      var map = {};
      Object.keys(models).sort().forEach(function(m) {
        map[m] = activityModelColor(m);
      });
      return map;
    }

    // 把「窗口内完成请求的 (模型,次数)」近似摊到当前占用的调度格子上:
    // pass1 不同实际模型各占一格(近期优先),pass2 按完成次数补足剩余格子;
    // 窗口内无完成日志的格子为未知(灰)。
    function activityBlocksFor(u) {
      var n = u.current_in_use || 0;
      if (n <= 0) return [];
      var pairs = (u.recent_models || []).filter(function(m) { return m && m.model; });
      var slots = [], seenEff = {};
      pairs.forEach(function(m) {
        if (slots.length >= n) return;
        var eff = activityEffectiveModel(m);
        if (seenEff[eff]) return;
        seenEff[eff] = true;
        slots.push(m);
      });
      pairs.forEach(function(m) {
        if (slots.length >= n) return;
        var used = 0;
        slots.forEach(function(s) { if (s === m) used++; });
        var extra = Math.min(Math.max((m.count || 1) - used, 0), n - slots.length);
        for (var i = 0; i < extra; i++) slots.push(m);
      });
      while (slots.length < n) slots.push(null);
      return slots;
    }

    function activityBlockTitle(m) {
      if (!m) return '长流式请求暂无完成日志,模型未知';
      // 发生转发时悬浮展示「请求模型 → 实际模型」,否则只展示模型名
      return (m.upstream_model && m.upstream_model !== m.model)
        ? (m.model + ' → ' + m.upstream_model)
        : activityEffectiveModel(m);
    }

    function escapeHtml(s) {
      return String(s).replace(/[&<>"']/g, function(c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
    }


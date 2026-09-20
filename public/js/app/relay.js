    // ============ 中转站实时活动面板(管理员) ============

    function activityApplyVisibility() {
      var panel = document.getElementById('activityPanel');
      if (!panel) return;
      var show = isAdmin() && FEATURES.relayEnabled;   // 服务端未配置中转站则整体隐藏
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

    // 模型色板:亮/暗各一套(同 8 个色相、按表面色分档,dataviz 六项校验通过;
    // claude 主题复用亮色版,奶油色表面同样通过)。灰色仅用于「未知模型」
    // 与槽位耗尽后的新模型
    var ACTIVITY_COLORS_LIGHT = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'];
    var ACTIVITY_COLORS_DARK = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];
    var ACTIVITY_MODEL_GRAY = '#94a3b8';
    // 模型名 → 色板槽位的持久分配表(localStorage),键名与页面其他本地键同风格
    var ACTIVITY_SLOTS_KEY = 'usage_activity_model_slots_v1';

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

    /* 模型颜色 = 槽位解析,而非按当前集合排序定位:
     * 首次出现的模型按名字哈希拿偏好槽,被占则按固定顺序找空槽,分配结果
     * 持久化 —— 之后无论快照里出现/消失哪些其他模型,颜色都不再漂移
     * (旧实现按排序位次取色,集合一变全体换色)。哈希冲突的模型必然分到
     * 不同槽,直连/转发(glm-5.3 vs glm-5.3-flash)依旧异色;历史累计超
     * 8 种后新模型折叠为灰(不入表,槽位保留给既有模型)。 */
    function activityModelColor(name) {
      var map = {};
      try { map = JSON.parse(localStorage.getItem(ACTIVITY_SLOTS_KEY)) || {}; } catch (e) { map = {}; }
      if (!map || typeof map !== 'object') map = {};
      var pal = activityPalette();
      if (Object.prototype.hasOwnProperty.call(map, name)) {
        return map[name] >= 0 && map[name] < pal.length ? pal[map[name]] : ACTIVITY_MODEL_GRAY;
      }
      var used = {};
      Object.keys(map).forEach(function(k) { used[map[k]] = true; });
      var slot = -1;
      var preferred = activityNameHash(name) % pal.length;
      if (!used[preferred]) slot = preferred;
      else {
        for (var i = 0; i < pal.length; i++) {
          if (!used[i]) { slot = i; break; }
        }
      }
      if (slot < 0) return ACTIVITY_MODEL_GRAY;   // 槽位耗尽:灰色,不写入分配表
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


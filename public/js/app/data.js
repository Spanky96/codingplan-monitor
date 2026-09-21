    // ============ 数据加载(调度 15s 高频 / 榜单 5min 低频 + 手动) ============

    function loadActivityDispatch() {
      var p = localStorage.getItem('glm_pwd') || '';
      if (!p) { activityDispatchData = null; return; }
      fetch(API_PREFIX + '/api/relay/activity?password=' + encodeURIComponent(p))
        .then(function(r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(function(data) {
          activityDispatchData = data; _activityDispatchError = false;
          renderActivityDispatch();
        })
        .catch(function() {
          _activityDispatchError = true;
          renderActivityDispatch();   // 保留旧数据 + 标红时间戳
        });
    }

    function loadActivityUsage(manual) {
      var p = localStorage.getItem('glm_pwd') || '';
      if (!p) { activityUsageData = null; return; }
      var btn = document.getElementById('activityUsageRefreshBtn');
      if (manual && btn) btn.classList.add('spinning');
      fetch(API_PREFIX + '/api/relay/usage?password=' + encodeURIComponent(p) + (manual ? '&force=1' : ''))
        .then(function(r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(function(data) {
          activityUsageData = data; _activityUsageError = false;
          renderActivityUsage();
        })
        .catch(function() {
          _activityUsageError = true;
          renderActivityUsage();
        })
        .finally(function() { if (btn) btn.classList.remove('spinning'); });
    }

    function renderActivityPanel() {
      renderActivityDispatch();
      renderActivityUsage();
    }

    function renderActivityDispatch() {
      if (!isAdmin()) return;
      var dispatchList = document.getElementById('activityDispatchList');
      var legend = document.getElementById('activityLegend');
      var timeEl = document.getElementById('activityTime');
      var summaryEl = document.getElementById('activityDispatchSummary');
      if (!dispatchList || !legend) return;

      timeEl.classList.toggle('stale', !!_activityDispatchError);
      timeEl.title = _activityDispatchError ? '拉取失败,展示最近一次数据' : '';

      if (!activityDispatchData) {
        dispatchList.innerHTML = _activityDispatchError
          ? '<div class="activity-error">中转站连接失败,稍后自动重试</div>'
          : '<div class="activity-empty">加载中...</div>';
        legend.style.display = 'none';
        summaryEl.textContent = '';
        return;
      }
      if (activityDispatchData.generated_at) {
        timeEl.textContent = new Date(activityDispatchData.generated_at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      }
      var users = activityDispatchData.users || [];   // 后端已按占用降序

      var totalInUse = 0, totalWait = 0;
      users.forEach(function(u) {
        totalInUse += u.current_in_use || 0;
        totalWait += u.waiting_in_queue || 0;
      });
      summaryEl.textContent = users.length
        ? ('总调度 ' + totalInUse + (totalWait > 0 ? ' · 排队 ' + totalWait : ''))
        : '';

      if (!users.length) {
        dispatchList.innerHTML = '<div class="activity-empty">当前没有在跑的调度</div>';
        legend.style.display = 'none';
        return;
      }

      var colorMap = activityColorMap();
      var html = '';
      var legendModels = {};
      var hasUnknown = false;
      users.forEach(function(u) {
        var blocksHtml = '';
        activityBlocksFor(u).forEach(function(m) {
          if (!m) {
            hasUnknown = true;
            blocksHtml += '<span class="dp-block unknown" data-tooltip="' + escapeHtml(activityBlockTitle(null)) + '"></span>';
            return;
          }
          var eff = activityEffectiveModel(m);
          legendModels[eff] = true;
          blocksHtml += '<span class="dp-block" style="background:' + colorMap[eff] + '" data-tooltip="' + escapeHtml(activityBlockTitle(m)) + '"></span>';
        });
        html += '<div class="dp-row">'
          + '<span class="dp-name" data-tooltip="' + escapeHtml(activityDisplayName(u)) + '">' + escapeHtml(activityDisplayName(u)) + '</span>'
          + '<span class="dp-blocks">' + blocksHtml + '</span>'
          + ((u.waiting_in_queue || 0) > 0 ? '<span class="dp-wait" data-tooltip="排队中请求">等 ' + u.waiting_in_queue + '</span>' : '')
          + '</div>';
      });
      dispatchList.innerHTML = html;

      // 图例:纯色块 + 实际模型名(无悬浮交互)
      var legendHtml = '';
      Object.keys(legendModels).sort().forEach(function(model) {
        legendHtml += '<span class="dp-legend-item"><i style="background:' + colorMap[model] + '"></i><span>' + escapeHtml(model) + '</span></span>';
      });
      if (hasUnknown) {
        legendHtml += '<span class="dp-legend-item"><i style="background:' + ACTIVITY_MODEL_GRAY + '"></i><span>未知</span></span>';
      }
      legend.innerHTML = legendHtml;
      legend.style.display = legendHtml ? '' : 'none';
    }

    function renderActivityUsage() {
      if (!isAdmin()) return;
      var rankList = document.getElementById('activityRankList');
      var summaryEl = document.getElementById('activityTokenSummary');
      var moreBtn = document.getElementById('activityMoreBtn');
      if (!rankList) return;

      if (!activityUsageData) {
        rankList.innerHTML = _activityUsageError
          ? '<div class="activity-error">榜单拉取失败,可点右上 ↻ 重试</div>'
          : '<div class="activity-empty">加载中...</div>';
        summaryEl.textContent = '';
        moreBtn.style.display = 'none';
        return;
      }

      var users = (activityUsageData.users || []).filter(function(u) { return u.today && (u.today.total_tokens || 0) > 0; });
      users.sort(function(a, b) { return (b.today.total_tokens || 0) - (a.today.total_tokens || 0); });

      var hasExternal = users.some(function(u) { return (u.today.external_tokens || 0) > 0; });
      summaryEl.textContent = users.length
        ? (users.length + ' 人有消费' + (hasExternal ? ' · 含外部' : ''))
        : '';

      if (!users.length) {
        rankList.innerHTML = '<div class="activity-empty">今日暂无用量</div>';
        moreBtn.style.display = 'none';
        return;
      }

      var colorMap = activityColorMap();
      var maxTok = users[0].today.total_tokens || 1;
      var shown = _activityRankExpanded ? users : users.slice(0, 5);
      var rhtml = '';
      shown.forEach(function(u, i) {
        var segs = (u.models || []).filter(function(m) { return m && m.model && (m.total_tokens || 0) > 0; });
        // 模型过多时保留前 6 段,其余合并为浅灰「其他」
        var restTokens = 0;
        if (segs.length > 6) {
          for (var k = 6; k < segs.length; k++) restTokens += segs[k].total_tokens || 0;
          segs = segs.slice(0, 6);
        }
        var segsHtml = '';
        segs.forEach(function(m) {
          var pct = Math.max(1.5, Math.round((m.total_tokens / maxTok) * 1000) / 10);
          segsHtml += '<span class="rank-bar-seg" style="width:' + Math.min(pct, 100) + '%;background:' + colorMap[m.model] + '"'
            + ' data-tooltip="' + escapeHtml(m.model) + ' ' + fmtTokens(m.total_tokens) + '"></span>';
        });
        if (restTokens > 0) {
          var restPct = Math.max(1.5, Math.round((restTokens / maxTok) * 1000) / 10);
          segsHtml += '<span class="rank-bar-seg" style="width:' + Math.min(restPct, 100) + '%;background:' + ACTIVITY_MODEL_GRAY + '"'
            + ' data-tooltip="其他模型 ' + fmtTokens(restTokens) + '"></span>';
        }
        var extBadge = (u.today.external_tokens || 0) > 0
          ? '<span class="rank-ext" data-tooltip="含外部资源用量 ' + fmtTokens(u.today.external_tokens) + '">外 ' + fmtTokens(u.today.external_tokens) + '</span>'
          : '';
        rhtml += '<div class="rank-row">'
          + '<div class="rank-line">'
          + '<span class="rank-no' + (i < 3 ? ' top' : '') + '">' + (i + 1) + '</span>'
          + '<span class="rank-name" data-tooltip="' + escapeHtml(activityDisplayName(u)) + '">' + escapeHtml(activityDisplayName(u)) + '</span>' + extBadge
          + '<span class="rank-val">' + fmtTokens(u.today.total_tokens)
          + '<span class="rank-cost">$' + (u.today.actual_cost || 0).toFixed(2) + '</span></span>'
          + '</div>'
          + '<div class="rank-bar">' + segsHtml + '</div>'
          + '</div>';
      });
      rankList.innerHTML = rhtml;

      if (users.length > 5) {
        moreBtn.style.display = '';
        moreBtn.textContent = _activityRankExpanded ? '收起' : '更多 ' + (users.length - 5) + ' 人';
      } else {
        moreBtn.style.display = 'none';
      }
    }

    // ============ 数据加载 ============

    function loadExpire(force) {
      var url = force ? API_PREFIX + '/api/expire?force=1' : API_PREFIX + '/api/expire';
      fetch(url, { headers: authHeaders() })
        .then(function(r){return r.json()}).then(function(data){
        expireData = data;
        if (accountsData.length) renderCards(accountsData);
      });
    }

    function refreshExpire(index) {
      fetch(API_PREFIX + '/api/expire/' + index + '?force=1', { headers: authHeaders() })
        .then(function(r){return r.json()}).then(function(data){
        expireData[index] = data;
        updateCard(index, accAt(index));
      });
    }

    function loadData(force) {
      var grid = document.getElementById('cardGrid');
      var url = force ? API_PREFIX + '/api/usage?force=1' : API_PREFIX + '/api/usage';
      if (!accountsData.length) grid.innerHTML = '<div class="loading"><div class="loading-spinner"></div><p style="margin-top:12px">加载中...</p></div>';
      fetch(url, { headers: authHeaders() })
        .then(function(r){return r.json()}).then(function(data){
        accountsData = data; renderCards(data);
        document.getElementById('lastUpdated').textContent = '更新于 ' + new Date().toLocaleTimeString('zh-CN');
        loadWeights();   // 拉取权重渲染徽标(游客仅公开账号,管理员全量)
        loadCapacity();  // 拉取 sub2api 容量快照渲染胶囊(仅管理员)
        // 慢账号(智云等)后台补齐:列表接口已触发抓取,这里 force=false 会优先 join inflight
        (data || []).forEach(function(acc, i) {
          if (!acc) return;
          var idx = acc.index != null ? acc.index : i;
          if (acc.loading || acc.pending) fillPendingCard(idx, false);
        });
      }).catch(function(err){ if(!accountsData.length) grid.innerHTML='<div class="empty">加载失败: '+err.message+'</div>'; });
    }

    document.getElementById('refreshBtn').addEventListener('click', function(){ loadData(true); loadExpire(true); });
    // 隐私状态(带当前登录态询问服务端是否强制):外网访客/全隐私时 applyPrivacyForced
    // 隐藏切换按钮并锁定;登录/登出后也要重取(管理员任何入口不强制)
    function refreshPrivacyState() {
      // 4s 超时兜底:features 挂起时不能阻塞主数据加载(finally 里的 loadData 照常执行)
      var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      var timer = ctrl ? setTimeout(function() { ctrl.abort(); }, 4000) : null;
      return fetch(API_PREFIX + '/api/features', { headers: authHeaders(), cache: 'no-store', signal: ctrl ? ctrl.signal : undefined })
        .then(function(r) { return r.ok ? r.json() : null; })
        .then(function(f) {
          if (f && typeof f.relayEnabled === 'boolean') FEATURES.relayEnabled = f.relayEnabled;
          if (f && typeof f.privacyForced === 'boolean') applyPrivacyForced(f.privacyForced);
        })
        .catch(function() { /* 拉取失败按未启用/不强制处理(安全默认;脱敏在后端兜底) */ })
        .finally(function() { if (timer) clearTimeout(timer); });
    }
    // 先拉功能开关+隐私标记再加载主数据:避免隐私按钮先显示后消失的闪烁
    refreshPrivacyState().finally(function() {
      loadData();
      loadExpire();
      activityApplyVisibility();
      if (FEATURES.relayEnabled && isAdmin()) { loadActivityDispatch(); loadActivityUsage(); }
    });
    setInterval(function(){ loadData(); }, 5 * 60 * 1000);
    // 容量快照轻量（后端 5s 缓存）：管理员打开页面时 30s 刷新一次胶囊
    setInterval(function(){ if (isAdmin() && accountsData.length) loadCapacity(); }, 30 * 1000);
    setInterval(function(){ if (FEATURES.relayEnabled && isAdmin() && !_activityCollapsed && !document.hidden) loadActivityDispatch(); }, 15 * 1000);
    setInterval(function(){ if (FEATURES.relayEnabled && isAdmin() && !document.hidden) loadActivityUsage(); }, 5 * 60 * 1000);
    document.addEventListener('visibilitychange', function() {
      if (!document.hidden && FEATURES.relayEnabled && isAdmin()) {
        if (!_activityCollapsed) loadActivityDispatch();
        loadActivityUsage();
      }
    });

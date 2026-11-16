    // ============ sub2api 容量胶囊(管理员) ============
    var _capacityRequestId = 0;
    var _capacityError = false;
    var _capacityUpdatedAt = 0;

    // 全局容量悬浮气泡：fixed 定位挂在 body 下，卡片 overflow:hidden / hover transform
    // 都不会裁剪或位移；卡片 innerHTML 重渲染也无损（事件委托到 document）。
    (function () {
      var tip = document.createElement('div');
      tip.id = 'capTip';
      document.body.appendChild(tip);
      function showTip(el) {
        var text = el.getAttribute('data-cap-tip');
        if (!text) return;
        tip.textContent = text;
        tip.style.display = 'block';
        var r = el.getBoundingClientRect();
        var top = r.top - tip.offsetHeight - 6;
        if (top < 8) top = r.bottom + 6;   // 上方放不下放下方
        var left = Math.min(Math.max(8, r.left), Math.max(8, window.innerWidth - tip.offsetWidth - 8));
        tip.style.top = top + 'px';
        tip.style.left = left + 'px';
      }
      function closestCap(t) { return (t && t.closest) ? t.closest('.cap-pill') : null; }
      document.addEventListener('mouseover', function(e) {
        var el = closestCap(e.target);
        if (el) showTip(el); else tip.style.display = 'none';
      });
      document.addEventListener('mouseout', function(e) {
        if (closestCap(e.target)) tip.style.display = 'none';
      });
    })();

    function escCapAttr(s) {
      return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    // capacityBadgeHTML 渲染「当前调度中|总容量」胶囊；
    // 悬浮 data-cap-tip 逐行列出指向同一权重的 sub2api 账号（如 glm5-周慧珍 #85：2/5）。
    function capacityBadgeHTML(name) {
      // 仅管理员可见(悬浮会暴露内部账号名);非管理员一律不渲染
      if (!isAdmin()) return '';
      var cap = capacityMap[name];
      // 无任何匹配的 sub2api 账号才不渲染；total=0（权重为 0 / 全部停调度）
      // 也显示 0|0，保持 UI 一致。
      if (!cap) return '';
      var cls = (cap.total > 0 && cap.current >= cap.total) ? 'full' : (cap.current > 0 ? 'busy' : '');
      var lines = cap.items.map(function(it) {
        return it.name + '：' + it.current + '/' + it.total + (it.off ? '（已停调度）' : '');
      }).join('\n');
      if (_capacityError) {
        cls += ' stale';
        lines = '刷新失败，显示最近一次数据' + (_capacityUpdatedAt ? '（' + new Date(_capacityUpdatedAt).toLocaleTimeString('zh-CN') + '）' : '') + '\n' + lines;
      }
      return '<span class="cap-pill ' + cls + '" data-cap-tip="' + escCapAttr(lines) + '">'
        + cap.current + '|' + cap.total + '</span>';
    }

    function loadCapacity() {
      var requestId = ++_capacityRequestId;
      // 服务端未配置 SUB2API_BASE_URL 时整体禁用(不请求、不渲染胶囊)
      if (!FEATURES.relayEnabled) { capacityMap = {}; return; }
      // 仅管理员展示；暂时失败保留最近的快照，并在悬浮中标注。
      var p = localStorage.getItem('glm_pwd') || '';
      if (!p) { capacityMap = {}; return; }
      return fetch(API_PREFIX + '/api/sub2api/capacity?password=' + encodeURIComponent(p))
        .then(function(r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(function(data) {
          if (requestId !== _capacityRequestId || p !== localStorage.getItem('glm_pwd') || !FEATURES.relayEnabled) return;
          if (!data || !Array.isArray(data.accounts)) throw new Error('容量快照格式无效');
          // matched_key depends on a second request from the relay to the weight
          // source. The account snapshot is still valid if that request fails.
          // Use the same longest-prefix rule as scheduling to recover its key.
          var names = accountsData.filter(function(a) { return a && a.name; })
            .map(function(a) { return a.name; }).sort(function(a, b) { return b.length - a.length; });
          var next = {};
          data.accounts.forEach(function(a) {
            if (!a) return;
            var key = names.indexOf(a.matched_key) >= 0 ? a.matched_key : names.find(function(name) {
              return typeof a.name === 'string' && a.name.trim().indexOf(name) === 0;
            });
            if (!key) return;
            var g = next[key];
            if (!g) g = next[key] = { current: 0, total: 0, items: [] };
            var active = a.schedulable && a.status === 'active';
            var cur = a.current_concurrency || 0;
            var tot = a.concurrency || 0;
            // 容量按全部匹配账号聚合（与 sub2api 管理页一致，停调度也在悬浮里标注），
            // 否则卡片 0|0 与悬浮明细 0/1 对不上。
            g.current += cur;
            g.total += tot;
            g.items.push({ name: a.name, current: cur, total: tot, off: !active });
          });
          capacityMap = next; _capacityError = false; _capacityUpdatedAt = Date.now();
          if (accountsData.length) renderCards(accountsData);
        })
        .catch(function() {
          if (requestId !== _capacityRequestId || p !== localStorage.getItem('glm_pwd')) return;
          _capacityError = true;
          if (accountsData.length) renderCards(accountsData);
        });
    }


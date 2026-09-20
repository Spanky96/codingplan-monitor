    // ============ sub2api 容量胶囊(管理员) ============

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
      var cap = capacityMap[name];
      // 无任何匹配的 sub2api 账号才不渲染；total=0（权重为 0 / 全部停调度）
      // 也显示 0|0，保持 UI 一致。
      if (!cap) return '';
      var cls = (cap.total > 0 && cap.current >= cap.total) ? 'full' : (cap.current > 0 ? 'busy' : '');
      var lines = cap.items.map(function(it) {
        return it.name + '：' + it.current + '/' + it.total + (it.off ? '（已停调度）' : '');
      }).join('\n');
      return '<span class="cap-pill ' + cls + '" data-cap-tip="' + escCapAttr(lines) + '">'
        + cap.current + '|' + cap.total + '</span>';
    }

    function loadCapacity() {
      // 服务端未配置 SUB2API_BASE_URL 时整体禁用(不请求、不渲染胶囊)
      if (!FEATURES.relayEnabled) { capacityMap = {}; return; }
      // 仅管理员展示（暴露内部账号名）；失败静默：没有快照就不渲染胶囊
      var p = localStorage.getItem('glm_pwd') || '';
      if (!p) { capacityMap = {}; return; }
      fetch(API_PREFIX + '/api/sub2api/capacity?password=' + encodeURIComponent(p))
        .then(function(r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(function(data) {
          capacityMap = {};
          ((data && data.accounts) || []).forEach(function(a) {
            if (!a || !a.matched_key) return;
            var g = capacityMap[a.matched_key];
            if (!g) g = capacityMap[a.matched_key] = { current: 0, total: 0, items: [] };
            var active = a.schedulable && a.status === 'active';
            var cur = a.current_concurrency || 0;
            var tot = a.concurrency || 0;
            // 容量按全部匹配账号聚合（与 sub2api 管理页一致，停调度也在悬浮里标注），
            // 否则卡片 0|0 与悬浮明细 0/1 对不上。
            g.current += cur;
            g.total += tot;
            g.items.push({ name: a.name, current: cur, total: tot, off: !active });
          });
          if (accountsData.length) renderCards(accountsData);
        })
        .catch(function() {});
    }


    // ============ 权重徽标与配置(管理员)============

    function weightBadgeHTML(name, i) {
      var w = weightsMap[name];
      if (w == null) return '';
      var cls = 'weight-badge ' + (w === 0 ? 'w-0' : w <= 3 ? 'w-low' : w <= 7 ? 'w-mid' : 'w-high');
      // 管理员:点击可配置;游客:仅展示
      if (isAdmin()) {
        return '<span class="' + cls + '" onclick="event.stopPropagation();openWeightConfig(' + i + ')" title="点击配置权重" style="cursor:pointer">' + w.toFixed(1) + '</span>';
      }
      return '<span class="' + cls + '" title="权重">' + w.toFixed(1) + '</span>';
    }

    function loadWeights() {
      // 权重对所有用户可见:游客拿到公开账号权重(后端按 isPublic 过滤),管理员拿全量 + detail
      var p = localStorage.getItem('glm_pwd') || '';
      var url = API_PREFIX + '/api/weights?detail=1';
      if (p) url += '&password=' + encodeURIComponent(p);
      fetch(url)
        .then(function(r){return r.json()})
        .then(function(d){
          if (!d) return;
          // 管理员:{weights, detail};游客:纯 {name:weight};出错置空
          weightsMap = d.weights ? d.weights : (d.error ? {} : d);
          weightsDetail = {};
          (d.detail || []).forEach(function(x){ if (x && x.name != null) weightsDetail[x.name] = x; });
          if (accountsData.length) renderCards(accountsData);
        }).catch(function(){});
    }

    // 前端复刻后端策略,用于弹窗实时预览
    function applyStrategyFE(base, strategy, value) {
      if (base == null) return null;
      if (strategy === 'A') return value;
      if (strategy === 'B') return base * value;
      if (strategy === 'C') return Math.min(base, value);
      if (strategy === 'D') return base + value;
      return base;
    }
    function clamp10FE(x) { return Math.max(0, Math.min(10, Math.round(x * 10) / 10)); }

    function updateWeightPreview() {
      var det = weightsDetail[_weightEditName] || {};
      var base = (det.base != null) ? det.base : null;
      var strategy = document.getElementById('w_strategy').value;
      var value = parseFloat(document.getElementById('w_value').value);
      value = isFinite(value) ? value : 0;
      var dw = parseFloat(document.getElementById('w_default').value);
      dw = isFinite(dw) ? dw : 1;
      // 有 usage(base)→ 当前权重 + 所选策略;无 usage → 默认权重
      var raw = (base == null) ? dw : applyStrategyFE(base, strategy, value);
      document.getElementById('w_preview').textContent = clamp10FE(raw).toFixed(1);
      var baseInfo;
      if (base == null) {
        baseInfo = '无法获取 usage → 使用默认权重 ' + clamp10FE(dw).toFixed(1);
      } else if (det.platform === 'telecomjs') {
        var days = det.noConsumption ? '暂无历史消费' : ((det.remainingDays || 0).toFixed(1) + ' 天');
        var coding = det.codingAverage == null ? '暂无 CodingPlan 样本' : ('CodingPlan 均分 ' + det.codingAverage.toFixed(1));
        baseInfo = '可用 ' + days + ' → 容量分 ' + det.capacityScore
          + '；' + coding + '，压力 ×' + det.codingPressure.toFixed(2)
          + '；' + (det.peak ? '14:00–18:00 高峰' : '非高峰') + ' ×' + det.timeMultiplier
          + '；base ' + base.toFixed(2);
      } else {
        baseInfo = '当前权重(base)= ' + base + ',配合所选策略计算(默认权重仅兜底)';
      }
      document.getElementById('w_base_info').textContent = baseInfo;
    }

    function openWeightConfig(i) {
      var acc = accAt(i);
      if (!acc) return;
      var det = weightsDetail[acc.name] || {};
      var cfg = {
        defaultWeight: (det.defaultWeight != null) ? det.defaultWeight : 1,
        strategy: det.strategy || 'B',
        value: (det.configValue != null) ? det.configValue : 1
      };
      _weightEditIndex = i; _weightEditName = acc.name;
      document.getElementById('weightBody').innerHTML = ''
        + '<div class="form-group"><label class="form-label">账号</label><div style="font-weight:600">' + esc(acc.name) + '</div></div>'
        + '<div class="form-group"><label class="form-label">基础用量</label><div id="w_base_info" style="color:var(--text-mute);font-size:13px">-</div></div>'
        + '<div class="form-group"><label class="form-label">默认权重(token 失效 / 无缓存时使用,0~10)</label><input class="form-input" type="number" min="0" max="10" step="1" id="w_default" value="' + cfg.defaultWeight + '" oninput="updateWeightPreview()"></div>'
        + '<div class="form-row"><div class="form-group"><label class="form-label">权重策略</label><select class="form-input" id="w_strategy" onchange="updateWeightPreview()">'
          + '<option value="B"' + (cfg.strategy==='B'?' selected':'') + '>B 倍率(默认 ×1)</option>'
          + '<option value="A"' + (cfg.strategy==='A'?' selected':'') + '>A 固定值</option>'
          + '<option value="C"' + (cfg.strategy==='C'?' selected':'') + '>C 最高值(上限)</option>'
          + '<option value="D"' + (cfg.strategy==='D'?' selected':'') + '>D 固定加减</option>'
        + '</select></div>'
        + '<div class="form-group"><label class="form-label">策略值</label><input class="form-input" type="number" step="any" id="w_value" value="' + cfg.value + '" oninput="updateWeightPreview()"></div></div>'
        + '<div class="form-group"><label class="form-label">预览最终权重</label><div style="font-size:22px;font-weight:700;color:var(--accent)">W <span id="w_preview">-</span> <span style="font-size:12px;color:var(--text-faint);font-weight:400">(钳制到 0~10)</span></div></div>'
        + '<div class="form-actions"><button class="btn-default" onclick="closeModal(\'weightOverlay\')">取消</button><button class="btn-primary" onclick="saveWeightConfig()">保存</button></div>';
      updateWeightPreview();
      document.getElementById('weightOverlay').classList.add('active');
    }

    function saveWeightConfig() {
      var i = _weightEditIndex;
      var dw = parseFloat(document.getElementById('w_default').value);
      var value = parseFloat(document.getElementById('w_value').value);
      var body = {
        defaultWeight: isFinite(dw) ? dw : 5,
        strategy: document.getElementById('w_strategy').value,
        value: isFinite(value) ? value : 1
      };
      fetch(API_PREFIX + '/api/weights/config/' + i, { method: 'PUT', headers: authHeaders(), body: JSON.stringify(body) })
        .then(function(r){return r.json()})
        .then(function(d){
          if (d.error) { alert('保存失败: ' + d.error); return; }
          closeModal('weightOverlay');
          loadWeights();   // 刷新徽标
        }).catch(function(e){ alert('请求失败: ' + e.message); });
    }


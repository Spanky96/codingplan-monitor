    // ============ 今日中转用量折线图(弹层;按模型/按用户 × Token/次数) ============
    // 数据来自 /api/relay/usage-hourly(中转站按小时 × 用户 × 模型稀疏行),
    // 前端透视成两套序列:x 轴 0-23 时(中转站服务器时区),y 轴按小时增量。
    // 模型色沿用 activityModelColor(名字哈希稳定分配,与调度色块/榜单一致);
    // 用户色按 user_id 哈希取同一色板(键加前缀避免与模型名撞键)。

    var _relayChartState = { mode: 'model', metric: 'tokens', data: null, fetchedAt: 0, loading: false, error: false, chart: null };

    function relayChartInk(name, fallback) {
      var v = getComputedStyle(document.documentElement).getPropertyValue(name);
      v = (v || '').trim();
      return v || fallback;
    }

    function relayChartSkeleton() {
      document.getElementById('relayChartBody').innerHTML
        = '<div class="rc-empty">加载中...</div>';
    }

    function openRelayChart() {
      if (!FEATURES.relayEnabled || !isAdmin()) return;
      document.getElementById('relayChartOverlay').classList.add('active');
      relayChartSkeleton();
      var stale = !_relayChartState.data || (Date.now() - _relayChartState.fetchedAt) > 60 * 1000;
      if (stale && !_relayChartState.loading) relayChartLoad();
      else if (_relayChartState.data) relayChartRender();
    }

    function relayChartLoad() {
      var p = localStorage.getItem('glm_pwd') || '';
      _relayChartState.loading = true;
      _relayChartState.error = false;
      fetch(API_PREFIX + '/api/relay/usage-hourly?password=' + encodeURIComponent(p))
        .then(function(r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(function(data) {
          _relayChartState.data = data;
          _relayChartState.fetchedAt = Date.now();
          relayChartRender();
        })
        .catch(function() {
          _relayChartState.error = true;
          var body = document.getElementById('relayChartBody');
          if (body) {
            body.innerHTML = '<div class="rc-error">折线图数据拉取失败'
              + '<div class="rc-retry"><button class="btn-primary" onclick="relayChartRetry()">重试</button></div></div>';
          }
        })
        .finally(function() { _relayChartState.loading = false; });
    }

    function relayChartRetry() { relayChartSkeleton(); relayChartLoad(); }

    function relayChartSetMode(mode) {
      if (_relayChartState.mode === mode) return;
      _relayChartState.mode = mode;
      relayChartRender();
    }

    function relayChartSetMetric(metric) {
      if (_relayChartState.metric === metric) return;
      _relayChartState.metric = metric;
      relayChartRender();
    }

    // 透视:rows → [{label, colorKey, values[24](null 起), total}],按 total 降序
    function relayChartSeries(data) {
      var byMode = _relayChartState.mode === 'model';
      var metric = _relayChartState.metric === 'tokens' ? 'total_tokens' : 'requests';
      var series = {};
      (data.rows || []).forEach(function(r) {
        if (!r || r.model == null) return;
        var key = byMode ? r.model : ('user:' + r.user_id);
        var entry = series[key];
        if (!entry) {
          entry = series[key] = {
            label: byMode ? r.model : escapeHtml(activityDisplayName(r)),
            colorKey: key,
            values: new Array(24).fill(null),
            total: 0
          };
        }
        var h = r.hour;
        if (h < 0 || h > 23) return;
        var v = +(r[metric] || 0);
        entry.values[h] = (entry.values[h] || 0) + v;
        entry.total += v;
      });
      return Object.keys(series).map(function(k) { return series[k]; })
        .sort(function(a, b) { return b.total - a.total; });
    }

    function relayChartRender() {
      var body = document.getElementById('relayChartBody');
      var data = _relayChartState.data;
      if (!body || !data) return;

      var list = relayChartSeries(data);
      var byMode = _relayChartState.mode === 'model';
      var isTokens = _relayChartState.metric === 'tokens';

      var meta = '';
      if (data.generated_at) {
        meta = list.length + ' 个' + (byMode ? '模型' : '用户') + ' · 更新于 '
          + new Date(data.generated_at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      }

      body.innerHTML = '<div class="relay-chart">'
        + '<div class="rc-controls">'
        + '<div class="rc-seg">'
        + '<button class="' + (byMode ? 'active' : '') + '" onclick="relayChartSetMode(\'model\')">按模型</button>'
        + '<button class="' + (!byMode ? 'active' : '') + '" onclick="relayChartSetMode(\'user\')">按用户</button>'
        + '</div>'
        + '<div class="rc-seg">'
        + '<button class="' + (isTokens ? 'active' : '') + '" onclick="relayChartSetMetric(\'tokens\')">Token</button>'
        + '<button class="' + (!isTokens ? 'active' : '') + '" onclick="relayChartSetMetric(\'requests\')">次数</button>'
        + '</div>'
        + '<span class="rc-meta">' + meta + '</span>'
        + '</div>'
        + '<div class="rc-box" id="relayChartBox"></div>'
        + '<div class="rc-note">口径:站内中转用量(外部资源为日粒度,未计入小时拆分,榜单数字中另行标注);小时为中转站服务器时区,无数据的小时段留空。</div>'
        + '</div>';

      if (!list.length) {
        document.getElementById('relayChartBox').outerHTML
          = '<div class="rc-empty" id="relayChartBox">今日暂无站内用量</div>';
        return;
      }

      relayChartDraw(list);
    }

    function relayChartDraw(list) {
      var box = document.getElementById('relayChartBox');
      if (_relayChartState.chart) _relayChartState.chart.dispose();
      _relayChartState.chart = echarts.init(box);

      var ink = relayChartInk('--text', '#1f2937');
      var inkMute = relayChartInk('--text-mute', '#6b7280');
      var inkFaint = relayChartInk('--text-faint', '#9ca3af');
      var gridLine = relayChartInk('--glass-border-soft', 'rgba(127,127,127,.2)');
      var isTokens = _relayChartState.metric === 'tokens';

      var hours = [];
      for (var h = 0; h < 24; h++) hours.push((h < 10 ? '0' + h : '' + h) + ':00');

      _relayChartState.chart.setOption({
        animationDuration: 250,
        color: list.map(function(s) { return activityModelColor(s.colorKey); }),
        tooltip: {
          trigger: 'axis',
          axisPointer: { type: 'cross', label: { backgroundColor: ink } },
          backgroundColor: relayChartInk('--glass-strong', '#fff'),
          borderColor: relayChartInk('--glass-border', 'rgba(127,127,127,.3)'),
          textStyle: { color: ink, fontSize: 12 },
          valueFormatter: function(v) { return v == null ? '-' : (isTokens ? fmtTokensMB(v) : String(v)); }
        },
        legend: {
          type: 'scroll',
          top: 0,
          textStyle: { color: inkMute, fontSize: 11 },
          pageIconColor: inkMute,
          pageIconInactiveColor: inkFaint,
          pageTextStyle: { color: inkMute }
        },
        grid: { left: 56, right: 18, top: 40, bottom: 26 },
        xAxis: {
          type: 'category',
          data: hours,
          axisLine: { lineStyle: { color: gridLine } },
          axisTick: { show: false },
          axisLabel: { color: inkMute, fontSize: 11, interval: 2 }
        },
        yAxis: {
          type: 'value',
          axisLabel: { color: inkMute, fontSize: 11, formatter: function(v) { return isTokens ? fmtTokensMB(v) : (v >= 1000 ? fmtTokensMB(v) : String(v)); } },
          splitLine: { lineStyle: { color: gridLine } }
        },
        series: list.map(function(s) {
          return {
            name: s.label,
            type: 'line',
            data: s.values,
            lineStyle: { width: 2 },
            itemStyle: { borderWidth: 1.5 },
            symbol: 'circle',
            symbolSize: 6,
            emphasis: { focus: 'series', symbolSize: 8 }
          };
        })
      });
    }

    function relayChartOnClose() {
      if (_relayChartState.chart) {
        _relayChartState.chart.dispose();
        _relayChartState.chart = null;
      }
    }

    window.addEventListener('resize', function() {
      if (_relayChartState.chart) _relayChartState.chart.resize();
    });

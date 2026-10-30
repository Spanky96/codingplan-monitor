    // ============ 今日中转用量折线图(弹层;按模型/按用户 × Token/次数) ============
    // 数据来自 /api/relay/usage-hourly(中转站按小时 × 用户 × 模型稀疏行),
    // 前端透视成两套序列:x 轴 0-23 时(中转站服务器时区),y 轴按小时增量。
    // 稀疏行有洞:系列活动范围内缺口补 0 保证折线连续;默认缩放窗口贴合数据
    // 活动范围(空凌晨时段不默认展开),滑块仍可拖回全天。
    // 模型色沿用 activityModelColor(名字哈希稳定分配,与调度色块/榜单一致);
    // 用户色按 user_id 哈希取同一色板(键加前缀避免与模型名撞键)。

    var _relayChartState = { mode: 'model', metric: 'tokens', data: null, fetchedAt: 0, loading: false, error: false, chart: null };

    // 用户模式默认仅绘制总量前 5 名,其余点图例名加选(用户多时全画挤成一团)
    var RELAY_CHART_DEFAULT_SERIES = 5;

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
        .sort(function(a, b) { return b.total - a.total; })
        .map(relayChartFillGaps);
    }

    // 小时行是稀疏的(没调用的小时没有行):null 起的 values 直接画会断成孤立散点。
    // 记录该系列首个/末个有用量的小时,把中间的 null 补成 0 —— 活动范围内折线
    // 连续(没调用的小时沉到 0),范围之外仍为 null(线不向两侧空时段延伸)。
    function relayChartFillGaps(entry) {
      var first = -1, last = -1;
      entry.values.forEach(function(v, i) {
        if (v != null) { if (first < 0) first = i; last = i; }
      });
      entry.firstHour = first;
      entry.lastHour = last;
      for (var i = first + 1; i < last; i++) {
        if (entry.values[i] == null) entry.values[i] = 0;
      }
      return entry;
    }

    // 默认缩放窗口 [start,end](类目下标,含端点):取系列活动范围首尾各留 1 小时,
    // 钳制到 0-23;无有效小时(异常数据)退回全天
    function relayChartZoomWindow(list, isSelected) {
      var minHour = 23, maxHour = 0;
      list.forEach(function(s) {
        if (s.firstHour == null || s.firstHour < 0) return;
        if (isSelected && !isSelected(s)) return;
        if (s.firstHour < minHour) minHour = s.firstHour;
        if (s.lastHour > maxHour) maxHour = s.lastHour;
      });
      if (maxHour < minHour) return [0, 23];
      return [Math.max(0, minHour - 1), Math.min(23, maxHour + 1)];
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
      // 轴线/网格比旧版(--glass-border-soft)加深一档:太淡读不出坐标系
      var axisColor = inkFaint;
      var gridColor = relayChartInk('--line', 'rgba(127,127,127,.32)');
      var isTokens = _relayChartState.metric === 'tokens';
      var byMode = _relayChartState.mode === 'model';

      var hours = [];
      for (var h = 0; h < 24; h++) hours.push((h < 10 ? '0' + h : '' + h) + ':00');

      var colors = list.map(function(s) { return activityModelColor(s.colorKey); });

      // 用户模式默认只画前 5 名,其余点图例名加选;模型模式默认全画
      var legendSelected = {};
      if (!byMode) {
        list.forEach(function(s, i) {
          if (i >= RELAY_CHART_DEFAULT_SERIES) legendSelected[s.label] = false;
        });
      }

      // 默认时间段贴合数据:初始缩放窗口取当前选中系列的活动范围(如凌晨 0-7 点
      // 无数据就不默认展开空轴);滑块仍可拖回全天 0-23
      var zoomWindow = relayChartZoomWindow(list, function(s) {
        return legendSelected[s.label] !== false;
      });

      // 图例文字与色点同色:rich text 按系列逐个上色(formatter name → 槽位)。
      // rich 会盖掉 ECharts 的 inactiveColor,未选中系列的文字要显式置灰,
      // 并在 legendselectchanged 时同步刷新,否则未选中项看着仍像选中
      var selectedMap = {};
      list.forEach(function(s) { selectedMap[s.label] = legendSelected[s.label] !== false; });
      var nameIdx = {};
      list.forEach(function(s, i) { nameIdx[s.label] = i; });
      var buildRich = function() {
        var r = {};
        list.forEach(function(s, i) {
          r['c' + i] = { color: selectedMap[s.label] === false ? inkFaint : colors[i], fontSize: 11 };
        });
        return r;
      };

      _relayChartState.chart.setOption({
        animationDuration: 250,
        color: colors,
        tooltip: {
          trigger: 'axis',
          axisPointer: { type: 'cross', label: { backgroundColor: ink } },
          backgroundColor: relayChartInk('--glass-strong', '#fff'),
          borderColor: relayChartInk('--glass-border', 'rgba(127,127,127,.3)'),
          textStyle: { color: ink, fontSize: 12 },
          confine: true,
          // 自定义 formatter:该时段没调用的系列整行省略(默认会列全系列占满 '-');
          // confine 保证用户多时 tooltip 不溢出画布
          formatter: function(params) {
            if (!params || !params.length) return '';
            var fmtVal = function(v) { return isTokens ? fmtTokensMB(v) : String(v); };
            var html = params[0].axisValue + '<br/>';
            params.forEach(function(p) {
              // 中途补 0 的小时同样是"该系列没调用",与 null 一样整行省略
              if (p.value == null || p.value === 0) return;
              // 注意:tooltip params 里 p.name 是类目轴值(时间),系列名是 p.seriesName
              html += p.marker + ' ' + p.seriesName + '&nbsp;&nbsp;<b>' + fmtVal(p.value) + '</b><br/>';
            });
            return html;
          }
        },
        legend: {
          type: 'scroll',
          top: 0,
          icon: 'circle',
          itemWidth: 10,
          itemHeight: 10,
          itemGap: 14,
          inactiveColor: inkFaint,
          selected: legendSelected,
          formatter: function(name) {
            var i = nameIdx[name];
            return i == null ? name : ('{c' + i + '|' + name + '}');
          },
          textStyle: { color: inkMute, fontSize: 11, rich: buildRich() },
          pageIconColor: inkMute,
          pageIconInactiveColor: inkFaint,
          pageTextStyle: { color: inkMute }
        },
        grid: { left: 60, right: 20, top: 44, bottom: 58 },
        xAxis: {
          type: 'category',
          data: hours,
          boundaryGap: false,
          axisLine: { show: true, lineStyle: { color: axisColor, width: 1.2 } },
          axisTick: { show: false },
          axisLabel: { color: inkMute, fontSize: 11.5, interval: 2 }
        },
        yAxis: {
          type: 'value',
          axisLine: { show: true, lineStyle: { color: axisColor, width: 1 } },
          axisLabel: { color: inkMute, fontSize: 11.5, formatter: function(v) { return isTokens ? fmtTokensMB(v) : (v >= 1000 ? fmtTokensMB(v) : String(v)); } },
          splitLine: { lineStyle: { color: gridColor } }
        },
        dataZoom: [
          { type: 'inside', xAxisIndex: 0, zoomOnMouseWheel: true, moveOnMouseWheel: true,
            startValue: zoomWindow[0], endValue: zoomWindow[1] },
          { type: 'slider', xAxisIndex: 0, height: 16, bottom: 10,
            startValue: zoomWindow[0], endValue: zoomWindow[1],
            borderColor: 'transparent', backgroundColor: 'rgba(127,127,127,.08)',
            fillerColor: 'rgba(127,127,127,.18)',
            handleIcon: 'circle', handleSize: '70%',
            handleStyle: { color: inkMute },
            moveHandleSize: 5, moveHandleStyle: { color: inkFaint },
            dataBackground: { lineStyle: { color: inkFaint }, areaStyle: { color: 'rgba(127,127,127,.12)' } },
            selectedDataBackground: { lineStyle: { color: inkMute }, areaStyle: { color: 'rgba(127,127,127,.2)' } },
            textStyle: { color: inkFaint, fontSize: 10 },
            brushSelect: false }
        ],
        series: list.map(function(s) {
          return {
            name: s.label,
            type: 'line',
            data: s.values,
            smooth: 0.3,
            lineStyle: { width: 2 },
            itemStyle: { borderWidth: 1.5 },
            symbol: 'circle',
            symbolSize: 6,
            sampling: 'lttb',
            emphasis: { focus: 'series', symbolSize: 8 }
          };
        })
      });

      // 图例选中变化 → 未选中系列文字同步置灰(rich 覆盖了 inactiveColor)
      _relayChartState.chart.off('legendselectchanged');
      _relayChartState.chart.on('legendselectchanged', function(e) {
        selectedMap = e.selected;
        _relayChartState.chart.setOption({ legend: { textStyle: { rich: buildRich() } } });
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

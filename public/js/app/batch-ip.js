    // ============ 批量 IP 白名单(管理员):一键替换/追加智谱账号白名单 IP ============
    // 账号勾选在「账号管理」弹窗的勾选模式完成(mgmtIpNext 带索引打开本弹层),
    // 详情页「批量设置…」入口则以单个账号直开。后端为长任务(每账号 list→diff→
    // 增删,节流防风控),POST 返回 taskId 后 1.2s 轮询进度;关弹层仅停轮询不停
    // 任务,重开时按 taskId 恢复进度视图。

    var _batchIpTimer = null;
    var _batchIpTaskId = null;   // 最近一次发起的任务(恢复视图用)
    var _batchIpSelectedIndexes = [];   // 本次批量的目标账号(表单/返回表单共用)

    function stopBatchIpPoll() {
      if (_batchIpTimer) { clearTimeout(_batchIpTimer); _batchIpTimer = null; }
    }

    function openBatchIp(indexes) { requireAuth(function() { openBatchIpInner(indexes); }); }

    function openBatchIpInner(indexes) {
      // 有进行中/刚结束的任务且弹层重开:恢复进度视图;任务过期(404)则回到表单
      if (_batchIpTaskId) {
        resumeBatchIpView(indexes);
        return;
      }
      _batchIpSelectedIndexes = indexes || [];
      renderBatchIpForm();
      document.getElementById('batchIpOverlay').classList.add('active');
    }

    function resumeBatchIpView(pendingIndexes) {
      fetch(API_PREFIX + '/api/ip-whitelist-batch/' + _batchIpTaskId, { headers: authHeaders() })
        .then(function(r) {
          if (r.status === 404) { _batchIpTaskId = null; return null; }
          if (r.status === 401) { localStorage.removeItem('glm_pwd'); requireAuth(function() { openBatchIpInner(pendingIndexes); }); return null; }
          return r.json();
        })
        .then(function(view) {
          if (!view) { openBatchIpFormWith(pendingIndexes); return; }
          document.getElementById('batchIpOverlay').classList.add('active');
          if (view.status !== 'running') _batchIpTaskId = null;   // 已结束:本次展示结果,再次重开回到表单
          renderBatchIpProgress(view);
          if (view.status === 'running') startBatchIpPoll();
        })
        .catch(function() {
          openBatchIpFormWith(pendingIndexes);
        });
    }

    function openBatchIpFormWith(indexes) {
      _batchIpSelectedIndexes = indexes || [];
      renderBatchIpForm();
      document.getElementById('batchIpOverlay').classList.add('active');
    }

    // 已选账号名称(从 accountsData 按索引取;数据未就绪时显示索引)
    function batchIpSelectedNames() {
      var byIndex = {};
      (accountsData || []).forEach(function(a) { if (a && a.index != null) byIndex[a.index] = a.name; });
      return _batchIpSelectedIndexes.map(function(idx) { return byIndex[idx] || ('#' + idx); });
    }

    function renderBatchIpForm() {
      var body = document.getElementById('batchIpBody');
      var names = batchIpSelectedNames();
      body.innerHTML = ''
        + '<div class="batch-selected"><b>将对 ' + _batchIpSelectedIndexes.length + ' 个智谱账号执行:</b><br>'
        + esc(names.join('、')) + '</div>'
        + '<div class="form-group"><label class="form-label">目标 IP(每行一个,支持 IPv4 或 IPv4/CIDR,如 1.2.3.4 / 10.0.0.0/8)</label>'
        + '<textarea class="form-input" id="batchIpInput" rows="3" placeholder="' + esc('1.2.3.4\n10.0.0.0/8') + '"></textarea></div>'
        + '<div class="form-group"><label class="form-label">执行方式</label>'
        + '<div style="font-size:13px;display:flex;flex-direction:column;gap:6px">'
        + '<label style="display:flex;gap:8px;align-items:baseline"><input type="radio" name="batchIpMode" value="replace" checked>'
        + '<span><b>替换</b> — 白名单整体替换为目标 IP,未列出的现有 IP 将被删除(公司换 IP 场景)</span></label>'
        + '<label style="display:flex;gap:8px;align-items:baseline"><input type="radio" name="batchIpMode" value="append">'
        + '<span><b>追加</b> — 仅添加缺失的 IP,现有白名单全部保留</span></label>'
        + '</div></div>'
        + '<div class="form-actions" style="margin-top:14px">'
        + '<button class="btn-primary" id="batchIpSubmitBtn" onclick="submitBatchIp()">开始执行</button></div>';
    }

    // 解析 IP 输入:换行/逗号/分号/空格分隔均可,trim + 去重保序
    function batchIpParseIps() {
      var seen = {};
      var out = [];
      (document.getElementById('batchIpInput').value || '').split(/[\n,;\s]+/).forEach(function(t) {
        var v = t.trim();
        if (!v || seen[v]) return;
        seen[v] = true;
        out.push(v);
      });
      return out;
    }

    // 与后端 isValidIp 同规则的前端预检(最终以后端校验为准)
    function batchIpLooksValid(ip) {
      var m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(\/(\d{1,2}))?$/);
      if (!m) return false;
      for (var i = 1; i <= 4; i++) if (parseInt(m[i], 10) > 255) return false;
      if (m[6] != null && parseInt(m[6], 10) > 32) return false;
      return true;
    }

    function submitBatchIp() {
      var indexes = _batchIpSelectedIndexes;
      var ips = batchIpParseIps();
      var modeEl = document.querySelector('input[name="batchIpMode"]:checked');
      var mode = modeEl ? modeEl.value : 'replace';
      if (!indexes.length) { alert('请至少勾选一个账号'); return; }
      if (!ips.length) { alert('请至少填写一个目标 IP'); return; }
      var badIp = null;
      for (var i = 0; i < ips.length; i++) { if (!batchIpLooksValid(ips[i])) { badIp = ips[i]; break; } }
      if (badIp) { alert('IP 格式不正确: ' + badIp + '\n支持 IPv4 或 IPv4/CIDR,如 1.2.3.4 或 10.0.0.0/8'); return; }

      var estSec = Math.max(1, Math.ceil(indexes.length * 2));
      var summary = '将对 ' + indexes.length + ' 个智谱账号' + (mode === 'append' ? '追加' : '替换') + '以下 ' + ips.length + ' 个 IP:\n\n' + ips.join('\n')
        + (mode === 'replace' ? '\n\n注意:替换模式下,未列出的现有白名单 IP 将被删除。' : '')
        + '\n\n逐账号串行执行(降低风控风险),预计约 ' + estSec + ' 秒。';
      if (!confirm(summary)) return;

      var btn = document.getElementById('batchIpSubmitBtn');
      btn.disabled = true;
      btn.textContent = '提交中...';
      fetch(API_PREFIX + '/api/ip-whitelist-batch', {
        method: 'POST', headers: authHeaders(),
        body: JSON.stringify({ indexes: indexes, ips: ips, mode: mode })
      })
        .then(function(r) {
          if (r.status === 401) { localStorage.removeItem('glm_pwd'); resetBatchIpSubmitBtn(); requireAuth(function() { submitBatchIp(); }); return null; }
          return r.json().then(function(d) { return { status: r.status, data: d }; });
        })
        .then(function(res) {
          if (!res) return;
          if (res.status !== 200 || !res.data || res.data.error) {
            alert('发起失败: ' + ((res.data && res.data.error) || ('HTTP ' + res.status)));
            resetBatchIpSubmitBtn();
            return;
          }
          _batchIpTaskId = res.data.taskId;
          startBatchIpPoll(true);
        })
        .catch(function(err) { alert('请求失败: ' + err.message); resetBatchIpSubmitBtn(); });
    }

    function resetBatchIpSubmitBtn() {
      var btn = document.getElementById('batchIpSubmitBtn');
      if (btn) { btn.disabled = false; btn.textContent = '开始执行'; }
    }

    function startBatchIpPoll(immediate) {
      stopBatchIpPoll();
      var tick = function() {
        if (!_batchIpTaskId) return;
        fetch(API_PREFIX + '/api/ip-whitelist-batch/' + _batchIpTaskId, { headers: authHeaders() })
          .then(function(r) {
            if (r.status === 404) { _batchIpTaskId = null; return { lost: true }; }
            if (r.status === 401) { localStorage.removeItem('glm_pwd'); stopBatchIpPoll(); requireAuth(function() { startBatchIpPoll(true); }); return null; }
            return r.json();
          })
          .then(function(view) {
            if (!view) return;
            if (!document.getElementById('batchIpOverlay').classList.contains('active')) return;   // 弹层已关:停止轮询(任务后台继续)
            if (view.lost) {
              renderBatchIpLost();
              return;
            }
            renderBatchIpProgress(view);
            if (view.status === 'running') _batchIpTimer = setTimeout(tick, 1200);
            else _batchIpTaskId = null;   // done:保留视图但不再轮询
          })
          .catch(function() {
            // 网络抖动退避重试;弹层已关则不复活定时器(stopBatchIpPoll 已清过)
            if (!document.getElementById('batchIpOverlay').classList.contains('active')) return;
            _batchIpTimer = setTimeout(tick, 2500);
          });
      };
      if (immediate) tick();
      else _batchIpTimer = setTimeout(tick, 1200);
    }

    // 服务重启导致内存任务丢失:提示重新发起(已执行账号的改动已生效)
    function renderBatchIpLost() {
      var body = document.getElementById('batchIpBody');
      if (!body) return;
      body.innerHTML = '<p class="error-text">任务状态丢失(服务可能已重启)。已执行账号的变更已生效,未完成的账号请重新发起。</p>'
        + '<div class="form-actions"><button class="btn-primary" onclick="batchIpBackToForm()">返回重新发起</button></div>';
    }

    function batchIpBackToForm() {
      _batchIpTaskId = null;
      renderBatchIpForm();   // 仍用本次已选账号;要换账号可关闭弹层回管理列表重勾
    }

    function renderBatchIpProgress(view) {
      var body = document.getElementById('batchIpBody');
      if (!body) return;
      var stateText = { pending: '· 待处理', running: '⟳ 执行中', ok: '✓ 成功', error: '✗ 失败' };
      var rows = (view.results || []).map(function(it) {
        var detail = '';
        if (it.status === 'ok') {
          var parts = [];
          if (it.added && it.added.length) parts.push('添加 ' + it.added.join('、'));
          if (it.removed && it.removed.length) parts.push('删除 ' + it.removed.join('、'));
          if (it.keptCount > 0) parts.push('保持 ' + it.keptCount + ' 条');
          detail = parts.length ? esc(parts.join(';')) : '无变化,已是目标状态';
        } else if (it.status === 'error') {
          detail = esc(it.error || '未知错误');
        }
        return '<div class="batch-result-row' + (it.status === 'ok' ? ' is-ok' : '') + (it.status === 'error' ? ' is-error' : '') + '">'
          + '<span class="batch-result-state">' + (stateText[it.status] || it.status) + '</span>'
          + '<span>' + esc(it.name != null ? String(it.name) : ('#' + it.index)) + '</span>'
          + '<span class="batch-result-detail">' + detail + '</span></div>';
      }).join('');
      var okN = (view.results || []).filter(function(it) { return it.status === 'ok'; }).length;
      var errN = (view.results || []).filter(function(it) { return it.status === 'error'; }).length;
      var html = '<div class="form-label">执行进度:' + view.done + ' / ' + view.total + '(' + (view.mode === 'append' ? '追加' : '替换') + ' '
        + esc((view.ips || []).join('、')) + ')</div>'
        + '<div class="batch-results">' + rows + '</div>'
        + (view.status === 'done'
          ? '<div class="batch-summary">完成:成功 ' + okN + ' 个,失败 ' + errN + ' 个。'
            + (errN ? '失败账号可稍后单独重试。' : '') + '</div>'
            + '<div class="form-actions" style="margin-top:14px"><button class="btn-primary" onclick="batchIpBackToForm()">返回表单</button></div>'
          : '<div class="batch-summary" style="color:var(--text-mute)">串行执行中,可关闭本窗口稍后重开查看(任务不会中断)…</div>');
      body.innerHTML = html;
    }

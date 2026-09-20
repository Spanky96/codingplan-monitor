    // ============ Key 操作 ============

    var _svgCopy = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>';
    var _svgCheck = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>';
    var _svgDel = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/></svg>';

    function copySecret(btn, idx, apiKey) {
      if (btn.disabled) return;
      btn.disabled = true;
      btn.innerHTML = '...';
      fetch(API_PREFIX + '/api/keys/' + idx + '/copy/' + apiKey, { headers: authHeaders() })
        .then(function(r) {
          if (r.status === 401) { localStorage.removeItem('glm_pwd'); btn.disabled = false; btn.innerHTML = _svgCopy; requireAuth(function(){copySecret(btn,idx,apiKey)}); return null; }
          return r.json();
        })
        .then(function(d) {
          if (!d) return;
          if (d.error) { btn.disabled = false; btn.innerHTML = _svgCopy; alert('失败: ' + d.error); return; }
          var full = (d.apiKey || apiKey) + '.' + (d.secretKey || '');
          var td = btn.closest('tr').querySelectorAll('td');
          if (td[1]) td[1].textContent = full;
          clipCopy(full).then(function() {
            btn.innerHTML = _svgCheck;
            btn.classList.add('copied');
            setTimeout(function() { btn.innerHTML = _svgCopy; btn.classList.remove('copied'); btn.disabled = false; }, 2000);
          });
        })
        .catch(function() { btn.disabled = false; btn.innerHTML = _svgCopy; });
    }

    function createKey(idx) {
      var input = document.getElementById('newKeyName');
      var name = (input.value || '').trim();
      if (!name) { alert('请输入 Key 名称'); input.focus(); return; }
      input.disabled = true;
      fetch(API_PREFIX + '/api/keys/' + idx, { method: 'POST', headers: authHeaders(), body: JSON.stringify({ name: name }) })
        .then(function(r) {
          if (r.status === 401) { localStorage.removeItem('glm_pwd'); input.disabled = false; requireAuth(function(){createKey(idx)}); return null; }
          return r.json();
        })
        .then(function(d) {
          if (!d) return;
          if (d.error) { alert('创建失败: ' + d.error); input.disabled = false; return; }
          // 创建成功后，通过 copy 接口获取完整密钥再复制
          var apiKey = d.apiKey || '';
          if (apiKey) {
            fetch(API_PREFIX + '/api/keys/' + idx + '/copy/' + apiKey, { headers: authHeaders() })
              .then(function(r) { return r.json(); })
              .then(function(cd) {
                if (cd.error) { alert('创建成功，但获取密钥失败: ' + cd.error); showDetail(idx); return; }
                var full = (cd.apiKey || apiKey) + '.' + (cd.secretKey || '');
                if (full && full !== '.') {
                  clipCopy(full).then(function() { alert('已创建并复制: ' + full); });
                } else {
                  alert('创建成功');
                }
                showDetail(idx);
              })
              .catch(function() { alert('创建成功，但复制失败'); showDetail(idx); });
          } else {
            alert('创建成功');
            showDetail(idx);
          }
        })
        .catch(function(err) { alert('请求失败: ' + err.message); input.disabled = false; });
    }

    function deleteKey(btn, idx, apiKey) {
      if (!confirm('确定删除此 Key？删除后不可恢复。')) return;
      btn.disabled = true;
      btn.innerHTML = '...';
      fetch(API_PREFIX + '/api/keys/' + idx + '/' + apiKey, { method: 'DELETE', headers: authHeaders() })
        .then(function(r) {
          if (r.status === 401) { localStorage.removeItem('glm_pwd'); btn.disabled = false; btn.innerHTML = _svgDel; requireAuth(function(){deleteKey(btn,idx,apiKey)}); return null; }
          return r.json();
        })
        .then(function(d) {
          if (!d) return;
          if (d.error) { alert('删除失败: ' + d.error); btn.disabled = false; btn.innerHTML = _svgDel; return; }
          showDetail(idx);
        })
        .catch(function() { btn.disabled = false; btn.innerHTML = _svgDel; });
    }

    // ============ IP 白名单操作（智谱账号,管理员）============

    var _svgDelIp = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/></svg>';

    function loadIpWhitelist(idx) {
      var container = document.getElementById('ipContainer');
      if (!container) return;
      container._ipLoaded = true;
      container.className = 'keys-loading';
      container.textContent = '加载中...';
      fetch(API_PREFIX + '/api/ip-whitelist/' + idx, { headers: authHeaders() })
        .then(function(r) {
          if (r.status === 401) { localStorage.removeItem('glm_pwd'); requireAuth(function(){loadIpWhitelist(idx)}); return null; }
          return r.json();
        })
        .then(function(rows) {
          if (!rows) return;
          if (rows.error) { container.className = ''; container.innerHTML = '<p class="error-text">' + esc(rows.error) + '</p>'; return; }
          renderIpWhitelist(idx, rows);
        })
        .catch(function(err) { container.className = ''; container.innerHTML = '<p class="error-text">加载失败: ' + esc(err.message) + '</p>'; });
    }

    function renderIpWhitelist(idx, rows) {
      var container = document.getElementById('ipContainer');
      if (!container) return;
      container.className = '';
      if (!rows || !rows.length) {
        container.innerHTML = '<p style="color:var(--text-mute);font-size:13px">暂无白名单 IP(当前不限制访问 IP)</p>';
        return;
      }
      var body = rows.map(function(r) {
        var delBtn = '<button class="icon-btn del-icon" onclick="deleteIpWhitelist(this,' + idx + ',' + r.id + ')" title="删除">' + _svgDelIp + '</button>';
        return '<tr><td class="mono">' + esc(r.ipAddress || '') + '</td><td>' + esc(r.createTime || '-') + '</td>'
          + '<td><div class="key-actions">' + delBtn + '</div></td></tr>';
      }).join('');
      container.innerHTML = '<table class="keys-table"><tr><th>IP 地址</th><th>添加时间</th><th style="width:72px">操作</th></tr>' + body + '</table>';
    }

    function addIpWhitelist(idx) {
      var input = document.getElementById('newIpAddr');
      if (!input) return;
      var ip = (input.value || '').trim();
      if (!ip) { alert('请输入 IP 地址'); input.focus(); return; }
      input.disabled = true;
      fetch(API_PREFIX + '/api/ip-whitelist/' + idx, { method: 'POST', headers: authHeaders(), body: JSON.stringify({ ipAddress: ip }) })
        .then(function(r) {
          if (r.status === 401) { localStorage.removeItem('glm_pwd'); input.disabled = false; requireAuth(function(){addIpWhitelist(idx)}); return null; }
          return r.json();
        })
        .then(function(d) {
          if (!d) return;
          if (d.error) { alert('添加失败: ' + d.error); input.disabled = false; return; }
          input.value = ''; input.disabled = false;
          loadIpWhitelist(idx);
        })
        .catch(function(err) { alert('请求失败: ' + err.message); input.disabled = false; });
    }

    function deleteIpWhitelist(btn, idx, id) {
      if (!confirm('确定删除此白名单 IP？')) return;
      btn.disabled = true;
      btn.innerHTML = '...';
      fetch(API_PREFIX + '/api/ip-whitelist/' + idx + '/' + id, { method: 'DELETE', headers: authHeaders() })
        .then(function(r) {
          if (r.status === 401) { localStorage.removeItem('glm_pwd'); btn.disabled = false; btn.innerHTML = _svgDelIp; requireAuth(function(){deleteIpWhitelist(btn,idx,id)}); return null; }
          return r.json();
        })
        .then(function(d) {
          if (!d) return;
          if (d.error) { alert('删除失败: ' + d.error); btn.disabled = false; btn.innerHTML = _svgDelIp; return; }
          loadIpWhitelist(idx);
        })
        .catch(function() { btn.disabled = false; btn.innerHTML = _svgDelIp; });
    }

    // ============ 重置卡操作（智谱个人版账号,管理员）============

    // 用最新列表刷新内存态并重渲染详情区块与卡片徽章(列表接口与使用接口共用)
    function applyResetCards(idx, cards, checkedAt) {
      accAt(idx).resetCards = (cards && cards.length)
        ? { count: cards.length, cards: cards, checkedAt: checkedAt }
        : null;
      var sec = document.getElementById('resetCards-' + idx);
      if (sec) sec.innerHTML = resetCardsSectionHTML(accAt(idx), true, idx);
      updateCard(idx, accAt(idx));
    }

    function loadResetCards(idx) {
      fetch(API_PREFIX + '/api/reset-cards/' + idx, { headers: authHeaders() })
        .then(function(r) {
          if (r.status === 401) { localStorage.removeItem('glm_pwd'); requireAuth(function(){loadResetCards(idx)}); return null; }
          return r.json();
        })
        .then(function(r) {
          if (!r || r.error) return;
          applyResetCards(idx, r.cards, r.checkedAt);
        })
        .catch(function() {});
    }

    function useResetCard(btn, idx, type, recordId) {
      var label = type === 'fiveHour' ? '5小时重置卡' : '周重置卡';
      if (!confirm('确定使用这张' + label + '？使用后将重置对应周期的用量,且不可撤销。')) return;
      btn.disabled = true;
      btn.textContent = '使用中...';
      fetch(API_PREFIX + '/api/reset-cards/' + idx + '/use', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ type: type, recordId: recordId }) })
        .then(function(r) {
          if (r.status === 401) { localStorage.removeItem('glm_pwd'); btn.disabled = false; btn.textContent = '使用'; requireAuth(function(){useResetCard(btn,idx,type,recordId)}); return null; }
          return r.json();
        })
        .then(function(d) {
          if (!d) return;
          if (d.error) { alert('使用失败: ' + d.error); btn.disabled = false; btn.textContent = '使用'; return; }
          // 直接用返回的最新列表刷新区块与徽章,免二次请求
          applyResetCards(idx, d.cards, d.checkedAt);
          alert('已使用,对应周期用量已重置');
        })
        .catch(function(err) { alert('请求失败: ' + err.message); btn.disabled = false; btn.textContent = '使用'; });
    }


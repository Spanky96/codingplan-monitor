    // ============ 密码验证 ============

    function submitPassword() {
      var pwd = document.getElementById('pwdInput').value;
      fetch(API_PREFIX + '/api/auth', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({password: pwd}) })
        .then(function(r) { return r.json().then(function(d) { return { status: r.status, data: d }; }); })
        .then(function(res) {
          var d = res.data;
          if (d.success) {
            localStorage.setItem('glm_pwd', pwd);
            closeModal('pwdOverlay');
            var next = _pendingAuth;
            _pendingAuth = null;
            // 登录即管理员:重取隐私标记(外网强制态随之解除)并刷新为明文数据
            refreshPrivacyState();
            loadData();
            loadExpire();
            if (FEATURES.relayEnabled) {
              activityApplyVisibility();   // 登录成功后显示实时活动面板(配置了中转站才启用)
              loadActivityDispatch();
              loadActivityUsage();
            }
            if (next) { next(); }
          } else {
            // 429=连续错误被封禁 15 分钟；其余为普通密码错误
            document.getElementById('pwdError').textContent = d.error || '密码错误';
            document.getElementById('pwdInput').value = '';
            document.getElementById('pwdInput').focus();
          }
        });
    }
    document.getElementById('pwdInput').addEventListener('keydown', function(e) { if (e.key === 'Enter') submitPassword(); });

    // ============ 账号管理 ============

    document.getElementById('mgmtBtn').addEventListener('click', function() { requireAuth(openMgmtInner); });

    var editingIndex = -1;

    function openMgmtInner() {
      editingIndex = -1;
      renderMgmtList();
      document.getElementById('mgmtOverlay').classList.add('active');
    }

    var _dragSrcIdx = null;
    var _svgGrip = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/></svg>';

    function renderMgmtList() {
      document.getElementById('mgmtTitle').textContent = '账号管理';
      fetch(API_PREFIX + '/api/accounts', { headers: authHeaders() })
        .then(function(r) { if (r.status===401){localStorage.removeItem('glm_pwd');alert('密码已失效');closeModal('mgmtOverlay');refreshPrivacyState();loadData();loadExpire();return null;} return r.json(); })
        .then(function(accounts) {
          if (!accounts) return;
          var html = '';
          if (!accounts.length) html += '<div style="text-align:center;padding:24px;color:var(--text-mute);font-size:13px">暂无账号</div>';
          accounts.forEach(function(a, i) {
            html += '<div class="acct-item" draggable="true" data-idx="'+i+'"><div class="drag-handle" title="拖动排序">' + _svgGrip + '</div>'
              + '<div class="acct-info"><div class="acct-name">' + platformTag(a.platform || 'glm', null, a.alias) + ' ' + esc(a.name||'未命名') + '</div>'
              + '<div class="acct-meta">' + esc(a.responsiblePerson||'') + (a.phone?' &middot; '+esc(a.phone):'') + '</div></div>'
              + '<div class="acct-actions"><button class="btn-sm" onclick="editAccount('+i+')">编辑</button><button class="btn-sm danger" onclick="deleteAccount('+i+')">删除</button></div></div>';
          });
          html += '<button class="btn-add" onclick="showForm(-1)">+ 新增账号</button>';
          document.getElementById('mgmtBody').innerHTML = html;
          initDragSort();
        });
    }

    function initDragSort() {
      var items = document.querySelectorAll('.acct-item[draggable]');
      items.forEach(function(el) {
        el.addEventListener('dragstart', function(e) {
          _dragSrcIdx = parseInt(el.dataset.idx);
          el.classList.add('dragging');
          e.dataTransfer.effectAllowed = 'move';
        });
        el.addEventListener('dragend', function() {
          el.classList.remove('dragging');
          document.querySelectorAll('.acct-item.drag-over').forEach(function(x){ x.classList.remove('drag-over'); });
        });
        el.addEventListener('dragover', function(e) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          el.classList.add('drag-over');
        });
        el.addEventListener('dragleave', function() {
          el.classList.remove('drag-over');
        });
        el.addEventListener('drop', function(e) {
          e.preventDefault();
          el.classList.remove('drag-over');
          var targetIdx = parseInt(el.dataset.idx);
          if (_dragSrcIdx === null || _dragSrcIdx === targetIdx) return;
          // 从服务端拿最新数据做重排
          fetch(API_PREFIX + '/api/accounts', { headers: authHeaders() })
            .then(function(r){ return r.json(); })
            .then(function(accounts) {
              var moved = accounts.splice(_dragSrcIdx, 1)[0];
              accounts.splice(targetIdx, 0, moved);
              return fetch(API_PREFIX + '/api/accounts', { method: 'PUT', headers: authHeaders(), body: JSON.stringify(accounts) });
            })
            .then(function(r){ return r.json(); })
            .then(function(d) {
              if (d.error) { alert('排序失败: ' + d.error); return; }
              renderMgmtList();
              loadData();
              loadExpire();
            });
        });
      });
    }

    function showForm(idx) {
      editingIndex = idx;
      document.getElementById('mgmtTitle').textContent = idx >= 0 ? '编辑账号' : '新增账号';
      if (idx >= 0) {
        fetch(API_PREFIX + '/api/accounts',{headers:authHeaders()}).then(function(r){return r.json()}).then(function(a){renderForm(a[idx]||{})});
      } else { renderForm({}); }
    }

    function renderForm(a) {
      var origPlatform = a.platform || 'glm';
      // 旧 huoli 账号即 sub2api 部署,编辑时归入 sub2api(默认回填 huolilink)
      var platform = origPlatform === 'huoli' ? 'sub2api' : origPlatform;
      var glmDisp = platform === 'glm' ? '' : 'none';
      var yesDisp = platform === 'yescode' ? '' : 'none';
      var sub2apiDisp = platform === 'sub2api' ? '' : 'none';
      var volcDisp = platform === 'volc' ? '' : 'none';
      var telecomDisp = platform === 'telecomjs' ? '' : 'none';
      var qwenDisp = platform === 'qwen' ? '' : 'none';
      var minimaxDisp = platform === 'minimax' ? '' : 'none';
      var stepfunDisp = platform === 'stepfun' ? '' : 'none';
      document.getElementById('mgmtBody').innerHTML = ''
        + '<div class="import-section"><div class="import-toggle" onclick="this.nextElementSibling.classList.toggle(\'open\')">&#9660; 快速导入（粘贴 fetch 命令）</div>'
        + '<div class="import-body"><textarea class="form-input" id="f_fetch" placeholder="粘贴 fetch / cURL 命令，自动识别智谱 / YesCode / Sub2API 中转站 / 火山 / 智云 / 千问 / MiniMax / 阶跃星辰"></textarea>'
        + '<div class="import-actions"><button class="btn-primary" style="padding:5px 16px;font-size:12px" onclick="parseFetch()">解析并填充</button></div></div></div>'
        + '<div class="form-row">'
        + '<div class="form-group"><label class="form-label">站点</label><select class="form-input" id="f_platform" onchange="onPlatformChange()">'
        + '<option value="glm"' + (platform==='glm'?' selected':'') + '>智谱</option>'
        + '<option value="yescode"' + (platform==='yescode'?' selected':'') + '>YesCode</option>'
        + '<option value="sub2api"' + (platform==='sub2api'?' selected':'') + '>Sub2API 中转站</option>'
        + '<option value="volc"' + (platform==='volc'?' selected':'') + '>火山</option>'
        + '<option value="telecomjs"' + (platform==='telecomjs'?' selected':'') + '>智云</option>'
        + '<option value="qwen"' + (platform==='qwen'?' selected':'') + '>千问</option>'
        + '<option value="minimax"' + (platform==='minimax'?' selected':'') + '>MiniMax</option>'
        + '<option value="stepfun"' + (platform==='stepfun'?' selected':'') + '>阶跃星辰</option>'
        + '</select></div>'
        + '<div class="form-group"><label class="form-label">账号名称</label><input class="form-input" id="f_name" value="' + esc(a.name||'') + '"></div>'
        + '</div>'
        + '<div id="f_glm_fields" style="display:' + glmDisp + '">'
        + '<div class="form-group"><label class="form-label">Authorization Token</label><textarea class="form-input" id="f_auth">' + esc(a.authorization||'') + '</textarea></div>'
        + '<div class="form-row"><div class="form-group"><label class="form-label">Organization ID</label><input class="form-input" id="f_org" value="' + esc(a.organization||'') + '"></div>'
        + '<div class="form-group"><label class="form-label">Project ID</label><input class="form-input" id="f_proj" value="' + esc(a.project||'') + '"></div></div>'
        + '<div class="form-row"><div class="form-group"><label class="form-label">登录账号（可选）</label><input class="form-input" id="f_glm_username" placeholder="Token 失效时自动重新登录" value="' + esc(a.glm_username||'') + '" autocomplete="off"></div>'
        + '<div class="form-group"><label class="form-label">登录密码（可选）</label><input class="form-input" type="password" id="f_glm_password" placeholder="非必填；与账号同时填写才启用自动重登" value="' + esc(a.glm_password||'') + '" autocomplete="new-password"></div></div>'
        + '<div class="form-group"><label class="form-label" style="display:flex;align-items:center;gap:6px;cursor:pointer"><input type="checkbox" id="f_team_edition"' + (a.teamEdition ? ' checked' : '') + ' style="width:16px;height:16px;cursor:pointer"> 团队版（接口 URL 加 type=2）</label></div>'
        + '</div>'
        + '<div id="f_yescode_fields" style="display:' + yesDisp + '">'
        + '<div class="form-group"><label class="form-label">Cookie（可不填）</label><textarea class="form-input" id="f_cookie" placeholder="完整 Cookie，用于访问 co.yes.vg；官方有效期已缩短为 24h，配置账密后会自动登录刷新">' + esc(a.cookie||'') + '</textarea></div>'
        + '<div class="form-row"><div class="form-group"><label class="form-label">登录账号（推荐）</label><input class="form-input" id="f_yescode_username" placeholder="邮箱/用户名，Cookie 失效时自动登录" value="' + esc(a.yescode_username||'') + '" autocomplete="off"></div>'
        + '<div class="form-group"><label class="form-label">登录密码（推荐）</label><input class="form-input" type="password" id="f_yescode_password" placeholder="与账号同时填写才启用自动重登" value="' + esc(a.yescode_password||'') + '" autocomplete="new-password"></div></div>'
        + '</div>'
        + '<div id="f_sub2api_fields" style="display:' + sub2apiDisp + '">'
        + '<div class="form-row"><div class="form-group"><label class="form-label">站点别名</label><input class="form-input" id="f_sub2api_alias" placeholder="如 SUPER·NB，卡片平台角标显示用" value="' + esc(a.alias||'') + '"></div>'
        + '<div class="form-group"><label class="form-label">站点地址</label><input class="form-input" id="f_sub2api_base" placeholder="https://super-nb.me" value="' + esc(a.base_url || (origPlatform === 'huoli' ? 'https://huolilink.com' : '')) + '"></div></div>'
        + '<div class="form-group"><label class="form-label">Authorization Token（可不填）</label><textarea class="form-input" id="f_sub2api_auth" placeholder="Bearer eyJ...；官方有效期仅 24h，配置账密后会自动登录刷新">' + esc(a.authorization||'') + '</textarea></div>'
        + '<div class="form-row"><div class="form-group"><label class="form-label">登录邮箱（推荐）</label><input class="form-input" id="f_sub2api_email" placeholder="用于 Token 过期时自动登录" value="' + esc(a.sub2api_email||a.huoli_email||'') + '"></div>'
        + '<div class="form-group"><label class="form-label">登录密码（推荐）</label><input class="form-input" type="password" id="f_sub2api_password" placeholder="与邮箱同时填写才启用自动重登" value="' + esc(a.sub2api_password||a.huoli_password||'') + '" autocomplete="new-password"></div></div>'
        + '</div>'
        + '<div id="f_volc_fields" style="display:' + volcDisp + '">'
        + '<div class="form-group"><label class="form-label">套餐类型</label><div style="display:flex;gap:18px;align-items:center;flex-wrap:wrap">'
        + '<label style="display:flex;align-items:center;gap:6px;cursor:pointer"><input type="radio" name="f_volc_plan" value="agent"' + (a.planType !== 'coding' ? ' checked' : '') + ' style="width:16px;height:16px;cursor:pointer"> AgentPlan（火山A）</label>'
        + '<label style="display:flex;align-items:center;gap:6px;cursor:pointer"><input type="radio" name="f_volc_plan" value="coding"' + (a.planType === 'coding' ? ' checked' : '') + ' style="width:16px;height:16px;cursor:pointer"> CodingPlan（火山C）</label>'
        + '</div></div>'
        + '<div class="form-group"><label class="form-label">Cookie</label><textarea class="form-input" id="f_volc_cookie" placeholder="完整 Cookie，用于访问 console.volcengine.com">' + esc(a.cookie||'') + '</textarea></div>'
        + '<div class="form-row"><div class="form-group"><label class="form-label">X-CSRF-Token</label><input class="form-input" id="f_volc_csrf" value="' + esc(a.csrf||'') + '"></div>'
        + '<div class="form-group"><label class="form-label">X-Web-Id（可选）</label><input class="form-input" id="f_volc_webid" value="' + esc(a.web_id||'') + '"></div></div>'
        + '</div>'
        + '<div id="f_telecom_fields" style="display:' + telecomDisp + '">'
        + '<div class="form-group"><label class="form-label">Satoken</label><textarea class="form-input" id="f_satoken" placeholder="智云页面请求头中的 Satoken">' + esc(a.satoken||'') + '</textarea></div>'
        + '</div>'
        + '<div id="f_qwen_fields" style="display:' + qwenDisp + '">'
        + '<div class="form-group"><label class="form-label">Cookie</label><textarea class="form-input" id="f_qwen_cookie" placeholder="完整 Cookie，用于访问 platform.qianwenai.com（建议 Copy as cURL 带出登录态）">' + esc(a.cookie||'') + '</textarea></div>'
        + '<div class="form-row"><div class="form-group"><label class="form-label">Sec Token</label><input class="form-input" id="f_qwen_sec_token" placeholder="请求 body 中的 sec_token" value="' + esc(a.sec_token||'') + '"></div>'
        + '<div class="form-group"><label class="form-label">Nbid（可选）</label><input class="form-input" id="f_qwen_nbid" placeholder="请求 body params 中的 Nbid" value="' + esc(a.nbid||'') + '"></div></div>'
        + '</div>'
        + '<div id="f_minimax_fields" style="display:' + minimaxDisp + '">'
        + '<div class="form-group"><label class="form-label">Cookie</label><textarea class="form-input" id="f_minimax_cookie" placeholder="完整 Cookie，用于访问 www.minimaxi.com（建议从 platform.minimaxi.com 请求 Copy as cURL 带出登录态）">' + esc(a.cookie||'') + '</textarea></div>'
        + '<div class="form-group"><label class="form-label">Group ID（可选）</label><input class="form-input" id="f_minimax_group_id" placeholder="请求头 x-group-id；留空时自动取 Cookie 中的 minimax_group_id_v2" value="' + esc(a.group_id||'') + '"></div>'
        + '</div>'
        + '<div id="f_stepfun_fields" style="display:' + stepfunDisp + '">'
        + '<div class="form-group"><label class="form-label">Cookie</label><textarea class="form-input" id="f_stepfun_cookie" placeholder="完整 Cookie，用于访问 platform.stepfun.com（建议 Copy as cURL 带出登录态，须含 Oasis-Token 双段 JWT 与 _wafdytokenv1）；access 段 30 分钟自动续期回写">' + esc(a.cookie||'') + '</textarea></div>'
        + '<div class="form-group"><label class="form-label">Webid（可选）</label><input class="form-input" id="f_stepfun_webid" placeholder="请求头 oasis-webid；留空时自动取 Cookie 中的 Oasis-Webid" value="' + esc(a.stepfun_webid||'') + '"></div>'
        + '</div>'
        + '<div class="form-row"><div class="form-group"><label class="form-label">负责人</label><input class="form-input" id="f_person" value="' + esc(a.responsiblePerson||'') + '"></div>'
        + '<div class="form-group"><label class="form-label">电话</label><input class="form-input" id="f_phone" value="' + esc(a.phone||'') + '"></div></div>'
        + '<div class="form-group"><label class="form-label">备注</label><input class="form-input" id="f_notes" value="' + esc(a.notes||'') + '"></div>'
        + '<div class="form-group"><label class="form-label" style="display:flex;align-items:center;gap:6px;cursor:pointer"><input type="checkbox" id="f_public"' + (a.isPublic !== false ? ' checked' : '') + ' style="width:16px;height:16px;cursor:pointer"> 公开（未登录管理员时可见）</label></div>'
        + '<div class="form-actions"><button class="btn-default" onclick="renderMgmtList()">取消</button><button class="btn-primary" onclick="saveAccount()">保存</button></div>';
    }

    function onPlatformChange() {
      var p = document.getElementById('f_platform').value;
      document.getElementById('f_glm_fields').style.display = p === 'glm' ? '' : 'none';
      document.getElementById('f_yescode_fields').style.display = p === 'yescode' ? '' : 'none';
      document.getElementById('f_sub2api_fields').style.display = p === 'sub2api' ? '' : 'none';
      document.getElementById('f_volc_fields').style.display = p === 'volc' ? '' : 'none';
      document.getElementById('f_telecom_fields').style.display = p === 'telecomjs' ? '' : 'none';
      document.getElementById('f_qwen_fields').style.display = p === 'qwen' ? '' : 'none';
      document.getElementById('f_minimax_fields').style.display = p === 'minimax' ? '' : 'none';
      document.getElementById('f_stepfun_fields').style.display = p === 'stepfun' ? '' : 'none';
    }

    // 从 fetch / Node fetch / cURL 文本中提取指定 header 值
    function extractHeader(text, name) {
      var esc = name.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
      // "name": "value" 或 'name': 'value'
      var m = text.match(new RegExp('["\']' + esc + '["\']\\s*:\\s*["\']([^"\']+)["\']', 'i'));
      if (m) return m[1];
      // -H 'name: value' / -H "name: value" / --header 'name: value'
      m = text.match(new RegExp('(?:-H|--header)\\s+["\']' + esc + '\\s*:\\s*([^"\']+)["\']', 'i'));
      if (m) return m[1].trim();
      // 行内格式 name: value（多行 fetch/curl）
      m = text.match(new RegExp('(?:^|\\n)\\s*' + esc + '\\s*:\\s*([^\\n\\r]+)', 'i'));
      if (m) return m[1].trim();
      return null;
    }

    function extractCookie(text) {
      var v = extractHeader(text, 'cookie');
      if (v) return v;
      // cURL 的 -b / --cookie
      var m = text.match(/(?:-b|--cookie)\s+["']([^"']+)["']/i);
      if (m) return m[1].trim();
      return null;
    }

    function parseFetch() {
      var t = document.getElementById('f_fetch').value; if (!t.trim()) return;
      var isYescode = /yes\.vg/i.test(t);
      var isSub2api = /\/api\/v1\/(auth\/login|auth\/me|subscriptions)/i.test(t);
      var isVolc = /volcengine\.com|console\.volcengine/i.test(t);
      var isTelecom = /token\.telecomjs\.com|card-with-time-range|satoken/i.test(t);
      var isGlm = /bigmodel\.cn|bigmodel-organization|bigmodel-project/i.test(t);
      var isQwen = /qianwenai\.com|sfm_tokenplansolo|tokenplan\/personal/i.test(t);
      var isMinimax = /minimaxi\.com|minimax_group_id/i.test(t);
      var isStepfun = /platform\.stepfun\.com|oasis-token|oasis-webid/i.test(t);

      if (isTelecom && !isGlm) {
        document.getElementById('f_platform').value = 'telecomjs';
        onPlatformChange();
        var satoken = extractHeader(t, 'satoken');
        if (satoken) document.getElementById('f_satoken').value = satoken;
        else alert('未能解析出 Satoken，请从智云费用接口请求头复制 Satoken。');
        return;
      }

      if (isVolc && !isGlm) {
        var coding = /GetCodingPlanUsage|coding-plan/i.test(t);
        document.getElementById('f_platform').value = 'volc';
        var planRadio = document.querySelector('input[name=f_volc_plan][value="' + (coding ? 'coding' : 'agent') + '"]');
        if (planRadio) planRadio.checked = true;
        onPlatformChange();
        var cookie = extractCookie(t);
        var csrf = extractHeader(t, 'x-csrf-token');
        var webid = extractHeader(t, 'x-web-id');
        if (cookie) { document.getElementById('f_volc_cookie').value = cookie; }
        if (csrf) { document.getElementById('f_volc_csrf').value = csrf; }
        if (webid) { document.getElementById('f_volc_webid').value = webid; }
        if (!cookie) {
          alert('未能解析出 Cookie。\n\n「Copy as fetch」不会包含 Cookie 头（它靠 credentials:include 由浏览器自动带），\n请改用：右键请求 → Copy → Copy as cURL (bash)，\ncURL 复制会带出完整 Cookie（含 HttpOnly 登录态），再粘贴到这里解析。');
        } else if (!csrf) {
          alert('已解析出 Cookie，但未解析出 X-CSRF-Token，请确认复制的是 GetAgentPlanAFPUsage 或 GetCodingPlanUsage 请求。');
        }
        return;
      }

      if (isYescode && !isGlm) {
        document.getElementById('f_platform').value = 'yescode';
        onPlatformChange();
        var cookie = extractCookie(t);
        if (cookie) { document.getElementById('f_cookie').value = cookie; }
        // 登录接口 fetch 可解析出 username/password（官方 Cookie 有效期仅 24h，推荐直接配账密自动续期）
        var ycBodyMatch = t.match(/"body"\s*:\s*"({[^"]+})"/);
        if (ycBodyMatch) { try { var yb = JSON.parse(ycBodyMatch[1].replace(/\\"/g,'"').replace(/\\\\/g,'\\')); if (yb.username) document.getElementById('f_yescode_username').value = yb.username; if (yb.password) document.getElementById('f_yescode_password').value = yb.password; } catch(e){} }
        if (!ycBodyMatch) { try { var yb2 = t.match(/"username"\s*:\s*"([^"]+)"[^}]*"password"\s*:\s*"([^"]+)"/); if (yb2) { document.getElementById('f_yescode_username').value = yb2[1]; document.getElementById('f_yescode_password').value = yb2[2]; } } catch(e){} }
        if (!cookie && !document.getElementById('f_yescode_username').value) {
          alert('未能解析出 cookie 或登录账密。\n\n配置账密：复制登录接口（auth/login）请求 → Copy as fetch 粘贴；\n配置 Cookie：DevTools Network 右键请求 → Copy as cURL（fetch 格式不含 Cookie）。');
        }
        return;
      }

      if (isSub2api && !isGlm && !isYescode) {
        document.getElementById('f_platform').value = 'sub2api';
        onPlatformChange();
        // 站点地址取 fetch URL 的 origin
        var s2Base = t.match(/https?:\/\/[^\/"'\s]+\/api\/v1\//);
        if (s2Base) { document.getElementById('f_sub2api_base').value = s2Base[0].replace(/\/api\/v1\/$/, ''); }
        var auth = extractHeader(t, 'authorization');
        if (auth) { document.getElementById('f_sub2api_auth').value = auth; }
        // 尝试从 body 中解析 email/password（登录接口）
        var bodyMatch = t.match(/"body"\s*:\s*"({[^"]+})"/);
        if (bodyMatch) { try { var b = JSON.parse(bodyMatch[1].replace(/\\"/g,'"').replace(/\\\\/g,'\\')); if (b.email) document.getElementById('f_sub2api_email').value = b.email; if (b.password) document.getElementById('f_sub2api_password').value = b.password; } catch(e){} }
        if (!bodyMatch) { try { var b2 = t.match(/"email"\s*:\s*"([^"]+)"[^}]*"password"\s*:\s*"([^"]+)"/); if (b2) { document.getElementById('f_sub2api_email').value = b2[1]; document.getElementById('f_sub2api_password').value = b2[2]; } } catch(e){} }
        if (!s2Base) { alert('未能解析出站点地址，请手动填写 BaseUrl。'); }
        else if (!auth && !document.getElementById('f_sub2api_email').value) {
          alert('未能解析出 Authorization 或登录账密。\n\n推荐复制登录接口（auth/login）请求 → Copy as fetch 粘贴，\n邮箱密码会自动解析；Token 失效后自动重登续期。');
        }
        return;
      }

      if (isQwen) {
        document.getElementById('f_platform').value = 'qwen';
        onPlatformChange();
        var qCookie = extractCookie(t);
        if (qCookie) { document.getElementById('f_qwen_cookie').value = qCookie; }
        var secMatch = t.match(/sec_token=([A-Za-z0-9_-]+)/);
        if (secMatch) { document.getElementById('f_qwen_sec_token').value = secMatch[1]; }
        var nbidMatch = t.match(/%22Nbid%22%3A%22([0-9a-zA-Z_-]+)/) || t.match(/"Nbid"\s*:\s*"([^"]+)"/);
        if (nbidMatch) { document.getElementById('f_qwen_nbid').value = nbidMatch[1]; }
        if (!qCookie) {
          alert('未能解析出 Cookie。\n\n「Copy as fetch」不会包含 Cookie 头（它靠 credentials:include 由浏览器自动带），\n请改用：右键请求 -> Copy -> Copy as cURL (bash)，\ncURL 复制会带出完整 Cookie（含登录态），再粘贴到这里解析。');
        } else if (!secMatch) {
          alert('已解析出 Cookie，但未解析出 sec_token，请确认复制的是 tokenplan usage 或 subscription 请求。');
        }
        return;
      }

      if (isMinimax) {
        document.getElementById('f_platform').value = 'minimax';
        onPlatformChange();
        var mmCookie = extractCookie(t);
        if (mmCookie) { document.getElementById('f_minimax_cookie').value = mmCookie; }
        var groupId = extractHeader(t, 'x-group-id');
        if (!groupId && mmCookie) {
          var gm = mmCookie.match(/minimax_group_id_v2=(\d+)/);
          if (gm) groupId = gm[1];
        }
        if (groupId) { document.getElementById('f_minimax_group_id').value = groupId; }
        if (!mmCookie) {
          alert('未能解析出 Cookie。\n\n「Copy as fetch」不会包含 Cookie 头（它靠 credentials:include 由浏览器自动带），\n请改用：右键请求 -> Copy -> Copy as cURL (bash)，\ncURL 复制会带出完整 Cookie（含登录态），再粘贴到这里解析。');
        }
        return;
      }

      if (isStepfun) {
        document.getElementById('f_platform').value = 'stepfun';
        onPlatformChange();
        var sfCookie = extractCookie(t);
        if (sfCookie) { document.getElementById('f_stepfun_cookie').value = sfCookie; }
        var sfWebid = extractHeader(t, 'oasis-webid');
        if (!sfWebid && sfCookie) {
          var swm = sfCookie.match(/Oasis-Webid=([^;\s]+)/);
          if (swm) sfWebid = swm[1];
        }
        if (sfWebid) { document.getElementById('f_stepfun_webid').value = sfWebid; }
        if (!sfCookie) {
          alert('未能解析出 Cookie。\n\n「Copy as fetch」不会包含 Cookie 头（它靠 credentials:include 由浏览器自动带），\n请改用：右键请求 -> Copy -> Copy as cURL (bash)，\ncURL 复制会带出完整 Cookie（含 Oasis-Token 登录态与 _wafdytokenv1），再粘贴到这里解析。');
        } else if (!/Oasis-Token=/.test(sfCookie)) {
          alert('已解析出 Cookie，但其中缺少 Oasis-Token 登录态，请确认复制的是登录后的请求。');
        }
        return;
      }

      document.getElementById('f_platform').value = 'glm';
      onPlatformChange();
      var n = 0;
      var auth = extractHeader(t, 'authorization'); if (auth) { document.getElementById('f_auth').value = auth; n++; }
      var org = extractHeader(t, 'bigmodel-organization'); if (org) { document.getElementById('f_org').value = org; n++; }
      var proj = extractHeader(t, 'bigmodel-project'); if (proj) { document.getElementById('f_proj').value = proj; n++; }
      // 自动识别团队版：URL 中包含 type=2
      if (/[?&]type=2/.test(t)) { document.getElementById('f_team_edition').checked = true; }
      if (!n) alert('未能解析出 token、organization 或 project');
    }

    function saveAccount() {
      var platform = document.getElementById('f_platform').value;
      var body = {
        platform: platform,
        name: document.getElementById('f_name').value.trim(),
        responsiblePerson: document.getElementById('f_person').value.trim(),
        phone: document.getElementById('f_phone').value.trim(),
        notes: document.getElementById('f_notes').value.trim(),
        isPublic: document.getElementById('f_public').checked
      };
      if (platform === 'yescode') {
        body.cookie = document.getElementById('f_cookie').value.trim();
        body.yescode_username = document.getElementById('f_yescode_username').value.trim();
        body.yescode_password = document.getElementById('f_yescode_password').value;
        if (!body.name) { alert('账号名称不能为空'); return; }
        // 官方 Cookie 有效期仅 24h：Cookie 与账密至少配一样，配了账密即可自动续期
        if (!body.cookie && !(body.yescode_username && body.yescode_password)) { alert('Cookie 与 登录账号/密码 至少填写一项；推荐填账密，Cookie 失效后自动重登刷新'); return; }
        // 账密需成对：只填其一也允许保存，但不会触发自动重登
        if ((body.yescode_username && !body.yescode_password) || (!body.yescode_username && body.yescode_password)) {
          if (!confirm('登录账号/密码需同时填写才会在 Cookie 失效时自动重登。当前只填了一项，仍要保存吗？')) return;
        }
      } else if (platform === 'sub2api') {
        body.alias = document.getElementById('f_sub2api_alias').value.trim();
        body.base_url = document.getElementById('f_sub2api_base').value.trim().replace(/\/+$/, '');
        body.authorization = document.getElementById('f_sub2api_auth').value.trim();
        body.sub2api_email = document.getElementById('f_sub2api_email').value.trim();
        body.sub2api_password = document.getElementById('f_sub2api_password').value;
        if (!body.name) { alert('账号名称不能为空'); return; }
        if (!body.base_url || !/^https?:\/\//.test(body.base_url)) { alert('站点地址必填，需以 http(s):// 开头'); return; }
        // token 24h 过期:token 与账密至少配一样,配了账密即可自动续期
        if (!body.authorization && !(body.sub2api_email && body.sub2api_password)) { alert('Authorization Token 与 登录邮箱/密码 至少填写一项；推荐填账密，Token 失效后自动重登刷新'); return; }
        if ((body.sub2api_email && !body.sub2api_password) || (!body.sub2api_email && body.sub2api_password)) {
          if (!confirm('登录邮箱/密码需同时填写才会在 Token 失效时自动重登。当前只填了一项，仍要保存吗？')) return;
        }
      } else if (platform === 'volc') {
        body.cookie = document.getElementById('f_volc_cookie').value.trim();
        body.csrf = document.getElementById('f_volc_csrf').value.trim();
        body.web_id = document.getElementById('f_volc_webid').value.trim();
        var planSel = document.querySelector('input[name=f_volc_plan]:checked');
        body.planType = planSel ? planSel.value : 'agent';
        if (!body.name || !body.cookie || !body.csrf) { alert('账号名称、Cookie 和 X-CSRF-Token 不能为空'); return; }
      } else if (platform === 'telecomjs') {
        body.satoken = document.getElementById('f_satoken').value.trim();
        if (!body.name || !body.satoken) { alert('账号名称和 Satoken 不能为空'); return; }
      } else if (platform === 'qwen') {
        body.cookie = document.getElementById('f_qwen_cookie').value.trim();
        body.sec_token = document.getElementById('f_qwen_sec_token').value.trim();
        body.nbid = document.getElementById('f_qwen_nbid').value.trim();
        if (!body.name || !body.cookie || !body.sec_token) { alert('账号名称、Cookie 和 Sec Token 不能为空'); return; }
      } else if (platform === 'minimax') {
        body.cookie = document.getElementById('f_minimax_cookie').value.trim();
        body.group_id = document.getElementById('f_minimax_group_id').value.trim();
        if (!body.name || !body.cookie) { alert('账号名称和 Cookie 不能为空'); return; }
      } else if (platform === 'stepfun') {
        body.cookie = document.getElementById('f_stepfun_cookie').value.trim();
        body.stepfun_webid = document.getElementById('f_stepfun_webid').value.trim();
        if (!body.name || !body.cookie) { alert('账号名称和 Cookie 不能为空'); return; }
        // Cookie 必须带 Oasis-Token 登录态（双段 JWT）；缺省时提示但仍允许保存（如只先占位）
        if (body.cookie && !/Oasis-Token=/.test(body.cookie)) {
          if (!confirm('Cookie 中未检测到 Oasis-Token 登录态，保存后将无法抓取用量。仍要保存吗？')) return;
        }
      } else {
        body.authorization = document.getElementById('f_auth').value.trim();
        body.organization = document.getElementById('f_org').value.trim();
        body.project = document.getElementById('f_proj').value.trim();
        body.glm_username = document.getElementById('f_glm_username').value.trim();
        body.glm_password = document.getElementById('f_glm_password').value;
        body.teamEdition = document.getElementById('f_team_edition').checked || undefined;
        if (!body.name || !body.authorization) { alert('账号名称和 Token 不能为空'); return; }
        // 账密需成对：只填其一也允许保存，但不会触发自动重登
        if ((body.glm_username && !body.glm_password) || (!body.glm_username && body.glm_password)) {
          if (!confirm('登录账号/密码需同时填写才会在 Token 失效时自动重登。当前只填了一项，仍要保存吗？')) return;
        }
      }
      var method = editingIndex>=0?'PUT':'POST', url = editingIndex>=0?API_PREFIX + '/api/accounts/'+editingIndex:API_PREFIX + '/api/accounts';
      fetch(url,{method:method,headers:authHeaders(),body:JSON.stringify(body)}).then(function(r){return r.json()}).then(function(d){
        if(d.error){alert('保存失败: '+d.error);return;} renderMgmtList(); loadData();
      }).catch(function(e){alert('请求失败: '+e.message)});
    }

    function editAccount(i){showForm(i)}
    function deleteAccount(i) {
      if(!confirm('确定删除该账号？'))return;
      fetch(API_PREFIX + '/api/accounts/'+i,{method:'DELETE',headers:authHeaders()}).then(function(r){return r.json()}).then(function(d){
        if(d.error){alert('删除失败: '+d.error);return;} renderMgmtList(); loadData();
      });
    }


    // ============ 智云扫码登录 ============

    function telecomJsonFetch(url, options) {
      options = options || {};
      options.headers = authHeaders();
      return fetch(url, options).then(function(r) {
        return r.json().catch(function(){ return {}; }).then(function(d) {
          if (!r.ok || d.error) throw new Error(d.error || ('请求失败: HTTP ' + r.status));
          return d;
        });
      });
    }

    function setTelecomLoginStatus(text, type) {
      var el = document.getElementById('telecomLoginStatus');
      if (!el) return;
      el.textContent = text || '';
      el.className = 'telecom-login-status' + (type ? ' ' + type : '');
    }

    function clearTelecomLoginTimers() {
      if (_telecomLoginPollTimer) clearInterval(_telecomLoginPollTimer);
      if (_telecomQrTimer) clearInterval(_telecomQrTimer);
      _telecomLoginPollTimer = null;
      _telecomQrTimer = null;
      if (_telecomQrObjectUrl) URL.revokeObjectURL(_telecomQrObjectUrl);
      _telecomQrObjectUrl = null;
      _telecomQrLoading = false;
    }

    function stopTelecomLogin(cancelRemote) {
      _telecomLoginGeneration++;
      clearTelecomLoginTimers();
      var sessionId = _telecomLoginSessionId;
      _telecomLoginSessionId = null;
      _telecomLoginIndex = -1;
      if (cancelRemote && sessionId) {
        fetch(API_PREFIX + '/api/telecomjs/login/' + encodeURIComponent(sessionId), { method: 'DELETE', headers: authHeaders() }).catch(function(){});
      }
    }

    function updateTelecomQrImage() {
      if (!_telecomLoginSessionId || _telecomQrLoading) return;
      _telecomQrLoading = true;
      var id = _telecomLoginSessionId;
      fetch(API_PREFIX + '/api/telecomjs/login/' + encodeURIComponent(id) + '/screenshot?t=' + Date.now(), { headers: authHeaders() })
        .then(function(r) { if (!r.ok) throw new Error('二维码加载失败'); return r.blob(); })
        .then(function(blob) {
          if (id !== _telecomLoginSessionId) return;
          var nextUrl = URL.createObjectURL(blob);
          document.getElementById('telecomQrImage').src = nextUrl;
          if (_telecomQrObjectUrl) URL.revokeObjectURL(_telecomQrObjectUrl);
          _telecomQrObjectUrl = nextUrl;
        })
        .catch(function(){})
        .finally(function(){ _telecomQrLoading = false; });
    }

    function handleTelecomLoginSuccess() {
      if (_telecomLoginHandled) return;
      _telecomLoginHandled = true;
      clearTelecomLoginTimers();
      setTelecomLoginStatus('登录成功，Satoken 已自动更新', 'success');
      loadData(true);
      setTimeout(function() { closeModal('telecomLoginOverlay'); }, 1200);
    }

    function pollTelecomLogin() {
      if (!_telecomLoginSessionId) return;
      var id = _telecomLoginSessionId;
      telecomJsonFetch(API_PREFIX + '/api/telecomjs/login/' + encodeURIComponent(id))
        .then(function(d) {
          if (id !== _telecomLoginSessionId) return;
          if (d.status === 'success') { handleTelecomLoginSuccess(); return; }
          if (d.status === 'error' || d.status === 'expired' || d.status === 'cancelled') {
            clearTelecomLoginTimers();
            setTelecomLoginStatus(d.message || '登录会话已结束，请重试', 'error');
            return;
          }
          if (d.status === 'saving') setTelecomLoginStatus(d.message || '正在更新 Satoken...');
        })
        .catch(function(err) {
          if (id === _telecomLoginSessionId) setTelecomLoginStatus(err.message, 'error');
        });
    }

    function openTelecomLogin(index) {
      stopTelecomLogin(true);
      _telecomLoginIndex = index;
      _telecomLoginHandled = false;
      document.getElementById('telecomQrImage').removeAttribute('src');
      document.getElementById('telecomAccountPhone').value = '';
      document.getElementById('telecomPhoneCheck').style.display = '';
      document.getElementById('telecomLoginOptions').style.display = 'none';
      document.getElementById('telecomPhoneCheckBtn').disabled = false;
      setTelecomLoginStatus('请输入账号登记的手机号');
      document.getElementById('telecomLoginOverlay').classList.add('active');
      setTimeout(function(){ document.getElementById('telecomAccountPhone').focus(); }, 80);
    }

    function verifyTelecomAccountPhone() {
      var telephone = document.getElementById('telecomAccountPhone').value.replace(/\s+/g, '');
      if (!/^1[3-9]\d{9}$/.test(telephone)) { setTelecomLoginStatus('请输入正确的 11 位手机号', 'error'); return; }
      var btn = document.getElementById('telecomPhoneCheckBtn');
      btn.disabled = true;
      setTelecomLoginStatus('正在核对手机号...');
      var generation = _telecomLoginGeneration;
      telecomJsonFetch(API_PREFIX + '/api/telecomjs/login/' + _telecomLoginIndex, {
        method: 'POST', body: JSON.stringify({ telephone: telephone })
      })
        .then(function(d) {
          if (generation !== _telecomLoginGeneration) {
            fetch(API_PREFIX + '/api/telecomjs/login/' + encodeURIComponent(d.id), { method: 'DELETE', headers: authHeaders() }).catch(function(){});
            return;
          }
          _telecomLoginSessionId = d.id;
          document.getElementById('telecomPhoneCheck').style.display = 'none';
          document.getElementById('telecomLoginOptions').style.display = '';
          setTelecomLoginStatus('手机号核对通过，请使用智云官方二维码扫码');
          updateTelecomQrImage();
          _telecomQrTimer = setInterval(updateTelecomQrImage, 5000);
          _telecomLoginPollTimer = setInterval(pollTelecomLogin, 1200);
        })
        .catch(function(err) {
          if (generation === _telecomLoginGeneration) {
            btn.disabled = false;
            setTelecomLoginStatus(err.message, 'error');
          }
        });
    }


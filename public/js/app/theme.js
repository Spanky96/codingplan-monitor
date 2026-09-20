    // ============ 主题系统（亮色 / 暗色 / Claude 黄灰）============
    var THEME_META = {
      light: { label: '亮色', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>' },
      dark: { label: '暗色', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg>' },
      claude: { label: 'Claude', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6L5.6 18.4"/></svg>' }
    };
    // 兜底揭示动画的遮罩底色 = 旧主题的基础背景色
    var THEME_BASE_BG = { light: '#eef2fa', dark: '#070b18', claude: '#f0ede3' };

    function currentTheme() {
      var cl = document.documentElement.classList;
      if (cl.contains('dark')) return 'dark';
      if (cl.contains('claude')) return 'claude';
      return 'light';
    }

    function applyTheme(theme) {
      var cl = document.documentElement.classList;
      cl.toggle('dark', theme === 'dark');
      cl.toggle('claude', theme === 'claude');
      document.body.classList.toggle('dark', theme === 'dark');
      document.body.classList.toggle('claude', theme === 'claude');
      localStorage.setItem('usage_theme', theme);
      localStorage.setItem('usage_dark', String(theme === 'dark'));
      syncThemePicker();
      // 详情图表若已打开,按新主题配色重绘
      var cont = _detailIndex >= 0 ? document.getElementById('chartContainer-' + _detailIndex) : null;
      if (cont && cont._chartLoaded && _chartPeriod[_detailIndex]) loadUsageChart(_detailIndex, _chartPeriod[_detailIndex]);
      // 中转站面板模型色随主题切换色阶(槽位不变,仅色值换档)
      if (FEATURES.relayEnabled && isAdmin() && typeof renderActivityPanel === 'function') renderActivityPanel();
    }

    function syncThemePicker() {
      var meta = THEME_META[currentTheme()];
      document.getElementById('themePickerIcon').innerHTML = meta.icon;
      document.getElementById('themePickerLabel').textContent = meta.label;
      document.querySelectorAll('#themeMenu [data-set-theme]').forEach(function(b) {
        b.classList.toggle('active', b.getAttribute('data-set-theme') === currentTheme());
      });
    }

    function toggleThemeMenu(open) {
      document.getElementById('themeMenu').classList.toggle('open', open);
    }

    function setTheme(theme, originEl) {
      toggleThemeMenu(false);
      if (theme === currentTheme()) return;
      var el = originEl || document.getElementById('themePickerBtn');
      var rect = el.getBoundingClientRect();
      var cx = rect.left + rect.width / 2;
      var cy = rect.top + rect.height / 2;
      var prevBg = THEME_BASE_BG[currentTheme()];
      document.documentElement.style.setProperty('--theme-x', cx + 'px');
      document.documentElement.style.setProperty('--theme-y', cy + 'px');

      if (document.startViewTransition) {
        document.startViewTransition(function() { applyTheme(theme); });
        return;
      }

      // 兜底:遮罩圆形揭示(旧主题底色上挖洞,逐渐露出新主题)
      var overlay = document.getElementById('themeOverlay');
      var maxDist = Math.max(
        Math.hypot(cx, cy),
        Math.hypot(window.innerWidth - cx, cy),
        Math.hypot(cx, window.innerHeight - cy),
        Math.hypot(window.innerWidth - cx, window.innerHeight - cy)
      );
      var maxR = Math.ceil(maxDist) + 10;
      var tpl = 'radial-gradient(circle {SIZE}px at {CX}px {CY}px, transparent {HOLE}px, black {EDGE}px)';
      overlay.style.background = prevBg;
      overlay.style.webkitMaskImage = tpl.replace('{SIZE}', maxR).replace('{CX}', cx).replace('{CY}', cy).replace('{HOLE}', '0').replace('{EDGE}', '0');
      overlay.style.maskImage = overlay.style.webkitMaskImage;

      applyTheme(theme);

      var duration = 500;
      var startTime = performance.now();
      function frame(now) {
        var t = Math.min(1, (now - startTime) / duration);
        var eased = 1 - Math.pow(1 - t, 3);
        var r = eased * maxR;
        var m = tpl.replace('{SIZE}', maxR).replace('{CX}', cx).replace('{CY}', cy).replace('{HOLE}', r.toFixed(1)).replace('{EDGE}', (r + 2).toFixed(1));
        overlay.style.webkitMaskImage = m;
        overlay.style.maskImage = m;
        if (t < 1) { requestAnimationFrame(frame); }
        else {
          overlay.style.webkitMaskImage = '';
          overlay.style.maskImage = '';
          overlay.style.background = '';
        }
      }
      requestAnimationFrame(frame);
    }

    (function initThemePicker() {
      var menu = document.getElementById('themeMenu');
      var btn = document.getElementById('themePickerBtn');
      menu.innerHTML = Object.keys(THEME_META).map(function(key) {
        return '<button data-set-theme="' + key + '" role="menuitem">' + THEME_META[key].icon + '<span>' + THEME_META[key].label + '</span></button>';
      }).join('');
      syncThemePicker();
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        toggleThemeMenu(!menu.classList.contains('open'));
      });
      menu.addEventListener('click', function(e) {
        var item = e.target.closest('[data-set-theme]');
        if (!item) return;
        e.stopPropagation();
        setTheme(item.getAttribute('data-set-theme'), btn);
      });
      document.addEventListener('click', function(e) {
        if (!e.target.closest('#themePicker')) toggleThemeMenu(false);
      });
      document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') toggleThemeMenu(false);
      });
    })();


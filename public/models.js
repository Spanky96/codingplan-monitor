/* MiniMax 模型调用页逻辑(配合 models.html / models.css)
 *
 * 接口规格(官方文档,2026-08 核对):
 * - V1 /v1/video_generation(Hailuo-02):仅 1 张首帧图 first_frame_image(公网 URL 或 base64 Data URL);
 *   查询返回 file_id,需再调 /v1/files/retrieve?file_id= 换取 download_url。
 * - V2 /v2/video_generation(MiniMax-H3):content 数组,prompt(text 项)必填;
 *   图片 role: first_frame ≤1 / last_frame ≤1 / reference_image ≤9,首尾帧与参考图互斥;
 *   resolution 仅 768P|2K,duration 4~15;查询 /v2/query/video_generation,成功返回 task.content.url。
 * - 文件上传 /v1/files/upload:purpose=video_generation_input,引用格式 mm_file://{file_id},有效期 7 天。
 * 语音/复刻/音乐(见 models-audio.js,官方文档 2026-08 核对):
 * - 同步 /v1/t2a_v2(合法模型 speech-2.8/2.6/02-hd|turbo,裸 speech-02 为非法名);
 * - 异步 /v1/t2a_async_v2 → /v1/query/t2a_async_query_v2 → /v1/files/retrieve_content;
 * - 复刻 /v1/files/upload(voice_clone) → /v1/voice_clone;音色库 /v1/get_voice;/v1/delete_voice;
 * - 音乐 /v1/music_generation。
 * 全部经中转站透传(sub2api 已注册这些原生端点);可用模型严格以 GET /v1/models
 * 按分组返回为准,非法裸名(如 speech-02)会被剔除,页面上不额外合并模型。
 */
'use strict';

/* ================= 工具 ================= */
function $(id) { return document.getElementById(id); }
function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function fmtBytes(n) {
  if (!n && n !== 0) return '-';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return Math.round(n / 1024) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}
function dataUrlBytes(dataUrl) {
  var i = String(dataUrl).indexOf(',');
  return i < 0 ? 0 : Math.floor((dataUrl.length - i - 1) * 3 / 4);
}
function uid() { return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8); }

var _toastTimer = null;
function toast(msg, isError) {
  var el = $('toast');
  el.textContent = msg;
  el.className = 'toast show' + (isError ? ' error' : '');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(function () { el.className = 'toast'; }, 2800);
}

/* ================= 配置(localStorage) ================= */
var LS_KEY = 'minimax_api_key_v1';
// 网关地址固定为 sub2api 中转站公网入口(只读,不提供修改)
var API_URL = 'https://lwai.05info.com:8887/v1';

function loadConfig() {
  $('api_url').value = API_URL;
  // Key 只来自用户保存;不内置任何默认密钥(避免硬编码泄露,
  // 并保证「清除配置」后刷新仍为空,需重新输入)
  $('api_key').value = localStorage.getItem(LS_KEY) || '';
  loadModels();
}
function saveConfig() {
  var key = $('api_key').value.trim();
  if (!key) return showConfigStatus('请填写 API Key', true);
  localStorage.setItem(LS_KEY, key);
  showConfigStatus('正在加载可用模型...');
  loadModels();
}
/* 清除本页写入浏览器的全部数据:API Key、音色库缓存、复刻音色记录、
 * 调用记录、图片池(去掉使用痕迹;代码内置的默认演示 Key 不受影响) */
function clearConfig() {
  if (!confirm('确认清除本页保存在浏览器中的全部数据?\n\n包括:API Key、音色库缓存、我的复刻音色记录、调用记录、图片池。\n清除后需重新填写 API Key。')) return;
  [LS_KEY, 'minimax_voice_lib_v1', 'minimax_my_clones_v1', LS_HISTORY, LS_POOL].forEach(function (k) {
    localStorage.removeItem(k);
  });
  $('api_key').value = '';
  if (typeof clearAudioState === 'function') clearAudioState();
  POOL = [];
  SEL = [];
  modelsLoaded = false;
  $('model_name').innerHTML = '<option value="">— 设置 API Key 后自动加载可用模型 —</option>';
  setModelGate('(请先在上方设置 API Key)', true);
  showConfigStatus('已清除浏览器本地数据');
  renderHistory();
  renderPool();
  toast('已清除配置与本页本地数据');
}
function showConfigStatus(msg, isError) {
  var el = $('config_status');
  el.textContent = msg;
  el.className = isError ? 'config-hint error' : 'config-hint';
}

/* 静默读取(供上传等非主流程使用,不污染结果区) */
function readApiUrl() { return API_URL; }
function readApiKey() { return $('api_key').value.trim(); }
function apiBase() { return API_URL; }
function apiKey() {
  var k = readApiKey();
  if (!k) { showError('请先填写 API Key'); throw new Error('no key'); }
  return k;
}

/* ================= 可用模型加载(按 API Key) ================= */
var modelsLoaded = false;
function setModelGate(hint, disabled) {
  $('model_name').disabled = !!disabled;
  var el = $('model_gate_hint');
  if (el) el.textContent = hint || '';
}
/* 第一步:用户设置 Key 后,经 GET {API_URL}/models 拉取该 Key 分组内
 * 可调用的上游模型(sub2api 按账号模型映射返回),再渲染可选模型。 */
function loadModels() {
  var key = readApiKey();
  if (!key) {
    setModelGate('(请先在上方设置 API Key)', true);
    return;
  }
  setModelGate('(模型加载中...)', true);
  fetch(API_URL + '/models', { headers: { 'Authorization': 'Bearer ' + key } })
    .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, json: j }; }); })
    .then(function (resp) {
      if (!resp.ok || !resp.json || !Array.isArray(resp.json.data)) {
        modelsLoaded = false;
        $('model_name').innerHTML = '<option value="">— API Key 校验失败 —</option>';
        setModelGate('(Key 无效或加载失败: HTTP ' + (resp.ok ? '格式' : 'status') + ')', true);
        showConfigStatus('模型列表加载失败,请检查 API Key', true);
        refreshForm();
        return;
      }
      var relayIds = resp.json.data
        .map(function (m) { return String((m && m.id) || '').trim(); })
        .filter(Boolean);
      // 规范化:仅剔除网关返回的非法裸名(如 speech-02),不额外合并模型 ——
      // 分组支持哪些模型完全由中转站 /v1/models 决定
      var ids = normalizeModelIds(relayIds);
      if (!ids.length) {
        modelsLoaded = false;
        $('model_name').innerHTML = '<option value="">— 该 Key 无可用模型 —</option>';
        setModelGate('(上游未开放任何模型)', true);
        showConfigStatus('该 API Key 没有可用模型', true);
        refreshForm();
        return;
      }
      var groups = { chat: [], image: [], video: [], tts: [], music: [] };
      ids.forEach(function (m) { groups[modelCategory(m.id)].push(m); });
      var labels = { chat: '对话', image: '图像', video: '视频', tts: '语音合成', music: '音乐生成' };
      var html = '';
      ['chat', 'image', 'video', 'tts', 'music'].forEach(function (cat) {
        if (!groups[cat].length) return;
        html += '<optgroup label="' + labels[cat] + '">';
        groups[cat].forEach(function (m) {
          html += '<option value="' + escHtml(m.id) + '">' + escHtml(m.id) + (m.note ? '(' + escHtml(m.note) + ')' : '') + '</option>';
        });
        html += '</optgroup>';
      });
      $('model_name').innerHTML = html;
      modelsLoaded = true;
      setModelGate('', false);
      showConfigStatus('已加载 ' + ids.length + ' 个可用模型');
      refreshForm();
    })
    .catch(function (e) {
      modelsLoaded = false;
      setModelGate('(模型加载失败: ' + e.message + ')', true);
      showConfigStatus('模型列表加载失败: ' + e.message, true);
    });
}
/* 去掉用户所填 URL 末尾的版本段,再按需要的版本重拼(避免 /v1/v2/... 这类错误路径) */
function versionedBase(ver) { return apiBase().replace(/\/v\d+$/, '') + '/' + ver; }

/* ================= 模型元信息 ================= */
function modelCategory(model) {
  if (/^image-/.test(model)) return 'image';
  if (/^MiniMax-Hailuo|^MiniMax-H3|^video-/.test(model)) return 'video';
  if (/^music-/.test(model)) return 'music';
  if (/^speech-/.test(model)) return 'tts';
  return 'chat';
}
function videoApiVersion(model) { return /^MiniMax-H3/.test(model) ? 'v2' : 'v1'; }

/* V2 参考图模式:first_frame ≤1 / reference_image ≤9(官方上限) */
var VIDEO_MODES = {
  first_frame: { cap: 1, role: 'first_frame' },
  reference: { cap: 9, role: 'reference_image' }
};
var videoMode = 'first_frame';

function videoSelCap() {
  var model = $('model_name').value;
  var cat = modelCategory(model);
  if (cat === 'image') return 1; // image-01 图生图:subject_reference 仅支持 1 张
  if (cat !== 'video') return 0;
  if (videoApiVersion(model) === 'v1') return 1; // Hailuo-02 仅支持 1 张首帧图
  return VIDEO_MODES[videoMode].cap;
}

/* ================= 图片池(状态) ================= */
var LS_POOL = 'minimax_image_pool_v2';
var POOL_MAX = 40;
var FILE_TTL_REFRESH = 6 * 86400000; // 官方有效期 7 天,提前 1 天自动重传
var POOL = [];  // {id, hash, name, src(dataURL 或外链 URL), ext, origin, ts, fileId, fileTs, status?, error?}
var SEL = [];   // 已勾选的 item id(有序)

function loadPool() {
  try {
    var raw = JSON.parse(localStorage.getItem(LS_POOL) || 'null');
    if (raw && Array.isArray(raw.items)) {
      POOL = raw.items.filter(function (it) { return it && it.id && it.src; });
      SEL = Array.isArray(raw.selected)
        ? raw.selected.filter(function (id) { return POOL.some(function (p) { return p.id === id; }); })
        : [];
    }
  } catch (e) { POOL = []; SEL = []; }
}

/* 持久化;localStorage 配额不足时从最旧(未勾选优先)逐条移除 */
function savePool() {
  var persist = function (items, sel) {
    return JSON.stringify({
      v: 2,
      selected: sel,
      items: items.map(function (it) {
        return { id: it.id, hash: it.hash, name: it.name, src: it.src, ext: !!it.ext, origin: it.origin, ts: it.ts, fileId: it.fileId || null, fileTs: it.fileTs || 0 };
      })
    });
  };
  var items = POOL.slice();
  var sel = SEL.slice();
  for (var i = 0; i < 30; i++) {
    try { localStorage.setItem(LS_POOL, persist(items, sel)); POOL = items; SEL = sel; return; }
    catch (e) {
      if (!items.length) {
        try { localStorage.setItem(LS_POOL, persist([], [])); } catch (e2) { /* 忽略 */ }
        POOL = []; SEL = [];
        return;
      }
      var idx = -1;
      for (var j = items.length - 1; j >= 0; j--) {
        if (sel.indexOf(items[j].id) < 0) { idx = j; break; }
      }
      if (idx < 0) idx = items.length - 1;
      var removed = items[idx];
      items = items.slice(0, idx).concat(items.slice(idx + 1));
      sel = sel.filter(function (id) { return id !== removed.id; });
    }
  }
}

function getItem(id) {
  for (var i = 0; i < POOL.length; i++) if (POOL[i].id === id) return POOL[i];
  return null;
}
function patchItem(id, patch) {
  POOL = POOL.map(function (it) { return it.id === id ? Object.assign({}, it, patch) : it; });
}
function selectedItems() {
  return SEL.map(getItem).filter(function (it) { return !!it; });
}

/* ================= 图片处理 ================= */
/* 缩放为 JPEG dataURL(白底压平),用于预览 / 哈希去重 / 上传源 / V1 base64 内嵌 */
var IMG_MAX_EDGE = 1600;
function blobToDataURL(fileOrBlob, maxEdge) {
  return new Promise(function (resolve, reject) {
    var reader = new FileReader();
    reader.onerror = function () { reject(new Error('读取文件失败')); };
    reader.onload = function () {
      var img = new Image();
      img.onerror = function () { reject(new Error('无法解码该图片(HEIC 请先转为 JPG/PNG)')); };
      img.onload = function () {
        try {
          var scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
          var w = Math.max(1, Math.round(img.width * scale));
          var h = Math.max(1, Math.round(img.height * scale));
          var canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          var ctx = canvas.getContext('2d');
          ctx.fillStyle = '#fff';
          ctx.fillRect(0, 0, w, h);
          ctx.drawImage(img, 0, 0, w, h);
          resolve(canvas.toDataURL('image/jpeg', 0.9));
        } catch (e) { reject(e); }
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(fileOrBlob);
  });
}

function dataURLtoBlob(dataUrl) {
  var parts = String(dataUrl).split(',');
  var mime = (parts[0].match(/data:([^;]+)/) || [])[1] || 'image/jpeg';
  var bin = atob(parts[1]);
  var arr = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

/* 内容哈希(去重):优先 SHA-256;不可用时(非安全上下文)退回 djb2 */
function hashText(s) {
  if (window.crypto && crypto.subtle && crypto.subtle.digest) {
    var buf = new TextEncoder().encode(s);
    return crypto.subtle.digest('SHA-256', buf).then(function (d) {
      return Array.prototype.map.call(new Uint8Array(d), function (b) {
        return ('0' + b.toString(16)).slice(-2);
      }).join('');
    });
  }
  var h1 = 5381, h2 = 52711;
  for (var i = 0; i < s.length; i++) {
    h1 = (h1 * 33) ^ s.charCodeAt(i);
    h2 = (h2 * 31) ^ s.charCodeAt(i);
  }
  return Promise.resolve('djb2-' + (h1 >>> 0).toString(36) + '-' + (h2 >>> 0).toString(36) + '-' + s.length);
}

/* ================= 图片池(操作) ================= */
function addLocalFiles(fileList) {
  var files = Array.prototype.slice.call(fileList || []);
  if (!files.length) return;
  files.forEach(function (file) {
    var okType = /^image\//.test(file.type) || /\.(jpe?g|png|webp|heic|heif)$/i.test(file.name);
    if (!okType) { toast('不支持的格式: ' + file.name, true); return; }
    if (file.size > 30 * 1024 * 1024) { toast(file.name + ' 超过 30MB 上限', true); return; }
    blobToDataURL(file, IMG_MAX_EDGE)
      .then(function (dataUrl) {
        return addPoolItem({ src: dataUrl, name: file.name, origin: 'upload', upload: true, autoSelect: true });
      })
      .catch(function (e) { toast('图片处理失败: ' + e.message, true); });
  });
}

/* 文生图结果入池:优先抓取为本地 dataURL;跨域受限时退化为外链项 */
function addGeneratedImages(urls) {
  urls.forEach(function (u, i) {
    fetch(u)
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.blob();
      })
      .then(function (blob) { return blobToDataURL(blob, IMG_MAX_EDGE); })
      .then(function (dataUrl) {
        return addPoolItem({ src: dataUrl, name: '生成图-' + (i + 1) + '-' + new Date().toLocaleTimeString('zh-CN', { hour12: false }).replace(/:/g, ''), origin: 'generated', upload: false, autoSelect: false });
      })
      .catch(function () {
        addPoolItem({ src: u, name: '生成图-' + (i + 1) + '(外链)', origin: 'generated', ext: true, upload: false, autoSelect: false });
      });
  });
}

/* 入池:按内容哈希去重;命中已有项时直接复用并(按需)勾选 */
function addPoolItem(opts) {
  var key = opts.ext ? 'url:' + opts.src : opts.src;
  return hashText(key).then(function (hash) {
    var existing = null;
    for (var i = 0; i < POOL.length; i++) {
      if (POOL[i].hash === hash) { existing = POOL[i]; break; }
    }
    if (existing) {
      toast('相同图片已在池中,已直接勾选');
      if (opts.autoSelect) selectById(existing.id);
      else renderPool();
      return existing;
    }
    var item = {
      id: uid(), hash: hash,
      name: opts.name || '图片',
      src: opts.src, ext: !!opts.ext,
      origin: opts.origin || 'upload',
      ts: Date.now(), fileId: null, fileTs: 0
    };
    POOL = [item].concat(POOL);
    if (POOL.length > POOL_MAX) {
      var dropped = POOL.slice(POOL_MAX);
      POOL = POOL.slice(0, POOL_MAX);
      var dropIds = dropped.map(function (d) { return d.id; });
      SEL = SEL.filter(function (id) { return dropIds.indexOf(id) < 0; });
      toast('图片池已满(' + POOL_MAX + ' 张),已移除最旧 ' + dropped.length + ' 张');
    }
    savePool();
    renderPool();
    if (item.ext) {
      if (opts.autoSelect) selectById(item.id);
      return item;
    }
    if (opts.upload) {
      return uploadItem(item.id).then(function (ok) {
        if (ok && opts.autoSelect) selectById(item.id);
        return getItem(item.id);
      });
    }
    if (opts.autoSelect) selectById(item.id);
    return item;
  });
}

/* 上传到 MiniMax(purpose=video_generation_input);fileId 新鲜则跳过,避免重复上传 */
function uploadItem(id) {
  var it = getItem(id);
  if (!it || it.ext) return Promise.resolve(true);
  if (it.fileId && Date.now() - (it.fileTs || 0) < FILE_TTL_REFRESH) return Promise.resolve(true);

  var key = readApiKey();
  if (!key) {
    patchItem(id, { status: 'failed', error: '未配置 API Key' });
    renderPool();
    toast('请先在顶部配置 API Key 后再上传', true);
    return Promise.resolve(false);
  }
  patchItem(id, { status: 'uploading', error: '' });
  renderPool();

  var blob;
  try { blob = dataURLtoBlob(it.src); }
  catch (e) {
    patchItem(id, { status: 'failed', error: e.message });
    renderPool();
    return Promise.resolve(false);
  }
  var fd = new FormData();
  fd.append('file', new File([blob], 'pool-' + id + '.jpg', { type: 'image/jpeg' }));
  fd.append('purpose', 'video_generation_input');

  return fetch(versionedBase('v1') + '/files/upload', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + key },
    body: fd
  })
    .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, json: j }; }); })
    .then(function (resp) {
      var base = resp.json && resp.json.base_resp;
      var fid = resp.json && resp.json.file && resp.json.file.file_id;
      if (!resp.ok || !base || base.status_code !== 0 || !fid) {
        var msg = (base && base.status_msg) || ('HTTP ' + resp.status);
        patchItem(id, { status: 'failed', error: msg });
        renderPool();
        toast('上传失败: ' + msg, true);
        return false;
      }
      patchItem(id, { fileId: String(fid), fileTs: Date.now(), status: 'uploaded', error: '' });
      savePool();
      renderPool();
      return true;
    })
    .catch(function (e) {
      patchItem(id, { status: 'failed', error: e.message });
      renderPool();
      toast('上传失败: ' + e.message, true);
      return false;
    });
}

/* 生成前确保所选图片均有新鲜 fileId(顺序上传,任一失败即抛错) */
function ensureSelectedUploads() {
  var ids = selectedItems().filter(function (it) { return !it.ext; }).map(function (it) { return it.id; });
  return ids.reduce(function (chain, id) {
    return chain.then(function () {
      return uploadItem(id).then(function (ok) {
        if (!ok) {
          var it = getItem(id);
          throw new Error('参考图上传失败: ' + ((it && it.error) || '未知错误'));
        }
      });
    });
  }, Promise.resolve());
}

/* ================= 勾选 ================= */
function trimSelToCap() {
  var cap = videoSelCap();
  if (cap > 0 && SEL.length > cap) {
    SEL = SEL.slice(SEL.length - cap);
    savePool();
  }
}
function selectById(id) {
  if (SEL.indexOf(id) >= 0) return;
  var cap = videoSelCap();
  if (cap <= 0) return;
  if (SEL.length >= cap) {
    SEL = SEL.slice(SEL.length - cap + 1);
    toast('该模型最多勾选 ' + cap + ' 张,已替换最早的选择');
  }
  SEL = SEL.concat([id]);
  savePool();
  renderPool();
}
function toggleSelect(id) {
  var cap = videoSelCap();
  if (cap <= 0) { toast('当前模型不支持勾选参考图'); return; }
  if (SEL.indexOf(id) >= 0) {
    SEL = SEL.filter(function (x) { return x !== id; });
    savePool();
    renderPool();
    return;
  }
  selectById(id);
  // 勾选未上传的本地项时触发(重新)上传;失败项点此即重试
  var it = getItem(id);
  if (it && !it.ext && !it.fileId) uploadItem(id);
}
function removeItem(id) {
  POOL = POOL.filter(function (it) { return it.id !== id; });
  SEL = SEL.filter(function (x) { return x !== id; });
  savePool();
  renderPool();
}
function clearPool() {
  if (!confirm('确认清空图片池(含本地缓存的 file_id)?')) return;
  POOL = [];
  SEL = [];
  savePool();
  renderPool();
}

function itemStatus(it) {
  if (it.ext) return { cls: 'ext', text: '外链' };
  if (it.status === 'uploading') return { cls: 'ing', text: '上传中…' };
  if (it.fileId) {
    var stale = Date.now() - (it.fileTs || 0) > FILE_TTL_REFRESH;
    return stale ? { cls: 'stale', text: '过期·将自动重传' } : { cls: 'ok', text: '已缓存' };
  }
  if (it.error || it.status === 'failed') return { cls: 'err', text: '失败·点击重试' };
  return { cls: 'idle', text: '待上传' };
}

function renderPool() {
  var grid = $('pool_grid');
  $('pool_count_badge').textContent = POOL.length + ' 张 · 已选 ' + SEL.length;
  $('pool_empty').style.display = POOL.length ? 'none' : '';
  grid.innerHTML = POOL.map(function (it) {
    var sel = SEL.indexOf(it.id) >= 0;
    var st = itemStatus(it);
    return '<div class="pool-item' + (sel ? ' selected' : '') + '" data-id="' + it.id + '" title="' + escHtml(it.name) + '">'
      + '<img src="' + escHtml(it.src) + '" alt="" loading="lazy" onerror="this.style.opacity=.35">'
      + '<span class="pool-check">✓</span>'
      + '<span class="pool-status ' + st.cls + '">' + escHtml(st.text) + '</span>'
      + '<div class="pool-bar"><span class="pool-name">' + escHtml(it.name) + '</span>'
      + '<button class="pool-del" data-del="' + it.id + '" title="从池中移除">×</button></div>'
      + '</div>';
  }).join('');
  grid.querySelectorAll('.pool-item').forEach(function (el) {
    el.onclick = function (e) {
      if (e.target && e.target.classList && e.target.classList.contains('pool-del')) return;
      toggleSelect(el.dataset.id);
    };
  });
  grid.querySelectorAll('.pool-del').forEach(function (btn) {
    btn.onclick = function (e) {
      e.stopPropagation();
      removeItem(btn.dataset.del);
    };
  });
  updateRefDisplay();
}

/* 只读引用框:展示实际将随视频请求发送的引用 */
function updateRefDisplay() {
  var el = $('ref_display');
  if (!el) return;
  var model = $('model_name').value;
  if (modelCategory(model) !== 'video') { el.value = ''; return; }
  var items = selectedItems();
  if (!items.length) { el.value = ''; return; }
  if (videoApiVersion(model) === 'v1') {
    var it = items[0];
    el.value = it.ext ? it.src : (it.name + ' · base64 内嵌 · ' + fmtBytes(dataUrlBytes(it.src)));
  } else {
    el.value = items.map(function (x) {
      if (x.ext) return x.src;
      return x.fileId ? 'mm_file://' + x.fileId : '(上传后自动填充)';
    }).join('  ;  ');
  }
}

/* ================= 表单切换 ================= */
function refreshForm() {
  var model = $('model_name').value;
  var cat = modelCategory(model);
  var ver = cat === 'video' ? videoApiVersion(model) : '';
  var labels = { chat: '对话', image: '文生图', video: '视频', tts: '语音合成', music: '音乐生成' };
  $('model_category_badge').textContent = labels[cat];
  $('model_category_badge').className = cat === 'video' ? 'badge badge-warn' : 'badge';
  $('input_category_badge').textContent = labels[cat];

  // 提示词/合成文本输入框对所有模态可见(tts 用它输入要合成的文字)
  $('prompt_field').classList.remove('hidden');
  $('prompt_label').textContent = cat === 'tts' ? '要合成的文本'
    : cat === 'music' ? '音乐描述(风格/情绪/场景,如:独立民谣,忧郁,独自漫步)'
    : (cat === 'video' && ver === 'v2' ? '提示词(H3 必填)' : '提示词');
  if (cat === 'video' && ver === 'v1') $('prompt').setAttribute('maxlength', '2000');
  else $('prompt').removeAttribute('maxlength');

  $('chat_row').classList.toggle('hidden', cat !== 'chat');
  $('image_row').classList.toggle('hidden', cat !== 'image');
  $('tts_row').classList.toggle('hidden', cat !== 'tts');
  $('image_field').classList.toggle('hidden', cat !== 'video');
  $('duration_field').classList.toggle('hidden', cat !== 'video');
  $('resolution_field').classList.toggle('hidden', cat !== 'video');
  $('pool_card').classList.toggle('hidden', cat !== 'video' && cat !== 'image');

  if (cat === 'video') rebuildVideoOptions(ver);
  if (typeof refreshAudioForm === 'function') refreshAudioForm(cat);
  renderModePills();
  trimSelToCap();
  renderPool();
}

/* 按 V1/V2 重建时长与分辨率选项(H3:4~15s、768P|2K;Hailuo-02:6|10s、512P~1080P) */
function rebuildVideoOptions(ver) {
  var durSel = $('duration');
  var resSel = $('resolution');
  var prevDur = durSel.value || '6';
  var prevRes = resSel.value || '768P';
  var durs = [];
  if (ver === 'v2') { for (var d = 4; d <= 15; d++) durs.push(d); }
  else { durs = [6, 10]; }
  var ress = ver === 'v2' ? ['768P', '2K'] : ['512P', '768P', '1080P'];
  durSel.innerHTML = durs.map(function (d) { return '<option value="' + d + '">' + d + '</option>'; }).join('');
  resSel.innerHTML = ress.map(function (r) { return '<option value="' + r + '">' + r + '</option>'; }).join('');
  durSel.value = durs.indexOf(parseInt(prevDur, 10)) >= 0 ? prevDur : '6';
  resSel.value = ress.indexOf(prevRes) >= 0 ? prevRes : '768P';
  applyV1Constraint();
}

/* Hailuo-02:10s 仅支持 ≤768P */
function applyV1Constraint() {
  var model = $('model_name').value;
  if (modelCategory(model) !== 'video' || videoApiVersion(model) !== 'v1') return;
  var durSel = $('duration');
  var resSel = $('resolution');
  Array.prototype.forEach.call(resSel.options, function (o) {
    o.disabled = (o.value === '1080P' && durSel.value === '10');
  });
  if (resSel.value === '1080P' && durSel.value === '10') {
    resSel.value = '768P';
    toast('Hailuo-02 时长 10s 仅支持 ≤768P,已自动切换');
  }
}

function renderModePills() {
  var model = $('model_name').value;
  var isV2 = modelCategory(model) === 'video' && videoApiVersion(model) === 'v2';
  $('video_mode_seg').classList.toggle('hidden', !isV2);
  $('video_mode_seg').querySelectorAll('.seg-btn').forEach(function (b) {
    b.classList.toggle('active', b.dataset.mode === videoMode);
  });
  var hint = $('video_mode_hint');
  if (modelCategory(model) !== 'video') { hint.textContent = ''; return; }
  if (!isV2) {
    hint.textContent = 'Hailuo-02(图生视频):仅支持 1 张首帧图,以 base64 内嵌发送,无需上传。';
  } else if (videoMode === 'first_frame') {
    hint.textContent = 'MiniMax-H3 首帧模式:勾选 1 张作为首帧。file_id 有效期 7 天,过期自动重传。';
  } else {
    hint.textContent = 'MiniMax-H3 参考图模式:最多勾选 9 张参考图。注意:参考图与首帧/尾帧互斥。';
  }
}

/* ================= 结果区 ================= */
function showResult(html) { $('result').innerHTML = html; }
function showError(msg) { showResult('<div class="result-error">' + escHtml(String(msg)) + '</div>'); }
function showLoading(text) {
  showResult('<div class="result-loading"><div class="spin"></div>' + escHtml(text) + '</div>');
}
function setBusy(busy) {
  $('btn_generate').disabled = busy;
  $('btn_generate').textContent = busy ? '生成中...' : '生成';
  $('btn_cancel').classList.toggle('hidden', !busy);
}

/* ================= 轮询 ================= */
var currentPoll = null;
function pollUntil(fn, intervalMs, maxAttempts, label) {
  if (currentPoll) currentPoll.cancelled = true;
  var p = { cancelled: false };
  currentPoll = p;
  var attempt = 0;
  return new Promise(function (resolve, reject) {
    function step() {
      if (p.cancelled) return reject(new Error('用户取消'));
      attempt++;
      showLoading((label || '轮询中') + ' · 第 ' + attempt + ' 次...');
      fn().then(function (r) {
        if (r.done) { resolve(r.value); return; }
        if (attempt >= maxAttempts) return reject(new Error('轮询超时(' + maxAttempts + ' 次仍未完成)'));
        setTimeout(step, intervalMs);
      }).catch(reject);
    }
    step();
  });
}

/* ================= 调度 ================= */
function onGenerate() {
  if (!modelsLoaded) return showError('请先设置 API Key,加载可用模型后再调用');
  var model = $('model_name').value;
  if (!model) return showError('请选择模型');
  var cat = modelCategory(model);
  if (cat === 'chat') return runChat(model);
  if (cat === 'image') return runImage(model);
  if (cat === 'video') return runVideo(model);
  if (cat === 'tts') return runTts(model);
  if (cat === 'music') return runMusic(model);
}

/* ================= 对话 ================= */
function runChat(model) {
  var prompt = $('prompt').value.trim();
  if (!prompt) return showError('请输入提示词');
  var maxTokens = parseInt($('max_tokens').value, 10) || 1024;
  var temperature = parseFloat($('temperature').value) || 0.7;
  var histInput = { prompt: prompt, max_tokens: maxTokens, temperature: temperature };
  var body = {
    model: model,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: maxTokens,
    temperature: temperature
  };
  setBusy(true);
  showLoading('对话中...');
  fetch(apiBase() + '/text/chatcompletion_v2', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + apiKey(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
    .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, json: j }; }); })
    .then(function (resp) {
      setBusy(false);
      if (!resp.ok) {
        var msg = 'HTTP ' + resp.status + ' · ' + JSON.stringify(resp.json);
        addHistory({ id: histId(), ts: Date.now(), model: model, category: 'chat', input: histInput, error: { message: msg } });
        return showError(msg);
      }
      if (resp.json.base_resp && resp.json.base_resp.status_code !== 0) {
        var msg2 = 'MiniMax 错误 ' + resp.json.base_resp.status_code + ': ' + resp.json.base_resp.status_msg;
        addHistory({ id: histId(), ts: Date.now(), model: model, category: 'chat', input: histInput, error: { message: msg2 } });
        return showError(msg2);
      }
      var text = (resp.json.choices && resp.json.choices[0] && resp.json.choices[0].message && resp.json.choices[0].message.content) || '(空响应)';
      var usage = resp.json.usage || {};
      showResult('<div class="result-success-text">' + escHtml(text) + '</div>'
        + '<div class="result-meta">model: <code>' + escHtml(model) + '</code> · tokens: <code>' + (usage.total_tokens || '-') + '</code> (in ' + (usage.prompt_tokens || 0) + ' / out ' + (usage.completion_tokens || 0) + ')</div>');
      addHistory({
        id: histId(), ts: Date.now(), model: model, category: 'chat',
        input: histInput,
        result: { text: text, meta: { tokens: usage.total_tokens, prompt_tokens: usage.prompt_tokens, completion_tokens: usage.completion_tokens } }
      });
    })
    .catch(function (e) {
      setBusy(false);
      addHistory({ id: histId(), ts: Date.now(), model: model, category: 'chat', input: histInput, error: { message: e.message } });
      showError(e.message);
    });
}

/* ================= 文生图 / 图生图 ================= */
function runImage(model) {
  var prompt = $('prompt').value.trim();
  if (!prompt) return showError('请输入提示词');
  var ratio = $('aspect_ratio').value;
  var parts = ratio.split(':');
  var n = parseInt($('image_count').value, 10) || 1;
  // 图生图:勾选 1 张参考图作为 subject_reference(官方仅支持单张;
  // image_file 接受 base64 Data URL,图片池本地项可直接使用)
  var items = selectedItems();
  var histInput = { prompt: prompt, ratio: ratio, n: n, refImage: items.length ? items[0].name : null };
  var body = {
    model: model,
    prompt: prompt,
    width: parseInt(parts[0], 10) * 512,
    height: parseInt(parts[1], 10) * 512,
    n: n,
    response_format: 'url'
  };
  if (items.length) {
    body.subject_reference = [{ type: 'character', image_file: items[0].src }];
  }
  setBusy(true);
  showLoading('生成图片中...');
  fetch(apiBase() + '/image_generation', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + apiKey(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
    .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, json: j }; }); })
    .then(function (resp) {
      setBusy(false);
      if (!resp.ok) {
        var msg = 'HTTP ' + resp.status + ' · ' + JSON.stringify(resp.json);
        addHistory({ id: histId(), ts: Date.now(), model: model, category: 'image', input: histInput, error: { message: msg } });
        return showError(msg);
      }
      if (resp.json.base_resp && resp.json.base_resp.status_code !== 0) {
        var msg2 = 'MiniMax 错误 ' + resp.json.base_resp.status_code + ': ' + resp.json.base_resp.status_msg;
        addHistory({ id: histId(), ts: Date.now(), model: model, category: 'image', input: histInput, error: { message: msg2 } });
        return showError(msg2);
      }
      var urls = ((resp.json.data || {}).image_urls || []);
      if (!urls.length) {
        var msg3 = '未返回图片 URL: ' + JSON.stringify(resp.json);
        addHistory({ id: histId(), ts: Date.now(), model: model, category: 'image', input: histInput, error: { message: msg3 } });
        return showError(msg3);
      }
      var grid = '<div class="image-grid">' + urls.map(function (u) {
        return '<a href="' + escHtml(u) + '" target="_blank" rel="noopener"><img src="' + escHtml(u) + '" loading="lazy"></a>';
      }).join('') + '</div>';
      var meta = '<div class="result-meta">model: <code>' + escHtml(model) + '</code> · count: <code>' + urls.length + '</code> · ratio: <code>' + ratio + '</code><br>图片已自动加入图片池,切换到视频模型即可勾选使用</div>';
      showResult(grid + meta);
      addGeneratedImages(urls);
      addHistory({
        id: histId(), ts: Date.now(), model: model, category: 'image',
        input: histInput,
        result: { imageUrls: urls }
      });
    })
    .catch(function (e) {
      setBusy(false);
      addHistory({ id: histId(), ts: Date.now(), model: model, category: 'image', input: histInput, error: { message: e.message } });
      showError(e.message);
    });
}

/* ================= 视频(V1 / V2) ================= */
// 常见 MiniMax 业务错误码 → 可执行提示(让报错不再是一坨 JSON)
var MINIMAX_HINTS = {
  1004: 'API Key 无效或未正确携带,请检查顶部配置的 API Key',
  1027: '请求并发/频率超限,请稍后重试',
  2013: '该模型不支持 TokenPlan/Credit 计费 —— 需切换到按量付费(后付费)账户,或申请该模型权限',
  2056: 'Token Plan 用量已耗尽,请升级套餐或购买积分补充用量'
};
function miniMaxHint(code) {
  return (code && MINIMAX_HINTS[code]) ? '\n💡 ' + MINIMAX_HINTS[code] : '';
}
// 把 MiniMax 任意错误信封解析成人话(base_resp 形式 / V2 的 {type:'error'} 形式各兼容一种)
function describeMiniMaxError(resp) {
  var j = resp.json || {};
  var msg = (j.base_resp && j.base_resp.status_msg) || (j.error && j.error.message) || ('HTTP ' + resp.status);
  var code = (j.base_resp && j.base_resp.status_code) || null;
  if (!code && j.error) {
    var m = String(j.error.message || '').match(/\((\d{3,4})\)\s*$/); // V2 把业务码写在 message 结尾 (NNNN)
    if (m) code = parseInt(m[1], 10);
  }
  var rid = j.request_id ? (' · request_id=' + j.request_id) : '';
  return 'HTTP ' + resp.status + ' · ' + msg + rid + miniMaxHint(code);
}

function buildVideoBody(ctx) {
  var items = selectedItems();
  if (ctx.ver === 'v1') {
    return {
      model: ctx.model,
      prompt: ctx.prompt || 'Animate this image.',
      first_frame_image: items[0].src, // 外链 URL 或 base64 Data URL
      duration: ctx.duration,
      resolution: ctx.resolution
    };
  }
  var content = [{ type: 'text', text: ctx.prompt }];
  var role = VIDEO_MODES[videoMode].role;
  items.forEach(function (it) {
    content.push({
      type: 'image_url',
      image_url: { url: it.ext ? it.src : 'mm_file://' + it.fileId },
      role: role
    });
  });
  return { model: ctx.model, content: content, resolution: ctx.resolution, duration: ctx.duration };
}

function runVideo(model) {
  var prompt = $('prompt').value.trim();
  var ver = videoApiVersion(model);
  var duration = parseInt($('duration').value, 10) || 6;
  var resolution = $('resolution').value;
  var items = selectedItems();

  if (ver === 'v2' && !prompt) return showError('MiniMax-H3 要求必须填写提示词(text 项必填)');
  if (ver === 'v1' && !items.length) return showError('Hailuo-02 为图生视频:请先在图片池勾选 1 张首帧图');
  if (ver === 'v2' && items.length > VIDEO_MODES[videoMode].cap) return showError('超出参考图数量上限(' + VIDEO_MODES[videoMode].cap + ' 张)');

  var submitUrl, queryUrl;
  try {
    submitUrl = versionedBase(ver) + '/video_generation';
    queryUrl = versionedBase(ver) + '/query/video_generation';
  } catch (e) { return; }

  var ctx = {
    model: model, ver: ver, prompt: prompt, duration: duration, resolution: resolution,
    submitUrl: submitUrl, queryUrl: queryUrl, retried: false,
    histInput: {
      prompt: prompt, duration: duration, resolution: resolution,
      videoMode: ver === 'v2' ? videoMode : 'first_frame',
      images: items.map(function (it) { return { id: it.id, name: it.name }; })
    }
  };

  setBusy(true);
  var needUpload = ver === 'v2' && items.some(function (i) { return !i.ext; });
  showLoading(needUpload ? '准备参考图(首次使用或过期需上传)...' : '提交视频生成任务...');

  var prep = ver === 'v2' ? ensureSelectedUploads() : Promise.resolve();
  prep
    .then(function () { return submitVideo(ctx); })
    .catch(function (e) {
      setBusy(false);
      addHistory({ id: histId(), ts: Date.now(), model: model, category: 'video', input: ctx.histInput, error: { message: e.message } });
      showError(e.message);
    });
}

/* file_id 过期时:清除缓存 fileId → 重新上传 → 重试一次 */
function maybeRetryExpired(msg, ctx) {
  if (ctx.retried || !/expired/i.test(String(msg))) return null;
  selectedItems().forEach(function (it) {
    if (!it.ext) patchItem(it.id, { fileId: null, fileTs: 0 });
  });
  savePool();
  renderPool();
  toast('参考图已过期,正在重新上传并重试…');
  return ensureSelectedUploads().then(function () {
    return submitVideo(Object.assign({}, ctx, { retried: true }));
  });
}

function submitVideo(ctx) {
  return fetch(ctx.submitUrl, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + apiKey(), 'Content-Type': 'application/json' },
    body: JSON.stringify(buildVideoBody(ctx))
  })
    .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, json: j }; }); })
    .then(function (resp) {
      var taskId, baseResp;
      if (!resp.ok) {
        var msg = describeMiniMaxError(resp);
        var retry = maybeRetryExpired(msg, ctx);
        if (retry) return retry;
        throw new Error(msg);
      }
      taskId = resp.json.task_id || (resp.json.task && resp.json.task.id);
      baseResp = resp.json.base_resp || (resp.json.task && resp.json.task.base_resp);
      if (!taskId) throw new Error('未返回 task_id: ' + JSON.stringify(resp.json));
      if (baseResp && baseResp.status_code !== 0) {
        var m2 = 'MiniMax 错误 ' + baseResp.status_code + ': ' + baseResp.status_msg + miniMaxHint(baseResp.status_code);
        var retry2 = maybeRetryExpired(m2, ctx);
        if (retry2) return retry2;
        throw new Error(m2);
      }
      showLoading('视频生成中 · task_id=' + taskId + ' · 轮询中(每 5 秒)...');
      return pollUntil(function () {
        return fetch(ctx.queryUrl + '?task_id=' + encodeURIComponent(taskId), { headers: { 'Authorization': 'Bearer ' + apiKey() } })
          .then(function (r) { return r.json(); })
          .then(function (j) {
            var status = String(j.status || (j.task && j.task.status) || '').toLowerCase();
            if (status === 'success' || status === 'succeeded') {
              return {
                done: true,
                value: {
                  videoUrl: ctx.ver === 'v2' ? extractVideoUrl(j) : null,
                  fileId: ctx.ver === 'v1' ? (j.file_id || null) : null,
                  status: status, raw: j
                }
              };
            }
            if (status === 'fail' || status === 'failed' || status === 'cancelled' || status === 'canceled') {
              var err = (j.base_resp && j.base_resp.status_msg) || (j.task && j.task.base_resp && j.task.base_resp.status_msg) || 'failed';
              return { done: true, value: { error: err, raw: j } };
            }
            return { done: false };
          });
      }, 5000, 90, '视频生成中')
        .then(function (result) { return finalizeVideo(ctx, taskId, result); });
    });
}

function extractVideoUrl(j) {
  return (j.task && j.task.content && j.task.content.url)
    || (j.task && j.task.video_url)
    || j.video_url
    || null;
}

/* V1 查询成功返回的是视频 file_id,需再调 /v1/files/retrieve 换 download_url */
function fetchVideoDownloadUrl(fileId) {
  return fetch(versionedBase('v1') + '/files/retrieve?file_id=' + encodeURIComponent(fileId), {
    headers: { 'Authorization': 'Bearer ' + apiKey() }
  })
    .then(function (r) { return r.json(); })
    .then(function (j) {
      var dl = j && j.file && j.file.download_url;
      if (!dl) throw new Error('files/retrieve 未返回 download_url: ' + JSON.stringify(j));
      if (!/^https?:\/\//i.test(dl)) dl = 'https://' + String(dl).replace(/^\/\//, '');
      return dl;
    });
}

function finalizeVideo(ctx, taskId, result) {
  setBusy(false);
  var model = ctx.model;
  var histInput = ctx.histInput;
  if (result.error) {
    var msg = '生成失败: ' + result.error;
    addHistory({ id: histId(), ts: Date.now(), model: model, category: 'video', input: histInput, error: { message: msg } });
    showError(msg);
    return null;
  }
  var finish = function (videoUrl) {
    if (!videoUrl) {
      var msg2 = '已完成但未返回视频 URL: ' + JSON.stringify(result.raw);
      addHistory({ id: histId(), ts: Date.now(), model: model, category: 'video', input: histInput, error: { message: msg2 } });
      showError(msg2);
      return;
    }
    showResult(
      '<div class="video-wrap"><video src="' + escHtml(videoUrl) + '" controls autoplay loop></video></div>'
      + '<div class="result-meta">model: <code>' + escHtml(model) + '</code> · task: <code>' + escHtml(taskId) + '</code> · status: <code>' + escHtml(result.status) + '</code></div>'
    );
    addHistory({
      id: histId(), ts: Date.now(), model: model, category: 'video',
      input: histInput,
      result: { videoUrl: videoUrl, taskId: taskId, status: result.status }
    });
  };
  if (!result.videoUrl && result.fileId) {
    showLoading('视频已生成,获取下载地址...');
    return fetchVideoDownloadUrl(result.fileId)
      .then(finish)
      .catch(function (e) {
        addHistory({ id: histId(), ts: Date.now(), model: model, category: 'video', input: histInput, error: { message: e.message } });
        showError('获取视频下载地址失败: ' + e.message);
      });
  }
  finish(result.videoUrl);
  return null;
}

/* ================= 语音合成 / 复刻 / 音乐 ================= */
/* runTts / runMusic / 音色库 / 复刻闭环 均在 models-audio.js 定义(先于本文件加载) */

/* MiniMax TTS 返回的 audio 是 hex 字符串:转 Uint8Array */
function hexToBytes(hex) {
  var len = hex.length / 2;
  var out = new Uint8Array(len);
  for (var i = 0; i < len; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

/* ================= 调用记录(localStorage,最多 50 条) ================= */
var LS_HISTORY = 'minimax_history_v1';
var HISTORY_MAX = 50;
var _histSeq = 0;
function histId() { return Date.now().toString(36) + '-' + (++_histSeq); }

function getHistory() {
  try {
    var arr = JSON.parse(localStorage.getItem(LS_HISTORY) || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}
function saveHistory(arr) {
  try {
    localStorage.setItem(LS_HISTORY, JSON.stringify(arr.slice(0, HISTORY_MAX)));
  } catch (e) {
    try { localStorage.setItem(LS_HISTORY, JSON.stringify(arr.slice(0, Math.max(1, Math.floor(HISTORY_MAX / 3))))); }
    catch (e2) { /* 忽略 */ }
  }
}
function addHistory(record) {
  var arr = getHistory();
  arr.unshift(record);
  saveHistory(arr);
  renderHistory();
}
function deleteHistoryRecord(id) {
  var arr = getHistory().filter(function (r) { return r.id !== id; });
  saveHistory(arr);
  renderHistory();
}
function clearHistory() {
  if (!confirm('确认清空所有调用记录?')) return;
  localStorage.removeItem(LS_HISTORY);
  renderHistory();
}

function categoryLabel(c) {
  return ({ chat: '对话', image: '文生图', video: '视频', tts: '语音合成', music: '音乐生成', clone: '音色复刻' })[c] || c;
}
function formatTime(ts) {
  var d = new Date(ts);
  var diff = Date.now() - ts;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return Math.floor(diff / 60000) + '分钟前';
  var today = new Date(); today.setHours(0, 0, 0, 0);
  var day = new Date(ts); day.setHours(0, 0, 0, 0);
  if (today - day < 86400000) {
    return '今天 ' + d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');
  }
  if (today - day < 2 * 86400000) {
    return '昨天 ' + d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');
  }
  return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');
}

function histPreview(r) {
  if (r.error) return '<span style="color:#cf1322">✗ ' + escHtml(r.error.message) + '</span>';
  var prompt = r.input.prompt || r.input.text || '';
  var promptShort = prompt.length > 60 ? prompt.slice(0, 60) + '…' : prompt;
  if (r.category === 'chat') {
    return escHtml(promptShort) + ' <span class="arrow">→</span> <span style="color:#595959">' + escHtml(((r.result.text || '').slice(0, 60))) + '</span>';
  }
  if (r.category === 'image') {
    return escHtml(promptShort) + ' <span class="arrow">→</span> <span style="color:#595959">' + r.result.imageUrls.length + ' 张图</span>';
  }
  if (r.category === 'video') {
    var imgs = Array.isArray(r.input.images) ? r.input.images.length : 0;
    var imgNote = imgs ? ' · ' + imgs + ' 张参考图' : '';
    return escHtml(promptShort) + imgNote + ' <span class="arrow">→</span> <span style="color:#595959">' + (r.result.videoUrl ? '视频已就绪' : '生成失败') + '</span>';
  }
  if (r.category === 'tts') {
    var modeNote = r.input.mode === 'async' ? ' · 异步' : '';
    return escHtml(promptShort) + modeNote + ' <span class="arrow">→</span> <span style="color:#595959">' + (r.result.format || 'mp3').toUpperCase() + ' ' + Math.round((r.result.bytes || 0) / 1024) + ' KB</span>';
  }
  if (r.category === 'music') {
    return escHtml(promptShort) + ' <span class="arrow">→</span> <span style="color:#595959">音乐 ' + Math.round((r.result.bytes || 0) / 1024) + ' KB' + (r.result.durationMs ? ' · ' + Math.round(r.result.durationMs / 1000) + 's' : '') + '</span>';
  }
  if (r.category === 'clone') {
    return '复刻 ' + escHtml((r.input && r.input.voice_id) || '-') + ' <span class="arrow">→</span> <span style="color:#595959">' + (r.error ? '失败' : '成功') + '</span>';
  }
  return '';
}

function renderHistory() {
  var arr = getHistory();
  $('hist_count_badge').textContent = arr.length;
  var el = $('history');
  if (!arr.length) {
    el.innerHTML = '<div class="history-empty">暂无调用记录(完成一次生成会自动记录在此)</div>';
    return;
  }
  el.innerHTML = arr.map(function (r) {
    var isFail = !!r.error;
    return '<div class="hist-row' + (isFail ? ' failed' : '') + '" data-id="' + r.id + '">'
      + '<div class="hist-meta"><span class="ts">' + escHtml(formatTime(r.ts)) + '</span>'
      + escHtml(r.model)
      + '<span class="badge' + (isFail ? ' badge-fail' : '') + '">' + escHtml(categoryLabel(r.category)) + '</span>'
      + '</div>'
      + '<div class="hist-preview">' + histPreview(r) + '</div>'
      + '<button class="hist-del" data-del="' + r.id + '" title="删除该记录">×</button>'
      + '</div>';
  }).join('');
  el.querySelectorAll('.hist-row').forEach(function (row) {
    row.onclick = function (e) {
      if (e.target && e.target.classList && e.target.classList.contains('hist-del')) return;
      var r = getHistory().find(function (x) { return x.id === row.dataset.id; });
      if (r) loadRecord(r);
    };
  });
  el.querySelectorAll('.hist-del').forEach(function (btn) {
    btn.onclick = function (e) {
      e.stopPropagation();
      deleteHistoryRecord(btn.dataset.del);
    };
  });
}

function setSelectValue(sel, v) {
  Array.prototype.some.call(sel.options, function (o) {
    if (o.value === String(v)) { sel.value = o.value; return true; }
    return false;
  });
}

/* 点击历史记录:恢复输入参数并重新渲染结果 */
function loadRecord(r) {
  $('model_name').value = r.model;
  $('model_name').dispatchEvent(new Event('change'));
  var input = r.input || {};
  if ('prompt' in input) $('prompt').value = input.prompt || '';
  if (r.category === 'chat') {
    if (input.max_tokens) $('max_tokens').value = input.max_tokens;
    if (input.temperature != null) $('temperature').value = input.temperature;
  }
  if (r.category === 'image') {
    if (input.ratio) $('aspect_ratio').value = input.ratio;
    if (input.n) $('image_count').value = input.n;
  }
  if (r.category === 'video') {
    setSelectValue($('duration'), input.duration);
    setSelectValue($('resolution'), input.resolution);
    // 恢复参考图勾选与模式(仅当图片仍在池中)
    if (input.videoMode === 'reference' && videoApiVersion(r.model) === 'v2') videoMode = 'reference';
    else videoMode = 'first_frame';
    if (Array.isArray(input.images)) {
      SEL = input.images
        .map(function (x) { return x && x.id; })
        .filter(function (id) { return !!id && !!getItem(id); });
      trimSelToCap();
    }
    renderModePills();
    renderPool();
  }
  if (r.category === 'tts') {
    if (input.voice_id) setSelectValue($('voice_id'), input.voice_id);
    if (input.speed != null) $('tts_speed').value = input.speed;
    if (input.vol != null) $('tts_vol').value = input.vol;
    if (input.pitch != null) $('tts_pitch').value = input.pitch;
    if (input.emotion != null) $('tts_emotion').value = input.emotion;
    if (input.lang != null) $('tts_lang_boost').value = input.lang;
    if (input.format) $('tts_format').value = input.format;
    if (input.sample_rate) $('tts_sample_rate').value = input.sample_rate;
    if (input.bitrate) $('tts_bitrate').value = input.bitrate;
    if (input.mode) {
      var wantMode = input.mode === 'async' ? 'async' : 'sync';
      $('tts_mode_seg').querySelectorAll('.seg-btn').forEach(function (b) {
        b.classList.toggle('active', b.dataset.mode === wantMode);
      });
    }
  }
  if (r.category === 'music') {
    if (input.lyrics != null) $('music_lyrics').value = input.lyrics;
    if (input.instrumental != null) $('music_instrumental').checked = !!input.instrumental;
    if (input.optimize != null) $('music_optimize').checked = !!input.optimize;
    if (input.format) $('music_format').value = input.format;
  }
  if (r.error) showError('失败: ' + r.error.message);
  else showResult(buildResultHTML(r));
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function buildResultHTML(r) {
  if (r.category === 'chat') {
    var m = r.result.meta || {};
    return '<div class="result-success-text">' + escHtml(r.result.text || '') + '</div>'
      + '<div class="result-meta">'
      + 'model: <code>' + escHtml(r.model) + '</code>'
      + (m.tokens ? ' · tokens: <code>' + m.tokens + '</code> (in ' + (m.prompt_tokens || 0) + ' / out ' + (m.completion_tokens || 0) + ')' : '')
      + ' · <span style="color:#52c41a">来自历史记录</span></div>';
  }
  if (r.category === 'image') {
    var urls = r.result.imageUrls || [];
    var grid = '<div class="image-grid">' + urls.map(function (u) {
      return '<a href="' + escHtml(u) + '" target="_blank" rel="noopener"><img src="' + escHtml(u) + '" loading="lazy" onerror="this.style.opacity=.4;this.title=\'链接已失效\'"></a>';
    }).join('') + '</div>';
    var meta = '<div class="result-meta">model: <code>' + escHtml(r.model) + '</code> · count: <code>' + urls.length + '</code>'
      + (r.input.ratio ? ' · ratio: <code>' + escHtml(r.input.ratio) + '</code>' : '')
      + ' · <span style="color:#52c41a">来自历史记录(旧链接可能已失效,新结果会自动入池)</span></div>';
    return grid + meta;
  }
  if (r.category === 'video') {
    if (!r.result.videoUrl) return '<div class="result-error">视频 URL 已失效</div>';
    return '<div class="video-wrap"><video src="' + escHtml(r.result.videoUrl) + '" controls loop></video></div>'
      + '<div class="result-meta">model: <code>' + escHtml(r.model) + '</code>'
      + (r.result.taskId ? ' · task: <code>' + escHtml(r.result.taskId) + '</code>' : '')
      + ' · <span style="color:#52c41a">来自历史记录</span></div>';
  }
  if (r.category === 'tts') {
    /* 异步结果不缓存音频(hex 过大),按 file_id 现取(9 小时内有效) */
    if (!r.result.audio && r.result.fileId) {
      return '<div class="result-meta">异步合成结果(9 小时内可重新下载):'
        + '<button class="btn-secondary btn-sm" type="button" onclick="redownloadAsyncAudio(\'' + escHtml(r.result.fileId) + '\',\'' + escHtml(r.result.format || 'mp3') + '\')">⬇ 重新获取音频</button></div>'
        + '<div class="result-meta">model: <code>' + escHtml(r.model) + '</code> · file_id: <code>' + escHtml(r.result.fileId) + '</code> · <span style="color:#52c41a">来自历史记录</span></div>';
    }
    if (!r.result.audio) return '<div class="result-error">音频数据丢失或过大未缓存,请重新生成</div>';
    var bytes2 = hexToBytes(r.result.audio);
    var mime2 = r.result.format === 'wav' ? 'audio/wav' : (r.result.format === 'flac' ? 'audio/flac' : 'audio/mpeg');
    var blob2 = new Blob([bytes2], { type: mime2 });
    var url2 = URL.createObjectURL(blob2);
    var filename2 = 'minimax-tts-' + r.id + '.' + (r.result.format || 'mp3');
    return '<div class="audio-wrap">'
      + '<audio src="' + url2 + '" controls></audio>'
      + '<a class="audio-download" href="' + url2 + '" download="' + filename2 + '">⬇ 下载 ' + filename2 + ' (' + Math.round(bytes2.length / 1024) + ' KB)</a>'
      + '</div>'
      + '<div class="result-meta">model: <code>' + escHtml(r.model) + '</code>'
      + ' · voice: <code>' + escHtml(r.input.voice_id || '-') + '</code>'
      + (r.result.chars ? ' · 计费 ' + r.result.chars + ' 字' : '')
      + ' · ' + bytes2.length + ' bytes'
      + ' · <span style="color:#52c41a">来自历史记录</span></div>';
  }
  if (r.category === 'music') {
    if (!r.result.audio) return '<div class="result-error">音频过大未缓存(仅记录参数),请重新生成</div>';
    var bytes3 = hexToBytes(r.result.audio);
    var blob3 = new Blob([bytes3], { type: r.result.format === 'wav' ? 'audio/wav' : 'audio/mpeg' });
    var url3 = URL.createObjectURL(blob3);
    var filename3 = 'minimax-music-' + r.id + '.' + (r.result.format || 'mp3');
    return '<div class="audio-wrap">'
      + '<audio src="' + url3 + '" controls></audio>'
      + '<a class="audio-download" href="' + url3 + '" download="' + filename3 + '">⬇ 下载 ' + filename3 + ' (' + Math.round(bytes3.length / 1024) + ' KB)</a>'
      + '</div>'
      + '<div class="result-meta">model: <code>' + escHtml(r.model) + '</code>'
      + (r.result.durationMs ? ' · 时长 ' + Math.round(r.result.durationMs / 1000) + 's' : '')
      + ' · <span style="color:#52c41a">来自历史记录</span></div>';
  }
  if (r.category === 'clone') {
    var demo = r.result && r.result.demoAudio;
    return '<div class="result-meta">复刻音色: <code>' + escHtml((r.input && r.input.voice_id) || '-') + '</code>'
      + ' · <span style="color:#52c41a">' + (r.error ? '失败' : '成功') + '</span>'
      + (demo ? '</div><div class="audio-wrap"><audio src="' + escHtml(demo) + '" controls></audio>' : '</div>');
  }
  return '<div class="result-error">未知记录类型</div>';
}

/* ================= 初始化 ================= */
loadConfig();
$('btn_save_config').onclick = saveConfig;
$('btn_clear_config').onclick = clearConfig;
$('model_name').onchange = refreshForm;
$('duration').onchange = applyV1Constraint;
$('btn_generate').onclick = onGenerate;
$('btn_cancel').onclick = function () { if (currentPoll) currentPoll.cancelled = true; };

/* 图片池:上传按钮 / 拖拽 / 清空 */
$('pool_file_input').addEventListener('change', function () {
  addLocalFiles(this.files);
  this.value = '';
});
$('pool_drop').addEventListener('click', function () { $('pool_file_input').click(); });
['dragenter', 'dragover'].forEach(function (ev) {
  $('pool_card').addEventListener(ev, function (e) {
    e.preventDefault();
    $('pool_card').classList.add('dragover');
  });
});
['dragleave', 'drop'].forEach(function (ev) {
  $('pool_card').addEventListener(ev, function (e) {
    e.preventDefault();
    if (ev === 'dragleave' && e.relatedTarget && $('pool_card').contains(e.relatedTarget)) return;
    $('pool_card').classList.remove('dragover');
  });
});
$('pool_card').addEventListener('drop', function (e) {
  if (e.dataTransfer && e.dataTransfer.files) addLocalFiles(e.dataTransfer.files);
});
$('btn_clear_pool').onclick = clearPool;

/* V2 参考图模式切换 */
$('video_mode_seg').querySelectorAll('.seg-btn').forEach(function (btn) {
  btn.onclick = function () {
    if (videoMode === btn.dataset.mode) return;
    videoMode = btn.dataset.mode;
    trimSelToCap();
    renderModePills();
    renderPool();
  };
});

loadPool();
refreshForm();
renderHistory();
$('btn_clear_history').onclick = clearHistory;
if (typeof initAudioPage === 'function') initAudioPage();

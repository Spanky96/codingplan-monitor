/* 语音合成 · 音色复刻 · 音色库 · 音乐生成(配合 models.html / models.js / models.css)
 *
 * 本文件先于 models.js 加载:只做定义,不在顶层触碰 DOM(models.js 的 $ 尚未就绪);
 * 入口 initAudioPage() 由 models.js 初始化时调用,refreshAudioForm() 由 refreshForm() 调用。
 *
 * 接口规格(官方文档 2026-08 核对,统一经中转站透传,端点与 MiniMax 官方一致):
 * - 同步 TTS   POST /v1/t2a_v2:text ≤1万字符;voice_setting{voice_id,speed[0.5,2],
 *   vol(0,10],pitch[-12,12],emotion};audio_setting{sample_rate,bitrate,format,channel};
 *   stream=true 流式返回逐行 JSON 分片,末片(status=2)含完整音频 hex;subtitle_enable 开字幕。
 * - 异步 TTS   POST /v1/t2a_async_v2(text ≤5万;注意字段名是 audio_sample_rate)
 *   → GET /v1/query/t2a_async_query_v2?task_id=(status: Processing/Success/Failed/Expired)
 *   → GET /v1/files/retrieve_content?file_id=(带 Authorization 下载二进制,9 小时内有效)。
 * - 音色库     POST /v1/get_voice{voice_type:'all'}(复刻音色需正式合成一次后才出现);
 *   删除 POST /v1/delete_voice{voice_type:'voice_cloning',voice_id}(仅复刻/文生音色)。
 * - 音色复刻   POST /v1/files/upload(purpose=voice_clone;mp3/m4a/wav,10s~5min,≤20MB)
 *   → POST /v1/voice_clone{file_id,voice_id,text?,model?,need_noise_reduction,
 *   need_volume_normalization} → demo_audio 试听链接(URL 形式)。
 * - 音乐生成   POST /v1/music_generation{model,prompt,lyrics,is_instrumental,
 *   lyrics_optimizer,audio_setting,audio_base64|audio_url(翻唱)} → data.audio(hex)。
 *
 * 通道:全部走中转站(sub2api 已注册上述原生端点透传,账号凭据由中转站托管);
 * 可用模型严格以 GET /v1/models 按分组返回为准,本页不额外合并模型。
 */
'use strict';

/* ================= 通道(统一中转站) ================= */
function relayChannel() { return { base: apiBase(), key: apiKey() }; }

/* ================= 模型名规范化 =================
 * 网关 /v1/models 可能返回上游不存在的非法裸名(如 speech-02、speech-2.6):
 * 官方合法模型名均带 -hd/-turbo 后缀,裸版本号名一律剔除(否则 2013 报错)。 */
function normalizeModelIds(relayIds) {
  return (relayIds || [])
    .filter(function (id) { return !/^speech-\d+(\.\d+)?$/.test(id); })
    .map(function (id) { return { id: id, note: '' }; });
}

/* ================= 常用系统音色(官方系统音色列表精选,离线兜底) ================= */
/* lb: 需配套的 language_boost(粤语音色需 Chinese,Yue) */
var COMMON_VOICES = [
  { g: '中文·经典', id: 'female-shaonv', n: '少女' },
  { g: '中文·经典', id: 'female-yujie', n: '御姐' },
  { g: '中文·经典', id: 'female-chengshu', n: '成熟女性' },
  { g: '中文·经典', id: 'female-tianmei', n: '甜美女性' },
  { g: '中文·经典', id: 'male-qn-qingse', n: '青涩青年' },
  { g: '中文·经典', id: 'male-qn-jingying', n: '精英青年' },
  { g: '中文·经典', id: 'male-qn-badao', n: '霸道青年' },
  { g: '中文·经典', id: 'male-qn-daxuesheng', n: '青年大学生' },
  { g: '中文·特色', id: 'Chinese (Mandarin)_News_Anchor', n: '新闻女声' },
  { g: '中文·特色', id: 'Chinese (Mandarin)_Male_Announcer', n: '播报男声' },
  { g: '中文·特色', id: 'Chinese (Mandarin)_Reliable_Executive', n: '沉稳高管' },
  { g: '中文·特色', id: 'Chinese (Mandarin)_Gentleman', n: '温润男声' },
  { g: '中文·特色', id: 'Chinese (Mandarin)_Radio_Host', n: '电台男主播' },
  { g: '中文·特色', id: 'Chinese (Mandarin)_Sweet_Lady', n: '甜美女声' },
  { g: '中文·特色', id: 'Chinese (Mandarin)_Warm_Girl', n: '温暖少女' },
  { g: '中文·特色', id: 'clever_boy', n: '聪明男童' },
  { g: '中文·特色', id: 'lovely_girl', n: '萌萌女童' },
  { g: '粤语(需语种增强)', id: 'Cantonese_GentleLady', n: '温柔女声', lb: 'Chinese,Yue' },
  { g: '粤语(需语种增强)', id: 'Cantonese_CuteGirl', n: '可爱女孩', lb: 'Chinese,Yue' },
  { g: '英文', id: 'English_Graceful_Lady', n: 'Graceful Lady', lb: 'English' },
  { g: '英文', id: 'English_Trustworthy_Man', n: 'Trustworthy Man', lb: 'English' },
  { g: '英文', id: 'English_Persuasive_Man', n: 'Persuasive Man', lb: 'English' },
  { g: '英文', id: 'English_radiant_girl', n: 'radiant girl', lb: 'English' },
  { g: '英文', id: 'English_Lucky_Robot', n: 'Lucky Robot', lb: 'English' },
  { g: '日文', id: 'Japanese_Whisper_Belle', n: 'Whisper Belle', lb: 'Japanese' },
  { g: '日文', id: 'Japanese_GentleButler', n: 'Gentle Butler', lb: 'Japanese' }
];

/* ================= 音色库状态(localStorage) ================= */
var LS_VOICES = 'minimax_voice_lib_v1';   // {ts, system:[{id,n}], cloning:[{id}], generation:[{id}]}
var LS_CLONES = 'minimax_my_clones_v1';   // [{id, ts}] 本页复刻成功的音色
var VOICE_LIB = { ts: 0, system: [], cloning: [], generation: [] };
var MY_CLONES = [];

function loadVoiceState() {
  try {
    var lib = JSON.parse(localStorage.getItem(LS_VOICES) || 'null');
    if (lib && typeof lib === 'object') {
      VOICE_LIB = {
        ts: lib.ts || 0,
        system: Array.isArray(lib.system) ? lib.system.filter(function (v) { return v && v.id; }) : [],
        cloning: Array.isArray(lib.cloning) ? lib.cloning.filter(function (v) { return v && v.id; }) : [],
        generation: Array.isArray(lib.generation) ? lib.generation.filter(function (v) { return v && v.id; }) : []
      };
    }
  } catch (e) { VOICE_LIB = { ts: 0, system: [], cloning: [], generation: [] }; }
  try {
    var clones = JSON.parse(localStorage.getItem(LS_CLONES) || '[]');
    MY_CLONES = Array.isArray(clones) ? clones.filter(function (v) { return v && v.id; }) : [];
  } catch (e) { MY_CLONES = []; }
}
function saveVoiceState() {
  try { localStorage.setItem(LS_VOICES, JSON.stringify(VOICE_LIB)); } catch (e) { /* 配额满则放弃缓存 */ }
  try { localStorage.setItem(LS_CLONES, JSON.stringify(MY_CLONES.slice(0, 50))); } catch (e) { /* 同上 */ }
}

/* ================= 音色下拉框 ================= */
function voiceOptionHtml(v) {
  var lb = v.lb ? ' data-lb="' + escHtml(v.lb) + '"' : '';
  var label = v.n ? (escHtml(v.n) + '(' + escHtml(v.id) + ')') : escHtml(v.id);
  return '<option value="' + escHtml(v.id) + '"' + lb + '>' + label + '</option>';
}
function voiceGroupHtml(label, voices) {
  if (!voices.length) return '';
  return '<optgroup label="' + escHtml(label) + ' · ' + voices.length + '">' + voices.map(voiceOptionHtml).join('') + '</optgroup>';
}

function renderVoiceSelect() {
  var sel = $('voice_id');
  if (!sel) return;
  var prev = sel.value;
  var seen = {};
  var cloneIds = MY_CLONES.map(function (c) { return c.id; });
  var localClones = MY_CLONES.map(function (c) { return { id: c.id }; });
  var remoteClones = VOICE_LIB.cloning.filter(function (v) {
    if (cloneIds.indexOf(v.id) >= 0) { seen[v.id] = true; return false; }
    return true;
  });
  var html = voiceGroupHtml('我的复刻', localClones);
  html += voiceGroupHtml('复刻音色(在线)', remoteClones);
  html += voiceGroupHtml('文生音色(在线)', VOICE_LIB.generation);
  var commonGroups = [];
  COMMON_VOICES.forEach(function (v) {
    if (seen[v.id]) return;
    seen[v.id] = true;
    var last = commonGroups[commonGroups.length - 1];
    if (last && last.label === v.g) last.voices.push(v);
    else commonGroups.push({ label: v.g, voices: [v] });
  });
  commonGroups.forEach(function (g) { html += voiceGroupHtml('系统·' + g.label, g.voices); });
  var online = VOICE_LIB.system.filter(function (v) { return !seen[v.id]; });
  html += voiceGroupHtml('系统音色·在线全部', online);
  sel.innerHTML = html || '<option value="female-shaonv">female-shaonv(少女)</option>';
  if (prev) setSelectValue(sel, prev);
  if (!sel.value) sel.value = 'female-shaonv';
}

/* 拉取全部可用音色(system + voice_cloning + voice_generation),经中转站透传;
 * silent=true 供自动拉取使用,失败只改提示不打 toast */
function fetchVoiceLib(silent) {
  var ch;
  try { ch = relayChannel(); }
  catch (e) { if (!silent) toast('请先在顶部填写 API Key', true); return Promise.resolve(); }
  var btn = $('btn_fetch_voices');
  btn.disabled = true;
  btn.textContent = '获取中...';
  return fetch(versionedBase('v1') + '/get_voice', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + ch.key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ voice_type: 'all' })
  })
    .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, json: j }; }); })
    .then(function (resp) {
      btn.disabled = false;
      btn.textContent = '获取在线音色';
      var j = resp.json || {};
      var base = j.base_resp;
      if (!resp.ok || !base || base.status_code !== 0) {
        if (!silent) toast('获取音色失败: ' + audioErrMsg(base, resp), true);
        return;
      }
      VOICE_LIB = {
        ts: Date.now(),
        system: (j.system_voice || []).map(function (v) { return { id: v.voice_id, n: v.voice_name }; }),
        cloning: (j.voice_cloning || []).map(function (v) { return { id: v.voice_id }; }),
        generation: (j.voice_generation || []).map(function (v) { return { id: v.voice_id }; })
      };
      saveVoiceState();
      renderVoiceSelect();
      if (!silent) toast('已获取 ' + VOICE_LIB.system.length + ' 个系统音色 · 复刻 ' + VOICE_LIB.cloning.length + ' 个');
    })
    .catch(function (e) {
      btn.disabled = false;
      btn.textContent = '获取在线音色';
      if (!silent) toast('获取音色失败: ' + e.message, true);
    });
}

/* ================= 错误提示(语音/复刻/音乐) ================= */
var AUDIO_HINTS = {
  1004: '鉴权失败:请检查 API Key 是否正确',
  1008: '账户余额不足,请充值',
  1026: '内容触发风控(敏感内容)',
  1042: '文本非法字符占比超过 10%',
  1043: '复刻音频与 text_validation 相似度校验未通过',
  2013: '输入参数不合法,请检查模型名/参数',
  2038: '无复刻权限:中转站上游账号需先在 MiniMax 平台完成个人/企业认证',
  2049: 'API Key 无效'
};
function audioErrMsg(base, resp) {
  if (base && base.status_code !== undefined && base.status_code !== 0) {
    var msg = 'MiniMax 错误 ' + base.status_code + ': ' + (base.status_msg || '');
    return msg + (AUDIO_HINTS[base.status_code] ? '(💡 ' + AUDIO_HINTS[base.status_code] + ')' : '');
  }
  /* 中转站错误信封 {"error":{"message":...}}:账号池暂无可用通道 / 端点未映射等 */
  var relayErr = resp && resp.json && resp.json.error && resp.json.error.message;
  if (relayErr) {
    var hint = /no available accounts/i.test(String(relayErr))
      ? '(💡 中转站当前无可用账号通道,请稍后重试)'
      : (/not mapped|endpoint-mapped/i.test(String(relayErr))
        ? '(💡 中转站未映射该端点:请在 sub2api 账号上启用 minimax 端点预设)'
        : '');
    return '中转站错误: ' + relayErr + hint;
  }
  return 'HTTP ' + resp.status + ' · ' + JSON.stringify(resp.json || {}).slice(0, 300);
}
function audioJson(fetchPromise) {
  return fetchPromise
    .then(function (r) {
      return r.text().then(function (txt) {
        var j = null;
        try { j = JSON.parse(txt); } catch (e) { /* 非 JSON 响应(如网关纯文本 404)在下方给出可读错误 */ }
        return { ok: r.ok, status: r.status, json: j, text: txt };
      });
    })
    .then(function (resp) {
      if (!resp.json) {
        throw new Error('HTTP ' + resp.status + ' · 非 JSON 响应: ' + String(resp.text).slice(0, 120));
      }
      var base = resp.json.base_resp;
      if (!resp.ok || (base && base.status_code !== 0) || resp.json.error) {
        throw new Error(audioErrMsg(base, resp));
      }
      return resp.json;
    });
}

/* ================= 音频渲染(试听 + 下载,hex / blob 通用) ================= */
function mimeOf(format) {
  if (format === 'wav') return 'audio/wav';
  if (format === 'flac') return 'audio/flac';
  return 'audio/mpeg';
}
function renderAudioResult(hexOrBytes, format, metaHtml, filename) {
  var bytes = (typeof hexOrBytes === 'string') ? hexToBytes(hexOrBytes) : hexOrBytes;
  var url = URL.createObjectURL(new Blob([bytes], { type: mimeOf(format) }));
  var name = filename || ('minimax-' + Date.now() + '.' + (format || 'mp3'));
  showResult(
    '<div class="audio-wrap">'
    + '<audio src="' + url + '" controls autoplay></audio>'
    + '<a class="audio-download" href="' + url + '" download="' + escHtml(name) + '">⬇ 下载 ' + escHtml(name) + ' (' + Math.round(bytes.length / 1024) + ' KB)</a>'
    + '</div>' + (metaHtml || '')
  );
}

/* ================= 语音合成(同步 / 流式 / 异步) ================= */
function currentTtsMode() {
  var active = $('tts_mode_seg').querySelector('.seg-btn.active');
  return active ? active.dataset.mode : 'sync';
}
function buildVoiceSetting() {
  var vs = {
    voice_id: $('voice_id').value,
    speed: parseFloat($('tts_speed').value) || 1.0,
    vol: parseFloat($('tts_vol').value) || 1.0,
    pitch: parseInt($('tts_pitch').value, 10) || 0
  };
  var emotion = $('tts_emotion').value;
  if (emotion) vs.emotion = emotion;
  return vs;
}
function buildAudioSetting(isAsync) {
  var format = $('tts_format').value;
  var as = isAsync
    ? { audio_sample_rate: parseInt($('tts_sample_rate').value, 10), format: format, channel: 1 }
    : { sample_rate: parseInt($('tts_sample_rate').value, 10), format: format, channel: 1 };
  if (format === 'mp3') as.bitrate = parseInt($('tts_bitrate').value, 10); // 仅 mp3 生效
  return as;
}
function ttsHistInput(text, mode) {
  return {
    text: text, mode: mode,
    voice_id: $('voice_id').value,
    speed: parseFloat($('tts_speed').value) || 1.0,
    vol: parseFloat($('tts_vol').value) || 1.0,
    pitch: parseInt($('tts_pitch').value, 10) || 0,
    emotion: $('tts_emotion').value,
    lang: $('tts_lang_boost').value,
    format: $('tts_format').value,
    sample_rate: $('tts_sample_rate').value,
    bitrate: $('tts_bitrate').value
  };
}
function ttsMetaHtml(model, extra) {
  var bits = ['model: <code>' + escHtml(model) + '</code>', 'voice: <code>' + escHtml($('voice_id').value) + '</code>'];
  if (extra) bits.push(extra);
  return '<div class="result-meta">' + bits.join(' · ') + '</div>';
}

function runTts(model) {
  var text = $('prompt').value.trim();
  if (!text) return showError('请输入要合成的文本(在「输入」区)');
  var mode = currentTtsMode();
  if (mode === 'sync' && text.length > 10000) return showError('同步合成单次最长 1 万字符(当前 ' + text.length + '),请切换「异步」或缩短文本');
  if (mode === 'async' && text.length > 50000) return showError('异步合成单次最长 5 万字符(当前 ' + text.length + ')');
  var histInput = ttsHistInput(text, mode);
  setBusy(true);
  var job = (mode === 'sync') ? runTtsSync(model, text, histInput) : runTtsAsync(model, text, histInput);
  job.catch(function (e) {
    setBusy(false);
    addHistory({ id: histId(), ts: Date.now(), model: model, category: 'tts', input: histInput, error: { message: e.message } });
    showError(e.message);
  });
}

/* 同步:非流式一次性返回;流式逐行分片,末片含完整音频(长文本更稳,不易超时) */
function runTtsSync(model, text, histInput) {
  var ch = relayChannel();
  var streaming = $('tts_stream').checked && text.length > 500;
  var body = {
    model: model,
    text: text,
    stream: !!streaming,
    voice_setting: buildVoiceSetting(),
    audio_setting: buildAudioSetting(false)
  };
  var lang = $('tts_lang_boost').value;
  if (lang) body.language_boost = lang;
  if ($('tts_subtitle').checked) body.subtitle_enable = true;
  showLoading(streaming ? '流式合成中...' : '合成语音中...');
  var url = versionedBase('v1') + '/t2a_v2';
  var headers = { 'Authorization': 'Bearer ' + ch.key, 'Content-Type': 'application/json' };

  if (!streaming) {
    return audioJson(fetch(url, { method: 'POST', headers: headers, body: JSON.stringify(body) }))
      .then(function (j) {
        var hex = j.data && j.data.audio;
        if (!hex) throw new Error('未返回音频: ' + JSON.stringify(j).slice(0, 300));
        finishTts(model, histInput, hex, j);
      });
  }
  return fetch(url, { method: 'POST', headers: headers, body: JSON.stringify(body) })
    .then(function (r) {
      if (!r.ok || !r.body) {
        return r.json().then(function (j) { throw new Error(audioErrMsg(j && j.base_resp, { status: r.status, json: j })); });
      }
      var reader = r.body.getReader();
      var decoder = new TextDecoder();
      var buffer = '';
      var finalAudio = '';
      var received = 0;
      var subtitleFile = '';
      /* 逐行解析 JSON 分片;末片 status=2 自带拼接后的完整音频 hex */
      function pump() {
        return reader.read().then(function (res) {
          if (res.done) {
            if (!finalAudio) throw new Error('流式响应结束但未收到完整音频分片');
            return { hex: finalAudio, subtitle: subtitleFile };
          }
          buffer += decoder.decode(res.value, { stream: true });
          var lines = buffer.split('\n');
          buffer = lines.pop() || '';
          lines.forEach(function (line) {
            var s = line.trim();
            if (!s) return;
            var j;
            try { j = JSON.parse(s); } catch (e) { return; }
            var base = j.base_resp;
            if (base && base.status_code !== 0) throw new Error(audioErrMsg(base, { status: r.status, json: j }));
            if (j.data && j.data.audio) {
              received += j.data.audio.length / 2;
              if (j.data.status === 2) { finalAudio = j.data.audio; if (j.data.subtitle_file) subtitleFile = j.data.subtitle_file; }
            }
          });
          showLoading('流式合成中 · 已接收 ' + Math.round(received / 1024) + ' KB...');
          return pump();
        });
      }
      return pump().then(function (out) {
        finishTts(model, histInput, out.hex, { data: { subtitle_file: out.subtitle } });
      });
    });
}

function finishTts(model, histInput, hex, j) {
  setBusy(false);
  var extra = j.extra_info || {};
  var meta = ttsMetaHtml(model,
    (extra.audio_length ? '时长 ' + Math.round(extra.audio_length / 1000) + 's' : '')
    + (extra.usage_characters != null ? ' · 计费 ' + extra.usage_characters + ' 字' : ''));
  var subtitle = j.data && j.data.subtitle_file;
  if (subtitle) meta += '<div class="result-meta">字幕: <a href="' + escHtml(subtitle) + '" target="_blank" rel="noopener">下载字幕 JSON(句级时间戳)</a></div>';
  renderAudioResult(hex, histInput.format, meta);
  addHistory({
    id: histId(), ts: Date.now(), model: model, category: 'tts',
    input: histInput,
    result: { audio: hex, format: histInput.format, bytes: hex.length / 2, mode: 'sync', chars: extra.usage_characters }
  });
}

/* 异步:提交任务 → 轮询(3s,查询接口限 10 QPS)→ retrieve_content 下载(9 小时内有效) */
function runTtsAsync(model, text, histInput) {
  var ch;
  try { ch = relayChannel(); }
  catch (e) { return Promise.reject(e); }
  var body = {
    model: model,
    text: text,
    voice_setting: buildVoiceSetting(),
    audio_setting: buildAudioSetting(true)
  };
  var lang = $('tts_lang_boost').value;
  if (lang) body.language_boost = lang;
  showLoading('提交异步合成任务...');
  var headers = { 'Authorization': 'Bearer ' + ch.key, 'Content-Type': 'application/json' };
  return audioJson(fetch(versionedBase('v1') + '/t2a_async_v2', { method: 'POST', headers: headers, body: JSON.stringify(body) }))
    .then(function (j) {
      var taskId = j.task_id;
      if (!taskId) throw new Error('未返回 task_id: ' + JSON.stringify(j).slice(0, 300));
      return pollUntil(function () {
        return fetch(versionedBase('v1') + '/query/t2a_async_query_v2?task_id=' + encodeURIComponent(taskId), { headers: headers })
          .then(function (r) { return r.json(); })
          .then(function (q) {
            var status = String(q.status || '').toLowerCase();
            if (status === 'success') return { done: true, value: q.file_id };
            if (status === 'failed' || status === 'expired') {
              throw new Error('异步任务 ' + status + ': ' + ((q.base_resp && q.base_resp.status_msg) || ''));
            }
            return { done: false };
          });
      }, 3000, 120, '异步合成中(task ' + taskId + ')');
    })
    .then(function (fileId) {
      if (!fileId) throw new Error('任务完成但未返回 file_id');
      showLoading('任务完成,下载音频...');
      return downloadAsyncAudio(String(fileId), histInput.format);
    })
    .then(function (file) {
      setBusy(false);
      var meta = ttsMetaHtml(model, 'file_id: <code>' + escHtml(file.fileId) + '</code> · 下载链接 9 小时内有效');
      if (file.isAudio) {
        renderAudioResult(file.bytes, histInput.format, meta, 'minimax-async-' + file.fileId + '.' + histInput.format);
      } else {
        showResult('<div class="result-meta">结果为压缩包(音频+字幕+附加信息):'
          + '<a class="audio-download" href="' + file.url + '" download="minimax-async-' + escHtml(file.fileId) + '.zip">⬇ 下载 zip(' + Math.round(file.bytes.length / 1024) + ' KB)</a></div>' + meta);
      }
      addHistory({
        id: histId(), ts: Date.now(), model: model, category: 'tts',
        input: histInput,
        result: { fileId: String(file.fileId), format: histInput.format, bytes: file.bytes.length, mode: 'async', zip: !file.isAudio }
      });
    });
}

/* 从中转站下载异步结果二进制(retrieve_content 需带 Authorization,不能直接放 <audio src>) */
function downloadAsyncAudio(fileId, format) {
  var ch;
  try { ch = relayChannel(); }
  catch (e) { return Promise.reject(e); }
  return fetch(versionedBase('v1') + '/files/retrieve_content?file_id=' + encodeURIComponent(fileId), {
    headers: { 'Authorization': 'Bearer ' + ch.key }
  })
    .then(function (r) {
      if (!r.ok) throw new Error('下载失败: HTTP ' + r.status);
      var disp = r.headers.get('content-disposition') || '';
      var m = disp.match(/filename=([^;]+)/i);
      var name = m ? m[1].replace(/^"|"$/g, '') : '';
      var type = r.headers.get('content-type') || '';
      return r.arrayBuffer().then(function (ab) {
        return { bytes: new Uint8Array(ab), name: name, type: type };
      });
    })
    .then(function (file) {
      var isAudio = /^(audio\/|application\/octet-stream)/.test(file.type) || /\.(mp3|wav|flac)$/i.test(file.name || ('x.' + format));
      var blob = new Blob([file.bytes], { type: isAudio ? mimeOf(format) : 'application/zip' });
      return { fileId: fileId, bytes: file.bytes, url: URL.createObjectURL(blob), isAudio: isAudio, name: file.name };
    });
}

/* 历史记录回放:异步结果未缓存音频,按 file_id 重新拉取 */
function redownloadAsyncAudio(fileId, format) {
  showLoading('重新下载音频(file_id ' + fileId + ')...');
  downloadAsyncAudio(fileId, format || 'mp3')
    .then(function (file) {
      setBusy(false);
      var meta = '<div class="result-meta">file_id: <code>' + escHtml(fileId) + '</code> · 来自历史记录(9 小时内有效,过期需重新生成)</div>';
      if (file.isAudio) renderAudioResult(file.bytes, format || 'mp3', meta, 'minimax-async-' + fileId + '.' + format);
      else showResult('<div class="result-meta"><a class="audio-download" href="' + file.url + '" download="minimax-async-' + escHtml(fileId) + '.zip">⬇ 下载 zip</a></div>' + meta);
    })
    .catch(function (e) {
      setBusy(false);
      showError('重新下载失败: ' + e.message);
    });
}

/* ================= 音色复刻(上传 → 复刻 → 试听 → 入下拉) ================= */
var cloneFile = null; // {file, name, duration}

function randomVoiceId() {
  return 'vc' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}
function isValidVoiceId(v) {
  return /^[A-Za-z][A-Za-z0-9_-]{7,255}$/.test(v) && !/[-_]$/.test(v);
}
/* 浏览器侧探测音频时长(元数据读取失败则跳过,由服务端兜底校验) */
function probeAudioDuration(file) {
  return new Promise(function (resolve) {
    var url = URL.createObjectURL(file);
    var audio = new Audio();
    var done = false;
    var finish = function (d) {
      if (done) return;
      done = true;
      URL.revokeObjectURL(url);
      resolve(d);
    };
    audio.onloadedmetadata = function () { finish(audio.duration); };
    audio.onerror = function () { finish(null); };
    setTimeout(function () { finish(null); }, 4000);
    audio.src = url;
  });
}
function onCloneFilePicked(file) {
  if (!file) return;
  if (!/\.(mp3|m4a|wav)$/i.test(file.name) && !/^audio\//.test(file.type)) {
    return toast('复刻音频仅支持 mp3 / m4a / wav:' + file.name, true);
  }
  if (file.size > 20 * 1024 * 1024) {
    return toast('复刻音频不能超过 20MB(当前 ' + Math.round(file.size / 1048576) + 'MB)', true);
  }
  $('clone_file_name').textContent = file.name + '(' + Math.round(file.size / 1024) + ' KB,读取时长中...)';
  probeAudioDuration(file).then(function (d) {
    cloneFile = { file: file, name: file.name, duration: d };
    var text = file.name + ' · ' + Math.round(file.size / 1024) + ' KB';
    if (d) text += ' · ' + Math.round(d) + ' 秒' + ((d < 10 || d > 300) ? '(要求 10 秒~5 分钟)' : ' ✓');
    $('clone_file_name').textContent = text;
  });
}
function uploadCloneAudio(ch) {
  var fd = new FormData();
  fd.append('file', cloneFile.file);
  fd.append('purpose', 'voice_clone');
  return audioJson(fetch(versionedBase('v1') + '/files/upload', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + ch.key },
    body: fd
  })).then(function (j) {
    var fid = j.file && j.file.file_id;
    if (!fid) throw new Error('上传未返回 file_id: ' + JSON.stringify(j).slice(0, 300));
    return fid;
  });
}
function renderCloneChips() {
  var el = $('clone_chips');
  if (!el) return;
  if (!MY_CLONES.length) {
    el.innerHTML = '<span class="field-hint">暂无 — 复刻成功后会出现在这里</span>';
    return;
  }
  el.innerHTML = MY_CLONES.map(function (c) {
    return '<span class="clone-chip" data-vid="' + escHtml(c.id) + '">' + escHtml(c.id)
      + '<button type="button" title="删除该复刻音色">×</button></span>';
  }).join('');
  el.querySelectorAll('.clone-chip button').forEach(function (btn) {
    btn.onclick = function (e) {
      e.stopPropagation();
      deleteClonedVoice(btn.parentElement.dataset.vid);
    };
  });
}
function deleteClonedVoice(voiceId) {
  if (!confirm('确认删除复刻音色 ' + voiceId + '?删除后该 voice_id 无法再用。')) return;
  var removeLocal = function () {
    MY_CLONES = MY_CLONES.filter(function (c) { return c.id !== voiceId; });
    saveVoiceState();
    renderVoiceSelect();
    renderCloneChips();
  };
  var ch;
  try { ch = relayChannel(); }
  catch (e) {
    if (!confirm('未填写 API Key,仅从本地移除(不影响服务端)?')) return;
    removeLocal();
    toast('已从本地移除 ' + voiceId);
    return;
  }
  audioJson(fetch(versionedBase('v1') + '/delete_voice', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + ch.key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ voice_type: 'voice_cloning', voice_id: voiceId })
  }))
    .then(function () {
      removeLocal();
      toast('已删除复刻音色 ' + voiceId);
    })
    .catch(function (e) { toast('删除失败: ' + e.message, true); });
}

function runClone() {
  var vid = $('clone_voice_id').value.trim();
  if (!cloneFile) return showCloneError('请先选择复刻音频(mp3/m4a/wav,10 秒~5 分钟)');
  if (cloneFile.duration && (cloneFile.duration < 10 || cloneFile.duration > 300)) {
    return showCloneError('音频时长 ' + Math.round(cloneFile.duration) + ' 秒,要求 10 秒 ~ 5 分钟');
  }
  if (!isValidVoiceId(vid)) {
    return showCloneError('Voice ID 不合法:8~256 位,首字符须为字母,仅限字母/数字/-/_,末位不能是 - 或 _');
  }
  var ch;
  try { ch = relayChannel(); }
  catch (e) { return showCloneError('请先在顶部填写 API Key'); }
  var demoEnabled = $('clone_demo_enable').checked;
  var demoText = $('clone_demo_text').value.trim();
  if (demoEnabled && !demoText) return showCloneError('已勾选「生成试听」,请填写试听文本');
  var model = $('model_name').value;
  if (!/^speech-/.test(model)) model = 'speech-2.8-hd'; // 复刻卡片仅语音类可见,兜底

  var btn = $('btn_clone');
  btn.disabled = true;
  btn.textContent = '复刻中(上传+复刻,约需十几秒)...';
  $('clone_result').innerHTML = '<div class="result-loading"><div class="spin"></div>正在上传复刻音频...</div>';

  uploadCloneAudio(ch)
    .then(function (fid) {
      $('clone_result').innerHTML = '<div class="result-loading"><div class="spin"></div>音频已上传(file_id ' + fid + '),正在复刻音色...</div>';
      var body = {
        file_id: Number(fid),
        voice_id: vid,
        need_noise_reduction: $('clone_nr').checked,
        need_volume_normalization: $('clone_vnorm').checked
      };
      if (demoEnabled) {
        body.text = demoText.slice(0, 1000);
        body.model = model;
      }
      return audioJson(fetch(versionedBase('v1') + '/voice_clone', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + ch.key, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }));
    })
    .then(function (j) {
      btn.disabled = false;
      btn.textContent = '开始复刻';
      if (MY_CLONES.every(function (c) { return c.id !== vid; })) MY_CLONES = [{ id: vid, ts: Date.now() }].concat(MY_CLONES);
      saveVoiceState();
      renderVoiceSelect();
      setSelectValue($('voice_id'), vid);
      renderCloneChips();
      var html = '<div class="clone-ok">✓ 复刻成功:voice_id <code>' + escHtml(vid) + '</code></div>';
      if (j.demo_audio) {
        html += '<div class="audio-wrap"><audio src="' + escHtml(j.demo_audio) + '" controls></audio>'
          + '<a class="audio-download" href="' + escHtml(j.demo_audio) + '" download="clone-demo-' + escHtml(vid) + '.mp3" target="_blank" rel="noopener">⬇ 下载试听音频</a></div>';
      }
      var extra = j.extra_info || {};
      html += '<div class="result-meta">复刻音色已加入音色下拉框并自动选中。'
        + (extra.usage_characters != null ? '试听计费 ' + extra.usage_characters + ' 字。' : '')
        + '注意:官方要求复刻音色 <b>7 天内正式合成一次</b>,否则会被删除;且正式合成一次后才能在「在线音色」接口中查到。</div>'
        + '<div class="actions"><button class="btn-primary btn-sm" id="btn_use_clone" type="button">↑ 用该音色立即合成(激活)</button></div>';
      $('clone_result').innerHTML = html;
      $('btn_use_clone').onclick = function () {
        window.scrollTo({ top: 0, behavior: 'smooth' });
        toast('已选中 ' + vid + ',在上方输入文本点击「生成」即可正式合成');
      };
      addHistory({
        id: histId(), ts: Date.now(), model: 'voice_clone', category: 'clone',
        input: { voice_id: vid, file: cloneFile.name, demo: demoEnabled },
        result: { voiceId: vid, demoAudio: j.demo_audio || '' }
      });
      toast('复刻成功:' + vid + '(已加入音色下拉)');
    })
    .catch(function (e) {
      btn.disabled = false;
      btn.textContent = '开始复刻';
      showCloneError(e.message);
      addHistory({
        id: histId(), ts: Date.now(), model: 'voice_clone', category: 'clone',
        input: { voice_id: vid, file: cloneFile ? cloneFile.name : '' },
        error: { message: e.message }
      });
    });
}
function showCloneError(msg) {
  $('clone_result').innerHTML = '<div class="result-error">' + escHtml(msg) + '</div>';
}

/* ================= 音乐生成(经中转站透传 /v1/music_generation) ================= */
function readCoverAudio() {
  var url = ($('music_cover_url').value || '').trim();
  if (url) return Promise.resolve({ audio_url: url });
  var input = $('music_cover_file_input');
  var file = input && input.files && input.files[0];
  if (!file) return Promise.resolve(null);
  if (file.size > 50 * 1024 * 1024) return Promise.reject(new Error('翻唱参考音频不能超过 50MB'));
  return new Promise(function (resolve, reject) {
    var reader = new FileReader();
    reader.onerror = function () { reject(new Error('读取参考音频失败')); };
    reader.onload = function () {
      var dataUrl = String(reader.result);
      resolve({ audio_base64: dataUrl.slice(dataUrl.indexOf(',') + 1) }); // 去掉 data:...;base64, 前缀
    };
    reader.readAsDataURL(file);
  });
}

function runMusic(model) {
  var isCover = /cover/.test(model);
  var prompt = $('prompt').value.trim();
  var lyrics = $('music_lyrics').value.trim();
  var instrumental = $('music_instrumental').checked;
  var optimize = $('music_optimize').checked;

  if (isCover && (prompt.length < 10 || prompt.length > 300)) {
    return showError('翻唱需填写 10~300 字的目标风格描述(在「音乐描述」中)');
  }
  if (!instrumental && !optimize && !lyrics) {
    return showError('请填写歌词;或勾选「由描述自动生成歌词」;或勾选「纯音乐」');
  }
  if (!instrumental && !prompt && !optimize && !isCover && lyrics) {
    return showError('非纯音乐建议同时填写音乐描述(风格/情绪),当前为空');
  }
  if (prompt && prompt.length > 2000) return showError('音乐描述最长 2000 字符');
  if (lyrics && lyrics.length > 3500) return showError('歌词最长 3500 字符');

  var ch;
  try { ch = relayChannel(); }
  catch (e) { return showError('请先在顶部填写 API Key'); }

  var format = $('music_format').value;
  var histInput = { prompt: prompt, lyrics: lyrics, instrumental: instrumental, optimize: optimize, format: format };
  var body = {
    model: model,
    is_instrumental: instrumental,
    lyrics_optimizer: optimize,
    output_format: 'hex',
    audio_setting: {
      sample_rate: parseInt($('music_sample_rate').value, 10),
      bitrate: parseInt($('music_bitrate').value, 10),
      format: format
    }
  };
  if (prompt) body.prompt = prompt;
  if (!instrumental && lyrics) body.lyrics = lyrics;

  setBusy(true);
  var prep = Promise.resolve(body);
  if (isCover) {
    prep = readCoverAudio().then(function (audio) {
      if (!audio) throw new Error('翻唱需提供参考音频:选择本地文件或填写 URL');
      return Object.assign({}, body, audio);
    });
  }
  showLoading('生成音乐中(通常 30 秒~2 分钟,请勿关闭页面)...');
  prep
    .then(function (finalBody) {
      return audioJson(fetch(versionedBase('v1') + '/music_generation', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + ch.key, 'Content-Type': 'application/json' },
        body: JSON.stringify(finalBody)
      }));
    })
    .then(function (j) {
      setBusy(false);
      var hex = j.data && j.data.audio;
      if (!hex) throw new Error('未返回音频: ' + JSON.stringify(j).slice(0, 300));
      var extra = j.extra_info || {};
      var meta = '<div class="result-meta">model: <code>' + escHtml(model) + '</code>'
        + (extra.music_duration ? ' · 时长 ' + Math.round(extra.music_duration / 1000) + 's' : '')
        + (extra.music_sample_rate ? ' · ' + extra.music_sample_rate + 'Hz' : '')
        + (instrumental ? ' · 纯音乐' : '') + '</div>';
      renderAudioResult(hex, format, meta);
      /* 大音频不进 localStorage(容量保护),只记参数与大小 */
      var storable = hex.length <= 1536 * 1024 ? hex : null;
      addHistory({
        id: histId(), ts: Date.now(), model: model, category: 'music',
        input: histInput,
        result: { audio: storable, format: format, bytes: hex.length / 2, durationMs: extra.music_duration || null }
      });
    })
    .catch(function (e) {
      setBusy(false);
      addHistory({ id: histId(), ts: Date.now(), model: model, category: 'music', input: histInput, error: { message: e.message } });
      showError(e.message);
    });
}

/* ================= 表单联动(由 models.js refreshForm 调用) ================= */
var _voiceLibAutoFetched = false;
function refreshAudioForm(cat) {
  var isTts = cat === 'tts';
  var isMusic = cat === 'music';
  var isCover = isMusic && /cover/.test($('model_name').value || '');
  $('tts_row').classList.toggle('hidden', !isTts);
  $('tts_row2').classList.toggle('hidden', !isTts);
  $('clone_card').classList.toggle('hidden', !isTts);
  $('music_lyrics_field').classList.toggle('hidden', !isMusic);
  $('music_row').classList.toggle('hidden', !isMusic);
  $('music_cover_row').classList.toggle('hidden', !isCover);
  $('tts_stream').disabled = currentTtsMode() !== 'sync';
  $('tts_bitrate').disabled = $('tts_format').value !== 'mp3';
  /* 首次进入语音模型时自动拉一次在线音色库(失败静默,可手动点按钮重试) */
  if (isTts && !_voiceLibAutoFetched) {
    _voiceLibAutoFetched = true;
    if (!VOICE_LIB.ts) fetchVoiceLib(true);
  }
}

/* ================= 初始化(models.js 末尾调用) ================= */
function initAudioPage() {
  loadVoiceState();
  renderVoiceSelect();
  renderCloneChips();

  $('tts_mode_seg').querySelectorAll('.seg-btn').forEach(function (btn) {
    btn.onclick = function () {
      if (btn.classList.contains('active')) return;
      $('tts_mode_seg').querySelectorAll('.seg-btn').forEach(function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
      $('tts_stream').disabled = currentTtsMode() !== 'sync';
      var hint = $('voice_hint');
      hint.textContent = currentTtsMode() === 'async'
        ? '异步合成长文本更稳(任务式,结果 9 小时内可下载)'
        : '内置常用系统音色;「获取在线音色」经中转站拉取全部系统音色 + 我的复刻音色(复刻音色正式合成一次后才会出现在接口里)';
    };
  });

  $('btn_fetch_voices').onclick = fetchVoiceLib;
  $('tts_format').onchange = function () { $('tts_bitrate').disabled = $('tts_format').value !== 'mp3'; };

  /* 选中小语种音色时自动配套 language_boost */
  $('voice_id').onchange = function () {
    var opt = this.options[this.selectedIndex];
    var lb = opt && opt.dataset && opt.dataset.lb;
    if (lb && !$('tts_lang_boost').value) {
      $('tts_lang_boost').value = lb;
      toast('已自动切换语种增强为 ' + lb + '(该音色需要)');
    }
  };

  $('clone_file_input').addEventListener('change', function () {
    onCloneFilePicked(this.files && this.files[0]);
    this.value = '';
  });
  $('btn_rand_vid').onclick = function () {
    $('clone_voice_id').value = randomVoiceId();
  };
  $('btn_clone').onclick = runClone;

  $('music_cover_file_input').addEventListener('change', function () {
    var f = this.files && this.files[0];
    $('music_cover_name').textContent = f ? (f.name + ' · ' + Math.round(f.size / 1024) + ' KB') : '未选择(与 URL 二选一)';
  });
}

/* 清除本页音频相关本地状态(供 models.js clearConfig 调用) */
function clearAudioState() {
  VOICE_LIB = { ts: 0, system: [], cloning: [], generation: [] };
  MY_CLONES = [];
  cloneFile = null;
  $('clone_file_name').textContent = '未选择文件';
  $('clone_voice_id').value = '';
  $('clone_result').innerHTML = '';
  renderVoiceSelect();
  renderCloneChips();
}

// ============================================================
//   30-params.js — 参数采集回填 / 预设管理 / 分辨率与码率联动
//   由 static/index.html 内联脚本拆分而来（整块切分，零行为变更）
// ============================================================

async function onCodecChange() {
  const codec = document.getElementById('p_codec').value;
  const ci = codecInfo[codec];
  if (!ci) return;

  // Update codec status to highlight current selection
  renderCodecStatus();

  // Show/hide warning for unavailable codecs
  const warnEl = document.getElementById('codecWarning');
  if (codecAvailability[codec] === false) {
    const group = ci.group;
    const errDetail = codecErrorDetails[codec] || '';
    const fixHint = codecFixHints[codec] || '';
    let hint = '未检测到对应硬件或驱动';
    if (group === 'cuda') hint = '未检测到 NVIDIA GPU 或 NVENC 驱动。请确认已安装 NVIDIA 显卡驱动。';
    else if (group === 'qsv') hint = '未检测到 Intel 核显或 QSV 运行时。请确认已安装 Intel 显卡驱动 (含 Media SDK 运行时)。';
    else if (group === 'amf') hint = '未检测到 AMD 显卡或 AMF 驱动。请确认已安装 AMD 显卡驱动。';
    let warnHtml = '<span style="color:var(--warning);">&#9888; ' + esc(hint);
    if (errDetail) {
      warnHtml += ' <span style="font-size:0.7rem;color:var(--text-muted);">(' + esc(errDetail) + ')</span>';
    }
    warnHtml += ' <span style="color:var(--text-muted);font-size:0.7rem;cursor:pointer;text-decoration:underline;" data-action="encoder-detail" data-encoder="' + esc(codec) + '">查看详情</span>';
    warnHtml += '</span>';
    if (fixHint) {
      warnHtml += '<div style="margin-top:4px;padding:6px 8px;background:var(--bg-secondary);border-radius:4px;font-size:0.72rem;white-space:pre-wrap;color:var(--text);line-height:1.5;">' + esc(fixHint) + '</div>';
    }
    warnEl.innerHTML = warnHtml;
    warnEl.style.display = 'block';
  } else {
    // Codec is available — clear warning
    warnEl.innerHTML = '';
    warnEl.style.display = 'none';
  }

  // Update preset dropdown options
  const presetSel = document.getElementById('p_preset');
  presetSel.innerHTML = '';
  ci.presets.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p; opt.textContent = p;
    if (p === ci.default_preset) opt.selected = true;
    presetSel.appendChild(opt);
  });

  // Update CRF label
  const crfLabel = document.getElementById('crfLabel');
  if (ci.group === 'cpu') {
    crfLabel.textContent = codec === 'libx265' ? 'CRF 值 (H.265 推荐 28)' : 'CRF 值 (越小质量越高)';
  } else if (ci.group === 'cuda') {
    crfLabel.textContent = 'CQ 值 (NVENC 质量等级, 越小越高)';
  } else if (ci.group === 'qsv') {
    crfLabel.textContent = 'Global Quality (QSV, 越小越高)';
  } else if (ci.group === 'amf') {
    crfLabel.textContent = 'QP 值 (AMF, 越小越高)';
  }

  // Show/hide profile field
  document.getElementById('field_profile').style.display = ci.has_profile ? '' : 'none';

  // Show/hide B-frames, refs
  document.getElementById('field_bf').style.display = ci.has_bf_refs ? '' : 'none';
  document.getElementById('field_refs').style.display = (ci.has_bf_refs && ci.group === 'cpu') ? '' : 'none';

  // Show/hide x264/x265 params
  document.getElementById('field_x264_params').style.display = ci.has_x264_params ? '' : 'none';
  document.getElementById('field_x265_params').style.display = ci.x265_params ? '' : 'none';

  // Update CRF default
  const crfInput = document.getElementById('p_crf');
  if (parseInt(crfInput.value) === 23 && codec === 'libx265') {
    crfInput.value = ci.default_crf;
  }

  toggleRateMode();
}

// ── Resolution change: high-res (6K/8K/custom) auto-adjustments ──

function getOutputResolution() {
  const sel = document.getElementById('p_resolution').value;
  if (sel !== 'custom') return sel;
  const custom = (document.getElementById('p_resolution_custom').value || '').trim().toLowerCase();
  const m = custom.match(/^(\d{2,5})\s*x\s*(\d{2,5})$/);
  return m ? (parseInt(m[1], 10) + 'x' + parseInt(m[2], 10)) : '';
}


function onResolutionChange() {
  const sel = document.getElementById('p_resolution').value;
  const customInput = document.getElementById('p_resolution_custom');
  if (customInput) customInput.style.display = sel === 'custom' ? '' : 'none';

  const res = getOutputResolution();
  if (!res || res === 'original') return;

  const parts = res.split('x');
  const w = parseInt(parts[0], 10), h = parseInt(parts[1], 10);
  const pixels = w * h;
  const notices = [];

  // 1. Auto-bump Level to minimum compliant value (software encoders apply it strictly)
  const minLevel = pixels > 35651584 ? '6.1' : (pixels > 8912896 ? '6.0' : '5.1');
  const levelSel = document.getElementById('p_level');
  if (levelSel && parseFloat(levelSel.value) < parseFloat(minLevel)) {
    levelSel.value = minLevel;
    notices.push('Level 已自动提升至 ' + minLevel);
  }

  // 2. H.264 hardware encoders cap at 4096x4096 → auto-switch to HEVC variant
  const codecSel = document.getElementById('p_codec');
  const hwH264ToHevc = { h264_nvenc: 'hevc_nvenc', h264_qsv: 'hevc_qsv', h264_amf: 'hevc_amf' };
  if ((w > 4096 || h > 4096) && codecSel && hwH264ToHevc[codecSel.value]) {
    const hevc = hwH264ToHevc[codecSel.value];
    codecSel.value = hevc;
    onCodecChange();
    notices.push('H.264 硬件编码上限 4096x4096，已切换至 HEVC 编码器');
  }

  // 3. Bitrate suggestion — only if maxrate still at 4K default (40M)
  const mrInput = document.getElementById('p_maxrate');
  const bufInput = document.getElementById('p_bufsize');
  const suggestions = { '5760x2880': ['80M', '40M'], '7680x3840': ['120M', '60M'] };
  if (suggestions[res] && mrInput && mrInput.value.trim() === '40M') {
    mrInput.value = suggestions[res][0];
    if (bufInput) bufInput.value = suggestions[res][1];
    notices.push('最大码率/缓冲已调整为 ' + suggestions[res][0] + '/' + suggestions[res][1]);
  }

  if (notices.length) showToast(notices.join('；'), 'info');
}

// ── Date Extraction Preview ────────────────────────

async function updateDatePreview() {
  const enabled = document.getElementById('p_date_from_filename').checked;
  document.getElementById('dateOptions').classList.toggle('hidden', !enabled);

  if (currentMode === 'single') {
    updateSingleDatePreview();
  } else {
    updateBatchDatePreview();
  }
}


async function updateSingleDatePreview() {
  if (!document.getElementById('p_date_from_filename').checked) {
    document.getElementById('singleDatePreview').innerHTML = '';
    return;
  }
  const filename = document.getElementById('singleInput').value;
  if (!filename) {
    document.getElementById('singleDatePreview').innerHTML = '';
    return;
  }
  const r = await fetch('/api/extract_date', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({filename: filename.split(/[\/\\]/).pop()})
  });
  const data = await r.json();
  const container = document.getElementById('singleDatePreview');
  if (data.date_str) {
    container.innerHTML = `<div class="date-preview">&#128197; 从文件名提取日期: <strong>${data.date_str}</strong></div>`;
  } else {
    container.innerHTML = `<div class="date-preview no-date">&#9888; 文件名中未找到日期信息</div>`;
  }
}


function updateBatchDatePreview() {
  // Date info is already shown in the batch table
}

// ── Location Toggle ────────────────────────────────

// FIX (v3.13.2 P1-2): parseInt 的 0 是合法值 —— 旧写法 `parseInt(v) || 默认`
// 会把合法的 0 吞成默认值（okaa_yaw_r 显示 0、实际按 180 执行）。
// 改用 Number.isNaN 判空：空/非数字才落默认值，0 原样通过。
function intOrDefault(id, def) {
  const n = parseInt(val(id));
  return Number.isNaN(n) ? def : n;
}

function collectParams() {
  // Custom resolution validation
  if (val('p_resolution') === 'custom') {
    const cres = getOutputResolution();
    let errMsg = '';
    if (!cres) {
      errMsg = '自定义分辨率格式无效，请输入 "宽x高"（如 6400x3200）';
    } else {
      const _p = cres.split('x').map(Number);
      if (_p[0] % 2 !== 0 || _p[1] % 2 !== 0) {
        errMsg = '自定义分辨率的宽和高必须为偶数（yuv420p 要求），当前: ' + cres;
      }
    }
    if (errMsg) {
      alert(errMsg);
      throw new Error(errMsg);
    }
  }
  const params = {
    codec: val('p_codec'),
    resolution: getOutputResolution() || 'original', profile: val('p_profile'),
    level: val('p_level'), pix_fmt: val('p_pix_fmt'),
    color_range: val('p_color_range'), color_space: val('p_color_space'),
    color_primaries: val('p_color_space') === 'bt2020nc' ? 'bt2020' : 'bt709',
    color_trc: val('p_color_space') === 'bt2020nc' ? 'smpte2084' : 'bt709',
    bf: num('p_bf'), refs: num('p_refs'), gop: num('p_gop'),
    rate_mode: val('p_rate_mode'), crf: num('p_crf'),
    maxrate: val('p_maxrate'), bufsize: val('p_bufsize'),
    target_bitrate: val('p_target_bitrate'),
    preset: val('p_preset'), x264_params: val('p_x264_params'),
    x265_params: val('p_x265_params'),
    audio_bitrate: val('p_audio_bitrate'),
    audio_sample_rate: val('p_audio_sample_rate'),
    audio_channels: num('p_audio_channels'),
    audio_profile: val('p_audio_profile'),
    brand: val('p_brand'),
  faststart: document.getElementById('p_faststart').checked,
  // copy 模式（v3.13.0）：直接复制源流，不重编码。后端 build_cmd 据此走流复制分支，
  // 并自动忽略 okaa/insv/vidstab/scale（这些功能必须重编码，与 -c copy 互斥）。
  copy_mode: !!(document.getElementById('p_copy_mode') || {}).checked,
  inject_spherical: document.getElementById('p_inject_spherical').checked,
    pano_type: (function(){ var m=val('p_spherical_mode')||'360-mono'; var i=m.indexOf('-'); return m.substring(0,i); })(),
    stereo_mode: (function(){ var m=val('p_spherical_mode')||'360-mono'; var i=m.indexOf('-'); return m.substring(i+1); })(),
    // Stabilization
    stabilize: document.getElementById('p_stabilize').checked,
    stabilize_smoothing: num('p_stabilize_smoothing') || 30,
    stabilize_shakiness: num('p_stabilize_shakiness') || 5,
    stabilize_zoom: parseFloat(val('p_stabilize_zoom')) || 0.05,
    // Okaa dual-fisheye correction
    okaa_correction: document.getElementById('p_okaa_correction').checked,
    okaa_fov: intOrDefault('p_okaa_fov', 200),          // 后端默认 200（app.py build_okaa）
    okaa_yaw_l: parseInt(val('p_okaa_yaw_l')) || 0,
    okaa_yaw_r: intOrDefault('p_okaa_yaw_r', 180),      // 0 是合法值，不得吞成 180
    okaa_pitch_l: parseInt(val('p_okaa_pitch_l')) || 0,
    okaa_pitch_r: parseInt(val('p_okaa_pitch_r')) || 0,
    okaa_roll_l: parseInt(val('p_okaa_roll_l')) || 0,
    okaa_roll_r: parseInt(val('p_okaa_roll_r')) || 0,
    okaa_blend: val('p_okaa_blend') || 'replace',       // 后端默认 'replace'（原 'seam' 不一致）
    okaa_layout: val('p_okaa_layout') || 'sbs',
    okaa_out_resolution: val('p_okaa_out_resolution') || '3840x1920',
    // Insta360 native processing (v3.9.0)
    insv_stitch: document.getElementById('p_insv_stitch')?.checked ?? true,
    insv_stabilize: document.getElementById('p_insv_stabilize')?.checked ?? false,
    insv_direction_lock: document.getElementById('p_insv_direction_lock')?.checked ?? false,
    insv_denoise: document.getElementById('p_insv_denoise')?.checked ?? false,
    insv_fov: parseInt(val('p_insv_fov')) || 200,
    insv_yaw: parseInt(val('p_insv_yaw')) || 0,
    insv_pitch: parseInt(val('p_insv_pitch')) || 0,
    insv_roll: parseInt(val('p_insv_roll')) || 0,
    // Date metadata
    date_from_filename: document.getElementById('p_date_from_filename').checked,
    set_creation_time: document.getElementById('p_set_creation_time').checked,
    set_file_created: document.getElementById('p_set_file_created').checked,
    set_file_modified: document.getElementById('p_set_file_modified').checked,
    manual_date: val('p_manual_date'),
    // Location metadata
    set_location: document.getElementById('p_set_location').checked,
    location_name: val('p_location_name'),
    location_address: val('p_location_address'),
    location_lat: val('p_location_lat'),
    location_lon: val('p_location_lon'),
    amap_api_key: getAmapKey(),
  };
  // Test encoding duration
  const testCb = document.getElementById('testEncode');
  if (testCb && testCb.checked) {
    params.test_duration = parseInt(document.getElementById('testDuration').value) || 10;
  }
  return params;
}

function applyParams(p) {
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
  set('p_codec', p.codec || 'libx264');
  // Resolution: fall back to "custom" mode if value not in preset list
  (function() {
    const r = p.resolution || '4096x2048';
    const sel = document.getElementById('p_resolution');
    if (!sel) return;
    const hasOpt = Array.from(sel.options).some(o => o.value === r);
    sel.value = hasOpt ? r : 'custom';
    const ci = document.getElementById('p_resolution_custom');
    if (ci) ci.value = hasOpt ? '' : r;
  })();
  set('p_profile', p.profile);
  set('p_level', p.level); set('p_pix_fmt', p.pix_fmt);
  set('p_color_range', p.color_range); set('p_color_space', p.color_space);
  set('p_bf', p.bf); set('p_refs', p.refs); set('p_gop', p.gop);
  set('p_rate_mode', p.rate_mode); set('p_crf', p.crf);
  set('p_maxrate', p.maxrate); set('p_bufsize', p.bufsize);
  set('p_target_bitrate', p.target_bitrate);
  set('p_preset', p.preset); set('p_x264_params', p.x264_params);
  set('p_x265_params', p.x265_params || '');
  set('p_audio_bitrate', p.audio_bitrate);
  set('p_audio_sample_rate', p.audio_sample_rate);
  set('p_audio_channels', p.audio_channels);
  set('p_audio_profile', p.audio_profile);
  set('p_brand', p.brand);
  document.getElementById('p_faststart').checked = p.faststart;
  document.getElementById('p_copy_mode').checked = !!p.copy_mode;
  if (typeof onCopyModeChange === 'function') onCopyModeChange();   // 同步互斥禁用态
  document.getElementById('p_inject_spherical').checked = p.inject_spherical;
  set('p_spherical_mode', (p.pano_type || '360') + '-' + (p.stereo_mode || 'mono'));
  // Stabilization
  document.getElementById('p_stabilize').checked = p.stabilize || false;
  set('p_stabilize_smoothing', p.stabilize_smoothing !== undefined ? p.stabilize_smoothing : 30);
  set('p_stabilize_shakiness', p.stabilize_shakiness !== undefined ? p.stabilize_shakiness : 5);
  set('p_stabilize_zoom', p.stabilize_zoom !== undefined ? p.stabilize_zoom : 0.05);
  toggleStabilize();
  // Okaa dual-fisheye correction
  document.getElementById('p_okaa_correction').checked = p.okaa_correction || false;
  set('p_okaa_fov', p.okaa_fov !== undefined ? p.okaa_fov : 200);
  set('p_okaa_yaw_l', p.okaa_yaw_l !== undefined ? p.okaa_yaw_l : 0);
  set('p_okaa_yaw_r', p.okaa_yaw_r !== undefined ? p.okaa_yaw_r : 0);
  set('p_okaa_pitch_l', p.okaa_pitch_l !== undefined ? p.okaa_pitch_l : 0);
  set('p_okaa_pitch_r', p.okaa_pitch_r !== undefined ? p.okaa_pitch_r : 0);
  set('p_okaa_roll_l', p.okaa_roll_l !== undefined ? p.okaa_roll_l : 0);
  set('p_okaa_roll_r', p.okaa_roll_r !== undefined ? p.okaa_roll_r : 0);
  set('p_okaa_blend', p.okaa_blend || 'seam');
  set('p_okaa_layout', p.okaa_layout || 'sbs');
  set('p_okaa_out_resolution', p.okaa_out_resolution || '3840x1920');
  toggleOkaaCorrection();
  // Insta360 native processing
  const ck = (id, v) => { const el = document.getElementById(id); if (el) el.checked = v; };
  ck('p_insv_stitch', p.insv_stitch !== false);
  ck('p_insv_stabilize', p.insv_stabilize || false);
  ck('p_insv_direction_lock', p.insv_direction_lock || false);
  ck('p_insv_denoise', p.insv_denoise || false);
  set('p_insv_fov', p.insv_fov || 200);
  set('p_insv_yaw', p.insv_yaw || 0);
  set('p_insv_pitch', p.insv_pitch || 0);
  set('p_insv_roll', p.insv_roll || 0);
  // Date
  document.getElementById('p_date_from_filename').checked = p.date_from_filename || false;
  document.getElementById('p_set_creation_time').checked = p.set_creation_time !== false;
  document.getElementById('p_set_file_created').checked = p.set_file_created !== false;
  document.getElementById('p_set_file_modified').checked = p.set_file_modified !== false;
  set('p_manual_date', p.manual_date || '');
  // Location
  document.getElementById('p_set_location').checked = p.set_location || false;
  set('p_location_name', p.location_name || '');
  set('p_location_address', p.location_address || '');
  set('p_location_lat', p.location_lat || '');
  set('p_location_lon', p.location_lon || '');
  // Test-encode toggle (global action bar control) — restore from task params
  const te = document.getElementById('testEncode');
  const td = document.getElementById('testDuration');
  if (te && td) {
    if (p.test_duration) { te.checked = true; td.value = p.test_duration; }
    else { te.checked = false; }
    toggleTestEncode();
  }
  // Update UI state
  onCodecChange();
  onResolutionChange();
  toggleRateMode();
  updateDatePreview();
  toggleLocation();
}

// ── Presets ─────────────────────────────────────────

async function refreshPresets() {
  const r = await fetch('/api/presets');
  const data = await r.json();
  const sel = document.getElementById('presetSelect');
  const cur = sel.value;
  sel.innerHTML = '<option value="">&mdash; 选择预设 &mdash;</option>';
  data.presets.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.name;
    opt.textContent = p.name;
    sel.appendChild(opt);
  });
  if (cur) sel.value = cur;
}


async function loadPreset() {
  const name = document.getElementById('presetSelect').value;
  if (!name) return;
  const r = await fetch('/api/presets');
  const data = await r.json();
  const preset = data.presets.find(p => p.name === name);
  if (preset) {
    applyParams({...DEFAULT_PARAMS, ...preset.params});
    if (preset.batch_formula) {
      document.getElementById('batchFormula').value = preset.batch_formula;
    }
    if (preset.project_dir) {
      const pdEl = document.getElementById('projectDir');
      if (pdEl) pdEl.value = preset.project_dir;
    }
  }
}


async function savePresetDialog() {
  const name = prompt('预设名称:');
  if (!name) return;
  const params = collectParams();
  const formula = document.getElementById('batchFormula').value;
  const projectDir = document.getElementById('projectDir')?.value || '';
  await fetch('/api/presets', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({name, params, batch_formula: formula, project_dir: projectDir})
  });
  await refreshPresets();
  document.getElementById('presetSelect').value = name;
}


async function deletePreset() {
  const name = document.getElementById('presetSelect').value;
  if (!name || !confirm(`删除预设 "${name}"?`)) return;
  await fetch(`/api/presets/${encodeURIComponent(name)}`, {method: 'DELETE'});
  await refreshPresets();
}

// ── Native File Dialogs ─────────────────────────────
// Uses Windows native file dialogs via backend API.
// Remembers last-used paths separately for open and save dialogs.


function collectVR3DParams() {
  const params = collectParams();
  params['vr3d_layout'] = document.getElementById('vr3dLayout')?.value || 'top-bottom';
  params['vr3d_check_alignment'] = document.getElementById('vr3dCheckAlignment')?.checked ?? true;
  // VR 3D always injects spherical metadata with stereo mode
  params['inject_spherical'] = true;
  if (params['vr3d_layout'] === 'top-bottom') {
    params['pano_type'] = '360';
    params['stereo_mode'] = 'top-bottom';
  } else {
    params['pano_type'] = '360';
    params['stereo_mode'] = 'left-right';
  }
  return params;
}


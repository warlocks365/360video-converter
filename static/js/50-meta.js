// ============================================================
//   50-meta.js — 元数据工具（批量列表 / 单行编辑 / 探测 / 源复用）
//   由 static/index.html 内联脚本拆分而来（整块切分，零行为变更）
// ============================================================

let metaBatchItems = [];  // {path, name, size_mb, date_in_name, selected, status, statusMsg, duration}

let _metaProcessingIndices = [];  // maps backend item index → metaBatchItems index

let mapPickerTarget = 'encode'; // 'encode' or 'meta'


function addToMetaBatchList() {
  const inp = document.getElementById('metaInput').value.trim();
  if (!inp) { alert('请先选择视频文件'); return; }
  if (metaBatchItems.some(f => f.path === inp)) {
    showToast('文件已在列表中', 'warning');
    return;
  }
  const name = inp.split(/[\/\\]/).pop();
  const item = {
    path: inp,
    name: name,
    size_mb: '',
    date_in_name: '',
    selected: true,
    status: 'pending',
    statusMsg: '',
    duration: '',
    settings: getDefaultMetaSettings(),
    probed: false
  };
  metaBatchItems.push(item);
  renderMetaBatchTable();
  showToast(`已添加到批量列表（共 ${metaBatchItems.length} 项），正在探测元数据...`, 'success');
  // Async probe existing metadata
  probeMetaFile(metaBatchItems.length - 1);
}

// ══ 元数据设置区「采集 / 回填」统一层（v3.12.0）════════════════════
// 背景：项目存在三套功能相同、id 前缀不同的元数据设置区：
//   p_  → #encodePanel（转换族用）
//   m_  → #metadataMode（元数据工具用）
//   me_ → #metaEditModal（批量列表单行编辑弹窗）
// 改造前每套的采集/回填各写一份，字段名不统一、且 m_ 侧采集重复写了两遍
// （50-meta.js 的 getDefaultMetaSettings 与 60-jobs.js 的 startMetadataApply），
// 任一处漏改就会造成"界面上设了、实际下发的值不一致"。
// 现统一为本文件的 collectMetaSettings() / applyMetaSettings() / setMetaSectionVisible()。

// 叶子控件 id 映射。三套前缀的命名规则不统一（见下方容器映射），必须显式列出。
const META_FIELD_IDS = {
  sphericalMaster: { p: 'p_inject_spherical',   m: 'm_apply_spherical',    me: 'me_apply_spherical' },
  sphericalMode:   { p: 'p_spherical_mode',     m: 'm_spherical_mode',     me: 'me_spherical_mode' },
  dateMaster:      { p: 'p_date_from_filename', m: 'm_apply_date',         me: 'me_apply_date' },       // ⚠ p_ 语义合并
  dateFromName:    { p: 'p_date_from_filename', m: 'm_date_from_filename',  me: 'me_date_from_filename' },// ⚠ p_ 与总开关同 id
  setCreationTime: { p: 'p_set_creation_time',  m: 'm_set_creation_time',  me: 'me_set_creation_time' },
  setFileCreated:  { p: 'p_set_file_created',   m: 'm_set_file_created',   me: 'me_set_file_created' },
  setFileModified: { p: 'p_set_file_modified',  m: 'm_set_file_modified',  me: 'me_set_file_modified' },
  manualDate:      { p: 'p_manual_date',        m: 'm_manual_date',        me: 'me_manual_date' },
  locationMaster:  { p: 'p_set_location',       m: 'm_apply_location',     me: 'me_apply_location' },    // p_ 用 p_set_location
  locationName:    { p: 'p_location_name',      m: 'm_location_name',      me: 'me_location_name' },
  locationLat:     { p: 'p_location_lat',       m: 'm_location_lat',       me: 'me_location_lat' },
  locationLon:     { p: 'p_location_lon',       m: 'm_location_lon',       me: 'me_location_lon' },
  locationAddress: { p: 'p_location_address',   m: 'm_location_address',   me: 'me_location_address' },
};

// 子区容器 id 映射。⚠ 三套用了三种命名法，无法用 prefix+固定后缀 推导，必须显式列出：
//   p_  : 球面带前缀、日期/位置却不带前缀      (dateOptions / locationOptions)
//   m_  : 球面带前缀、日期/位置改用 "meta" 词前缀 (metaDateOptions / metaLocationOptions)
//   me_ : 球面用 "_opts" 后缀，日期/位置用 me_ 前缀
const META_CONTAINER_IDS = {
  spherical: { p: 'p_spherical_options', m: 'm_spherical_options', me: 'me_spherical_opts' },
  date:      { p: 'dateOptions',         m: 'metaDateOptions',     me: 'me_date_opts' },
  location:  { p: 'locationOptions',     m: 'metaLocationOptions', me: 'me_location_opts' },
};

// 从指定前缀的元数据设置区采集设置，返回归一化对象。
// 归一化字段（对下游使用者的契约）：
//   apply_spherical, spherical_mode, apply_date, date_from_filename,
//   set_creation_time, set_file_created, set_file_modified, manual_date,
//   apply_location, location_name, location_lat, location_lon, location_address
// 另附带 pano_type / stereo_mode（由 spherical_mode 派生），以兼容既有消费方
// （renderMetaBatchTable 的任务徽章、后端 /api/apply_metadata 都读这两个字段）。
function collectMetaSettings(prefix) {
  const fieldId = key => META_FIELD_IDS[key][prefix];
  const checked = key => { const el = document.getElementById(fieldId(key)); return !!(el && el.checked); };
  const value   = key => { const el = document.getElementById(fieldId(key)); return el ? el.value : ''; };

  // 球面模式下拉（如 "360-mono" / "180-top-bottom"）→ pano_type + stereo_mode
  const sphericalMode = value('sphericalMode') || '360-mono';
  const dash = sphericalMode.indexOf('-');

  // ── p_ 前缀的日期合并语义 ──────────────────────────────
  // p_ 侧没有独立的「日期总开关」控件：p_date_from_filename 同时承担
  //   ①总开关（dateOptions 容器显隐、是否写入日期）
  //   ②「从文件名提取日期」子项
  // 故 p_ 归一化时 apply_date 与 date_from_filename 取同一复选框值。
  // m_/me_ 侧则是两个独立控件（*_apply_date 总开关 + *_date_from_filename 子项）。
  let apply_date, date_from_filename;
  if (prefix === 'p') {
    const v = checked('dateMaster'); // dateMaster.p === dateFromName.p === 'p_date_from_filename'
    apply_date = v;
    date_from_filename = v;
  } else {
    apply_date = checked('dateMaster');
    date_from_filename = checked('dateFromName');
  }

  return {
    apply_spherical: checked('sphericalMaster'),   // p_ 用 p_inject_spherical
    spherical_mode: sphericalMode,
    pano_type: sphericalMode.substring(0, dash),
    stereo_mode: sphericalMode.substring(dash + 1),
    apply_date: apply_date,
    date_from_filename: date_from_filename,
    set_creation_time: checked('setCreationTime'),
    set_file_created: checked('setFileCreated'),
    set_file_modified: checked('setFileModified'),
    manual_date: value('manualDate'),
    apply_location: checked('locationMaster'),     // p_ 用 p_set_location
    location_name: value('locationName'),
    location_lat: value('locationLat'),
    location_lon: value('locationLon'),
    location_address: value('locationAddress'),
  };
}

// 把设置对象回填到指定前缀的设置区（空值安全：元素不存在则跳过，绝不抛错）。
// m_ 侧当前无回填需求，但为与 me_ 对称、以及未来可用性一并实现。
function applyMetaSettings(prefix, s) {
  s = s || {};
  const setChecked = (key, v) => { const el = document.getElementById(META_FIELD_IDS[key][prefix]); if (el) el.checked = v; };
  const setValue   = (key, v) => { const el = document.getElementById(META_FIELD_IDS[key][prefix]); if (el) el.value = v; };

  setChecked('sphericalMaster', !!s.apply_spherical);
  setValue('sphericalMode', (s.pano_type || '360') + '-' + (s.stereo_mode || 'mono'));

  // ── p_ 日期合并语义（回填）────────────────────────────
  // 判断依据：既有 applyParams()（30-params.js:330）行为是
  //   document.getElementById('p_date_from_filename').checked = p.date_from_filename || false;
  // 即该复选框完全由 date_from_filename 决定，不参考 apply_date。为保持一致，此处同样取 date_from_filename。
  // 当入参 s 由 collectMetaSettings('p') 产生时 apply_date===date_from_filename，两种取法等价；
  // 仅当外部传入"只置 apply_date"的对象时才有差异，此时仍按既有行为以 date_from_filename 为准。
  if (prefix === 'p') {
    setChecked('dateMaster', !!s.date_from_filename);
  } else {
    setChecked('dateMaster', !!s.apply_date);
    setChecked('dateFromName', !!s.date_from_filename);
  }

  setChecked('setCreationTime', s.set_creation_time !== false);
  setChecked('setFileCreated', s.set_file_created !== false);
  setChecked('setFileModified', s.set_file_modified !== false);
  setValue('manualDate', s.manual_date || '');

  setChecked('locationMaster', !!s.apply_location);
  setValue('locationName', s.location_name || '');
  setValue('locationLat', s.location_lat || '');
  setValue('locationLon', s.location_lon || '');
  setValue('locationAddress', s.location_address || '');
}

// 统一某个元数据子区的显隐（用 .hidden 类，配合项目 css 的 .hidden{display:none!important}）。
// ⚠ 不适用于 p_ 球面容器：它由 10-ui.js 的 toggleSphericalOptions() 以内联
//   style.setProperty('display', ..., 'important') 控制，内联 !important 会压过 .hidden 类，
//   对本函数调用将无效（p_ 三容器的显隐仍走各自既有函数 updateDatePreview/toggleLocation/
//   toggleSphericalOptions）。本函数主要服务于 me_ 与 m_ 侧。
function setMetaSectionVisible(prefix, kind, visible) {
  const id = META_CONTAINER_IDS[kind] && META_CONTAINER_IDS[kind][prefix];
  const el = id && document.getElementById(id);
  if (el) el.classList.toggle('hidden', !visible);
}

// 新建文件的默认设置 = 当前 m_ 全局开关卡片的采集结果。
function getDefaultMetaSettings() {
  return collectMetaSettings('m');
}

// FIX (v3.13.4 场景4): probe 返回的 creation_time 是 UTC（带 Z 后缀）。旧链路把它
// 原样塞进 manual_date，后端 fromisoformat 得到 aware-UTC：FS 时间用绝对时刻（本地
// 显示 +8h）、tag 把 UTC 墙钟当本地写（-8h）——两处都与队列设定不一致。
// 现在在"进入设置"的入口统一归一化为本地 naive 字符串，保证复用/设定时间全链路一致。
function utcToLocalNaive(s) {
  if (!s) return s;
  const str = String(s).trim().replace(' ', 'T');
  const m = str.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/i);
  if (!m) return s;                       // EXIF 等非 ISO 形态：交由后续解析处理
  if (!m[2]) return m[1];                 // 已是 naive：原样保留
  const dt = new Date(m[1] + (m[2].toUpperCase() === 'Z' ? 'Z' : m[2]));
  if (isNaN(dt.getTime())) return s;
  const p = n => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}` +
         `T${p(dt.getHours())}:${p(dt.getMinutes())}:${p(dt.getSeconds())}`;
}

// FIX (v3.13.4 场景3): 「手动指定日期」与「从文件名提取日期」互斥。
// 旧链路：探测/复用把拍摄时间写进 manual_date 后，用户勾选"从文件名提取"并不会
// 清掉 manual_date，而后端优先级 manual > 文件名 → 文件名日期永远不生效。
// 勾选"从文件名提取"时清空手动框，让用户意图真实下传。
function onMetaDateFromNameChange(prefix) {
  const ids = META_FIELD_IDS;
  const fromName = document.getElementById(ids.dateFromName[prefix]);
  const manual = document.getElementById(ids.manualDate[prefix]);
  if (fromName && fromName.checked && manual) manual.value = '';
  if (prefix === 'm') updateMetaDatePreview();
}

// Probe existing metadata for a file and update its settings accordingly

async function probeMetaFile(idx) {
  const f = metaBatchItems[idx];
  if (!f) return;
  try {
    const r = await fetch('/api/probe_metadata?path=' + encodeURIComponent(f.path));
    const data = await r.json();
    if (data.error) { f.probed = true; renderMetaBatchTable(); return; }

    // FIX (v3.13.4 场景1): 保留探测结果，供单行编辑弹窗内的「复用」按钮使用
    f.probeData = data;

    // Update file info
    if (data.file_size_mb) f.size_mb = data.file_size_mb;
    if (data.date_in_name) f.date_in_name = data.date_in_name;

    // Auto-enable toggles based on existing metadata
    const s = f.settings;
    if (data.has_spherical) {
      s.apply_spherical = true;
      if (data.spherical.pano_type) s.pano_type = data.spherical.pano_type;
      if (data.spherical.stereo_mode) s.stereo_mode = data.spherical.stereo_mode;
    }
    if (data.has_date) {
      s.apply_date = true;
      // FIX (v3.13.6): 用户已明确的日期来源不被探测覆盖。旧链路只要源视频带
      // 拍摄时间就改写 manual_date 并关闭「从文件名提取」，导致全局面板选的
      // 「从文件名提取日期」入队后被悄悄换成源时间，弹窗与外部预览不一致。
      // 现改为：仅在用户未选择任何来源（未勾选文件名提取 且 手动框为空）时，
      // 才默认复用源视频拍摄时间（UTC Z 归一化为本地 naive）。
      if (!s.date_from_filename && !s.manual_date && data.creation_time) {
        s.manual_date = utcToLocalNaive(data.creation_time);
        s.date_from_filename = false;   // 复用路径下保持与手动框互斥
      }
    }
    if (data.has_gps && data.gps) {
      s.apply_location = true;
      s.location_lat = String(data.gps.lat);
      s.location_lon = String(data.gps.lon);
      if (data.location_name) s.location_name = data.location_name;
      if (data.location_address) s.location_address = data.location_address;
    }
    f.probed = true;
    renderMetaBatchTable();
  } catch(e) {
    f.probed = true;
    renderMetaBatchTable();
  }
}


async function updateMetaDatePreview() {
  if (!document.getElementById('m_date_from_filename').checked) {
    document.getElementById('metaDatePreview').innerHTML = '';
    return;
  }
  const filename = document.getElementById('metaInput').value;
  if (!filename) {
    document.getElementById('metaDatePreview').innerHTML = '';
    return;
  }
  const r = await fetch('/api/extract_date', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({filename: filename.split(/[\/\\]/).pop()})
  });
  const data = await r.json();
  const container = document.getElementById('metaDatePreview');
  if (data.date_str) {
    container.innerHTML = `<div class="date-preview">&#128197; 从文件名提取: <strong>${data.date_str}</strong></div>`;
  } else {
    container.innerHTML = `<div class="date-preview no-date">&#9888; 文件名中未找到日期</div>`;
  }
}


async function addMetaFileManual() {
  try {
    const r = await fetch('/api/native_dialog', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        type: 'open_file',
        title: '选择视频文件',
        file_filter: 'video',
        path_type: 'open',
        initial_dir: ''
      })
    });
    const data = await r.json();
    if (data.error) { alert(data.error); return; }
    if (!data.path) return;
    // Check for duplicates
    if (metaBatchItems.some(f => f.path === data.path)) {
      showToast('文件已在列表中', 'warning');
      return;
    }
    const name = data.path.split(/[\/\\]/).pop();
    const item = {
      path: data.path,
      name: name,
      size_mb: '',
      date_in_name: '',
      selected: true,
      status: 'pending',
      statusMsg: '',
      duration: '',
      settings: getDefaultMetaSettings(),
      probed: false
    };
    metaBatchItems.push(item);
    renderMetaBatchTable();
    showToast('已添加文件，正在探测元数据...', 'success');
    probeMetaFile(metaBatchItems.length - 1);
  } catch(e) {
    alert('打开文件对话框失败: ' + e.message);
  }
}


function renderMetaBatchTable() {
  const tbody = document.getElementById('metaBatchTableBody');
  const countEl = document.getElementById('metaQueueCount');
  if (!tbody) return;

  if (metaBatchItems.length === 0) {
    if (countEl) countEl.textContent = '';
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--text-muted)">选择文件后点击「加入批量列表」或「添加文件」按钮添加到队列</td></tr>';
    return;
  }
  const selectedCount = metaBatchItems.filter(f => f.selected).length;
  if (countEl) countEl.textContent = `${metaBatchItems.length} 个文件 (${selectedCount} 选中)`;

  // Update select-all checkbox
  const selectAllEl = document.getElementById('metaSelectAll');
  if (selectAllEl) selectAllEl.checked = (selectedCount === metaBatchItems.length);

  tbody.innerHTML = metaBatchItems.map((f, i) => {
    const checked = f.selected ? 'checked' : '';
    let statusHtml = '<span style="color:var(--text-muted)">等待中</span>';
    if (f.status === 'processing') {
      statusHtml = '<span style="color:var(--accent)"><span class="spinner" style="display:inline-block;width:12px;height:12px;border-width:2px;vertical-align:middle;margin-right:4px;"></span>处理中...</span>';
    } else if (f.status === 'done') {
      statusHtml = `<span style="color:var(--success)">&#10003; 完成${f.duration ? ` (${f.duration})` : ''}</span>`;
    } else if (f.status === 'error') {
      statusHtml = `<span style="color:var(--error)" title="${esc(f.statusMsg || '')}">&#10007; ${esc(f.statusMsg || '失败')}</span>`;
    }

    // Build task summary badges
    let taskBadges = [];
    const s = f.settings || {};
    if (f.probed === false) {
      taskBadges.push('<span style="color:var(--text-muted);font-size:0.7rem;"><span class="spinner" style="display:inline-block;width:10px;height:10px;border-width:1.5px;vertical-align:middle;margin-right:3px;"></span>探测中...</span>');
    } else {
      if (s.apply_spherical) {
        const pano = s.pano_type || '360';
        const stereo = s.stereo_mode || 'mono';
        const label = stereo === 'mono' ? `${pano}°` : `${pano}°${stereo === 'left-right' ? '左右' : '上下'}`;
        taskBadges.push(`<span class="meta-badge meta-badge-spherical" title="全景元数据 ${pano}° ${stereo}">&#127760; ${esc(label)}</span>`);
      }
      if (s.apply_date) {
        let dateLabel = s.manual_date || f.date_in_name || '自动';
        if (dateLabel.length > 12) dateLabel = dateLabel.substring(0, 10);
        taskBadges.push(`<span class="meta-badge meta-badge-date" title="写入日期">&#128197; ${esc(dateLabel)}</span>`);
      }
      if (s.apply_location && s.location_lat && s.location_lon) {
        const lat = parseFloat(s.location_lat);
        const lon = parseFloat(s.location_lon);
        const latStr = Math.abs(lat).toFixed(1) + '°' + (lat >= 0 ? 'N' : 'S');
        const lonStr = Math.abs(lon).toFixed(1) + '°' + (lon >= 0 ? 'E' : 'W');
        // FIX (v3.13.4 场景2): 队列徽章此前只显示坐标，地名（拍摄地点）不可见
        const nameStr = s.location_name ? ` · ${esc(s.location_name)}` : '';
        taskBadges.push(`<span class="meta-badge meta-badge-gps" title="GPS ${esc(s.location_name || '')}">&#128205; ${esc(latStr)} ${esc(lonStr)}${nameStr}</span>`);
      }
      if (taskBadges.length === 0) {
        taskBadges.push('<span style="color:var(--text-muted);font-size:0.7rem;">无任务（点击编辑设置）</span>');
      }
    }

    return `<tr>
      <td><input type="checkbox" ${checked} data-action="toggle-meta-file-selection" data-idx="${i}"></td>
      <td>${i + 1}</td>
      <td style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${esc(f.path)}">${esc(f.name)}</td>
      <td style="font-size:0.75rem;">${f.size_mb ? f.size_mb + ' MB' : '-'}</td>
      <td style="font-size:0.72rem;">${taskBadges.join(' ')}</td>
      <td>${statusHtml}</td>
      <td>
        <button class="btn btn-sm" data-action="edit-meta-file-settings" data-idx="${i}" title="编辑设置">&#9998;</button>
        <button class="btn btn-sm btn-danger" data-action="remove-meta-file" data-idx="${i}" title="移除">&#10005;</button>
      </td>
    </tr>`;
  }).join('');
}


function toggleMetaFileSelection(idx, checked) {
  if (metaBatchItems[idx]) {
    metaBatchItems[idx].selected = checked;
    // Update count badge without full re-render
    const countEl = document.getElementById('metaQueueCount');
    if (countEl) {
      const selectedCount = metaBatchItems.filter(f => f.selected).length;
      countEl.textContent = `${metaBatchItems.length} 个文件 (${selectedCount} 选中)`;
    }
    const selectAllEl = document.getElementById('metaSelectAll');
    if (selectAllEl) selectAllEl.checked = (selectedCount === metaBatchItems.length);
  }
}


function selectAllMetaFiles(checked) {
  metaBatchItems.forEach(f => f.selected = checked);
  renderMetaBatchTable();
}


function removeSelectedMetaFiles() {
  const before = metaBatchItems.length;
  metaBatchItems = metaBatchItems.filter(f => !f.selected);
  if (before > metaBatchItems.length) {
    showToast(`已移除 ${before - metaBatchItems.length} 个文件`, 'info');
  }
  renderMetaBatchTable();
}


function clearMetaFiles() {
  if (metaBatchItems.length === 0) return;
  if (!confirm('确定清空列表中的所有文件？')) return;
  metaBatchItems = [];
  renderMetaBatchTable();
}


function removeMetaFile(idx) {
  metaBatchItems.splice(idx, 1);
  renderMetaBatchTable();
}

// ── Per-file Edit Modal ───────────────────────────

let _metaEditIndex = -1;


function editMetaFileSettings(idx) {
  const f = metaBatchItems[idx];
  if (!f) return;
  _metaEditIndex = idx;
  const s = f.settings || {};

  // Fill file info
  document.getElementById('metaEditFileInfo').innerHTML =
    `<strong>${esc(f.name)}</strong><br><small style="color:var(--text-muted);">${esc(f.path)}</small>` +
    (f.size_mb ? `<br><small>大小: ${f.size_mb} MB</small>` : '') +
    (f.date_in_name ? `<br><small>文件名日期: ${esc(f.date_in_name)}</small>` : '');

  // FIX (v3.13.4 场景1): 弹窗内提供「复用」入口（此前复用按钮只存在于全局面板，
  // 弹窗用户点不到，导致"复用后详细设置不更新"）。数据来源 = 该文件自己的探测结果。
  const reuseEl = document.getElementById('metaEditReuse');
  if (reuseEl) {
    const pd = f.probeData;
    if (pd && (pd.has_gps || pd.has_time)) {
      reuseEl.classList.remove('hidden');
      reuseEl.innerHTML =
        `<button class="si-btn" data-action="reuse-source-gps" data-target="me" ${(!pd.has_gps) ? 'disabled' : ''}>&#128205; 复用素材 GPS 及地名</button>` +
        `<button class="si-btn" data-action="reuse-source-time" data-target="me" ${(!pd.has_time) ? 'disabled' : ''}>&#128197; 复用拍摄时间</button>`;
    } else {
      reuseEl.classList.add('hidden');
      reuseEl.innerHTML = '';
    }
  }

  // 值回填（统一入口，替代原先逐字段手写）
  applyMetaSettings('me', s);
  // 子区显隐（统一入口）
  setMetaSectionVisible('me', 'spherical', !!s.apply_spherical);
  setMetaSectionVisible('me', 'date', !!s.apply_date);
  setMetaSectionVisible('me', 'location', !!s.apply_location);

  document.getElementById('metaEditModal').classList.add('active');
}


function closeMetaEditModal() {
  document.getElementById('metaEditModal').classList.remove('active');
  _metaEditIndex = -1;
}


function saveMetaFileSettings() {
  if (_metaEditIndex < 0 || !metaBatchItems[_metaEditIndex]) return;
  const f = metaBatchItems[_metaEditIndex];
  // 采集（统一入口）：等价于原先逐字段手写的 me_* 读取结果
  f.settings = collectMetaSettings('me');
  renderMetaBatchTable();
  closeMetaEditModal();
  showToast('设置已保存', 'success');
}


// Metadata DOMContentLoaded

let _lastSourceProbe = null;  // {gps, creation_time, location_name, filename}


async function probeSourceVideo(path, target) {
  // target: 'p' (encode panel) or 'm' (metadata panel)
  const panelId = target === 'm' ? 'metaSourceInfo' : 'sourceInfo';
  const panel = document.getElementById(panelId);
  if (!path) { panel.classList.add('hidden'); panel.innerHTML = ''; return; }

  panel.classList.remove('hidden');
  panel.innerHTML = '<div class="si-row"><span class="si-label">提取中...</span></div>';

  try {
    const r = await fetch('/api/probe-source?path=' + encodeURIComponent(path));
    const data = await r.json();
    if (data.error) {
      panel.innerHTML = `<div class="si-row"><span class="si-none">元数据提取失败: ${data.error}</span></div>`;
      return;
    }
    _lastSourceProbe = data;

    const gps = data.gps;
    const ct = data.creation_time;
    const locName = data.location_name || '';
    let html = '<div class="si-row"><span class="si-label">文件:</span><span class="si-value">' + (data.filename || '') + '</span></div>';

    // GPS row
    if (data.has_gps && gps) {
      html += `<div class="si-row"><span class="si-label">GPS 坐标:</span>` +
        `<span class="si-value coords">${gps.lat.toFixed(6)}, ${gps.lon.toFixed(6)}</span></div>`;
      if (locName) {
        html += `<div class="si-row"><span class="si-label">地点名称:</span><span class="si-value">${locName}</span></div>`;
      }
    } else {
      html += '<div class="si-row"><span class="si-label">GPS 坐标:</span><span class="si-none">未找到</span></div>';
    }

    // Creation time row
    if (data.has_time && ct) {
      // FIX (v3.13.7): 显示本地墙钟。旧实现剥掉 Z 直接展示 UTC 墙钟，与
      // 「复用拍摄时间」填充的本地值相差时区偏移——用户按显示值设定时间即产生
      // "标签时间与设定不一致（±8h）"的报告。显示、复用、写入三处统一为本地语义。
      const ctLocal = utcToLocalNaive(ct) || ct;
      const ctDisplay = ctLocal.replace('T', ' ');
      html += `<div class="si-row"><span class="si-label">拍摄时间:</span><span class="si-value">${ctDisplay}</span></div>`;
    } else {
      html += '<div class="si-row"><span class="si-label">拍摄时间:</span><span class="si-none">未找到</span></div>';
    }

    // Action buttons
    html += '<div class="si-actions">';
    html += `<button class="si-btn" data-action="reuse-source-gps" data-target="${esc(target)}" ${(!data.has_gps) ? 'disabled' : ''}>&#128205; 复用 GPS 位置</button>`;
    html += `<button class="si-btn" data-action="reuse-source-time" data-target="${esc(target)}" ${(!data.has_time) ? 'disabled' : ''}>&#128197; 复用拍摄时间</button>`;
    html += '</div>';

    panel.innerHTML = html;
  } catch(e) {
    panel.innerHTML = `<div class="si-row"><span class="si-none">提取失败: ${e.message}</span></div>`;
  }
}


// FIX (v3.13.4 场景1): 复用处理器表格化 —— 新增 me（批量编辑弹窗）目标，弹窗内
// 也能一键复用；同时回填详细地址（此前只填坐标与地名），地名缺失时用地址首段兜底。
const REUSE_TARGETS = {
  p:  { lat: 'p_location_lat', lon: 'p_location_lon', name: 'p_location_name',
        address: 'p_location_address', master: 'p_set_location',
        masterDate: 'p_date_from_filename', manual: 'p_manual_date', fromName: 'p_date_from_filename',
        showSection: () => toggleLocation(), showDateSection: () => updateDatePreview(),
        infoGps: 'locationInfo', infoTime: null, afterTime: () => updateDatePreview() },
  m:  { lat: 'm_location_lat', lon: 'm_location_lon', name: 'm_location_name',
        address: 'm_location_address', master: 'm_apply_location',
        masterDate: 'm_apply_date', manual: 'm_manual_date', fromName: 'm_date_from_filename',
        showSection: () => toggleMetaLocation(),
        showDateSection: () => { if (typeof toggleMetaDate === 'function') toggleMetaDate(); },
        infoGps: 'metaLocationInfo', infoTime: null, afterTime: () => updateMetaDatePreview() },
  me: { lat: 'me_location_lat', lon: 'me_location_lon', name: 'me_location_name',
        address: 'me_location_address', master: 'me_apply_location',
        masterDate: 'me_apply_date', manual: 'me_manual_date', fromName: 'me_date_from_filename',
        showSection: () => setMetaSectionVisible('me', 'location', document.getElementById('me_apply_location').checked),
        showDateSection: () => setMetaSectionVisible('me', 'date', document.getElementById('me_apply_date').checked),
        infoGps: 'me_location_info', infoTime: 'me_date_info', afterTime: null },
};

function probeForTarget(target) {
  if (target === 'me') {
    const f = metaBatchItems[_metaEditIndex];
    return (f && f.probeData) ? f.probeData : null;
  }
  return _lastSourceProbe;
}

// probe-source 返回 has_time；probe_metadata（批量列表探测）没有该字段，
// 只有 has_date + creation_time。兼容两种形状。
function probeHasTime(probe) {
  if (!probe) return false;
  if (probe.has_time !== undefined) return !!probe.has_time;
  return !!(probe.has_date && probe.creation_time);
}

async function reuseSourceGPS(target) {
  const t = REUSE_TARGETS[target];
  const probe = probeForTarget(target);
  if (!t || !probe || !probe.has_gps || !probe.gps) return;
  const gps = probe.gps;
  // FIX (v3.13.5): 非字符串类型收敛（Nominatim 本地化名映射对象等）
  let locName = mapFieldToStr(probe.location_name);
  let locAddr = mapFieldToStr(probe.location_address);
  document.getElementById(t.lat).value = gps.lat.toFixed(6);
  document.getElementById(t.lon).value = gps.lon.toFixed(6);
  // FIX (v3.13.4 场景2): 地名缺失时用地址首段兜底，保证「拍摄地点」始终有内容
  let nameVal = locName || (locAddr ? locAddr.split(/[,,]/)[0].trim() : '');
  document.getElementById(t.name).value = nameVal;
  if (locAddr && document.getElementById(t.address)) {
    document.getElementById(t.address).value = locAddr;
  }
  document.getElementById(t.master).checked = true;
  t.showSection();
  const info = document.getElementById(t.infoGps);
  if (info) {
    info.classList.remove('hidden');
    info.innerHTML = `已复用素材 GPS: <strong>${gps.lat.toFixed(4)}, ${gps.lon.toFixed(4)}</strong>` +
      (nameVal ? ` (${nameVal})` : '');
  }
  // FIX (v3.13.7 场景2): 源文件只有坐标、没有地名/地址文本时，调用逆地理补全
  // （与地图选点同一套解析：AMap regeo + Nominatim + 兜底），保证「复用 GPS」
  // 完整包含经纬度 + 详细地址 + 拍摄位置文本。
  if (!nameVal || !locAddr) {
    try {
      const r = await resolveReverseGeo(gps.lat, gps.lon, nameVal, locAddr);
      const rAddr = (r.address || '').startsWith('(地址获取失败') ? '' : r.address;
      nameVal = r.name || nameVal;
      locAddr = rAddr || locAddr;
      document.getElementById(t.name).value = nameVal;
      if (document.getElementById(t.address)) document.getElementById(t.address).value = locAddr;
      if (info) {
        info.innerHTML = `已复用素材 GPS 及地名: <strong>${gps.lat.toFixed(4)}, ${gps.lon.toFixed(4)}</strong>` +
          (nameVal ? ` (${nameVal})` : '') +
          (locAddr ? `<br><span style="opacity:0.7">${esc(locAddr)}</span>` : '');
      }
    } catch (e) { /* 逆地理失败：保留坐标与已得文本 */ }
  }
}


function reuseSourceTime(target) {
  const t = REUSE_TARGETS[target];
  const probe = probeForTarget(target);
  if (!t || !probeHasTime(probe)) return;
  // FIX (v3.13.4 场景4): 归一化为本地 naive（源值是 UTC Z 字符串；旧实现剥掉 Z
  // 把 UTC 当本地，产生 8 小时偏差）
  const dateStr = utcToLocalNaive(probe.creation_time);
  document.getElementById(t.manual).value = dateStr;
  const fromName = document.getElementById(t.fromName);
  if (fromName) fromName.checked = false;
  // 复用时间意味着要写日期 → 顺带启用日期总开关（此前 m_ 侧总开关关闭时复用无效）
  const masterDate = document.getElementById(t.masterDate);
  if (masterDate && !masterDate.checked) masterDate.checked = true;
  t.showDateSection();
  if (t.afterTime) t.afterTime();
  const info = document.getElementById(t.infoTime);
  if (info) {
    info.classList.remove('hidden');
    info.innerHTML = `已复用拍摄时间: <strong>${dateStr.replace('T', ' ')}</strong>`;
  }
}


function detectSpherical(probe) {
  // Detect whether a video carries 360° panoramic (spherical) metadata and
  // determine its real projection type (pano_type 360°/180° + stereo mode).
  //
  // Priority 1 — backend-parsed GSpherical XML (d['gspherical']):
  //   The report worker calls read_gspherical() which scans the MP4 for the
  //   GSpherical UUID box and parses the XML. This is the ONLY source that can
  //   distinguish 360° vs 180° (via crop-offset fields) and the authoritative
  //   stereo mode, matching the selectable types in the encoding UI.
  //
  // Priority 2 — ffprobe side_data_list fallback (no backend enrichment):
  //   Spherical Mapping side_data confirms spherical=true but CANNOT tell 360
  //   from 180 (no bound/crop fields).  Stereo 3D side_data gives stereo mode.
  //
  // Priority 3 — tag/string fallback for legacy formats.
  const d = probe || {};
  if (d.gspherical && d.gspherical.spherical) {
    return {
      spherical: true,
      projection: d.gspherical.projection || null,
      panoType: d.gspherical.pano_type || null,
      stereo: d.gspherical.stereo_mode || null,
    };
  }
  const streams = d.streams || [];
  const vStream = streams.find(s => s.codec_type === 'video') || {};
  const tags = (d.format && d.format.tags) || {};
  const vTags = vStream.tags || {};
  const sd = vStream.side_data_list || [];
  const sph = sd.find(x => (x.side_data_type || '') === 'Spherical Mapping');
  if (sph) {
    let stereo = null;
    const s3d = sd.find(x => (x.side_data_type || '') === 'Stereo 3D');
    if (s3d) {
      const t = s3d.type || '';
      stereo = t === '2D' ? 'mono'
        : t === 'side by side' ? 'left-right'
        : t === 'top and bottom' ? 'top-bottom' : null;
    }
    return { spherical: true, projection: sph.projection || null, panoType: null, stereo };
  }
  const raw = JSON.stringify(d);
  if (tags['spherical'] || vTags['spherical'] ||
      raw.includes('GSpherical') || raw.includes('stitchingSoftware') ||
      raw.includes('Spherical Mapping') || raw.includes('equirectangular')) {
    return { spherical: true, projection: null, panoType: null, stereo: null };
  }
  return { spherical: false, projection: null, panoType: null, stereo: null };
}

// Build the "全景元数据" label, mapping to the same type names used in the
// single-file / metadata-tool injection dropdown so the report matches the UI.
//   360-mono  -> 360° 单目全景
//   180-mono  -> 180° 单目全景
//   360-left-right -> 360° 双目VR左右
//   180-left-right -> 180° 双目VR左右
//   360-top-bottom -> 360° 双目VR上下
//   180-top-bottom -> 180° 双目VR上下

function sphericalLabel(sphInfo) {
  if (!sphInfo.spherical) return '未注入';
  const pt = sphInfo.panoType;
  const sm = sphInfo.stereo;
  if (pt && sm) {
    const pano = pt === '180' ? '180' : '360';
    const desc = sm === 'mono' ? '单目全景'
      : sm === 'left-right' ? '双目VR左右'
      : sm === 'top-bottom' ? '双目VR上下' : sm;
    return `已注入 (${pano}° ${desc})`;
  }
  // Partial info — show what we have
  if (sphInfo.projection && sphInfo.projection !== 'equirectangular') {
    return `已注入 (${sphInfo.projection})`;
  }
  if (sm) {
    const desc = sm === 'mono' ? '单目'
      : sm === 'left-right' ? '双目VR左右'
      : sm === 'top-bottom' ? '双目VR上下' : sm;
    return `已注入 (equirectangular ${desc})`;
  }
  if (sphInfo.projection) return `已注入 (${sphInfo.projection})`;
  return '已注入 (GSpherical)';
}


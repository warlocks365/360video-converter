// ============================================================
//   50-meta.js — 元数据工具（批量列表 / 单行编辑 / 探测 / 源复用）
//   由 static/index.html 内联脚本拆分而来（整块切分，零行为变更）
// ============================================================

let metaBatchItems = [];  // {path, name, size_mb, date_in_name, selected, status, statusMsg, duration, settings, outDir, probed}
//   settings = 加入列队那一刻冻结的元数据设置快照（collectMetaSettings('m')）
//   outDir   = 输出位置（ADR-004 D-1：随加入快照固定，不随界面变化）
//              { mode: 'global'|'snapshot'|'inplace', value: string }
//              ⚠ outDir 绝不并入 collectMetaSettings()：该函数由 META_FIELD_IDS 表驱动
//                且被 p_/m_/me_ 三前缀共用，p_/m_ 侧无「输出位置」控件，
//                checked() 对缺失元素恒 false 会静默拿到 inplace 并污染下发参数。

let _metaProcessingIndices = [];  // maps backend item index → metaBatchItems index

let mapPickerTarget = 'encode'; // 'encode' or 'meta'

// v3.13.14：一次性标志。用户点「仍按界面设置执行这一轮」后置 true，
// 由 startMetadataApply 消费后立即复位。不影响队列状态本身。
let forceFormRun = false;

// ── 路径归一化（ADR-004 D-5）──────────────────────────────
// 用途：入队去重。旧实现用严格字符串相等（f.path === inp），
// 用户从「浏览」拿到 C:\Users\PC\a.mp4、手输 c:/users/pc/a.mp4
// 就会绕过去重产生重复行 → 同一文件被处理两次（第二次读的是第一次的产物）。
function normalizePathForCompare(p) {
  if (!p) return '';
  let s = String(p).trim().replace(/^"|"$/g, '');   // 去掉手输时残留的引号
  s = s.replace(/\//g, '\\');                      // 统一分隔符
  s = s.replace(/\\{2,}/g, '\\');                   // 折叠重复分隔符
  s = s.replace(/\\+$/, '');                        // 去尾部分隔符
  return s.toLowerCase();                           // Windows 文件系统大小写不敏感
}

// 在队列中按归一化路径查找已存在项的下标，未找到返回 -1。
function findMetaItemIndex(p) {
  const key = normalizePathForCompare(p);
  if (!key) return -1;
  return metaBatchItems.findIndex(f => normalizePathForCompare(f.path) === key);
}

// 队列项的输出位置。未设置过的历史项按 ADR D-8 统一补成 inplace，
// 不依赖 `f.out_dir ? ... : f.path` 的假值巧合分支。
function getOutDir(f) {
  const od = f && f.outDir;
  if (od && (od.mode === 'global' || od.mode === 'snapshot' || od.mode === 'inplace')) return od;
  return { mode: 'inplace', value: '' };
}

// 执行期解析输出绝对路径（ADR-004 D-4 / 设计文档 4.4）：
//   snapshot 且 value 非空 → 快照目录（固定，不受全局改动影响）
//   global 且全局目录非空   → 执行时读 #metaBatchOutDir 当前值
//   其余（inplace / 两处皆空）→ 源文件本身（原地修改）
function resolveMetaOutputPath(f, globalOutDir) {
  const od = getOutDir(f);
  if (od.mode === 'snapshot' && od.value) return `${od.value}\\${f.name}`;
  if (od.mode === 'global' && globalOutDir) return `${globalOutDir}\\${f.name}`;
  return f.path;
}

// 入队快照（ADR-004 D-8）：三个入队入口统一走本函数，
// 避免某一入口漏写 outDir 造成「同一队列两种结构」。
// 返回真正新增的项在 metaBatchItems 中的下标数组。
function snapshotToMetaBatch(paths, settingsOverride, outDirOverride) {
  const added = [];
  const seen = new Set();
  (paths || []).forEach(p => {
    const raw = String(p || '').trim();
    if (!raw) return;
    const key = normalizePathForCompare(raw);
    // 同批次内也要去重：重复路径会让 forEach 推两个相同下标进 added
    if (!key || seen.has(key) || findMetaItemIndex(raw) >= 0) return;
    seen.add(key);
    const item = {
      path: raw,                                   // 存原值：可能含 UNC 前缀或相对路径，不归一化覆盖
      name: raw.split(/[\/\\]/).pop(),
      size_mb: '',
      date_in_name: '',
      selected: true,
      status: 'pending',
      statusMsg: '',
      duration: '',
      settings: settingsOverride || getDefaultMetaSettings(),
      outDir: outDirOverride || { mode: 'inplace', value: '' },
      probed: false
    };
    metaBatchItems.push(item);
    added.push(metaBatchItems.length - 1);
  });
  return added;
}

// 读取界面「输出目录」当前值，作为快照语义下的 outDir。
function currentOutDirSnapshot() {
  const el = document.getElementById('metaBatchOutDir');
  const v = el ? el.value.trim() : '';
  return v ? { mode: 'snapshot', value: v } : { mode: 'inplace', value: '' };
}

// 「加入批量列队」：把 #metaInput 当前文件按界面参数快照加入队列（D1）。
function addToMetaBatchList() {
  const inpEl = document.getElementById('metaInput');
  const inp = inpEl ? inpEl.value.trim() : '';
  if (!inp) {
    showToast('先在上方「视频文件」选择一个文件，再点「加入批量列队」', 'warning', 4000);
    return;
  }
  // 去重：命中则提示所在序号 + 该行闪烁一次（设计文档 3.5 步骤 2 / 8.3）
  const dupIdx = findMetaItemIndex(inp);
  if (dupIdx >= 0) {
    showToast(`该文件已在列队第 ${dupIdx + 1} 项，未重复加入`, 'warning', 4000);
    flashMetaRow(dupIdx);
    return;
  }
  const outDir = currentOutDirSnapshot();
  const added = snapshotToMetaBatch([inp], collectMetaSettings('m'), outDir);
  if (!added.length) return;
  const idx = added[0];
  renderMetaBatchTable();
  // 入队 toast 必须说出输出结果：这是用户点本按钮最易出错的点（设计文档 3.5）
  const outLabel = outDir.mode === 'snapshot' ? outDir.value : '原地修改';
  showToast(`已加入列队第 ${idx + 1} 项 · 输出 ${outLabel}`, 'success', 2500);
  // 不再连发第二条 toast：异步探测由行内微 spinner 表达（设计文档 3.5 步骤 4）
  probeMetaFile(idx);
}

// 让第 idx 行闪烁一次（CSS 动画，reduced-motion 下退化为描边）
function flashMetaRow(idx) {
  const tbody = document.getElementById('metaBatchTableBody');
  if (!tbody || !tbody.rows[idx]) return;
  const row = tbody.rows[idx];
  row.classList.add('metaq-flash');
  setTimeout(() => row.classList.remove('metaq-flash'), 700);
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
    container.innerHTML = `<div class="date-preview">${ico('calendar', 14)} 从文件名提取: <strong>${esc(data.date_str)}</strong></div>`;
  } else {
    container.innerHTML = `<div class="date-preview no-date">${ico('alert', 14)} 文件名中未找到日期</div>`;
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
    const dupIdx = findMetaItemIndex(data.path);
    if (dupIdx >= 0) {
      showToast(`该文件已在列队第 ${dupIdx + 1} 项，未重复加入`, 'warning', 4000);
      flashMetaRow(dupIdx);
      return;
    }
    // 该入口是「添加文件」而非「冻结界面设置」→ 全局语义：执行时读 #metaBatchOutDir
    const added = snapshotToMetaBatch([data.path], null, { mode: 'global', value: '' });
    if (!added.length) return;
    renderMetaBatchTable();
    showToast(`已添加文件到第 ${added[0] + 1} 项，正在探测元数据...`, 'success', 2500);
    probeMetaFile(added[0]);
  } catch(e) {
    alert('打开文件对话框失败: ' + e.message);
  }
}


// ── 队列状态统计（单一数据源，徽标/按钮文案/惰性化共用）────
// ⚠ 计数口径（此处是全应用唯一权威，三处 sync 与 startMetadataApply 必须同口径）：
//   待执行 = selected && status !== 'done'
//   → 'error' 项**既计入「失败」也计入「待转换」**：它是「上次失败、本次会重跑」的项，
//     按 ADR-004 D-2「失败可重试」，把它排除出待转换会让徽标与按钮文案脱节
//     （徽标说「1 待转换」而按钮实际跑 2 项，用户无法预判）。
//   故徽标的不变式是「总数 = 待转换 + 已完成」，「失败」是待转换内部的子类标注。
function metaQueueStats() {
  const total = metaBatchItems.length;
  let pending = 0, done = 0, error = 0, selected = 0, running = 0;
  metaBatchItems.forEach(f => {
    if (f.selected) selected++;
    if (f.status === 'processing') { running++; if (f.selected) pending++; return; }
    if (f.status === 'done') { done++; return; }
    if (f.selected) pending++;
    if (f.status === 'error') error++;
  });
  return { total, pending, done, error, selected, running };
}

// 待执行项 = selected && status !== 'done'（ADR-004 D-3）。
// ⚠ 与 hasAnyFeature 校验必须分开：合成一次过滤会把「有项但都没开功能」
//   的中止场景误判成「无可执行项」的兜底场景（架构师 advisory）。
function metaRunnableItems() {
  return metaBatchItems.filter(f => f.selected && f.status !== 'done');
}

// 输出归属芯片（设计文档 4.2）：三态均有「图标 + 文案 + 描边样式」三重编码，
// 不依赖颜色单独传达。
function outDirChipHtml(f) {
  const od = getOutDir(f);
  if (od.mode === 'snapshot') {
    let label = od.value || '(未指定)';
    if (label.length > 18) label = label.substring(0, 18) + '...';
    const title = `输出目录（加入时快照）：${od.value || '未指定，将回退到执行时的全局值'}`;
    return `<span class="metaq-chip metaq-chip-out-snapshot" title="${esc(title)}">${ico('outSnapshot', 14)} 快照 ${esc(label)}</span>`;
  }
  if (od.mode === 'global') {
    const gEl = document.getElementById('metaBatchOutDir');
    const gv = gEl ? gEl.value.trim() : '';
    const title = `输出目录：执行时读取上方「输出目录」的当前值${gv ? `（${gv}）` : '（当前为空 → 原地修改）'}`;
    return `<span class="metaq-chip metaq-chip-out-global" title="${esc(title)}">${ico('outGlobal', 14)} 跟随全局</span>`;
  }
  const title = '输出目录：留空，将覆盖源文件本身。建议先在「输出目录」指定目标目录';
  return `<span class="metaq-chip metaq-chip-out-inplace" title="${esc(title)}">${ico('outInplace', 14)} 原地修改</span>`;
}


function renderMetaBatchTable() {
  const tbody = document.getElementById('metaBatchTableBody');
  if (!tbody) return;

  if (metaBatchItems.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--text-muted)">选择文件后点「加入批量列队」或「添加文件」加入队列</td></tr>';
    syncMetaQueueCount();
    syncMetaApplyButton();
    syncMetaFormInert();
    return;
  }

  tbody.innerHTML = metaBatchItems.map((f, i) => {
    const checked = f.selected ? 'checked' : '';
    const isRunning = f.status === 'processing';

    // ── 状态列（设计文档 6.2）：图标 + 文案双编码，不靠颜色单独传达 ──
    let statusHtml = `<span class="metaq-state metaq-state-pending">待转换</span>`;
    let rowCls = '';
    if (isRunning) {
      statusHtml = '<span class="metaq-state metaq-state-running"><span class="spinner" style="display:inline-block;width:12px;height:12px;border-width:2px;vertical-align:middle;"></span>处理中</span>';
      rowCls = 'metaq-running';
    } else if (f.status === 'done') {
      const dur = f.duration ? ` ${esc(f.duration)}` : '';
      statusHtml = `<span class="metaq-state metaq-state-done" aria-label="已完成${f.duration ? '，耗时 ' + esc(f.duration) : ''}">${ico('check', 14)}完成${dur}</span>`;
      rowCls = 'metaq-done';
    } else if (f.status === 'error') {
      const msg = f.statusMsg || '失败';
      statusHtml = `<span class="metaq-state metaq-state-failed" title="${esc(msg)}">${ico('x', 14)}失败</span>` +
        `<span class="metaq-state-detail" title="${esc(msg)}">${esc(msg.length > 12 ? msg.substring(0, 12) + '…' : msg)}</span>`;
      rowCls = 'metaq-failed';
    }

    // ── 任务内容徽章（图标全部走内联 SVG，P0）────
    let taskBadges = [];
    const s = f.settings || {};
    if (f.probed === false) {
      taskBadges.push('<span style="color:var(--text-secondary);font-size:0.7rem;"><span class="spinner" style="display:inline-block;width:10px;height:10px;border-width:1.5px;vertical-align:middle;margin-right:3px;"></span>探测中...</span>');
    } else {
      if (s.apply_spherical) {
        const pano = s.pano_type || '360';
        const stereo = s.stereo_mode || 'mono';
        const label = stereo === 'mono' ? `${pano}°` : `${pano}°${stereo === 'left-right' ? '左右' : '上下'}`;
        taskBadges.push(`<span class="meta-badge meta-badge-spherical" title="全景元数据 ${esc(pano)}° ${esc(stereo)}">${ico('globe', 14)} ${esc(label)}</span>`);
      }
      if (s.apply_date) {
        let dateLabel = s.manual_date || f.date_in_name || '自动';
        if (dateLabel.length > 12) dateLabel = dateLabel.substring(0, 10);
        taskBadges.push(`<span class="meta-badge meta-badge-date" title="写入日期">${ico('calendar', 14)} ${esc(dateLabel)}</span>`);
      }
      if (s.apply_location && s.location_lat && s.location_lon) {
        const lat = parseFloat(s.location_lat);
        const lon = parseFloat(s.location_lon);
        const latStr = Math.abs(lat).toFixed(1) + '°' + (lat >= 0 ? 'N' : 'S');
        const lonStr = Math.abs(lon).toFixed(1) + '°' + (lon >= 0 ? 'E' : 'W');
        // FIX (v3.13.4 场景2): 队列徽章此前只显示坐标，地名（拍摄地点）不可见
        const nameStr = s.location_name ? ` · ${esc(s.location_name)}` : '';
        taskBadges.push(`<span class="meta-badge meta-badge-gps" title="GPS ${esc(s.location_name || '')}">${ico('pin', 14)} ${esc(latStr)} ${esc(lonStr)}${nameStr}</span>`);
      }
      if (taskBadges.length === 0) {
        taskBadges.push('<span style="color:var(--text-secondary);font-size:0.7rem;">无任务（点击编辑设置）</span>');
      }
    }
    // 输出归属芯片永远是该单元格最后一个（设计文档 4.2）
    taskBadges.push(outDirChipHtml(f));

    // ── 操作列：编辑 / 重排队（仅 done 行） / 移除 ──
    const resetBtn = f.status === 'done'
      ? `<button class="btn btn-sm" data-action="reset-meta-item" data-idx="${i}" title="重排队：改回待转换，下次点应用时重跑该项" aria-label="重排队：改回待转换，下次点应用时重跑该项">${ico('reset', 14)}</button>`
      : '';
    const dis = isRunning ? ' disabled' : '';

    return `<tr${rowCls ? ` class="${rowCls}"` : ''}>
      <td><input type="checkbox" ${checked}${dis} data-action="toggle-meta-file-selection" data-idx="${i}" aria-label="选择第 ${i + 1} 项"></td>
      <td class="col-idx">${i + 1}</td>
      <td class="col-name" style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${esc(f.path)}">${esc(f.name)}</td>
      <td style="font-size:0.75rem;">${f.size_mb ? f.size_mb + ' MB' : '-'}</td>
      <td style="font-size:0.72rem;"><div class="metaq-tasks" title="${esc(f.path)}">${taskBadges.join('')}</div></td>
      <td>${statusHtml}</td>
      <td class="col-actions">
        <button class="btn btn-sm" data-action="edit-meta-file-settings" data-idx="${i}" title="编辑设置" aria-label="编辑设置"${dis}>${ico('edit', 14)}</button>${resetBtn}
        <button class="btn btn-sm btn-danger" data-action="remove-meta-file" data-idx="${i}" title="移除" aria-label="移除"${dis}>${ico('trash', 14)}</button>
      </td>
    </tr>`;
  }).join('');

  // 单一渲染入口 → 三处计数/文案/惰性化统一在此产出，杜绝徽标与按钮脱节
  syncMetaQueueCount();
  syncMetaApplyButton();
  syncMetaFormInert();
}


// ── 徽标计数（设计文档 8.1 / ADR D-9）────────────────────
// 格式：[状态点] {总数} 项 · X 待转换 · Y 已完成 · Z 失败 · 勾选 S
// 每段仅在计数 > 0 时出现；总数 = X + Y + Z。
function syncMetaQueueCount() {
  const countEl = document.getElementById('metaQueueCount');
  const st = metaQueueStats();
  if (!countEl) return;
  if (st.total === 0) {
    // 空态必须切 hidden：旧实现 textContent='' 会留下一个只有背景色的空胶囊
    countEl.classList.add('hidden');
    countEl.innerHTML = '';
    countEl.removeAttribute('title');
  } else {
    countEl.classList.remove('hidden');
    const parts = [`${st.total} 项`];
    if (st.pending) parts.push(`${st.pending} 待转换`);
    if (st.done) parts.push(`${st.done} 已完成`);
    if (st.error) parts.push(`${st.error} 失败`);
    // 全选时「勾选 N」无信息量，不显示
    if (st.selected && st.selected < st.total) parts.push(`勾选 ${st.selected}`);
    const text = parts.join(' · ');
    // 状态点回答「我现在点应用会发生什么」：有失败→error / 有待转换→primary / 否则→success
    const dotColor = st.error ? 'var(--error)' : (st.pending ? 'var(--primary)' : 'var(--success)');
    countEl.innerHTML = `<span class="status-dot" style="background:${dotColor}"></span><span class="metaq-count-text">${esc(text)}</span>`;
    countEl.title = text;
  }
  const selectAllEl = document.getElementById('metaSelectAll');
  if (selectAllEl) selectAllEl.checked = (st.selected === st.total && st.total > 0);
}


// ── 「应用元数据」按钮文案随队列状态切换（设计文档 5.1）────
// 这是本次风险最高的一处：同一按钮标签对应两条不同执行路径，
// 按钮标签是这条分叉路径上唯一始终可见的载体。
function syncMetaApplyButton() {
  const btn = document.getElementById('metaApplyBtn');
  if (!btn) return;
  const st = metaQueueStats();
  const n = st.pending;
  // forceFormRun 置位期间按钮必须切到界面模式 —— 否则用户点完「仍按界面设置执行这一轮」，
  // 按钮仍显示「应用元数据 · N 项」，与实际本轮行为不符（标签是该分叉路径唯一可见载体）
  if (n > 0 && !forceFormRun) {
    btn.textContent = `应用元数据 · ${n} 项`;
    btn.title = `本次将按列队顺序执行 ${n} 个待转换项（不含已完成项）。上方界面设置本次不生效。`;
  } else if (forceFormRun) {
    btn.textContent = '按界面设置应用';
    btn.title = '本轮已选择忽略列队，将按上方界面设置处理「视频文件」中的单个文件。该选择只生效这一轮。';
  } else {
    btn.textContent = '按界面设置应用';
    btn.title = st.total > 0
      ? `列队 ${st.total} 项已全部处理完毕，本次将按上方界面设置处理「视频文件」中的单个文件。`
      : '列队为空，本次按上方界面设置处理「视频文件」中的单个文件。';
  }
  // 禁用态：全部项都在执行中 → 明确告知原因，而不是让用户点了没反应
  const allRunning = st.total > 0 && st.running === st.total;
  const noInput = !(document.getElementById('metaInput') || {}).value;
  btn.disabled = allRunning || ((n === 0 || forceFormRun) && noInput);
  if (allRunning) btn.title = '列队正在执行中';
  else if ((n === 0 || forceFormRun) && noInput) btn.title = '先在「视频文件」选择一个文件，或把文件加入列队';
}


// ── 界面设置惰性化 + 可撤销说明条（设计文档 5.2）────────────
// 有待转换项时：本次执行忽略界面设置，故把界面设置区置惰性并给出说明条 + 一次性覆盖出口。
// 说明条必须留在惰性子树之外，保证「为什么不生效」这句关键信息始终满对比度。
function syncMetaFormInert() {
  const notice = document.getElementById('metaScopeNotice');
  const st = metaQueueStats();
  const inert = st.pending > 0 && !forceFormRun;

  // 惰性目标：功能开关整卡 + 输出目录字段。用 closest 定位，避免新增 DOM id 契约。
  const targets = [];
  const spherical = document.getElementById('m_apply_spherical');
  if (spherical && spherical.closest('.card')) targets.push(spherical.closest('.card'));
  const outInput = document.getElementById('metaBatchOutDir');
  if (outInput && outInput.closest('.field')) targets.push(outInput.closest('.field'));
  targets.forEach(el => el.classList.toggle('meta-form-inert', inert));

  if (!notice) return;
  notice.classList.toggle('hidden', !inert);
  if (inert) {
    const textEl = notice.querySelector('.meta-scope-text');
    if (textEl) {
      textEl.innerHTML = `列队有 <strong>${st.pending}</strong> 项待转换，本次将忽略上方界面设置。`;
    }
  }
}


// 一次性覆盖：忽略队列，本轮按界面设置跑。队列状态完全不受影响。
function forceFormRunOnce() {
  forceFormRun = true;
  showToast('本轮将按界面设置执行', 'info', 3000);
  syncMetaApplyButton();
  syncMetaFormInert();
}


// ── 显式「重排队」出口（设计文档 6.4 / ADR D-4）──────────────
// 只改状态，零副作用：f.settings / f.outDir 保持不变，不调用任何执行函数。
// 理由：若按钮直接跑 ffmpeg，用户在 500 项队列上一点就是灾难性误操作。
function resetMetaItem(idx) {
  const f = metaBatchItems[idx];
  if (!f) return;
  if (f.status !== 'done') {
    showToast(`第 ${idx + 1} 项当前不是「已完成」，无需重排队`, 'info', 3000);
    return;
  }
  f.status = 'pending';
  f.statusMsg = '';
  f.duration = '';
  renderMetaBatchTable();
  showToast(`第 ${idx + 1} 项已改回待转换，下次点「应用元数据」时会重跑`, 'info', 2500);
}


function toggleMetaFileSelection(idx, checked) {
  if (!metaBatchItems[idx]) return;
  metaBatchItems[idx].selected = checked;
  // 只勾选状态变了，行内容无需重排：调统一 sync 保证徽标/按钮/惰性化不脱节
  syncMetaQueueCount();
  syncMetaApplyButton();
  syncMetaFormInert();
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
        `<button class="si-btn" data-action="reuse-source-gps" data-target="me" ${(!pd.has_gps) ? 'disabled' : ''}>${ico('pin', 14)} 复用素材 GPS 及地名</button>` +
        `<button class="si-btn" data-action="reuse-source-time" data-target="me" ${(!pd.has_time) ? 'disabled' : ''}>${ico('calendar', 14)} 复用拍摄时间</button>`;
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

  // 输出位置回填（v3.13.14）：独立于 collectMetaSettings 的第三条读写路径
  fillMetaOutMode(getOutDir(f));

  document.getElementById('metaEditModal').classList.add('active');
}


// ── 编辑弹窗「输出位置」三态（设计文档 4.3）──────────────────
// 分段是原生 radio（name=me_out_mode），故：
//   · 键盘方向键在组内循环、Tab 可达 —— 无需额外 ARIA 键盘处理
//   · 保存时取被选中的那个的 value，无需维护第二份状态
function getMetaOutMode() {
  const checked = document.querySelector('input[name="me_out_mode"]:checked');
  const v = checked ? checked.value : 'global';
  return (v === 'snapshot' || v === 'inplace') ? v : 'global';
}

const META_OUT_HINTS = {
  global:   '全局级：执行时读取上方「输出目录」的当前值',
  snapshot: '快照级：使用加入列队那一刻的目录，之后修改上方「输出目录」不影响本行',
  inplace:  '原地修改：直接覆盖源文件本身。源文件不可撤销，建议先指定输出目录',
};

function fillMetaOutMode(od) {
  const mode = (od && od.mode) || 'global';
  const radio = document.querySelector(`input[name="me_out_mode"][value="${mode}"]`);
  if (radio) radio.checked = true;
  // 快照路径：无快照值时预填上方全局当前值（设计文档 4.3「快照路径行显隐」）
  const dirEl = document.getElementById('me_out_dir');
  if (dirEl) {
    const gEl = document.getElementById('metaBatchOutDir');
    const globalVal = gEl ? gEl.value.trim() : '';
    dirEl.value = (mode === 'snapshot' && od && od.value) ? od.value : globalVal;
  }
  applyMetaOutModeUI(mode);
}

// 切换输出模式：仅控制「快照路径行」的显隐与提示文案，不清空已填的路径值
// （设计文档 4.5：切回 snapshot 时可恢复用户先前填的内容）。
function applyMetaOutModeUI(mode) {
  const wrap = document.querySelector('#metaEditModal .me-out-path');
  if (wrap) wrap.classList.toggle('hidden', mode !== 'snapshot');
  const hint = document.querySelector('#metaEditModal .me-out-hint');
  if (!hint) return;
  let text = META_OUT_HINTS[mode] || META_OUT_HINTS.global;
  if (mode === 'snapshot') {
    const dirEl = document.getElementById('me_out_dir');
    if (!dirEl || !dirEl.value.trim()) {
      text = '该项没有可用快照，将使用上方「输出目录」当前值';
    }
  }
  hint.textContent = text;
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
  // ⚠ 输出位置独立读写，绝不并入 collectMetaSettings（见文件头 outDir 注释）：
  //   该函数表驱动且三前缀共用，p_/m_ 侧无此控件，checked() 恒 false 会静默取 inplace。
  const mode = getMetaOutMode();
  const dirEl = document.getElementById('me_out_dir');
  f.outDir = {
    mode: mode,
    value: (mode === 'snapshot' && dirEl) ? dirEl.value.trim() : ''
  };
  // 防「点了没反应」：用户改了已完成项的设置却不会被自动重跑（ADR D-2 明确
  // 「编辑不隐式重排队」，理由是批量微调会引发 N 次意外 ffmpeg）。
  // 故此处显式回落为待转换并告知，让用户的编辑意图真实生效。
  const wasDone = f.status === 'done';
  if (wasDone) {
    f.status = 'pending';
    f.statusMsg = '';
    f.duration = '';
  }
  renderMetaBatchTable();
  closeMetaEditModal();
  showToast(
    wasDone ? '设置已保存，该项已改回待转换，下次点「应用元数据」时会重跑' : '设置已保存',
    'success', wasDone ? 4000 : 2500);
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
    html += `<button class="si-btn" data-action="reuse-source-gps" data-target="${esc(target)}" ${(!data.has_gps) ? 'disabled' : ''}>${ico('pin', 14)} 复用 GPS 位置</button>`;
    html += `<button class="si-btn" data-action="reuse-source-time" data-target="${esc(target)}" ${(!data.has_time) ? 'disabled' : ''}>${ico('calendar', 14)} 复用拍摄时间</button>`;
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
      // v3.13.14: 改用显式失败标志，不再靠 startsWith('(地址获取失败') 嗅探文案。
      // 嗅探的缺陷：提示文案一改，这里就永远判为真 → 真实地址被吞；
      // 反之文案被改得不匹配时，错误提示会被当成地址抄进输入框，且不报错。
      const rAddr = r.addrFailed ? '' : (r.address || '');
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


// 把一个「已归一化为本地 naive 的日期字符串」写入指定前缀的手动日期框，
// 并完成与「复用拍摄时间」完全相同的联动序列。
//
// ⚠⚠ 语句顺序是契约，不可调整、不可为 p_ 前缀写特判（ADR-004 D-7 第 1 条）：
//   REUSE_TARGETS.p 的 masterDate 与 fromName 指向**同一个元素**
//   （都是 p_date_from_filename，详见 50-meta.js 的 META_FIELD_IDS 注释）。
//   必须先 fromName.checked=false 再 masterDate.checked=true，
//   两行对 p_ 净效果 = 「取消勾选后立即重新勾选」= 保持日期功能开启。
//   一旦把「确保总开关打开」提前，p_ 侧会净变为「日期功能被关闭」——
//   用户填了日期却什么都不写，且界面无任何报错（p_date_from_filename 取消勾选
//   会同时触发 dateOptions 折叠，用户看到的是「选项区消失了」）。
//   回归防线：_verify_meta_reuse_flows.js 有 5 处断言直接校验本联动结果。
function applyManualDateToTarget(target, dateStr, infoLabel) {
  const t = REUSE_TARGETS[target];
  if (!t || !dateStr) return;
  document.getElementById(t.manual).value = dateStr;
  const fromName = document.getElementById(t.fromName);
  if (fromName) fromName.checked = false;
  // 复用/写入时间意味着要写日期 → 顺带启用日期总开关（此前 m_ 侧总开关关闭时复用无效）
  const masterDate = document.getElementById(t.masterDate);
  if (masterDate && !masterDate.checked) masterDate.checked = true;
  t.showDateSection();
  if (t.afterTime) t.afterTime();
  const info = document.getElementById(t.infoTime);
  if (info && infoLabel) {
    info.classList.remove('hidden');
    info.innerHTML = `${esc(infoLabel)}: <strong>${esc(dateStr.replace('T', ' '))}</strong>`;
  }
}


function reuseSourceTime(target) {
  const probe = probeForTarget(target);
  if (!REUSE_TARGETS[target] || !probeHasTime(probe)) return;
  // FIX (v3.13.4 场景4): 归一化为本地 naive（源值是 UTC Z 字符串；旧实现剥掉 Z
  // 把 UTC 当本地，产生 8 小时偏差）
  const dateStr = utcToLocalNaive(probe.creation_time);
  applyManualDateToTarget(target, dateStr, '已复用拍摄时间');
  markManualDateSource(target, 'reuse', dateStr);
}


// ══ 「读创建时间」（v3.13.14 / ADR-004 D-6、D-7）══════════════
// 语义：取所选文件在 Windows 资源管理器里的「创建日期」，**不是**视频拍摄时间。
// 与既有 14 处「输入框 + 浏览按钮」的差别：不填路径，只填一个时间戳，
// 故不复用 open-path-dialog（其 openFileBrowser 带 targetId==='singleInput'
// 等副作用分支，且 14 处路径输入的统一约定会被 data-date-target 污染）。

// 溯源条定位：m_manual_date 有注册 id（团队契约要求），其余两处用 data 属性定位，
// 避免为纯展示元素扩大 DOM id 契约面。
function getDateSourceEl(targetId) {
  return document.querySelector(`.date-source[data-date-source-for="${targetId}"]`);
}

function markManualDateSource(targetId, source, payload) {
  const el = getDateSourceEl(targetId);
  if (!el) return;
  if (source === 'none') {
    el.classList.add('hidden');
    el.classList.remove('is-error');
    el.dataset.source = 'none';
    el.innerHTML = '';
    return;
  }
  el.classList.remove('hidden');
  el.dataset.source = source;
  if (source === 'fs-ctime') {
    const name = String(payload.fileName || '').split(/[\/\\]/).pop();
    el.classList.remove('is-error');
    el.innerHTML = `已从 ${esc(name)} 读取 Windows 创建日期 <span class="ds-time">${esc(payload.ctime || '')}</span>` +
      ` <button type="button" data-action="meta-date-from-file" data-date-target="${esc(targetId)}" data-date-mode="clear">清除</button>`;
    el.title = `读取来源：${payload.path || ''}\n注意：这是文件系统创建日期，不是视频拍摄时间`;
  } else if (source === 'manual') {
    el.classList.remove('is-error');
    el.innerHTML = '手动输入，未从文件读取';
  } else if (source === 'error') {
    el.classList.add('is-error');
    // 铁律（设计文档 10.1）：失败绝不覆盖已有值。这里只改溯源条，不碰输入框。
    el.innerHTML = `未能读取创建日期 · <button type="button" data-action="meta-date-from-file" data-date-target="${esc(targetId)}" data-date-mode="manual">手动输入</button>`;
    el.title = payload.detail || '';
  }
}

// 失败文案归一化：Toast 只给人话，系统细节（[WinError 5] 之类）进 title 与日志。
// 参照 ADR D-6 的 HTTP 语义分流 404 / 403 / 其他。
function describeFsTimeFailure(status, errMsg, picked) {
  const fileName = String(picked || '').split(/[\/\\]/).pop() || '该文件';
  const dir = String(picked || '').replace(/[\\/][^\\/]*$/, '') || '原位置';
  if (status === 404) return { msg: `读不到创建日期：文件已不在 ${dir}`, detail: `HTTP 404：${errMsg || '文件不存在'}` };
  if (status === 403) return { msg: `读不到创建日期：没有读取 ${fileName} 的权限`, detail: `HTTP 403：${errMsg || '拒绝访问'}。请确认该文件未被其他程序独占，或把文件复制到可读位置后重试` };
  if (status === 400) return { msg: '读不到创建日期：后端拒绝了该路径', detail: `HTTP 400：${errMsg || ''}` };
  return { msg: `读取创建日期失败：${errMsg || '未知错误'}`, detail: `status=${status} ${errMsg || ''}` };
}

function logMetaDate(msg) {
  const box = document.getElementById('logBox');
  if (!box) return;
  const div = document.createElement('div');
  div.className = 'log-line';
  const ts = document.createElement('span');
  ts.className = 'log-ts';
  ts.textContent = new Date().toLocaleTimeString();
  const m = document.createElement('span');
  m.className = 'log-msg warn';
  m.textContent = msg;
  div.appendChild(ts); div.appendChild(m);
  box.appendChild(div);
  while (box.children.length > 100) box.removeChild(box.firstChild);
}

async function browseDateFromFile(targetId, prefix) {
  if (!targetId) return;
  let picked;
  try {
    const r = await fetch('/api/native_dialog', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        type: 'open_file', title: '选择参考文件（读取其 Windows 创建时间）',
        file_filter: 'video', path_type: 'open', initial_dir: ''
      })
    });
    const data = await r.json();
    if (data.error) { alert(data.error); return; }
    picked = data.path;
  } catch (e) {
    alert('打开文件对话框失败: ' + e.message);
    return;
  }
  // 用户取消不是错误：不弹 toast、不改溯源条、不碰输入框（设计文档 10.2 第 1 行）
  if (!picked) return;

  const el = document.getElementById(targetId);
  if (!el) return;
  try {
    const r = await fetch('/api/file_fs_time?path=' + encodeURIComponent(picked));
    const d = await r.json();
    if (d.error) {
      const info = describeFsTimeFailure(r.status, d.error, picked);
      markManualDateSource(targetId, 'error', { detail: `系统返回：${info.detail}` });
      logMetaDate(`[日期] 读取创建时间失败 ${picked}：${info.detail}`);
      showToast(info.msg, 'error', 6000);
      return;   // ⚠ 提前 return：绝不触碰 el.value（设计文档 10.1 铁律）
    }
    // ctime 已是后端给的**本地 naive 字符串**（ADR D-6）。绝对不要加 Z 后缀，
    // 也不要把本就该是本地的值再做一次 UTC→本地转换 ——
    // 加 Z 会让下游 datetime.fromisoformat() 当 UTC 解释，
    // 重新引入 v3.13.7 修掉的 ±8h 偏差缺陷。
    el.value = d.ctime || '';
    if (prefix) applyManualDateToTarget(prefix, el.value, null);
    if (prefix) markManualDateSource(targetId, 'fs-ctime', { ctime: el.value, fileName: picked, path: picked });
    el.dispatchEvent(new Event('change', { bubbles: true }));
    if (d.is_creation_time === false) {
      // POSIX 平台才出现；本机（Windows）恒 true。如实告知而非假装是创建时间。
      showToast('当前系统返回的是文件变更时间，不是创建时间', 'warning', 5000);
    }
    // 成功不弹 toast：回填 + 溯源条已是足够反馈，再加 toast 属重复告知（设计文档 9.4）
  } catch (e) {
    const info = describeFsTimeFailure(0, e.message, picked);
    markManualDateSource(targetId, 'error', { detail: `系统返回：${info.detail}` });
    logMetaDate(`[日期] 读取创建时间失败 ${picked}：${info.detail}`);
    showToast(info.msg, 'error', 6000);
  }
}

// 溯源条上的「清除」/「手动输入」按钮（设计文档 10.4）。
// 它不是提交按钮，是「放弃自动读取、改为自己敲」的跳转。
function metaDateFromFileAction(targetId, mode) {
  const el = document.getElementById(targetId);
  if (!el) return;
  if (mode === 'clear') {
    el.value = '';
    markManualDateSource(targetId, 'none');
    el.focus();
    return;
  }
  // manual：聚焦 + 全选，让用户直接在既有格式占位上改
  el.focus();
  if (el.select) el.select();
  markManualDateSource(targetId, 'manual');
  el.dispatchEvent(new Event('change', { bubbles: true }));
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


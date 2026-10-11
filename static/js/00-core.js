// ============================================================
//   00-core.js — 全局状态 / 常量 / 通用工具 / 格式化函数
//   由 static/index.html 内联脚本拆分而来（整块切分，零行为变更）
// ============================================================


// FIX: Global error handler — captures uncaught errors and displays them
// as a visible toast so the user (and developer) can see what went wrong
// instead of silent failures in WebView2.
// v3.11.0: 改为复用统一的 showToast()，不再自建一套内联样式气泡
window.addEventListener('error', function(e) {
  const msg = e.message || 'Unknown error';
  const src = e.filename ? e.filename.split('/').pop() : '';
  const line = e.lineno || '';
  console.error('[Global Error]', msg, src, line);
  showToast('JS错误: ' + msg + (src ? ' (' + src + ':' + line + ')' : ''), 'error', 8000);
});
// ── State ──────────────────────────────────────────

let currentMode = 'single';
// Batch is now task-list-centric: each entry carries its own export params + output.

let batchTasks = [];
// Directory import is decoupled from the task list: this is just the scanned media
// candidate pool (source path / size / date). User multi-selects then adds to tasks.

let importCandidates = [];

// 当前活动任务的 id。由 60-jobs.js 的 ActiveJob 控制器读写（唯一写入入口 beginJob/endJob）。
let jobId = null;

// 兼容镜像：实际定时器句柄由 ActiveJob.timer 持有
let pollTimer = null;

let lastLogCount = 0;  // FIX BUG-M08: track rendered log count for incremental append


const DEFAULT_PARAMS = {
  codec:'libx264', resolution:'4096x2048', profile:'high', level:'5.1', pix_fmt:'yuv420p',
  color_range:'tv', color_space:'bt709', color_primaries:'bt709', color_trc:'bt709',
  bf:3, refs:5, gop:48, sc_threshold:0, rate_mode:'crf', crf:23,
  maxrate:'40M', bufsize:'20M', target_bitrate:'50000k', preset:'fast',
  x264_params:'hrd=1:pic_init_qp=26', x265_params:'',
  audio_codec:'aac', audio_profile:'aac_low',
  audio_bitrate:'96k', audio_sample_rate:'48000', audio_channels:2,
  brand:'mp42', faststart:true, inject_spherical:true,
  pano_type:'360', stereo_mode:'mono',
  stabilize:false, stabilize_smoothing:30, stabilize_shakiness:5, stabilize_zoom:0.05,
      date_from_filename:false, set_creation_time:true, set_file_created:true,
      set_file_modified:true, manual_date:'',
      set_location:false, location_name:'', location_address:'', location_lat:'', location_lon:'',
      // Okaa dual-fisheye correction
      okaa_correction:false, okaa_fov:200, okaa_yaw_l:0, okaa_yaw_r:0,
      okaa_pitch_l:0, okaa_pitch_r:0, okaa_roll_l:0, okaa_roll_r:0,
      okaa_blend:'seam', okaa_layout:'sbs', okaa_out_resolution:'3840x1920',
      // Insta360 native processing
      insv_stitch:true, insv_stabilize:false, insv_direction_lock:false, insv_denoise:false,
      insv_fov:200, insv_yaw:0, insv_pitch:0, insv_roll:0,
    };

// ── Theme ──────────────────────────────────────────

function fetchWithTimeout(url, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, { signal: controller.signal }).finally(() => clearTimeout(timer));
}


function val(id) { return document.getElementById(id).value; }

function num(id) { return parseInt(document.getElementById(id).value) || 0; }


// ── 空值安全的 DOM 辅助（v3.11.0）────────────────────
// 此前轮询渲染中大量使用 `document.getElementById('x').style.width = ...` 的裸链式访问，
// 一旦目标元素缺失（模式切换、DOM 结构调整）就会抛 TypeError 并中断整个轮询周期，
// 表现为"进度条卡死且日志不再刷新"。统一改为空值安全访问。
function setText(id, text) { const el = document.getElementById(id); if (el) el.textContent = text; }
function setHTML(id, html) { const el = document.getElementById(id); if (el) el.innerHTML = html; }
function setStyle(id, prop, value) { const el = document.getElementById(id); if (el) el.style[prop] = value; }
function setDisplay(id, display) { const el = document.getElementById(id); if (el) el.style.display = display; }
function addClass(id, cls) { const el = document.getElementById(id); if (el) el.classList.add(cls); }
function removeClass(id, cls) { const el = document.getElementById(id); if (el) el.classList.remove(cls); }

// ── 统一轻提示（v3.11.0）────────────────────────────
// 改造前项目存在 4 套彼此独立的提示实现：
//   ① 全局错误 toast（z-index 99999，8000ms）
//   ② 本函数（z-index 100001，固定 2500ms）
//   ③④⑤⑥ 80-codec/70-report 中 4 处内联成功气泡（z-index 9999，4000ms）
// 层级、时长、圆角、字号均不一致，且各自复制 ~15 行 DOM 样板。
// 现统一为本函数：一套层级、一套样式、按时长语义分档。
const TOAST_DURATION = { success: 2500, warning: 4000, error: 6000, info: 2500 };

function showToast(msg, type, durationMs) {
  let toast = document.getElementById('toastNotification');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'toastNotification';
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
    toast.style.cssText = 'position:fixed;top:20px;right:20px;z-index:100001;padding:14px 24px;border-radius:10px;font-size:0.9rem;font-weight:500;box-shadow:0 4px 20px rgba(0,0,0,0.3);transition:opacity 0.3s,transform 0.3s;opacity:0;transform:translateY(-10px);max-width:420px;word-break:break-word;';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.style.background = type === 'success' ? 'var(--success)'
    : type === 'error' ? 'var(--error)'
    : type === 'warning' ? 'var(--warning)'
    : 'var(--accent)';
  toast.style.color = '#fff';
  toast.style.opacity = '1';
  toast.style.transform = 'translateY(0)';
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(-10px)';
  }, durationMs || TOAST_DURATION[type] || TOAST_DURATION.info);
}

// ── 内联 SVG 图标（P0：禁止 emoji / 字符图标作功能图标）──────
// 统一规格：24 网格 / fill=none / stroke=currentColor / stroke-width=2 / round 端点，
// 与 index.html 内既有 5 枚页签图标同源。currentColor 随文字色，14px 与 20px 两档。
//
// 位置说明（v3.13.14）：本块从 50-meta.js 迁到 00-core.js —— 全域 emoji 清零后
// 10-ui/30-params/40-files/70-report/80-codec 都要用它，而 00-core.js 是唯一
// 在这些模块之前加载的文件（原 50-meta.js 排在它们之后）。
const ICON_SVG_ATTRS = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"';
const ICON_PATHS = {
  inbox:     '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  folder:    '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
  check:     '<path d="M20 6 9 17l-5-5"/>',
  x:         '<path d="M18 6 6 18M6 6l12 12"/>',
  edit:      '<path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>',
  trash:     '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  globe:     '<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
  calendar:  '<rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
  pin:       '<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>',
  outSnapshot:'<polyline points="15 10 20 15 15 20"/><path d="M4 4v7a4 4 0 0 0 4 4h12"/>',
  // 「跟随全局」= refresh-cw（跟随上方「输出目录」当前值），设计文档 7.4 的 ico-out-global
  outGlobal: '<path d="M10 13a5 5 0 0 0 7.07 0"/><path d="M14 11a5 5 0 0 0-7.07 0"/><line x1="17" y1="7" x2="17" y2="11"/><line x1="7" y1="13" x2="7" y2="17"/>',
  outInplace:'<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
  // 链接（合并预处理）：v3.13.14 替换原字符图标。
  // 注：注释刻意不写该图标的字面字符，避免被 P0 emoji 扫描按字面量误报。
  link:      '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  reset:     '<path d="M3 2v6h6"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L3 8"/>',
  alert:     '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
  // ── v3.13.14 全域 emoji 清零追加 ──
// 圆圈对勾：用于「聚合成功/通过」语义（区别于裸check 的「单项勾选」）
  checkCircle: '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>',
  // 圆圈叉：用于「聚合失败」语义
  xCircle:   '<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>',
  // 方框加号：批量导入「将选中添加到任务」
  plusSquare:'<rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/>',
  plus:      '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  // 文档 / 剪贴板：导出日志与诊断报告
  fileText:  '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>',
  clipboard: '<rect x="8" y="2" width="8" height="4" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>',
  // 包裹：配对文件检测（双文件成对）
  package:   '<line x1="16.5" y1="9.4" x2="7.5" y2="4.21"/><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>',
  // 合并（多路合一）：批量任务里的合并项标记
  merge:     '<path d="M6 3v6a6 6 0 0 0 6 6h6"/><polyline points="15 12 18 15 15 18"/><path d="M18 9V3"/><path d="M6 21v-6"/>',
  // 垃圾桶：移除行（批量表/合并表/报告筛选行共用）
  trash:     '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  // ── v3.13.18 拍摄位置 GPS 增强 ──
  // 地图选点：与既有 openMapPicker 的 pin 图标同源，此处为「带靶心」的选点语义
  geoPick:   '<circle cx="12" cy="10" r="3"/><path d="M19 10c0 7-7 13-7 13s-7-6-7-13a7 7 0 0 1 14 0z"/><circle cx="19" cy="5" r="2"/>',
  // 复制到剪贴板：两个重叠矩形
  copy:      '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  // 从剪贴板粘贴：剪贴板 + 向下箭头
  paste:     '<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/><path d="M12 11v6"/><path d="M9 14h6"/>',
};
// 产出图标 HTML。size 只允许 14 / 20 两档（设计文档 7.1：不提供第三档）。
function ico(name, size) {
  const body = ICON_PATHS[name];
  if (!body) return '';
  const s = size === 20 ? 20 : 14;
  return `<svg width="${s}" height="${s}" ${ICON_SVG_ATTRS}>${body}</svg>`;
}


// ── Merge Mode ───────────────────────────────────────

function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// ── Metadata Tool ──────────────────────────────────

window.addEventListener('beforeunload', function() {
  endJob();                      // 统一清理活动任务与轮询定时器（见 60-jobs.js）
  if (sysmonTimer) { clearInterval(sysmonTimer); sysmonTimer = null; }
  const toast = document.getElementById('toastNotification');
  if (toast && toast._timer) { clearTimeout(toast._timer); }
});

// Override map picker to support both targets

function formatDuration(seconds) {
  if (!seconds || isNaN(seconds)) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0 ? `${h}h ${m}m ${s}s` : `${m}m ${s}s`;
}

// ── Time tracking helpers ───────────────────────────

function fmtTime(seconds) {
  if (seconds == null || isNaN(seconds) || seconds < 0) return '--';
  if (seconds < 1) return '<1秒';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}时${m}分${s}秒`;
  if (m > 0) return `${m}分${s}秒`;
  return `${s}秒`;
}


function calcTimeEstimates(startTime, progress, nowSec) {
  // Returns {elapsed, remaining, total} or null if not enough data
  if (!startTime || progress <= 0) return null;
  const elapsed = nowSec - startTime;
  if (elapsed < 0) return null;
  // estimated total = elapsed / (progress / 100)
  const total = elapsed / (progress / 100);
  const remaining = total - elapsed;
  return { elapsed, remaining: Math.max(0, remaining), total };
}


function formatFrameRate(rateStr) {
  if (!rateStr) return '—';
  const parts = rateStr.split('/');
  if (parts.length === 2) {
    const num = parseFloat(parts[0]);
    const den = parseFloat(parts[1]);
    if (den > 0) return (num / den).toFixed(2) + ' fps';
  }
  const val = parseFloat(rateStr);
  return isNaN(val) ? '—' : val.toFixed(2) + ' fps';
}


function formatBitrate(bps) {
  if (!bps || isNaN(bps)) return '—';
  const mbps = bps / 1000000;
  if (mbps >= 1) return `${mbps.toFixed(2)} Mbps`;
  return `${Math.round(bps / 1000)} kbps`;
}


// ══ 事件委托中央分发器（v3.12.0）══════════════════════════════════
// 背景：项目原有大量内联事件属性（onclick / onchange 等），其中相当一部分位于
// JS 动态生成的 HTML 字符串中。内联事件有两个问题：
//   ① 严格 CSP 下必须放开 unsafe-inline，等于放弃一半 CSP 保护；
//   ② 动态拼接进 HTML 属性的参数（文件名、路径、编码器名、URL）构成 XSS 面。
//      关键：esc() 在 "JS-in-HTML-attribute" 上下文中并不充分 —— HTML 实体先于
//      JS 解码生效，`&#39;` 在 JS 解析时已还原为引号，仍可闭合字符串。
//      改成 data-* 属性后，属性里不再出现函数名与引号嵌套，该攻击面自然消除。
//
// ── 绑定层级（关键设计）──
// 必须绑在 document 上，而不是各个业务容器上。
// 原因：#codecStatus、各表格 tbody 等容器会被 render* 函数整体 innerHTML 重建
// （部分容器甚至被多个函数轮流重建），绑在这些容器或其子元素上的监听器会随
// 重建一起丢失，表现为"首次渲染后点击无反应"。
// document 级监听不受重建影响，且天然负责清理。
//
// ── 事件类型判定 ──
// 表单控件（INPUT/SELECT/TEXTAREA）只响应 change，其余元素只响应 click，
// 避免同一元素同时触发 click 与 change 导致动作被执行两次。

const DELEGATED_ACTIONS = {
  // 编码器详情 / 诊断
  'encoder-detail':           el => showEncoderDetail(el.dataset.encoder),
  'copy-error-info':          el => copyErrorInfo(el.dataset.encoder),
  'export-diagnostic-report': () => exportDiagnosticReport(),
  'codec-change':             () => onCodecChange(),
  // 地图搜索结果
  'select-search-result':     el => selectSearchResultByIndex(Number(el.dataset.idx)),
  // 外部链接（原先用 <a href="javascript:void(0)">，严格 CSP 下同被禁）
  'open-external-url':        el => openExternalUrl(el.dataset.url),
  // 批量导入候选表
  'update-import-count':      () => updateImportCount(),
  // 批量任务表
  'task-check-change':        () => onTaskCheckChange(),
  'remove-batch-item':        el => removeBatchItem(Number(el.dataset.idx)),
  // 合并表
  'move-merge-item':          el => moveMergeItem(Number(el.dataset.idx), Number(el.dataset.dir)),
  'remove-merge-item':        el => removeMergeItem(Number(el.dataset.idx)),
  // 元数据批量表
  'toggle-meta-file-selection': (el, e) => toggleMetaFileSelection(Number(el.dataset.idx), e.target.checked),
  'edit-meta-file-settings':    el => editMetaFileSettings(Number(el.dataset.idx)),
  'remove-meta-file':           el => removeMetaFile(Number(el.dataset.idx)),
  // v3.13.14 元数据队列：加入列队 / 显式重排队 / 一次性忽略队列按界面跑 / 输出位置三态
  'meta-enqueue':               () => addToMetaBatchList(),
  'reset-meta-item':            el => resetMetaItem(Number(el.dataset.idx)),
  // v3.13.18 列队执行独立按钮：与 #metaApplyBtn（界面单文件）职责相反，
  // 两者各调一条执行路径，不再共用一个按队列状态切换文案的按钮。
  'meta-batch-run':            () => startMetadataBatchRun(),
  // v3.13.18 设置同步器：把界面设置写入所有勾选列队项，不启动转换。
  'meta-force-form-run':        () => applyFormSettingsToQueue(),
  'meta-out-mode':              el => applyMetaOutModeUI(el.value),
  // v3.13.18 拍摄位置 GPS：地图选点 / 一键复制 / 一键粘贴。
  // 三前缀（p_/m_/me_）共用同一套动作名与同一套 JSON 字段命名，
  // 目标前缀由 data-geo-prefix 决定 —— 一个动作一种语义，不按前缀分裂成六条。
  'geo-map-pick':               el => openGeoMapPicker(el.dataset.geoPrefix),
  'geo-copy':                   el => copyGeoEntry(el.dataset.geoPrefix),
  'geo-paste':                  el => pasteGeoEntry(el.dataset.geoPrefix),
  // v3.13.14「读创建时间」：与 14 处「填路径」的 open-path-dialog 是两件事，
  // 故独立成条（ADR-004 D-7）；溯源条上的清除/手动输入按钮也走这一条。
  'browse-date':                el => browseDateFromFile(el.dataset.dateTarget, el.dataset.datePrefix),
  'meta-date-from-file':        el => metaDateFromFileAction(el.dataset.dateTarget, el.dataset.dateMode),
  'reuse-source-gps':         el => reuseSourceGPS(el.dataset.target),
  'reuse-source-time':        el => reuseSourceTime(el.dataset.target),
  // 任务进度行
  'skip-item':                el => skipItem(Number(el.dataset.idx)),
  // 路径输入（14 处「输入框 + 浏览按钮」统一走此动作）
  'open-path-dialog':         el => openPathDialog(el.dataset),
  // 元数据设置区子容器显隐（原为内联 onchange，三套命名不一致故用显式前缀/区段标识）
  'toggle-spherical-options': el => toggleSphericalOptions(el, el.dataset.prefix),
  'toggle-meta-edit-section': el => toggleMetaEditSection(el.dataset.metaSection, el.checked),
  // 元数据报告批量结果（筛选 / 多选 / 加入批量转换队列）
  // FIX (v3.13.9): 单条件筛选控件已重构为多条件行容器，旧委托条目移除
  'report-filter-row-change': (el) => onReportFilterRowChange(el),
  'report-filter-remove':     (el) => removeReportFilterRow(el.dataset.row),
  'toggle-report-select':     (el, e) => toggleReportSelect(Number(el.dataset.idx), e.target.checked),
  'report-select-all':        () => reportSelectVisibleAll(),
  'report-select-invert':     () => reportSelectInvert(),
  'report-select-clear':      () => reportSelectClear(),
  'report-add-to-queue':      () => addSelectedReportToQueue(),
};

function dispatchDelegatedEvent(e) {
  const target = e.target;
  if (!target || !target.closest) return;
  // 表单控件走 change，其余走 click —— 二者互斥，防重复执行
  const isFormControl = /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName || '');
  if (isFormControl !== (e.type === 'change')) return;

  const el = target.closest('[data-action]');
  if (!el) return;
  const fn = DELEGATED_ACTIONS[el.dataset.action];
  if (!fn) {
    // 未注册的 action：多为拼写错误，显式报出而不是静默失效
    console.error('[delegate] 未注册的 data-action:', el.dataset.action);
    return;
  }
  // 锚点元素：阻止默认跳转（改用 data-action 后 href 只用于保持可键盘聚焦，
  // 不再承担导航职责；不阻止会因 href="#" 而把页面滚回顶部）
  if (e.type === 'click' && el.tagName === 'A' && !e.defaultPrevented) e.preventDefault();
  try {
    fn(el, e);
  } catch (err) {
    console.error('[delegate] action 执行失败:', el.dataset.action, err);
  }
}

document.addEventListener('click', dispatchDelegatedEvent);
document.addEventListener('change', dispatchDelegatedEvent);


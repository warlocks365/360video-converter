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
  'reuse-source-gps':         el => reuseSourceGPS(el.dataset.target),
  'reuse-source-time':        el => reuseSourceTime(el.dataset.target),
  // 任务进度行
  'skip-item':                el => skipItem(Number(el.dataset.idx)),
  // 路径输入（14 处「输入框 + 浏览按钮」统一走此动作）
  'open-path-dialog':         el => openPathDialog(el.dataset),
  // 元数据设置区子容器显隐（原为内联 onchange，三套命名不一致故用显式前缀/区段标识）
  'toggle-spherical-options': el => toggleSphericalOptions(el, el.dataset.prefix),
  'toggle-meta-edit-section': el => toggleMetaEditSection(el.dataset.metaSection, el.checked),
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


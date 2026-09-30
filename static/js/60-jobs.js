// ============================================================
//   60-jobs.js — 任务调度（JobRegistry / Poller / Renderers / 进度渲染）
//   由 static/index.html 内联脚本拆分而来（整块切分，零行为变更）
// ============================================================

async function checkVR3DAlignment() {
  const left = document.getElementById('vr3dLeftInput')?.value || '';
  const right = document.getElementById('vr3dRightInput')?.value || '';
  const resultDiv = document.getElementById('vr3dAlignmentResult');
  if (!left || !right) {
    if (resultDiv) resultDiv.innerHTML = '';
    return;
  }
  try {
    const r = await fetch('/api/vr3d/check_alignment', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({left, right})
    });
    const data = await r.json();
    if (data.error) {
      if (resultDiv) resultDiv.innerHTML = `<span style="color:var(--danger)">⚠ ${esc(data.error)}</span>`;
      return;
    }
    const info = data.info || {};
    let html = `<div style="padding:8px;background:var(--surface-2);border-radius:6px;">`;
    html += `<div>左眼: ${esc(info.left_resolution || '?')} / ${(info.left_duration || 0).toFixed(1)}s</div>`;
    html += `<div>右眼: ${esc(info.right_resolution || '?')} / ${(info.right_duration || 0).toFixed(1)}s</div>`;
    if (data.aligned) {
      html += `<div style="color:var(--success);margin-top:4px;">✅ 左右眼视频对齐良好</div>`;
    } else {
      html += `<div style="color:var(--warning);margin-top:4px;">⚠ ${esc((data.warnings || []).join('; '))}</div>`;
      html += `<div style="color:var(--text-muted);font-size:0.75rem;margin-top:2px;">将自动缩放对齐</div>`;
    }
    html += `</div>`;
    if (resultDiv) resultDiv.innerHTML = html;

    // Update info labels
    const leftInfo = document.getElementById('vr3dLeftInfo');
    const rightInfo = document.getElementById('vr3dRightInfo');
    if (leftInfo) leftInfo.textContent = `${info.left_resolution || '?'} / ${(info.left_duration || 0).toFixed(1)}s`;
    if (rightInfo) rightInfo.textContent = `${info.right_resolution || '?'} / ${(info.right_duration || 0).toFixed(1)}s`;
  } catch (e) {
    // Silently fail — alignment check is optional
  }
}


async function startVR3D(params) {
  const left = document.getElementById('vr3dLeftInput').value;
  const right = document.getElementById('vr3dRightInput').value;
  const out = document.getElementById('vr3dOutput').value;
  if (!left || !right || !out) {
    alert('请选择左眼视频、右眼视频和输出文件');
    return;
  }

  const items = [{left_input: left, right_input: right, output: out}];

  const r = await fetch('/api/start_vr3d', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({params, items})
  });
  const data = await r.json();
  if (data.error) { alert(data.error); return; }

  if (!beginJob(data.job_id, 'encode')) return;
  isPaused = false;
  resetJobButtons();
}

// Auto-check alignment when either file changes

document.addEventListener('DOMContentLoaded', function() {
  const leftInput = document.getElementById('vr3dLeftInput');
  const rightInput = document.getElementById('vr3dRightInput');
  if (leftInput) leftInput.addEventListener('change', () => setTimeout(checkVR3DAlignment, 100));
  if (rightInput) rightInput.addEventListener('change', () => setTimeout(checkVR3DAlignment, 100));
});

// ── Insta360 file support (v3.9.0) ────────────────────

async function detectInsvPair(inputId) {
  const input = document.getElementById(inputId);
  if (!input || !input.value) return;
  const path = input.value;
  if (!path.toLowerCase().endsWith('.insv')) return;

  try {
    const r = await fetch('/api/insta360/detect_pair', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({path})
    });
    const data = await r.json();
    if (data.is_insv && data.paired) {
      // Show a suggestion to use merge mode with both files
      const infoId = inputId.replace('Input', 'Info');
      const infoEl = document.getElementById(infoId);
      if (infoEl) {
        infoEl.innerHTML = `<span style="color:var(--accent);">📦 检测到配对文件: ${esc(data.paired.split(/[\\/]/).pop())}</span>
        <br><span style="font-size:0.75rem;">建议使用「合并转换」模式同时添加两个文件</span>`;
      }
    }
  } catch (e) {
    // Silently fail
  }
}

// ── Start Conversion ────────────────────────────────

// FIX (v3.13.2 P0-4): maps backend item index → batchTasks row index for the
// running batch encode job (backend items = checked tasks only). Reset on
// every batch submission in startConversion(); same pattern as
// _metaProcessingIndices (50-meta.js).
let _encodeProcessingIndices = [];

// FIX (v3.13.2 P1-4): 任务终态时 endJob() 会把全局 jobId 置 null，导致
// 「导出编码日志」请求 /api/encode_log/null 必然 404。终态渲染时把 job id
// 缓存到这里，导出时优先使用。
let lastCompletedJobId = null;

async function startConversion() {
  let items = [];

  if (currentMode === 'vr3d') {
    // FIX (v3.13.2 P0-5): must submit collectVR3DParams() — the plain
    // collectParams() snapshot never carried vr3d_layout /
    // vr3d_check_alignment, so the user's layout choice was silently
    // ignored (always top-bottom) and stereo metadata followed suit.
    return startVR3D(collectVR3DParams());
  }

  const params = collectParams();

  if (currentMode === 'single') {
    const inp = document.getElementById('singleInput').value;
    const out = document.getElementById('singleOutput').value;
    if (!inp || !out) { alert('请选择源文件和输出文件'); return; }
    // singleOutput now contains the full output file path from the save dialog
    items = [{input: inp, output: out}];
  } else if (currentMode === 'merge') {
    if (mergeFiles.length < 2) { alert('合并转换至少需要选择2个文件'); return; }
    const out = document.getElementById('mergeOutput').value;
    if (!out) { alert('请选择输出文件'); return; }
    items = [{inputs: mergeFiles.map(f => f.path), output: out}];
  } else {
    if (batchTasks.length === 0) { alert('请先扫描'); return; }
    // Recompute outputs from each task's own config (await to finalize)
    await recomputeOutputs();
    const selected = [];
    // FIX (v3.13.2 P0-4): record checked row indices — the backend only
    // returns the submitted (checked) items, so renderEncodeJob maps item
    // index → row index through this array.
    _encodeProcessingIndices = [];
    batchTasks.forEach((t, i) => {
      const cb = document.querySelector(`.batch-check[data-idx="${i}"]`);
      if (cb && cb.checked) { selected.push(t); _encodeProcessingIndices.push(i); }
    });
    if (selected.length === 0) { alert('请至少勾选一个文件'); return; }

    for (const t of selected) {
      if (t.custom_output) {
        // Manual / merge tasks: fixed output, still carry their own params
        if (t.is_merge && t.inputs) {
          items.push({inputs: t.inputs, output: t.custom_output, params: t.params});
        } else {
          items.push({input: t.path, output: t.custom_output, params: t.params});
        }
      } else {
        if (!t.output) {
          alert(`任务「${t.name}」的输出路径为空，请检查输出设置`);
          return;
        }
        items.push({input: t.path, output: t.output, params: t.params});
      }
    }
  }

  const r = await fetch('/api/convert', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({mode: currentMode, params, items})
  });
  const data = await r.json();
  if (data.error) { alert(data.error); return; }

  if (!beginJob(data.job_id, 'encode')) return;
  isPaused = false;
  resetJobButtons();
  setText('progressLabel', '转换中...');
}


async function cancelConversion() {
  if (!jobId) return;
  // 立即禁用取消按钮，防止重复点击。
  // 操作栏已统一（v3.11.0），不再存在 meta* 按钮与 meta* 进度标签两套 DOM。
  const cancelBtn = document.getElementById('cancelBtn');
  const pauseBtn = document.getElementById('pauseBtn');
  if (cancelBtn) { cancelBtn.disabled = true; cancelBtn.innerHTML = '&#8987; 停止中...'; }
  if (pauseBtn) pauseBtn.style.display = 'none';
  setText('progressLabel', '⏳ 正在停止任务...');
  // FIX (v3.3.5): Add 5-second timeout to the cancel request.
  // If the backend takes too long (e.g. proc.kill/proc.wait stuck),
  // abort the fetch. Polling will still detect the 'cancelled' status
  // and reset the UI — we don't need to wait for the cancel response.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);
  try {
    await fetch(`/api/cancel/${jobId}`, {method: 'POST', signal: controller.signal});
  } catch (e) {
    // Even if the request fails or times out, the polling will detect the final state
    console.error('Cancel request failed:', e);
    // FIX (v3.13.2 P1-6): 请求超时/失败且后端未实际取消时，必须恢复取消按钮
    // 与暂停按钮 —— 否则没有任何代码复位它们，用户直到任务自然结束前都
    // 失去取消能力。若取消其实已生效，轮询会在 500ms 内检测到终态并收尾。
    if (isJobRunning()) {
      if (cancelBtn) { cancelBtn.disabled = false; cancelBtn.innerHTML = '&#9209; 取消'; }
      if (pauseBtn) pauseBtn.style.display = '';
      updatePauseButtonUI();
      setText('progressLabel', ActiveJob.type === 'metadata' ? '应用中...' : '转换中...');
    }
  } finally {
    clearTimeout(timeoutId);
  }
  // Buttons will be fully hidden when polling detects 'cancelled' status
}


let isPaused = false;

let _pauseToggleLock = false;

async function togglePause() {
  if (!jobId || _pauseToggleLock) return;
  _pauseToggleLock = true;
  // Optimistic UI update for instant feedback
  const newPaused = !isPaused;
  isPaused = newPaused;
  updatePauseButtonUI();
  // 立即更新进度标签（标签文案随任务类型区分）
  if (newPaused) {
    setText('progressLabel', '⏸ 已暂停');
  } else {
    setText('progressLabel', ActiveJob.type === 'metadata' ? '应用中...' : '转换中...');
  }
  try {
    if (newPaused) {
      await fetch(`/api/pause/${jobId}`, {method: 'POST'});
    } else {
      await fetch(`/api/resume/${jobId}`, {method: 'POST'});
    }
  } catch (e) {
    // Revert on error
    isPaused = !newPaused;
    updatePauseButtonUI();
    console.error('Pause/resume request failed:', e);
  }
  _pauseToggleLock = false;
}


function updatePauseButtonUI() {
  const pauseBtn = document.getElementById('pauseBtn');
  const label = isPaused ? '&#9654; 恢复' : '&#9208; 暂停';
  if (pauseBtn) pauseBtn.innerHTML = label;
}


async function skipItem(idx) {
  if (!jobId) return;
  await fetch(`/api/item/${jobId}/${idx}/skip`, {method: 'POST'});
}


// ══ 任务调度控制器（v3.11.0 重构）══════════════════════════════
// 改造前的三处缺陷：
//  ① pollStatus 先在此处定义，又在文件后半被整体覆盖赋值
//     （`const _origPollStatus = pollStatus` 保存后从未被调用）→ 原实现沦为死代码；
//  ② jobId / pollTimer 是裸全局单例，而 startConversion() 只禁用 #startBtn、
//     startMetadataApply() 只禁用 #metaApplyBtn —— 元数据任务运行期间「开始转换」
//     仍可点击，新任务覆盖 jobId，导致前一任务的轮询被夺走、进度永久冻结；
//  ③ 覆盖版每个 500ms 周期同时写编码与元数据两套进度 DOM，其中一套必然不可见
//     （即每秒 12 次无效 DOM 写入）。
// 现改为显式控制器 + 按任务类型分派的渲染器。
const POLL_INTERVAL_MS = 500;

const ActiveJob = {
  id: null,
  type: null,     // 'encode' | 'metadata'
  timer: null,
};

const PRIMARY_BTN_IDS = ['startBtn', 'metaApplyBtn'];

function setPrimaryButtonsEnabled(enabled) {
  PRIMARY_BTN_IDS.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = !enabled;
  });
}

function isJobRunning() { return !!(ActiveJob.id && ActiveJob.timer); }

// 启动任务后调用；返回 false 表示被拒绝（已有任务进行中）
function beginJob(id, type) {
  if (isJobRunning()) {
    showToast('已有任务正在运行，请先取消或等待完成后再启动新任务', 'error');
    return false;
  }
  ActiveJob.id = id;
  ActiveJob.type = type;
  jobId = id;
  lastLogCount = 0;                 // 新任务重置增量日志计数器
  setPrimaryButtonsEnabled(false);  // 两个主按钮同时禁用，杜绝并发启动
  if (ActiveJob.timer) clearInterval(ActiveJob.timer);
  ActiveJob.timer = setInterval(pollActiveJob, POLL_INTERVAL_MS);
  pollTimer = ActiveJob.timer;      // 兼容镜像
  return true;
}

function endJob() {
  if (ActiveJob.timer) { clearInterval(ActiveJob.timer); ActiveJob.timer = null; }
  pollTimer = null;
  ActiveJob.id = null;
  ActiveJob.type = null;
  jobId = null;
  setPrimaryButtonsEnabled(true);
}

// 任务启动时统一复位按钮与进度显示。
// 改造前 startConversion 与 startMetadataApply 各自维护一份镜像复位逻辑（约 20 行 ×2），
// 而 startVR3D 完全缺失这段代码 → VR3D 任务运行时不显示暂停按钮。现统一为单一入口。
function resetJobButtons() {
  const cancelBtn = document.getElementById('cancelBtn');
  if (cancelBtn) { cancelBtn.disabled = false; cancelBtn.innerHTML = '&#9209; 取消'; cancelBtn.style.display = ''; }
  const pauseBtn = document.getElementById('pauseBtn');
  if (pauseBtn) { pauseBtn.disabled = false; pauseBtn.style.display = ''; }
  updatePauseButtonUI();
  const exportLogBtn = document.getElementById('exportLogBtn');
  if (exportLogBtn) exportLogBtn.style.display = '';
  const timeInfo = document.getElementById('encodeTimeInfo');
  if (timeInfo) { timeInfo.style.display = 'none'; timeInfo.classList.remove('success'); }
  const prog = document.getElementById('overallProgress');
  if (prog) prog.classList.remove('success');
}

// 兼容既有调用点（startVR3D / startConversion / startMetadataApply）
function startPolling() {
  if (!ActiveJob.id) return;
  if (ActiveJob.timer) clearInterval(ActiveJob.timer);
  ActiveJob.timer = setInterval(pollActiveJob, POLL_INTERVAL_MS);
  pollTimer = ActiveJob.timer;
}

function stopPolling() { endJob(); }


// ── 状态获取与按类型分派 ────────────────────────────

async function fetchJobStatus(id) {
  const r = await fetch(`/api/status/${id}`);
  return r.json();
}

async function pollActiveJob() {
  if (!ActiveJob.id) return;
  let data;
  try {
    data = await fetchJobStatus(ActiveJob.id);
  } catch (e) {
    return;   // 网络抖动：保留任务状态，下一周期重试
  }
  if (!data || data.error) { endJob(); return; }

  const nowSec = Date.now() / 1000;

  renderProgressBars(data);
  renderCommonStatus(data, nowSec);
  if (ActiveJob.type === 'metadata') renderMetadataJob(data, nowSec);
  else renderEncodeJob(data, nowSec);

  if (data.status === 'completed' || data.status === 'cancelled' || data.status === 'failed') {
    renderJobCompletion(data, nowSec);
    endJob();
  }
}


// ── 渲染器：进度条（编码与元数据共用同一套 DOM）────────

function renderProgressBars(data) {
  setStyle('overallProgress', 'width', `${data.overall_progress}%`);
  setText('progressPercent', `${Math.round(data.overall_progress)}%`);
  setStyle('fileProgress', 'width', `${data.file_progress}%`);
  setText('fileProgressPercent', `${Math.round(data.file_progress)}%`);
}


// ── 渲染器：公共部分（合并阶段标签 / 暂停态 / 增量日志 / 耗时）──

function renderCommonStatus(data, nowSec) {
  const ms = data.merge_status;

  if (ms && ms.phase === 'merging' && data.status === 'running' && !isPaused) {
    // 合并预处理阶段的文案（合并模式专用，编码/元数据共用同一标签位）
    const fi = ms.current_file_index || 0;
    const fn = ms.current_file_name || '';
    const totalFiles = ms.total_files || 0;
    const elapsed = ms.elapsed_time || 0;
    const totalDur = ms.total_duration || 0;
    const totalGb = ms.total_gb || 0;

    let mergeText = '🔗 合并预处理中';
    if (totalFiles > 0) mergeText += ` (${fi + 1}/${totalFiles})`;
    if (fn) mergeText += `：${fn}`;
    if (totalDur > 0) {
      mergeText += `，已用 ${fmtTime(elapsed)}/${fmtTime(totalDur)}`;
      const remaining = Math.max(0, totalDur - elapsed);
      if (remaining > 0 && elapsed > 1) mergeText += `，预计还需 ${fmtTime(remaining)}`;
    } else if (totalGb > 0) {
      mergeText += `，数据量 ${totalGb} GB`;
    }
    mergeText += '，完成后开始编码';

    setText('progressLabel', mergeText);
    setText('currentFileLabel', totalFiles > 0
      ? `🔗 合并 ${fi + 1}/${totalFiles}: ${fn}`
      : '🔗 合并中...');
  } else if (data.current_input) {
    const fname = data.current_input.split(/[\/\\]/).pop();
    setText('currentFileLabel', `[${data.current_index + 1}/${data.total}] ${fname}`);
    // 从合并阶段切回编码阶段时，重置进度标签文案
    const lbl = document.getElementById('progressLabel');
    if (lbl && data.status === 'running' && !isPaused && lbl.textContent.startsWith('🔗')) {
      lbl.textContent = ActiveJob.type === 'metadata' ? '应用中...' : '转换中...';
    }
  }

  // 暂停态以服务端为准
  if (data.paused !== undefined) {
    isPaused = data.paused;
    updatePauseButtonUI();
    if (isPaused && data.status === 'running') setText('progressLabel', '⏸ 已暂停');
  }

  appendLogLines(data.log || []);
  updateTimeInfo(data, nowSec);
}


// ── 渲染器：增量日志追加 ────────────────────────────
// 改造前同一段实现被逐字符复制了两份（原死代码版 + 覆盖版）。
// 用 lastLogCount 跟踪已渲染条数；日志被重置时全量重建，否则仅追加新条目。
function appendLogLines(log) {
  const logBox = document.getElementById('logBox');
  if (!logBox) return;
  const total = log.length;

  if (total < lastLogCount) {
    // 日志被重置（新任务或清空）→ 全量重建
    logBox.innerHTML = log.slice(-100).map(l =>
      `<div class="log-line"><span class="log-ts">${esc(l.ts)}</span>` +
      `<span class="log-msg ${esc(l.level)}">${esc(l.msg)}</span></div>`
    ).join('');
  } else if (total > lastLogCount) {
    // 仅追加新条目（DocumentFragment 批量插入，避免逐条 reflow）
    const frag = document.createDocumentFragment();
    for (const l of log.slice(lastLogCount)) {
      const div = document.createElement('div');
      div.className = 'log-line';
      const ts = document.createElement('span');
      ts.className = 'log-ts';
      ts.textContent = l.ts;
      const msg = document.createElement('span');
      msg.className = `log-msg ${l.level}`;
      msg.textContent = l.msg;
      div.appendChild(ts);
      div.appendChild(msg);
      frag.appendChild(div);
    }
    logBox.appendChild(frag);
    while (logBox.children.length > 100) logBox.removeChild(logBox.firstChild);
  }

  lastLogCount = total;
  logBox.scrollTop = logBox.scrollHeight;
}


// ── 渲染器：编码任务专属（批量任务表逐行状态）──────────

function renderEncodeJob(data, nowSec) {
  if (currentMode !== 'batch') return;
  if (!_encodeProcessingIndices.length || !data.items) return;
  const tbody = document.getElementById('batchTableBody');
  if (!tbody) return;
  // FIX (v3.13.2 P0-4): data.items holds only the CHECKED tasks while
  // tbody.rows is the full table — indexing rows by backend item position
  // misaligned every row after any task was unchecked (status/time/skip
  // buttons all applied to the wrong file). Map rows via
  // _encodeProcessingIndices; `i` stays the backend index because
  // renderItemStatus compares it with data.current_index and the skip API
  // consumes backend item indexes.
  data.items.forEach((item, i) => {
    const row = tbody.rows[_encodeProcessingIndices[i]];
    if (!row) return;
    renderItemStatus(row.cells[7], row.cells[9], item, i, data, isPaused);
    updateItemTimeInfo(row, item, i, data, nowSec);
  });
}


// ── 渲染器：元数据任务专属（批量列表状态映射）──────────
// 后端只返回被提交的条目，需通过 _metaProcessingIndices 映射回前端行索引
function renderMetadataJob(data) {
  if (!_metaProcessingIndices.length || !data.items) return;
  let tableChanged = false;
  _metaProcessingIndices.forEach((origIdx, i) => {
    const item = data.items[i];
    if (!item || !metaBatchItems[origIdx]) return;
    const f = metaBatchItems[origIdx];
    const oldStatus = f.status;
    if (i === data.current_index && data.status === 'running') {
      f.status = 'processing';
    } else if (item.ok === true) {
      f.status = 'done';
      if (item.start_time && item.end_time) f.duration = fmtTime(item.end_time - item.start_time);
    } else if (item.ok === false) {
      f.status = 'error';
      f.statusMsg = item.error || '失败';
    }
    if (f.status !== oldStatus) tableChanged = true;
  });
  // 仅在状态实际变化时重渲染，避免 spinner 闪烁
  if (tableChanged) renderMetaBatchTable();
}


// ── 渲染器：任务结束（按钮复位 + 终态标签 + 元数据表收尾）──

function renderJobCompletion(data, nowSec) {
  // FIX (v3.13.2 P1-4): endJob() 尚未执行（pollActiveJob 中顺序在此之后），
  // 此刻 ActiveJob.id 仍有效 —— 缓存下来供「导出编码日志」使用。
  if (ActiveJob.id) lastCompletedJobId = ActiveJob.id;
  const cancelBtn = document.getElementById('cancelBtn');
  if (cancelBtn) { cancelBtn.disabled = false; cancelBtn.innerHTML = '&#9209; 取消'; cancelBtn.style.display = 'none'; }
  const pauseBtn = document.getElementById('pauseBtn');
  if (pauseBtn) { pauseBtn.disabled = false; pauseBtn.style.display = 'none'; }
  isPaused = false;

  const completedLabel = data.status === 'completed' ? '&#9989; 全部完成'
    : data.status === 'failed' ? '&#10060; 有失败项'
    : '&#9209; 已取消';
  setHTML('progressLabel', completedLabel);
  addClass('overallProgress', 'success');

  // 元数据批量表收尾渲染，捕获可能遗漏的状态更新
  if (_metaProcessingIndices.length && data.items) {
    _metaProcessingIndices.forEach((origIdx, i) => {
      const item = data.items[i];
      if (!item || !metaBatchItems[origIdx]) return;
      const f = metaBatchItems[origIdx];
      if (item.ok === true) {
        f.status = 'done';
        if (item.start_time && item.end_time) f.duration = fmtTime(item.end_time - item.start_time);
      } else if (item.ok === false) {
        f.status = 'error';
        f.statusMsg = item.error || '失败';
      } else if (item.skipped) {
        f.status = 'error';
        f.statusMsg = '已跳过';
      }
    });
    renderMetaBatchTable();
    _metaProcessingIndices = [];
  }

  if (data.file_progress >= 100) setStyle('fileProgress', 'width', '100%');
  updateTimeInfo(data, nowSec);
}

// ── System Resource Monitor (always-on independent poller) ──

let sysmonTimer = null;


function startSysMonPolling() {
  if (sysmonTimer) clearInterval(sysmonTimer);
  // Poll immediately, then every 2 seconds
  pollSysMon();
  sysmonTimer = setInterval(pollSysMon, 2000);
}


async function pollSysMon() {
  try {
    const r = await fetch('/api/sysmon');
    const sm = await r.json();
    updateSysMon(sm);
  } catch (e) {
    // Silently ignore — will retry next interval
  }
}


function updateSysMon(sm) {
  const card = document.getElementById('sysmonCard');
  if (!sm || Object.keys(sm).length === 0) {
    if (card) card.style.display = 'none';
    return;
  }
  if (card) card.style.display = '';

  // CPU
  const cpuVal = sm.cpu_percent;
  if (cpuVal != null) {
    document.getElementById('smCpuVal').textContent = Math.round(cpuVal);
    document.getElementById('smCpuBar').style.width = `${Math.min(100, cpuVal)}%`;
    const coreCount = sm.cpu_count || 0;
    document.getElementById('smCpuSub').textContent = coreCount > 0 ? `${coreCount} 核心` : '';
  }

  // GPU
  const gpuVal = sm.gpu_percent;
  if (gpuVal != null) {
    document.getElementById('smGpuVal').textContent = Math.round(gpuVal);
    document.getElementById('smGpuBar').style.width = `${Math.min(100, gpuVal)}%`;
    let parts = [];
    if (sm.gpu_enc_percent != null) parts.push(`ENC ${sm.gpu_enc_percent}%`);
    if (sm.gpu_temp != null) parts.push(`${sm.gpu_temp}°C`);
    if (sm.gpu_mem_used_mb != null && sm.gpu_mem_total_mb != null) {
      parts.push(`${Math.round(sm.gpu_mem_used_mb)}/${Math.round(sm.gpu_mem_total_mb)}MB`);
    }
    document.getElementById('smGpuSub').textContent = parts.join(' ') || (sm.gpu_name || '');
  } else {
    // No GPU utilization data (no NVIDIA GPU or pynvml unavailable)
    document.getElementById('smGpuVal').textContent = 'N/A';
    document.getElementById('smGpuBar').style.width = '0%';
    const gpuName = sm.gpu_name;
    if (gpuName) {
      // Show detected GPU name (truncated if too long)
      const displayName = gpuName.length > 25 ? gpuName.substring(0, 23) + '...' : gpuName;
      document.getElementById('smGpuSub').textContent = displayName;
    } else {
      document.getElementById('smGpuSub').textContent = '无独立显卡';
    }
  }

  // Memory
  const memVal = sm.mem_percent;
  if (memVal != null) {
    document.getElementById('smMemVal').textContent = Math.round(memVal);
    document.getElementById('smMemBar').style.width = `${memVal}%`;
    document.getElementById('smMemSub').textContent =
      `${sm.mem_used_gb || '--'} / ${sm.mem_total_gb || '--'} GB`;
  }

  // Disk
  const rd = sm.disk_read_mbs;
  const wr = sm.disk_write_mbs;
  if (rd != null || wr != null) {
    const total = (rd || 0) + (wr || 0);
    document.getElementById('smDiskVal').textContent = total.toFixed(1);
    document.getElementById('smDiskBar').style.width = `${Math.min(100, total / 5)}%`;
    document.getElementById('smDiskSub').textContent =
      `R ${rd != null ? rd.toFixed(1) : '--'}  W ${wr != null ? wr.toFixed(1) : '--'}`;
  }

  // Network
  const up = sm.net_up_mbs;
  const dn = sm.net_down_mbs;
  if (up != null || dn != null) {
    const total = (up || 0) + (dn || 0);
    document.getElementById('smNetVal').textContent = total.toFixed(2);
    document.getElementById('smNetBar').style.width = `${Math.min(100, total * 20)}%`;
    document.getElementById('smNetSub').textContent =
      `↓ ${dn != null ? dn.toFixed(2) : '--'}  ↑ ${up != null ? up.toFixed(2) : '--'}`;
  }
}


async function startMetadataApply() {
  // Build global default params from the toggle card.
  // m_* 部分统一走 collectMetaSettings('m')（与 50-meta.js 的 getDefaultMetaSettings 同源，
  // 消除原先两处各写一份、改一处漏一处的隐患）；faststart 是本流程的额外硬编码字段，保留。
  const globalParams = {
    ...collectMetaSettings('m'),
    faststart: true,
  };

  let items = [];
  const selectedFiles = metaBatchItems.filter(f => f.selected);

  if (selectedFiles.length > 0) {
    // Batch mode: send per-item params from each file's settings
    const outDir = document.getElementById('metaBatchOutDir').value.trim();
    _metaProcessingIndices = [];
    items = [];
    let hasAnyFeature = false;
    metaBatchItems.forEach((f, i) => {
      if (f.selected) {
        _metaProcessingIndices.push(i);
        // Use per-file settings if available, otherwise use global params
        const itemParams = f.settings || globalParams;
        // Check if at least one feature is enabled for this file
        if (itemParams.apply_date || itemParams.apply_location || itemParams.apply_spherical) {
          hasAnyFeature = true;
        }
        items.push({
          input: f.path,
          output: outDir ? `${outDir}\\${f.name}` : f.path,
          params: itemParams
        });
        f.status = 'pending';
        f.statusMsg = '';
        f.duration = '';
      }
    });
    if (!hasAnyFeature) {
      alert('选中的文件均未启用任何元数据功能，请至少在一个文件中启用一项');
      return;
    }
    renderMetaBatchTable();
  } else {
    // Single file mode: process the file in the input field with global params
    const inp = document.getElementById('metaInput').value.trim();
    if (!inp) { alert('请选择视频文件，或将文件加入批量列表'); return; }
    if (!globalParams.apply_date && !globalParams.apply_location && !globalParams.apply_spherical) {
      alert('请至少选择一个元数据功能'); return;
    }
    const outDir = document.getElementById('metaBatchOutDir').value.trim();
    const name = inp.split(/[\/\\]/).pop();
    items = [{input: inp, output: outDir ? `${outDir}\\${name}` : inp}];
  }

  const r = await fetch('/api/apply_metadata', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({params: globalParams, items})
  });
  const data = await r.json();
  if (data.error) { alert(data.error); return; }

  if (!beginJob(data.job_id, 'metadata')) return;
  isPaused = false;
  resetJobButtons();
  setText('progressLabel', '应用中...');
}

// ── 已删除：pollStatus 覆盖式补丁（v3.11.0）──────────────────
// 原代码在此处执行：
//     const _origPollStatus = pollStatus;   ← 保存后从未调用（死变量）
//     pollStatus = async function() { ... } ← 直接重写函数引用，遮蔽上方原实现
// 后果：上方原 pollStatus 成为不可达死代码；且覆盖版每个轮询周期同时写
// 编码与元数据两套进度 DOM，其中一套必然不可见。
//
// 现已在文件前部（任务调度控制器一节）改为显式设计：
//     ActiveJob 控制器（beginJob / endJob）+ 单一 pollActiveJob
//     + renderProgressBars / renderCommonStatus / renderEncodeJob / renderMetadataJob
// 按 ActiveJob.type 分派渲染，每类渲染只写自己那套 DOM。

// ── Metadata Report ──────────────────────────────────

function updateTimeInfo(data, nowSec) {
  // 单一时间信息区。改造前有 encode*/meta* 两套（按 prefix 参数选择 DOM），
  // 操作栏合并后统一使用 encode 前缀的那一套 id。
  const timeInfo = document.getElementById('encodeTimeInfo');
  if (!timeInfo) return;
  const startTime = data.start_time;
  const endTime = data.end_time;
  if (!startTime) { timeInfo.style.display = 'none'; return; }

  const elEl = document.getElementById('encodeElapsed');
  const remEl = document.getElementById('encodeRemaining');
  const totEl = document.getElementById('encodeTotal');

  // 任务已结束：显示实际总耗时
  if (endTime && (data.status === 'completed' || data.status === 'cancelled' || data.status === 'failed')) {
    const total = endTime - startTime;
    if (elEl) elEl.textContent = fmtTime(total);
    if (remEl) remEl.textContent = '已完成';
    if (totEl) totEl.textContent = fmtTime(total);
    timeInfo.style.display = 'flex';
    return;
  }

  // 运行中：估算剩余时间
  const est = calcTimeEstimates(startTime, data.overall_progress || 0, nowSec);
  if (!est) {
    if (elEl) elEl.textContent = fmtTime(nowSec - startTime);
    if (remEl) remEl.textContent = '计算中...';
    if (totEl) totEl.textContent = '计算中...';
    timeInfo.style.display = 'flex';
    return;
  }

  if (elEl) elEl.textContent = fmtTime(est.elapsed);
  if (remEl) remEl.textContent = fmtTime(est.remaining);
  if (totEl) totEl.textContent = fmtTime(est.total);
  timeInfo.style.display = 'flex';
}


function updateItemTimeInfo(row, item, itemIndex, data, nowSec) {
  // Update the time cell for a batch item (index 8 after the 参数 column was added)
  const timeCell = row.cells[8];
  if (!timeCell) return;

  // FIX: 只有未真正执行（无 start_time）的跳过才显示"跳过"；
  // 已开始执行的任务（即使被标记 skipped）按实际结果渲染，避免最后任务失败后仍显示"跳过"。
  if (item.skipped && !item.start_time) {
    timeCell.innerHTML = '<span style="color:var(--text-muted);">跳过</span>';
    return;
  }

  // Completed item: show actual elapsed
  if (item.start_time && item.end_time) {
    const elapsed = item.end_time - item.start_time;
    const color = item.ok === false ? 'var(--error)' : 'var(--success)';
    timeCell.innerHTML = `<span style="color:${color};">${fmtTime(elapsed)}</span>`;
    return;
  }

  // Failed item without end_time: show elapsed until now
  if (item.start_time && item.ok === false) {
    const elapsed = (item.end_time || nowSec) - item.start_time;
    timeCell.innerHTML = `<span style="color:var(--error);">${fmtTime(elapsed)}</span>`;
    return;
  }

  // Currently running item
  if (item.start_time && !item.end_time) {
    const elapsed = nowSec - item.start_time;
    const isCurrent = (itemIndex === data.current_index);
    const fileProg = isCurrent ? data.file_progress : 0;
    const est = calcTimeEstimates(item.start_time, fileProg, nowSec);
    if (est && fileProg > 0) {
      timeCell.innerHTML = `<span style="color:var(--accent);">${fmtTime(elapsed)}</span><br><small style="color:var(--text-muted);">余 ${fmtTime(est.remaining)}</small>`;
    } else {
      timeCell.innerHTML = `<span style="color:var(--accent);">${fmtTime(elapsed)}</span>`;
    }
    return;
  }

  // Pending item
  timeCell.innerHTML = '<span style="color:var(--text-muted);">&mdash;</span>';
}

// Shared: render a single batch item's status cell + (optionally) the skip button.
// FIX (last-item bug): when the job is in a terminal state (completed/failed/cancelled),
// every item must show its final state — including the LAST item, which previously
// fell through to the "pending" branch because its index equals current_index while
// the job is no longer 'running'.

function renderItemStatus(cell, actionCell, item, i, data, isPaused) {
  if (!cell) return;
  const terminal = (data.status === 'completed' || data.status === 'failed' || data.status === 'cancelled');
  let html, showSkip = false;
  // FIX: 只有未真正执行（无 start_time）的跳过才显示"跳过"；
  // 已开始执行的跳过（ffmpeg 继续跑完/失败）按实际结果渲染。
  if (item.skipped && !item.start_time) {
    html = '<span class="status-dot" style="background:var(--text-muted);"></span> 跳过';
  } else if (terminal) {
    if (item.ok === false) {
      const errMsg = esc(item.error || '失败');
      const shortErr = errMsg.length > 20 ? errMsg.substring(0, 20) + '...' : errMsg;
      html = `<span class="status-dot status-fail"></span> <span style="color:var(--error);cursor:help;" title="${errMsg}">${shortErr}</span>`;
    } else {
      html = '<span class="status-dot status-done"></span> &#10003;';
    }
  } else if (i < data.current_index) {
    if (item.ok === false) {
      const errMsg = esc(item.error || '失败');
      const shortErr = errMsg.length > 20 ? errMsg.substring(0, 20) + '...' : errMsg;
      html = `<span class="status-dot status-fail"></span> <span style="color:var(--error);cursor:help;" title="${errMsg}">${shortErr}</span>`;
    } else {
      html = '<span class="status-dot status-done"></span> &#10003;';
    }
  } else if (i === data.current_index && data.status === 'running') {
    html = `<span class="status-dot status-running"></span> ${Math.round(data.file_progress)}%`;
    showSkip = !isPaused;
  } else {
    html = '<span class="status-dot status-pending"></span>';
    showSkip = (data.status === 'running');
  }
  cell.innerHTML = html;
  if (actionCell) {
    actionCell.innerHTML = showSkip
      ? `<button class="btn btn-sm btn-warning" data-action="skip-item" data-idx="${i}">跳过</button>`
      : '';
  }
}


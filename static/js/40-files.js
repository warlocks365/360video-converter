// ============================================================
//   40-files.js — 目录扫描 / 批量任务表 / 合并表 / 任务持久化
//   由 static/index.html 内联脚本拆分而来（整块切分，零行为变更）
// ============================================================

async function saveCurrentTasks() {
  if (batchTasks.length === 0) { alert('当前没有任务可保存'); return; }
  // v3.5.0: Use native file save dialog (same as encoding output save)
  // This lets the user choose the exact save path, replacing the old
  // browser-download approach.
  let savePath = '';
  try {
    const dr = await fetch('/api/native_dialog', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        type: 'save_file',
        title: '保存任务列表到文件',
        file_filter: 'json',
        default_name: '360VideoConverter_任务列表.json',
        path_type: 'save'
      })
    });
    const dd = await dr.json();
    if (dd.error) { alert('打开保存对话框失败: ' + dd.error); return; }
    savePath = dd.path;
    if (!savePath) return;  // User cancelled
  } catch(e) { alert('打开保存对话框失败: ' + e.message); return; }

  const params = collectParams();
  const outMode = document.querySelector('input[name="batchOutMode"]:checked')?.value || 'unified';
  const items = batchTasks.map(t => ({
    input: t.path,
    output: t.output || t.custom_output || '',
    name: t.name,
    custom_output: t.custom_output || '',
    is_merge: t.is_merge || false,
    inputs: t.inputs || null,
    is_manual: t.is_manual || false,
    size_mb: t.size_mb,
    size_str: t.size_str,
    dir: t.dir,
    date_in_name: t.date_in_name,
    // Per-task export params + output config (task-list-centric)
    params: t.params || params,
    out_mode: t.out_mode || outMode,
    out_dir: t.out_dir || '',
    formula: t.formula || '',
    project_dir: t.project_dir || ''
  }));
  const data = {
    mode: 'batch',
    items: items,
    params: params,
    batch_formula: document.getElementById('batchFormula')?.value || '',
    batch_out_dir: document.getElementById('batchOutDir')?.value || '',
    project_dir: document.getElementById('projectDir')?.value || '',
    path: savePath  // v3.5.0: custom save path
  };
  try {
    const r = await fetch('/api/tasks/save', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(data)
    });
    const result = await r.json();
    if (result.ok) {
      showToast(`任务已保存到: ${savePath} (${batchTasks.length} 个文件)`, 'success');
    } else {
      alert('保存失败: ' + (result.error || '未知错误'));
    }
  } catch(e) {
    alert('保存失败: ' + e.message);
  }
}


async function loadSavedTasks() {
  // v3.5.0: Use native file open dialog (same as encoding file open)
  let loadPath = '';
  try {
    const dr = await fetch('/api/native_dialog', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        type: 'open_file',
        title: '选择要加载的任务列表文件',
        file_filter: 'json',
        path_type: 'open'
      })
    });
    const dd = await dr.json();
    if (dd.error) { alert('打开文件对话框失败: ' + dd.error); return; }
    loadPath = dd.path;
    if (!loadPath) return;  // User cancelled
  } catch(e) { alert('打开文件对话框失败: ' + e.message); return; }

  try {
    const r = await fetch('/api/tasks/load_file', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({path: loadPath})
    });
    if (!r.ok) {
      const err = await r.json();
      alert('加载失败: ' + (err.error || ''));
      return;
    }
    const data = await r.json();
    if (!data.items || data.items.length === 0) {
      alert('文件中的任务为空');
      return;
    }
    // Confirm replace if current list is non-empty
    if (batchTasks.length > 0) {
      if (!confirm(`当前已有 ${batchTasks.length} 个任务，加载将替换现有列表。是否继续？`)) return;
    }
    // Restore task list from saved items (each carries its own params + output config)
    batchTasks = data.items.map(item => {
      const path = item.input || item.path || '';
      const name = item.name || path.split(/[\/\\]/).pop() || '';
      const dir = item.dir || path.split(/[\/\\]/).slice(0, -1).join('\\');
      return {
        path: path,
        name: name,
        dir: dir,
        size_str: item.size_str || null,
        size_mb: item.size_mb || 0,
        date_in_name: item.date_in_name || null,
        is_merge: item.is_merge || false,
        inputs: item.inputs || null,
        is_manual: item.is_manual || false,
        custom_output: item.custom_output || '',
        params: item.params || {},
        out_mode: item.out_mode || 'unified',
        out_dir: item.out_dir || '',
        formula: item.formula || '',
        project_dir: item.project_dir || '',
        output: item.output || item.custom_output || '',
        skipped: false, ok: null, error: null
      };
    });
    // Re-extract dates if missing
    for (const t of batchTasks) {
      if (!t.date_in_name && t.name) {
        try {
          const dr2 = await fetch('/api/extract_date', {
            method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify({filename: t.name})
          });
          const d = await dr2.json();
          t.date_in_name = d.date_str;
        } catch(e) {}
      }
    }
    // Restore global output defaults (used for NEW tasks) from the saved file
    if (data.params) {
      applyParams({...DEFAULT_PARAMS, ...data.params});
    }
    if (data.batch_formula) document.getElementById('batchFormula').value = data.batch_formula;
    if (data.batch_out_dir) document.getElementById('batchOutDir').value = data.batch_out_dir;
    if (data.project_dir) document.getElementById('projectDir').value = data.project_dir;
    // Set global output-mode radio to the first non-manual task's mode (no bulk-apply)
    const firstMode = batchTasks.find(t => !t.custom_output)?.out_mode || 'unified';
    const radio = document.querySelector(`input[name="batchOutMode"][value="${firstMode}"]`);
    if (radio) radio.checked = true;
    document.getElementById('unifiedOutput').classList.toggle('hidden', firstMode !== 'unified');
    document.getElementById('formulaOutput').classList.toggle('hidden', firstMode !== 'formula');
    document.getElementById('scanCount').textContent = `${batchTasks.length} 个文件`;
    await recomputeOutputs();
    showToast(`已加载 ${batchTasks.length} 个文件的任务列表`, 'success');
  } catch(e) {
    alert('加载失败: ' + e.message);
  }
}

// ── Export/Import Task List to File (v3.3.5) ───────
// v3.5.0: saveCurrentTasks/loadSavedTasks now use native file dialogs.
// exportTasksToFile/importTasksFromFile are kept as aliases for backward compat.

function exportTasksToFile() { saveCurrentTasks(); }

async function importTasksFromFile() { await loadSavedTasks(); }

// v3.5.0: Silent auto-load from default file (for startup auto-load setting)

async function autoLoadTasks() {
  try {
    const r = await fetch('/api/tasks/load');
    if (!r.ok) return;  // No saved tasks — silent
    const data = await r.json();
    if (!data.items || data.items.length === 0) return;
    // Restore task list from saved items
    batchTasks = data.items.map(item => {
      const path = item.input || item.path || '';
      const name = item.name || path.split(/[\/\\]/).pop() || '';
      const dir = item.dir || path.split(/[\/\\]/).slice(0, -1).join('\\');
      return {
        path: path, name: name, dir: dir,
        size_str: item.size_str || null, size_mb: item.size_mb || 0,
        date_in_name: item.date_in_name || null,
        is_merge: item.is_merge || false, inputs: item.inputs || null,
        is_manual: item.is_manual || false,
        custom_output: item.custom_output || '',
        params: item.params || {},
        out_mode: item.out_mode || 'unified', out_dir: item.out_dir || '',
        formula: item.formula || '', project_dir: item.project_dir || '',
        output: item.output || item.custom_output || '',
        skipped: false, ok: null, error: null
      };
    });
    if (data.params) applyParams({...DEFAULT_PARAMS, ...data.params});
    if (data.batch_formula) document.getElementById('batchFormula').value = data.batch_formula;
    if (data.batch_out_dir) document.getElementById('batchOutDir').value = data.batch_out_dir;
    if (data.project_dir) document.getElementById('projectDir').value = data.project_dir;
    const firstMode = batchTasks.find(t => !t.custom_output)?.out_mode || 'unified';
    const radio = document.querySelector(`input[name="batchOutMode"][value="${firstMode}"]`);
    if (radio) radio.checked = true;
    document.getElementById('unifiedOutput').classList.toggle('hidden', firstMode !== 'unified');
    document.getElementById('formulaOutput').classList.toggle('hidden', firstMode !== 'formula');
    document.getElementById('scanCount').textContent = `${batchTasks.length} 个文件`;
    await recomputeOutputs();
    console.log(`Auto-loaded ${batchTasks.length} tasks`);
  } catch(e) { console.error('Auto-load failed:', e); }
}


// ── Collect Params from UI ─────────────────────────

function buildTaskConfig() {
  const mode = document.querySelector('input[name="batchOutMode"]:checked')?.value || 'unified';
  return {
    params: JSON.parse(JSON.stringify(collectParams())),
    out_mode: mode,
    out_dir: document.getElementById('batchOutDir')?.value || '',
    formula: document.getElementById('batchFormula')?.value || '',
    project_dir: document.getElementById('projectDir')?.value || '',
  };
}


function makeTask(file, cfg) {
  return {
    path: file.path,
    name: file.name,
    dir: file.dir || '',
    size_str: file.size_str || null,
    size_mb: file.size_mb || 0,
    date_in_name: file.date_in_name || null,
    is_merge: file.is_merge || false,
    inputs: file.inputs || null,
    is_manual: file.is_manual || false,
    custom_output: file.custom_output || '',
    params: JSON.parse(JSON.stringify(cfg.params)),
    out_mode: cfg.out_mode,
    out_dir: cfg.out_dir,
    formula: cfg.formula,
    project_dir: cfg.project_dir,
    output: '',
    skipped: false,
    ok: null,
    error: null
  };
}

// ── Scan Directory -> Candidate List ──────────────

async function scanDirectory() {
  const dir = document.getElementById('batchDir').value.trim();
  if (!dir) { alert('请先选择扫描路径'); return; }
  const r = await fetch('/api/scan', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({directory: dir, recursive: true})
  });
  const data = await r.json();
  const files = data.files || [];
  // Directory import is decoupled from the task list: just collect media candidates.
  const existing = new Set(importCandidates.map(c => c.path));
  let added = 0;
  for (const f of files) {
    if (!existing.has(f.path)) {
      importCandidates.push({
        path: f.path,
        name: f.name,
        dir: f.dir || '',
        size_str: f.size_str || null,
        size_mb: f.size_mb || 0,
        date_in_name: f.date_in_name || null
      });
      added++;
    }
  }
  document.getElementById('scanCountSrc').textContent = `${importCandidates.length} 个媒体`;
  renderImportList();
  if (files.length === 0 && data.message) {
    alert(data.message);
  }
}


function renderImportList() {
  const tbody = document.getElementById('importCandidatesBody');
  if (importCandidates.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-muted)">扫描目录后，遍历到的所有媒体文件将列在此处</td></tr>';
    updateImportCount();
    return;
  }
  tbody.innerHTML = importCandidates.map((c, i) => {
    const escapedPath = (c.dir || '').replace(/</g, '&lt;');
    const dateInName = c.date_in_name ? `<span style="color:var(--success);">&#128197; ${c.date_in_name.split('T')[0]}</span>` : '<span style="color:var(--text-muted);">&mdash;</span>';
    const sizeDisplay = c.size_str || c.size_mb || '--';
    return `<tr>
      <td><input type="checkbox" class="import-check" data-idx="${i}" checked data-action="update-import-count"></td>
      <td>${i+1}</td>
      <td>${c.name}</td>
      <td title="${escapedPath}" style="max-width:320px;overflow:hidden;text-overflow:ellipsis;font-size:0.78rem;color:var(--text-muted);">${escapedPath}</td>
      <td>${sizeDisplay} ${c.size_str ? '' : 'MB'}</td>
      <td>${dateInName}</td>
    </tr>`;
  }).join('');
  updateImportCount();
}


function updateImportCount() {
  const checked = document.querySelectorAll('.import-check:checked').length;
  const el = document.getElementById('importCount');
  if (el) el.textContent = `已选 ${checked} / 共 ${importCandidates.length} 个媒体`;
}


function selectAllImport(checked) {
  document.querySelectorAll('.import-check').forEach(cb => { cb.checked = checked; });
  const sa = document.getElementById('importSelectAll');
  if (sa) sa.checked = checked;
  updateImportCount();
}

// Multi-select candidates -> batch task list (snapshots current encoding + output settings)

async function addSelectedToTasks() {
  const cfg = buildTaskConfig();
  const selected = [];
  importCandidates.forEach((c, i) => {
    const cb = document.querySelector(`.import-check[data-idx="${i}"]`);
    if (cb && cb.checked) selected.push(c);
  });
  if (selected.length === 0) { alert('请先在上方勾选要添加的媒体文件'); return; }
  const existing = new Set(batchTasks.map(t => t.path));
  let added = 0;
  for (const c of selected) {
    if (!existing.has(c.path)) {
      batchTasks.push(makeTask(c, cfg));
      added++;
    }
  }
  document.getElementById('scanCount').textContent = `${batchTasks.length} 个任务`;
  await recomputeOutputs();
  showToast(`已添加 ${added} 个任务（共 ${batchTasks.length} 个）`, 'success');
}


function renderBatchTable() {
  const tbody = document.getElementById('batchTableBody');
  const sc = document.getElementById('scanCount');
  if (sc) sc.textContent = `${batchTasks.length} 个任务`;
  if (batchTasks.length === 0) {
    tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;color:var(--text-muted);">将媒体文件添加到任务后显示任务列表</td></tr>';
    updateQueueCount();
    return;
  }
  tbody.innerHTML = batchTasks.map((t, i) => {
    const escaped = (t.output || '').replace(/</g, '&lt;');
    const dateInName = t.date_in_name ? `<span style="color:var(--success);">&#128197; ${t.date_in_name.split('T')[0]}</span>` : '<span style="color:var(--text-muted);">&mdash;</span>';
    const manualBadge = t.is_manual ? ' <span class="badge badge-accent" style="font-size:0.65rem;padding:1px 6px;">手动</span>' : '';
    const mergeIcon = t.is_merge ? '🔀 ' : '';
    const sizeDisplay = t.size_str || t.size_mb || '--';
    const paramsSummary = summarizeParams(t);
    return `<tr>
      <td><input type="checkbox" class="batch-check" data-idx="${i}" checked data-action="task-check-change"></td>
      <td>${i+1}</td>
      <td title="${t.path}">${mergeIcon}${t.name}${manualBadge}<br><small style="color:var(--text-muted);">${t.dir}</small></td>
      <td>${sizeDisplay} ${t.size_str ? '' : 'MB'}</td>
      <td>${dateInName}</td>
      <td style="max-width:300px;overflow:hidden;text-overflow:ellipsis" title="${escaped}">${escaped || '&mdash;'}</td>
      <td style="font-size:0.72rem;line-height:1.4;">${paramsSummary}</td>
      <td class="status-cell"><span class="status-dot status-pending"></span></td>
      <td class="time-cell" style="font-size:0.75rem;color:var(--text-muted);">&mdash;</td>
      <td><button class="btn btn-sm btn-danger" data-action="remove-batch-item" data-idx="${i}" title="移除">&#10005;</button></td>
    </tr>`;
  }).join('');
  updateQueueCount();
}


function summarizeParams(t) {
  const p = t.params || {};
  const codecMap = {libx264:'H.264', libx265:'H.265', h264_nvenc:'NVENC H.264', hevc_nvenc:'NVENC H.265', h264_qsv:'QSV H.264', hevc_qsv:'QSV H.265', h264_amf:'AMF H.264', hevc_amf:'AMF H.265'};
  const codec = t.custom_output ? '手动' : (codecMap[p.codec] || p.codec || '?');
  const res = p.resolution || '';
  let pano = '';
  if (p.inject_spherical) {
    const pt = p.pano_type || '360';
    const sm = p.stereo_mode || 'mono';
    const ptLabel = pt === '180' ? '180°' : pt === '360' ? '360°' : pt;
    const smLabel = sm === 'mono' ? '单目' : sm === 'left-right' ? '左右' : sm === 'top-bottom' ? '上下' : sm;
    pano = ' · ' + ptLabel + smLabel;
  }
  const test = p.test_duration ? ' · 测试' : '';
  const stab = p.stabilize ? ' · 防抖' : '';
  const insv = p.insv_stitch ? ' · INS' : '';
  const outMode = t.custom_output ? '固定' : (t.out_mode === 'formula' ? '公式' : '统一');
  return `${codec} · ${res} · ${outMode}${pano}${stab}${insv}${test}`;
}


function updateQueueCount() {
  const checked = document.querySelectorAll('.batch-check:checked').length;
  const el = document.getElementById('queueCount');
  if (el) el.textContent = `${checked} 已选`;
}


function selectAllBatch(checked) {
  document.querySelectorAll('.batch-check').forEach(cb => { cb.checked = checked; });
  const selectAll = document.getElementById('batchSelectAll');
  if (selectAll) selectAll.checked = checked;
  updateQueueCount();
}


async function removeBatchItem(idx) {
  batchTasks.splice(idx, 1);
  renderBatchTable();
  await recomputeOutputs();
}


async function removeUnselectedBatch() {
  batchTasks = batchTasks.filter((t, i) => {
    const cb = document.querySelector(`.batch-check[data-idx="${i}"]`);
    return cb && cb.checked;
  });
  renderBatchTable();
  await recomputeOutputs();
}

// When exactly one task is checked, load its config into the encoding panel + output controls

function onTaskCheckChange() {
  updateQueueCount();
  const checked = [...document.querySelectorAll('.batch-check:checked')];
  if (checked.length === 1) {
    const idx = parseInt(checked[0].dataset.idx);
    const t = batchTasks[idx];
    if (t) loadTaskIntoEditor(t);
  }
}


function loadTaskIntoEditor(t) {
  // Encoding params -> the shared encoding panel (no modal)
  applyParams({...DEFAULT_PARAMS, ...(t.params || {})});
  // Output config -> the import-panel "batch param settings"
  if (!t.custom_output) {
    const radio = document.querySelector(`input[name="batchOutMode"][value="${t.out_mode || 'unified'}"]`);
    if (radio) radio.checked = true;
    document.getElementById('batchOutDir').value = t.out_dir || '';
    document.getElementById('batchFormula').value = t.formula || '';
    document.getElementById('projectDir').value = t.project_dir || '';
    toggleBatchOutMode();
  }
}


async function removeSelectedTasks() {
  const checked = [...document.querySelectorAll('.batch-check:checked')];
  if (checked.length === 0) { alert('请先勾选要移除的任务'); return; }
  const idxs = checked.map(cb => parseInt(cb.dataset.idx)).sort((a, b) => b - a);
  for (const i of idxs) batchTasks.splice(i, 1);
  renderBatchTable();
  await recomputeOutputs();
}

// ── Per-task output recompute ─────────────────────

async function recomputeOutputs() {
  // Unified & manual are computed synchronously
  batchTasks.forEach(t => {
    if (t.custom_output) {
      t.output = t.custom_output;
    } else if (t.out_mode === 'unified') {
      t.output = t.out_dir ? `${t.out_dir}\\${t.name}` : '';
    }
  });
  // Formula tasks: group by (formula, project_dir, params) to minimize API calls
  const groups = {};
  batchTasks.forEach(t => {
    if (!t.custom_output && t.out_mode === 'formula') {
      const key = JSON.stringify({f: t.formula, p: t.project_dir, pr: t.params});
      (groups[key] = groups[key] || []).push(t);
    }
  });
  for (const key of Object.keys(groups)) {
    const grp = groups[key];
    try {
      const r = await fetch('/api/preview_formula', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({formula: grp[0].formula, params: grp[0].params, files: grp.map(t => t.path), project_dir: grp[0].project_dir})
      });
      const data = await r.json();
      grp.forEach((t, k) => { t.output = (data.results[k] && data.results[k].output) || ''; });
    } catch(e) {
      grp.forEach(t => { t.output = ''; });
    }
  }
  renderBatchTable();
}

// ── Batch Output Mode (default for NEW tasks) ──────

async function applySettingsToSelected() {
  const checked = [...document.querySelectorAll('.batch-check:checked')];
  if (checked.length === 0) { alert('请先勾选要更新的任务'); return; }
  const params = collectParams();
  const outMode = document.querySelector('input[name="batchOutMode"]:checked')?.value || 'unified';
  const outDir = document.getElementById('batchOutDir')?.value || '';
  const formula = document.getElementById('batchFormula')?.value || '';
  const projectDir = document.getElementById('projectDir')?.value || '';
  let updated = 0;
  for (const cb of checked) {
    const idx = parseInt(cb.dataset.idx);
    const t = batchTasks[idx];
    if (!t) continue;
    t.params = JSON.parse(JSON.stringify(params));
    if (!t.custom_output) {
      t.out_mode = outMode;
      t.out_dir = outDir;
      t.formula = formula;
      t.project_dir = projectDir;
    }
    updated++;
  }
  await recomputeOutputs();
  showToast(`已应用设置到 ${updated} 个任务`, 'success');
}


function insertVar(v) {
  const input = document.getElementById('batchFormula');
  const start = input.selectionStart;
  input.value = input.value.slice(0, start) + v + input.value.slice(input.selectionEnd);
  input.focus();
  input.setSelectionRange(start + v.length, start + v.length);
}

// ── Add to Batch Queue ────────────────────────────────

function addToBatchQueue() {
  const cfg = buildTaskConfig();
  if (currentMode === 'single') {
    const inp = document.getElementById('singleInput').value.trim();
    const out = document.getElementById('singleOutput').value.trim();
    if (!inp) { alert('请先选择源文件'); return; }
    if (!out) { alert('请先选择输出文件路径'); return; }

    const parts = inp.split(/[\\/]/);
    const name = parts.pop();
    const dir = parts.join('\\');

    batchTasks.push(makeTask({
      path: inp, name: name, dir: dir,
      size_str: '--', size_mb: 0, date_in_name: null,
      is_manual: true, custom_output: out
    }, cfg));

    document.getElementById('scanCount').textContent = `${batchTasks.length} 个文件`;
    renderBatchTable();
    showToast(`已添加到批量队列（共 ${batchTasks.length} 项）`, 'success');
    switchMode('batch');

  } else if (currentMode === 'merge') {
    if (mergeFiles.length < 2) { alert('合并转换至少需要选择2个文件'); return; }
    const out = document.getElementById('mergeOutput').value.trim();
    if (!out) { alert('请先选择输出文件路径'); return; }

    const inputPaths = mergeFiles.map(f => f.path);
    const inputNames = mergeFiles.map(f => f.name);
    const displayName = `🔀 合并 ${inputNames.length} 个文件`;

    batchTasks.push(makeTask({
      path: inputPaths[0], name: displayName, dir: inputNames.join(' + '),
      size_str: '--', size_mb: 0, date_in_name: null,
      is_merge: true, inputs: inputPaths, is_manual: true, custom_output: out
    }, cfg));

    document.getElementById('scanCount').textContent = `${batchTasks.length} 个文件`;
    renderBatchTable();
    showToast(`已添加合并任务到批量队列（共 ${batchTasks.length} 项）`, 'success');
    switchMode('batch');
  }
}


let mergeFiles = [];


async function addMergeFiles() {
  // Use the directory of the last added file as initial dir
  let initialDir = '';
  if (mergeFiles.length > 0) {
    const lastPath = mergeFiles[mergeFiles.length - 1].path;
    const parts = lastPath.split(/[\\/]/);
    parts.pop();
    initialDir = parts.join('\\');
  }
  try {
    const r = await fetch('/api/native_dialog', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        type: 'open_files',
        title: '选择要合并的视频文件',
        file_filter: 'video',
        path_type: 'merge',
        initial_dir: initialDir
      })
    });
    const data = await r.json();
    if (data.error) { alert(data.error); return; }
    if (data.paths && data.paths.length > 0) {
      for (const p of data.paths) {
        mergeFiles.push({path: p, name: p.split(/[\\/]/).pop()});
      }
      renderMergeTable();
    }
  } catch(e) {
    alert('打开文件对话框失败: ' + e.message);
  }
}


function renderMergeTable() {
  const tbody = document.getElementById('mergeTableBody');
  if (mergeFiles.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--text-muted);padding:20px;">点击"添加文件"选择要合并的视频</td></tr>';
    return;
  }
  tbody.innerHTML = mergeFiles.map((f, i) => {
    let sizeStr = '';
    // We don't have size info from the dialog, so we'll skip it
    return `<tr>
      <td>${i+1}</td>
      <td title="${esc(f.path)}">${esc(f.name)}<br><small style="color:var(--text-muted);">${esc(f.path)}</small></td>
      <td style="color:var(--text-muted);">--</td>
      <td>
        <button class="btn btn-sm" data-action="move-merge-item" data-idx="${i}" data-dir="-1" title="上移" ${i===0?'disabled':''}>&#8593;</button>
        <button class="btn btn-sm" data-action="move-merge-item" data-idx="${i}" data-dir="1" title="下移" ${i===mergeFiles.length-1?'disabled':''}>&#8595;</button>
        <button class="btn btn-sm btn-danger" data-action="remove-merge-item" data-idx="${i}" title="移除">&#10005;</button>
      </td>
    </tr>`;
  }).join('');
}


function moveMergeItem(idx, dir) {
  const newIdx = idx + dir;
  if (newIdx < 0 || newIdx >= mergeFiles.length) return;
  [mergeFiles[idx], mergeFiles[newIdx]] = [mergeFiles[newIdx], mergeFiles[idx]];
  renderMergeTable();
}


function removeMergeItem(idx) {
  mergeFiles.splice(idx, 1);
  renderMergeTable();
}


function clearMergeList() {
  mergeFiles = [];
  renderMergeTable();
}

// ── VR 3D 360° Synthesis (v3.9.0) ────────────────────

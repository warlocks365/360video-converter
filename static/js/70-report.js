// ============================================================
//   70-report.js — 元数据报告模式
//   由 static/index.html 内联脚本拆分而来（整块切分，零行为变更）
//   v3.x: 新增 moov atom 徽章（C1）/ 批量结果筛选（C2）/
//         多选与全选反选（C3）/ 加入批量转换队列（C4）
// ============================================================

let reportData = []; // Array of {filename, path, probeData, error, moov, size}

// 勾选状态按「文件路径」记录（Set<string>），而非显示索引——
// 这样筛选条件变化导致可见条目增减时，勾选不会丢失
let reportSelectedPaths = new Set();

// 筛选中属于布尔三态（全部/是/否）的字段，其余字段用关键词「包含」匹配
const REPORT_BOOL_FIELDS = ['moov', 'gspherical'];

let reportJobId = null;

let lastReportJobId = null;

// 关键词输入框的 input 监听只挂一次的标记
let reportFilterWired = false;


async function generateReport() {
  const path = (document.getElementById('reportInput').value || '').trim();
  if (!path) { alert('请选择视频文件'); return; }
  await startReportJob({ paths: [path] });
}


async function generateBatchReport() {
  const dir = (document.getElementById('reportBatchDir').value || '').trim();
  if (!dir) { alert('请选择扫描路径'); return; }
  // Scan first (immediate feedback / file count), then probe via a job for a live log.
  let sdata;
  try {
    const sr = await fetch('/api/scan', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({directory: dir, recursive: true})
    });
    sdata = await sr.json();
  } catch(e) {
    alert('扫描失败: ' + e.message);
    return;
  }
  const files = sdata.files || [];
  if (files.length === 0) {
    alert(sdata.message || '未找到视频文件');
    return;
  }
  await startReportJob({ paths: files.map(f => f.path) });
}


async function startReportJob(payload) {
  if (reportJobId) return; // a report job is already running
  const r = await fetch('/api/report', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(payload)
  });
  const d = await r.json();
  if (d.error) { alert(d.error); return; }
  reportJobId = d.job_id;
  lastReportJobId = d.job_id;
  // show live log box + export button
  const box = document.getElementById('reportLogBox');
  box.style.display = '';
  box.innerHTML = '<div class="log-line"><span class="log-ts">--:--:--</span><span class="log-msg info">报告任务已启动...</span></div>';
  document.getElementById('exportReportLogBtn').style.display = '';
  document.getElementById('reportResult').innerHTML = '<div style="padding:20px;text-align:center;"><span class="spinner" style="display:inline-block;vertical-align:middle;margin-right:8px;"></span>正在读取视频元数据... 0%</div>';
  pollReportJob();
}


function pollReportJob() {
  if (!reportJobId) return;
  fetch(`/api/status/${reportJobId}`)
    .then(r => r.json())
    .then(data => {
      if (data.error) { reportJobId = null; return; }
      // live log
      const box = document.getElementById('reportLogBox');
      box.innerHTML = (data.log || []).slice(-100).map(l =>
        `<div class="log-line"><span class="log-ts">${l.ts}</span><span class="log-msg ${l.level}">${esc(l.msg)}</span></div>`
      ).join('');
      box.scrollTop = box.scrollHeight;
      const pct = Math.round(data.overall_progress || 0);
      if (data.status === 'completed' || data.status === 'failed' || data.status === 'cancelled') {
        reportData = (data.items || []).map(it => {
          const fn = it.name || (it.input || '').split(/[\/\\]/).pop();
          if (it.error) return { filename: fn, path: it.input, error: it.error, moov: null };
          return { filename: fn, path: it.input, probeData: it.probe, size: it.size, moov: it.moov || null };
        });
        // 新一批数据：清空旧勾选，避免路径串档
        reportSelectedPaths = new Set();
        renderReport();
        const total = (data.items || []).length;
        const okc = (data.items || []).filter(it => it.ok).length;
        const box2 = document.getElementById('reportLogBox');
        box2.innerHTML += `<div class="log-line"><span class="log-ts">--:--:--</span><span class="log-msg success">完成: 成功 ${okc}/${total}</span></div>`;
        reportJobId = null;
      } else {
        document.getElementById('reportResult').innerHTML = `<div style="padding:20px;text-align:center;"><span class="spinner" style="display:inline-block;vertical-align:middle;margin-right:8px;"></span>正在读取视频元数据... ${pct}%</div>`;
        setTimeout(pollReportJob, 400);
      }
    })
    .catch(e => {
      setTimeout(pollReportJob, 1000);
    });
}


async function exportReportLog() {
  if (!lastReportJobId) { alert('当前没有可导出的日志'); return; }
  const btn = document.getElementById('exportReportLogBtn');
  const old = btn.textContent;
  btn.disabled = true; btn.textContent = '正在导出...';
  try {
    const r = await fetch(`/api/encode_log/${lastReportJobId}`);
    const d = await r.json();
    if (d.error) { alert(d.error); return; }
    const logText = d.log || '日志为空';
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const defaultName = `360VideoConverter_报告日志_${ts}`;
    openSaveDialog(defaultName, async (savePath) => {
      try {
        const sr = await fetch('/api/save_report', {
          method: 'POST', headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({path: savePath, content: logText})
        });
        const sd = await sr.json();
        if (sd.success) {
          // 已并入全局统一轻提示（原先此处与 80-codec.js 各复制了一份内联气泡实现）
          showToast('报告日志已保存到: ' + sd.path, 'success', 4000);
        } else {
          alert('保存失败: ' + (sd.error || '未知错误'));
        }
      } catch(e) { alert('保存失败: ' + e.message); }
    });
  } catch(e) {
    alert('导出日志失败: ' + e.message);
  } finally {
    btn.disabled = false; btn.textContent = old;
  }
}


// ══ C1: moov atom 徽章 ═════════════════════════════════════════

function moovBadgeHtml(item) {
  const m = item.moov;
  if (!m) return ''; // 后端未返回（旧数据/解析异常）：不显示徽章
  if (!m.has_moov) return '<span class="meta-badge moov-badge-missing">moov &#10007; 缺失</span>';
  if (m.moov_position === 'front') return '<span class="meta-badge moov-badge-front">moov &#10003; 前置（faststart）</span>';
  return '<span class="meta-badge moov-badge-end">moov &#10003; 尾部</span>';
}


// ══ C2: 批量结果筛选（纯前端，对 reportData 过滤后重渲染）═════════

function getReportFilterState() {
  const fEl = document.getElementById('reportFilterField');
  const bEl = document.getElementById('reportFilterBool');
  const kEl = document.getElementById('reportFilterKeyword');
  return {
    field: fEl ? fEl.value : '',
    boolVal: bEl ? bEl.value : '',
    kw: kEl ? kEl.value.trim().toLowerCase() : ''
  };
}


// 取某个文件条目在指定筛选字段上的可匹配值（统一转字符串；布尔字段返回 '是'/'否'）
function reportItemFilterValue(item, field) {
  if (!item || item.error || !item.probeData) return '';
  const d = item.probeData;
  const fmt = d.format || {};
  const streams = d.streams || [];
  const v = streams.find(s => s.codec_type === 'video') || {};
  const a = streams.find(s => s.codec_type === 'audio') || {};
  const tags = fmt.tags || {};
  const vTags = v.tags || {};
  switch (field) {
    // 容器
    case 'moov': {
      const m = item.moov;
      return m && m.has_moov ? '是' : '否';
    }
    case 'container_format': return `${fmt.format_name || ''} ${fmt.format_long_name || ''}`.trim();
    case 'file_size': return item.size != null ? String(item.size) : '';
    case 'duration': return fmt.duration != null ? String(fmt.duration) : '';
    // 视频流
    case 'vcodec': return v.codec_name || '';
    case 'resolution': return v.width ? `${v.width}x${v.height}` : '';
    case 'fps': return formatFrameRate(v.r_frame_rate);
    case 'vbitrate': return formatBitrate(parseInt(v.bit_rate));
    case 'pix_fmt': return v.pix_fmt || '';
    // 音频流
    case 'acodec': return a.codec_name || '';
    case 'sample_rate': return a.sample_rate ? String(a.sample_rate) : '';
    case 'channels': return a.channels ? String(a.channels) : '';
    // 球面元数据
    case 'gspherical': {
      const sph = detectSpherical(d) || {};
      return sph.spherical ? '是' : '否';
    }
    case 'pano_type': {
      const sph = detectSpherical(d) || {};
      return sph.panoType || '';
    }
    case 'stereo_mode': {
      const sph = detectSpherical(d) || {};
      return sph.stereo || '';
    }
    // 时间
    case 'creation_time': return tags['creation_time'] || vTags['creation_time'] || '';
    // 位置 GPS（location 标签为 "+lat+lon/" 原始串；名称/地址通常由注入流程写入 tags）
    case 'gps_coord': return tags['location'] || vTags['location'] || '';
    case 'location_name': return tags['location_name'] || vTags['location_name'] || '';
    case 'location_address': return tags['location_address'] || vTags['location_address'] || '';
    default: return '';
  }
}


// 返回当前筛选下可见的条目：[{item, idx}]，idx 是 reportData 中的固定下标
// （reportData 顺序不会因筛选改变，故 idx 可安全用作复选框的 data-idx）
function getVisibleReportItems() {
  const all = reportData.map((item, idx) => ({ item, idx }));
  const st = getReportFilterState();
  if (!st.field) return all;
  return all.filter(({ item }) => {
    const val = reportItemFilterValue(item, st.field);
    if (REPORT_BOOL_FIELDS.includes(st.field)) {
      if (st.boolVal === 'yes') return val === '是';
      if (st.boolVal === 'no') return val === '否';
      return true; // 全部
    }
    if (!st.kw) return true;
    return String(val).toLowerCase().includes(st.kw);
  });
}


function onReportFilterChange() {
  const st = getReportFilterState();
  const isBool = REPORT_BOOL_FIELDS.includes(st.field);
  setDisplay('reportFilterKeyword', isBool ? 'none' : '');
  setDisplay('reportFilterBool', isBool ? '' : 'none');
  renderReport();
}


function wireReportFilterEvents() {
  if (reportFilterWired) return;
  const kw = document.getElementById('reportFilterKeyword');
  if (kw) {
    // 中央委托只覆盖 click/change（change 需失焦才触发），文本框"输入即筛选"
    // 用本地 addEventListener 实现（非内联事件，符合事件规范）
    kw.addEventListener('input', () => renderReport());
    reportFilterWired = true;
  }
}


// ══ C3: 多选 / 全选 / 反选 / 清空 ══════════════════════════════

function toggleReportSelect(idx, checked) {
  const item = reportData[idx];
  if (!item || !item.path) return; // 空值安全：条目可能已被新数据替换
  if (checked) reportSelectedPaths.add(item.path);
  else reportSelectedPaths.delete(item.path);
  updateReportCounts();
}


// 全选/反选只作用于「当前筛选可见」的条目
function reportSelectVisibleAll() {
  getVisibleReportItems().forEach(({ item }) => {
    if (item.path) reportSelectedPaths.add(item.path);
  });
  renderReport();
}


function reportSelectInvert() {
  getVisibleReportItems().forEach(({ item }) => {
    if (!item.path) return;
    if (reportSelectedPaths.has(item.path)) reportSelectedPaths.delete(item.path);
    else reportSelectedPaths.add(item.path);
  });
  renderReport();
}


function reportSelectClear() {
  reportSelectedPaths.clear();
  renderReport();
}


// ══ C4: 把选中的媒体加入批量转换队列 ═══════════════════════════

function addSelectedReportToQueue() {
  if (reportSelectedPaths.size === 0) {
    showToast('请先勾选要加入队列的文件', 'warning');
    return;
  }
  const files = reportData
    .filter(it => it.path && reportSelectedPaths.has(it.path))
    .map(it => ({
      path: it.path, name: it.filename,
      size_mb: it.size || 0, size_str: it.size ? `${it.size} MB` : '--'
    }));
  // 复用 40-files.js 的任务构造逻辑（makeTask + buildTaskConfig 快照当前参数）
  const r = addMediaToBatchQueue(files);
  if (r.added === 0) {
    showToast(r.skipped > 0 ? `未添加任何任务：${r.skipped} 个文件已在队列中` : '未能添加任何任务', 'warning');
    return;
  }
  showToast(`已加入批量转换队列 ${r.added} 个（跳过 ${r.skipped} 个重复）`, 'success', 4000);
  switchMode('batch'); // 切到批量转换模式，用户可用已有的单任务调参能力
}


// ══ 工具栏显隐 / 计数刷新 ══════════════════════════════════════

function updateReportToolbars() {
  wireReportFilterEvents();
  const hasData = reportData.length > 0;
  const fbar = document.getElementById('reportFilterBar');
  if (fbar) fbar.classList.toggle('hidden', !hasData);
  const sbar = document.getElementById('reportSelectBar');
  if (sbar) sbar.classList.toggle('hidden', !hasData);
}


function updateReportCounts(visibleCount) {
  setText('reportFilterCount', `筛选后 ${visibleCount != null ? visibleCount : reportData.length} / 共 ${reportData.length} 个`);
  setText('reportSelectCount', `已选 ${reportSelectedPaths.size} 个`);
  const btn = document.getElementById('reportAddToQueueBtn');
  if (btn) btn.textContent = `加入批量转换队列（已选 ${reportSelectedPaths.size}）`;
}


// ══ 渲染 ══════════════════════════════════════════════════════

function renderReportItem(item, idx) {
  const checked = item.path && reportSelectedPaths.has(item.path) ? ' checked' : '';
  const cb = `<span class="report-item-select"><input type="checkbox" data-action="toggle-report-select" data-idx="${idx}"${checked} title="选中此文件"></span>`;
  if (item.error) {
    return `<div class="report-item">
      <div class="report-item-header">
        ${cb}
        <span class="fname">${esc(item.filename)}</span>
        <span style="color:var(--error);">&#9888; 读取失败</span>
      </div>
      <div class="report-row"><span class="label">路径</span><span class="value">${esc(item.path)}</span></div>
      <div class="report-row"><span class="label">错误</span><span class="value" style="color:var(--error);">${esc(item.error)}</span></div>
    </div>`;
  }
  const d = item.probeData;
  const fmt = d.format || {};
  const streams = d.streams || [];
  const vStream = streams.find(s => s.codec_type === 'video') || {};
  const aStream = streams.find(s => s.codec_type === 'audio') || {};

  // Check for spherical metadata
  const tags = fmt.tags || {};
  const vTags = vStream.tags || {};
  const sphInfo = detectSpherical(d);
  const hasSpherical = sphInfo.spherical;

  // Check for location
  const location = tags['location'] || vTags['location'] || '';

  // Check for creation_time
  const creationTime = tags['creation_time'] || vTags['creation_time'] || '';

  return `<div class="report-item">
    <div class="report-item-header">
      ${cb}
      <span class="fname">${esc(item.filename)}</span>
      ${moovBadgeHtml(item)}
      ${item.size ? `<span class="badge">${item.size} MB</span>` : ''}
    </div>
    <div class="report-item-header" style="border-bottom:none;padding-bottom:0;margin-bottom:6px;">
      <span class="fpath">${esc(item.path)}</span>
    </div>
    <div class="report-grid">
      <div class="report-section">
        <div class="report-section-title">容器信息</div>
        <div class="report-row"><span class="label">格式</span><span class="value">${esc(fmt.format_long_name || fmt.format_name || '—')}</span></div>
        <div class="report-row"><span class="label">moov atom</span><span class="value">${moovBadgeHtml(item) || '—'}</span></div>
        <div class="report-row"><span class="label">时长</span><span class="value">${formatDuration(parseFloat(fmt.duration))}</span></div>
        <div class="report-row"><span class="label">总码率</span><span class="value">${formatBitrate(parseInt(fmt.bit_rate))}</span></div>
        <div class="report-row"><span class="label">文件大小</span><span class="value">${item.size ? item.size + ' MB' : '—'}</span></div>
      </div>
      <div class="report-section">
        <div class="report-section-title">视频流</div>
        <div class="report-row"><span class="label">编码器</span><span class="value">${esc(vStream.codec_name || '—')} (${esc(vStream.codec_long_name || '')})</span></div>
        <div class="report-row"><span class="label">分辨率</span><span class="value">${vStream.width || '?'} × ${vStream.height || '?'}</span></div>
        <div class="report-row"><span class="label">帧率</span><span class="value">${formatFrameRate(vStream.r_frame_rate)}</span></div>
        <div class="report-row"><span class="label">像素格式</span><span class="value">${esc(vStream.pix_fmt || '—')}</span></div>
        <div class="report-row"><span class="label">Profile/Level</span><span class="value">${esc(vStream.profile || '—')} / ${esc(vStream.level || '—')}</span></div>
        <div class="report-row"><span class="label">色彩空间</span><span class="value">${esc(vStream.color_space || '—')} / ${esc(vStream.color_range || '—')}</span></div>
        <div class="report-row"><span class="label">视频码率</span><span class="value">${formatBitrate(parseInt(vStream.bit_rate))}</span></div>
      </div>
      <div class="report-section">
        <div class="report-section-title">音频流</div>
        <div class="report-row"><span class="label">编码器</span><span class="value">${esc(aStream.codec_name || '—')} (${esc(aStream.codec_long_name || '')})</span></div>
        <div class="report-row"><span class="label">采样率</span><span class="value">${aStream.sample_rate ? aStream.sample_rate + ' Hz' : '—'}</span></div>
        <div class="report-row"><span class="label">声道</span><span class="value">${aStream.channels || '—'} ch (${esc(aStream.channel_layout || '')})</span></div>
        <div class="report-row"><span class="label">音频码率</span><span class="value">${formatBitrate(parseInt(aStream.bit_rate))}</span></div>
      </div>
      <div class="report-section">
        <div class="report-section-title">元数据标签</div>
        <div class="report-row"><span class="label">拍摄日期</span><span class="value ${creationTime ? 'ok' : 'warn'}">${creationTime ? esc(creationTime) : '未设置'}</span></div>
        <div class="report-row"><span class="label">拍摄位置</span><span class="value ${location ? 'ok' : 'warn'}">${location ? esc(location) : '未设置'}</span></div>
        <div class="report-row"><span class="label">全景元数据</span><span class="value ${hasSpherical ? 'ok' : 'warn'}">${hasSpherical ? sphericalLabel(sphInfo) : '未注入'}</span></div>
        ${Object.entries(tags).filter(([k]) => !['creation_time','location','spherical'].includes(k)).slice(0, 5).map(([k,v]) =>
          `<div class="report-row"><span class="label">${esc(k)}</span><span class="value">${esc(String(v).substring(0, 80))}</span></div>`
        ).join('')}
      </div>
    </div>
  </div>`;
}


function renderReport() {
  updateReportToolbars();
  updateReportCounts();
  if (reportData.length === 0) {
    document.getElementById('reportResult').innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-muted);">无报告数据</div>';
    return;
  }
  const visible = getVisibleReportItems();
  if (visible.length === 0) {
    document.getElementById('reportResult').innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-muted);">没有符合筛选条件的文件</div>';
    return;
  }
  document.getElementById('reportResult').innerHTML = visible.map(({ item, idx }) => renderReportItem(item, idx)).join('');
}


function saveReport() {
  if (reportData.length === 0) { alert('无报告数据可保存'); return; }
  let text = `360° Video Converter - 元数据报告\n`;
  text += `生成时间: ${new Date().toLocaleString()}\n`;
  text += `文件数量: ${reportData.length}\n`;
  text += `${'='.repeat(80)}\n\n`;

  reportData.forEach((item, i) => {
    text += `[${i+1}] ${item.filename}\n`;
    text += `路径: ${item.path}\n`;
    if (item.size) text += `大小: ${item.size} MB\n`;
    if (item.error) {
      text += `错误: ${item.error}\n`;
    } else {
      const d = item.probeData;
      const fmt = d.format || {};
      const streams = d.streams || [];
      const v = streams.find(s => s.codec_type === 'video') || {};
      const a = streams.find(s => s.codec_type === 'audio') || {};
      const tags = fmt.tags || {};
      const vTags = v.tags || {};
      text += `格式: ${fmt.format_long_name || fmt.format_name || '—'}\n`;
      const m = item.moov;
      text += `moov atom: ${m ? (m.has_moov ? (m.moov_position === 'front' ? '前置（faststart）' : '尾部') : '缺失') : '未知'}\n`;
      text += `时长: ${formatDuration(parseFloat(fmt.duration))}\n`;
      text += `总码率: ${formatBitrate(parseInt(fmt.bit_rate))}\n`;
      text += `\n-- 视频 --\n`;
      text += `编码器: ${v.codec_name || '—'} (${v.codec_long_name || ''})\n`;
      text += `分辨率: ${v.width || '?'} × ${v.height || '?'}\n`;
      text += `帧率: ${formatFrameRate(v.r_frame_rate)}\n`;
      text += `像素格式: ${v.pix_fmt || '—'}\n`;
      text += `Profile/Level: ${v.profile || '—'} / ${v.level || '—'}\n`;
      text += `色彩空间: ${v.color_space || '—'} / ${v.color_range || '—'}\n`;
      text += `视频码率: ${formatBitrate(parseInt(v.bit_rate))}\n`;
      text += `\n-- 音频 --\n`;
      text += `编码器: ${a.codec_name || '—'} (${a.codec_long_name || ''})\n`;
      text += `采样率: ${a.sample_rate ? a.sample_rate + ' Hz' : '—'}\n`;
      text += `声道: ${a.channels || '—'} ch (${a.channel_layout || ''})\n`;
      text += `音频码率: ${formatBitrate(parseInt(a.bit_rate))}\n`;
      text += `\n-- 元数据 --\n`;
      text += `拍摄日期: ${tags['creation_time'] || vTags['creation_time'] || '未设置'}\n`;
      text += `拍摄位置: ${tags['location'] || vTags['location'] || '未设置'}\n`;
      const sphInfo2 = detectSpherical(d);
      text += `全景元数据: ${sphericalLabel(sphInfo2)}\n`;
    }
    text += `\n${'─'.repeat(80)}\n\n`;
  });

  // Download as file
  const blob = new Blob([text], {type: 'text/plain;charset=utf-8'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `video_metadata_report_${new Date().toISOString().slice(0,10)}.txt`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}


function clearReport() {
  reportData = [];
  reportSelectedPaths = new Set();
  reportJobId = null;
  lastReportJobId = null;
  document.getElementById('reportResult').innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-muted);">选择视频文件后点击"读取元数据"生成报告</div>';
  const box = document.getElementById('reportLogBox');
  if (box) {
    box.style.display = 'none';
    box.innerHTML = '<div class="log-line"><span class="log-ts">--:--:--</span><span class="log-msg info">等待读取元数据...</span></div>';
  }
  const eb = document.getElementById('exportReportLogBtn');
  if (eb) eb.style.display = 'none';
  updateReportToolbars();
  updateReportCounts(0);
}

// ── Tooltip System (viewport-aware dynamic positioning) ────────

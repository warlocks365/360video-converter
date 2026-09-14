// ============================================================
//   70-report.js — 元数据报告模式
//   由 static/index.html 内联脚本拆分而来（整块切分，零行为变更）
// ============================================================

let reportData = []; // Array of {filename, path, probeData, error}


let reportJobId = null;

let lastReportJobId = null;


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
          if (it.error) return { filename: fn, path: it.input, error: it.error };
          return { filename: fn, path: it.input, probeData: it.probe, size: it.size };
        });
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


function renderReport() {
  if (reportData.length === 0) {
    document.getElementById('reportResult').innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-muted);">无报告数据</div>';
    return;
  }
  const html = reportData.map(item => {
    if (item.error) {
      return `<div class="report-item">
        <div class="report-item-header">
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
        <span class="fname">${esc(item.filename)}</span>
        ${item.size ? `<span class="badge">${item.size} MB</span>` : ''}
      </div>
      <div class="report-item-header" style="border-bottom:none;padding-bottom:0;margin-bottom:6px;">
        <span class="fpath">${esc(item.path)}</span>
      </div>
      <div class="report-grid">
        <div class="report-section">
          <div class="report-section-title">容器信息</div>
          <div class="report-row"><span class="label">格式</span><span class="value">${esc(fmt.format_long_name || fmt.format_name || '—')}</span></div>
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
  }).join('');
  document.getElementById('reportResult').innerHTML = html;
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
}

// ── Tooltip System (viewport-aware dynamic positioning) ────────

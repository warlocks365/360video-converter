// ============================================================
//   80-codec.js — 编码器检测 / 诊断 / 日志导出
//   由 static/index.html 内联脚本拆分而来（整块切分，零行为变更）
// ============================================================

let codecInfo = {};       // codec profiles from API

let codecAvailability = {}; // which codecs are available

let codecErrorDetails = {};  // error messages per codec

let codecFfmpegInfo = {};     // ffmpeg version info

let codecRuntimeDlls = {};   // runtime DLL check results

let codecFixHints = {};       // fix hints per codec


// 保存成功提示气泡。历史上本模块用内联 DOM 样板弹出 4000ms 的绿色气泡。
// 已并入全局统一轻提示（00-core.js 的 showToast）。
// 改造前这段"创建 div + 内联 cssText + append + 定时移除"的样板在 80-codec.js
// 与 70-report.js 中各复制了一份（z-index 9999、停留 4000ms、独立配色与圆角）。
// showToast 现支持第 3 个参数 durationMs，故传入 4000 可在统一实现的同时
// 保持原有停留时长不变；位置（右上角）与语义（成功）也一致。
function _flashNote(msg) { showToast(msg, 'success', 4000); }


function browseCustomFfmpeg() {
  openFileBrowser('settings_custom_ffmpeg', false, 'exe');
}


async function testCustomFfmpeg() {
  const path = document.getElementById('settings_custom_ffmpeg').value.trim();
  const resultEl = document.getElementById('ffmpegTestResult');
  if (!path) {
    resultEl.style.display = 'block';
    resultEl.innerHTML = '<div style="color:var(--warning);font-size:0.82rem;">请先输入 ffmpeg.exe 路径</div>';
    return;
  }
  resultEl.style.display = 'block';
  resultEl.innerHTML = '<div style="color:var(--text-muted);font-size:0.82rem;">正在测试...</div>';
  try {
    const r = await fetch('/api/test_ffmpeg', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({path: path})
    });
    const data = await r.json();
    if (data.error) {
      resultEl.innerHTML = '<div style="color:var(--error);font-size:0.82rem;">&#10007; ' + esc(data.error) + '</div>';
      return;
    }
    let html = '<div style="font-size:0.82rem;line-height:1.8;">';
    html += '<div style="color:var(--success);font-weight:600;">&#10003; ' + esc(data.version || 'ffmpeg detected') + '</div>';
    const encs = data.encoders || {};
    const labels = {
      h264_nvenc: 'H.264 NVENC (NVIDIA)', hevc_nvenc: 'H.265 NVENC (NVIDIA)',
      h264_qsv: 'H.264 QSV (Intel)', hevc_qsv: 'H.265 QSV (Intel)',
      h264_amf: 'H.264 AMF (AMD)', hevc_amf: 'H.265 AMF (AMD)',
    };
    for (const [key, info] of Object.entries(encs)) {
      // Support both old format (boolean) and new format ({available, error})
      const avail = typeof info === 'boolean' ? info : info.available;
      const err = typeof info === 'boolean' ? '' : (info.error || '');
      const icon = avail ? '&#10003;' : '&#10007;';
      const color = avail ? 'var(--success)' : 'var(--text-muted)';
      let line = '<div style="color:' + color + ';">' + icon + ' ' + esc(labels[key] || key);
      if (!avail && err) {
        line += ' <span style="font-size:0.7rem;color:var(--text-muted);">(' + esc(err) + ')</span>';
      }
      line += '</div>';
      html += line;
    }
    html += '</div>';
    resultEl.innerHTML = html;
  } catch(e) {
    resultEl.innerHTML = '<div style="color:var(--error);font-size:0.82rem;">&#10007; 测试失败: ' + esc(e.message) + '</div>';
  }
}

// ── Task Save/Load ──────────────────────────────────

async function checkCodecs() {
  const statusEl = document.getElementById('codecStatus');
  statusEl.innerHTML = '<span class="spinner" style="display:inline-block;vertical-align:middle;margin-right:6px;"></span><span style="color:var(--text-muted);font-size:0.82rem;">正在检测编码器（测试编码中，请稍候）...</span>';

  try {
    const r2 = await fetch('/api/codec_check');
    const d2 = await r2.json();
    codecAvailability = d2.available || {};
    codecErrorDetails = d2.error_details || {};
    codecFfmpegInfo = d2.ffmpeg_info || {};
    codecRuntimeDlls = d2.runtime_dlls || {};
    codecFixHints = d2.fix_hints || {};
    renderCodecStatus();
  } catch(e) {
    statusEl.innerHTML = '<span style="color:var(--warning);">编码器检测失败: ' + esc(e.message || '') + '</span>';
  }
}


function renderCodecStatus() {
  const statusEl = document.getElementById('codecStatus');
  if (!statusEl) return;

  const selectedCodec = document.getElementById('p_codec')?.value || '';
  let html = '';
  for (const [key, avail] of Object.entries(codecAvailability)) {
    const ci = codecInfo[key];
    if (!ci) continue;
    const badge = `<span class="codec-badge ${esc(ci.group)}">${esc(ci.group.toUpperCase())}</span>`;
    const icon = avail ? '&#10003;' : '&#10007;';
    const color = avail ? 'var(--success)' : 'var(--text-muted)';
    const label = ci.label.split('(')[0].trim();
    // Highlight currently selected codec
    const isSelected = key === selectedCodec;
    const bg = isSelected ? 'background:var(--bg-secondary);border-radius:4px;padding:1px 4px;' : '';
    // Add error detail tooltip for unavailable encoders
    let errInfo = '';
    if (!avail && codecErrorDetails[key]) {
      errInfo = ` <span style="color:var(--warning);font-size:0.7rem;cursor:help;" title="${esc(codecErrorDetails[key])}" data-action="encoder-detail" data-encoder="${esc(key)}">[详情]</span>`;
    }
    html += `<div style="display:inline-flex;align-items:center;gap:4px;margin:2px 6px 2px 0;font-size:0.78rem;color:${color};${bg}">${icon} ${esc(label)} ${badge}${errInfo}</div>`;
  }
  // Show ffmpeg version info
  if (codecFfmpegInfo.bundled_version) {
    html += `<div style="display:block;margin-top:4px;font-size:0.72rem;color:var(--text-muted);">内置: ${esc(codecFfmpegInfo.bundled_version)}</div>`;
  }
  if (codecFfmpegInfo.system) {
    html += `<div style="font-size:0.72rem;color:var(--text-muted);">系统: ${esc(codecFfmpegInfo.system_version || 'unknown')}</div>`;
  }
  if (codecFfmpegInfo.custom) {
    html += `<div style="font-size:0.72rem;color:var(--text-muted);">自定义: ${esc(codecFfmpegInfo.custom_version || 'unknown')}</div>`;
  }
  // Show runtime DLL summary for unavailable hardware encoders
  const dllGroups = {cuda: 'NVIDIA', qsv: 'Intel', amf: 'AMD'};
  for (const [group, label] of Object.entries(dllGroups)) {
    const dlls = codecRuntimeDlls[group] || {};
    const found = Object.values(dlls).filter(p => p);
    const total = Object.keys(dlls).length;
    if (found.length === 0 && total > 0) {
      // No DLLs found for this group
      const anyUnavailable = Object.entries(codecAvailability).some(([k, v]) => {
        const ci2 = codecInfo[k];
        return ci2 && ci2.group === group && v === false;
      });
      if (anyUnavailable) {
        html += `<div style="font-size:0.7rem;color:var(--text-muted);">${label} 运行时 DLL: 未检测到 (需要安装显卡驱动)</div>`;
      }
    } else if (found.length > 0 && found.length < total) {
      html += `<div style="font-size:0.7rem;color:var(--warning);">${label} 运行时 DLL: 部分缺失 (${found.length}/${total})</div>`;
    }
  }
  // Add export button
  html += `<div style="margin-top:6px;"><button data-action="export-diagnostic-report" style="font-size:0.7rem;padding:2px 8px;border:1px solid var(--border);border-radius:4px;background:var(--bg-secondary);cursor:pointer;color:var(--text-muted);">📄 导出诊断报告</button></div>`;
  statusEl.innerHTML = html;
}


async function showEncoderDetail(encoder) {
  const ci = codecInfo[encoder];
  if (!ci) return;

  // Find the ffmpeg path to test
  let ffmpegPath = codecFfmpegInfo.bundled || '';
  // If system ffmpeg was used for this encoder, use that
  // (but for testing, try bundled first)

  const statusEl = document.getElementById('codecStatus');
  statusEl.innerHTML = `<span class="spinner" style="display:inline-block;vertical-align:middle;margin-right:6px;"></span><span style="color:var(--text-muted);font-size:0.82rem;">正在详细测试 ${esc(encoder)}...</span>`;

  try {
    const r = await fetch('/api/test_encoder_detail', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({encoder: encoder, ffmpeg_path: ffmpegPath})
    });
    const d = await r.json();

    let html = '<div style="font-size:0.78rem;">';
    html += `<div style="margin-bottom:4px;"><strong>编码器:</strong> ${esc(encoder)}</div>`;
    html += `<div style="margin-bottom:4px;"><strong>ffmpeg:</strong> ${esc(ffmpegPath)}</div>`;
    html += `<div style="margin-bottom:4px;"><strong>结果:</strong> ${d.success ? '<span style="color:var(--success);">✓ 可用</span>' : '<span style="color:var(--warning);">✗ 不可用</span>'}</div>`;
    if (d.returncode !== undefined) {
      html += `<div style="margin-bottom:4px;"><strong>退出码:</strong> ${d.returncode}</div>`;
    }
    if (d.error) {
      html += `<div style="margin-bottom:4px;color:var(--warning);"><strong>错误:</strong> ${esc(d.error)}</div>`;
    }
    // Show runtime DLL check results
    const group = ci.group;
    const dlls = codecRuntimeDlls[group] || {};
    const dllEntries = Object.entries(dlls);
    if (dllEntries.length > 0) {
      html += `<div style="margin-top:6px;"><strong>运行时 DLL 检测:</strong></div>`;
      for (const [dllName, dllPath] of dllEntries) {
        const found = !!dllPath;
        const icon = found ? '&#10003;' : '&#10007;';
        const color = found ? 'var(--success)' : 'var(--text-muted)';
        html += `<div style="color:${color};font-size:0.72rem;">${icon} ${esc(dllName)} ${found ? '(' + esc(dllPath) + ')' : '(未找到)'}</div>`;
      }
    }
    // Show fix hint if available
    const fixHint = codecFixHints[encoder] || '';
    if (fixHint) {
      html += `<div style="margin-top:8px;padding:6px 8px;background:#fff3cd;border:1px solid #ffc107;border-radius:4px;font-size:0.72rem;white-space:pre-wrap;color:#856404;line-height:1.5;"><strong>修复建议:</strong>\n${esc(fixHint)}</div>`;
    }
    if (d.stderr) {
      // Show last 10 lines of stderr
      const lines = d.stderr.trim().split('\n').slice(-15);
      html += `<div style="margin-top:6px;"><strong>ffmpeg 输出 (最后15行):</strong></div>`;
      html += `<pre style="background:var(--bg-secondary);padding:6px 8px;border-radius:4px;font-size:0.7rem;white-space:pre-wrap;max-height:200px;overflow-y:auto;margin-top:2px;">${esc(lines.join('\n'))}</pre>`;
    }
    html += '</div>';
    // Action buttons row
    html += `<div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap;">`;
    html += `<button data-action="export-diagnostic-report" style="font-size:0.72rem;padding:3px 10px;border:1px solid var(--border);border-radius:4px;background:var(--bg-secondary);cursor:pointer;color:var(--text);">📄 导出报告</button>`;
    html += `<button data-action="copy-error-info" data-encoder="${esc(encoder)}" style="font-size:0.72rem;padding:3px 10px;border:1px solid var(--border);border-radius:4px;background:var(--bg-secondary);cursor:pointer;color:var(--text);">📋 保存错误信息</button>`;
    html += `<button data-action="codec-change" style="font-size:0.72rem;padding:3px 10px;border:1px solid var(--border);border-radius:4px;background:var(--bg-secondary);cursor:pointer;color:var(--text-muted);">返回</button>`;
    html += `</div>`;
    statusEl.innerHTML = html;
  } catch(e) {
    statusEl.innerHTML = '<span style="color:var(--warning);">详细测试失败: ' + esc(e.message) + '</span>';
  }
}

// ── Export Diagnostic Report ─────────────────────

async function exportDiagnosticReport() {
  const statusEl = document.getElementById('codecStatus');
  const oldHtml = statusEl.innerHTML;
  statusEl.innerHTML = '<span class="spinner" style="display:inline-block;vertical-align:middle;margin-right:6px;"></span><span style="color:var(--text-muted);font-size:0.82rem;">正在生成诊断报告（测试所有编码器，请稍候）...</span>';

  try {
    const r = await fetch('/api/diagnostic_report');
    const d = await r.json();
    const reportText = d.report || '报告生成失败';

    // Restore view
    statusEl.innerHTML = oldHtml;

    if (!d.report) {
      alert('报告生成失败');
      return;
    }

    // Open save dialog
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const defaultName = `360VideoConverter_诊断报告_${ts}`;
    openSaveDialog(defaultName, async (savePath) => {
      try {
        const sr = await fetch('/api/save_report', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({path: savePath, content: reportText})
        });
        const sd = await sr.json();
        if (sd.success) {
          _flashNote('诊断报告已保存到: ' + sd.path);
        } else {
          alert('保存失败: ' + (sd.error || '未知错误'));
        }
      } catch(e) {
        alert('保存失败: ' + e.message);
      }
    });
  } catch(e) {
    statusEl.innerHTML = oldHtml;
    alert('导出报告失败: ' + e.message);
  }
}

// ── Export Encoding Log ─────────────────────────

async function exportEncodeLog() {
  if (!jobId) { alert('当前没有可导出的日志'); return; }
  const btn = document.getElementById('exportLogBtn');
  if (btn) { btn.disabled = true; btn.textContent = '正在导出...'; }
  try {
    const r = await fetch(`/api/encode_log/${jobId}`);
    const d = await r.json();
    if (d.error) { alert(d.error); return; }
    const logText = d.log || '日志为空';
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const defaultName = `360VideoConverter_编码日志_${ts}`;
    openSaveDialog(defaultName, async (savePath) => {
      try {
        const sr = await fetch('/api/save_report', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({path: savePath, content: logText})
        });
        const sd = await sr.json();
        if (sd.success) {
          _flashNote('编码日志已保存到: ' + sd.path);
        } else {
          alert('保存失败: ' + (sd.error || '未知错误'));
        }
      } catch(e) {
        alert('保存失败: ' + e.message);
      }
    });
  } catch(e) {
    alert('导出日志失败: ' + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '📄 导出日志'; }
  }
}

// ── Save Error Info to File ──────────────────────

function copyErrorInfo(encoder) {
  const ci = codecInfo[encoder];
  const errDetail = codecErrorDetails[encoder] || '';
  const ffmpegPath = codecFfmpegInfo.bundled || '';
  const group = ci ? ci.group : '';

  // Gather DLL info for this group
  let dllInfo = '';
  if (group && codecRuntimeDlls[group]) {
    const dlls = codecRuntimeDlls[group];
    dllInfo = Object.entries(dlls).map(([name, path]) =>
      `  ${name}: ${path || '未找到'}`
    ).join('\n');
  }

  // Build comprehensive error info text
  const lines = [
    '=== 360 Video Converter - 错误信息 ===',
    `编码器: ${encoder}`,
    `分组: ${group}`,
    `状态: 不可用`,
    `错误详情: ${errDetail}`,
    `ffmpeg路径: ${ffmpegPath}`,
    '',
    '--- 运行时 DLL 检测 ---',
    dllInfo || '(无信息)',
    '',
    '--- 所有编码器状态 ---',
  ];

  for (const [key, avail] of Object.entries(codecAvailability)) {
    const info = codecInfo[key];
    if (!info) continue;
    lines.push(`  ${key}: ${avail ? '可用' : '不可用'} ${avail ? '' : '- ' + (codecErrorDetails[key] || '')}`);
  }

  lines.push('');
  lines.push(`生成时间: ${new Date().toLocaleString()}`);

  const text = lines.join('\n');

  // Open save dialog
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const defaultName = `错误信息_${encoder}_${ts}`;
  openSaveDialog(defaultName, async (savePath) => {
    try {
      const sr = await fetch('/api/save_report', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({path: savePath, content: text})
      });
      const sd = await sr.json();
      if (sd.success) {
        _flashNote('错误信息已保存到: ' + sd.path);
      } else {
        alert('保存失败: ' + (sd.error || '未知错误'));
      }
    } catch(e) {
      alert('保存失败: ' + e.message);
    }
  });
}


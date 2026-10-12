// ============================================================
//   90-boot.js — 启动初始化
//   由 static/index.html 内联脚本拆分而来（整块切分，零行为变更）
// ============================================================

async function init() {
  // Load AMap API key from backend (persisted in _settings.json) before any map use
  await loadAmapConfig();
  applyParams(DEFAULT_PARAMS);
  refreshPresets();
  initTooltips();

  // Start system resource monitor polling (always-on)
  startSysMonPolling();

  // Fetch and display app version
  try {
    const vr = await fetch('/api/version');
    const vd = await vr.json();
    const tag = document.getElementById('appVersionTag');
    if (tag && vd.version) tag.textContent = 'v' + vd.version;
  } catch(e) {}

  // Check auto-load setting
  try {
    const r = await fetch('/api/settings');
    const s = await r.json();
    if (s.auto_load_tasks) {
      await autoLoadTasks();
    }
    // v3.14.1 A1：AI 助手入口按设置持久恢复——此前按钮显隐只在 openSettings
    // 回填时赋值，enabled=true 后重启/刷新按钮保持隐藏（违背设置字面语义）。
    if (typeof vcRestoreAgentUI === 'function') vcRestoreAgentUI(s);
  } catch(e) {}

  // Load codec info first, then check availability
  try {
    const r1 = await fetch('/api/codecs');
    const d1 = await r1.json();
    codecInfo = d1.codecs;
  } catch(e) {
    document.getElementById('codecStatus').innerHTML = '<span style="color:var(--warning);">编码器信息加载失败: ' + esc(e.message || '') + '</span>';
  }

  await checkCodecs();

  onCodecChange();
}

// ── Codec Check & Status Rendering ─────────────────

init();


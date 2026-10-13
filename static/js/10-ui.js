// ============================================================
//   10-ui.js — 模式切换 / 折叠开关 / 弹窗 / tooltip / 原生对话框
//   由 static/index.html 内联脚本拆分而来（整块切分，零行为变更）
// ============================================================

function toggleTheme() {
  const html = document.documentElement;
  const cur = html.getAttribute('data-theme');
  const next = cur === 'light' ? 'dark' : 'light';
  html.setAttribute('data-theme', next);
  document.getElementById('themeBtn').innerHTML = next === 'light' ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>' : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>';
  localStorage.setItem('theme', next);
}

(function() {
  // FIX (v3.13.12): 默认主题改为深海钴蓝（dark）—— 方案 D 实施
  const saved = localStorage.getItem('theme') || 'dark';
  document.documentElement.setAttribute('data-theme', saved);
  document.getElementById('themeBtn').innerHTML = saved === 'light' ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>' : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>';
})();

// ── Mode Switching ─────────────────────────────────

// 转换族主按钮的两枚图标（v3.13.14 P0：替换 🚀 / 🎬 emoji）。
// 24 网格 / stroke=currentColor / round 端点，与页签图标同源。
// ⚠ 必须用 innerHTML 而非 textContent —— SVG 元素无法塞进 textContent。
const ICON_SVG_BASE = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"';
const ICON_ROCKET_SVG = `<svg width="16" height="16" ${ICON_SVG_BASE}><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/></svg>`;
const ICON_PLAY_SVG = `<svg width="16" height="16" ${ICON_SVG_BASE}><polygon points="5 3 19 12 5 21 5 3"/></svg>`;

function switchMode(mode) {
  currentMode = mode;
  document.querySelectorAll('.mode-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.mode === mode);
  });
  document.getElementById('singleMode').classList.toggle('hidden', mode !== 'single');
  document.getElementById('mergeMode').classList.toggle('hidden', mode !== 'merge');
  document.getElementById('batchMode').classList.toggle('hidden', mode !== 'batch');
  document.getElementById('metadataMode').classList.toggle('hidden', mode !== 'metadata');
  document.getElementById('reportMode').classList.toggle('hidden', mode !== 'report');
  const vr3dMode = document.getElementById('vr3dMode');
  if (vr3dMode) vr3dMode.classList.toggle('hidden', mode !== 'vr3d');

  // 编码参数面板：转换族（含 VR3D）需要；元数据工具与报告不需要
  const showEncode = mode === 'single' || mode === 'merge' || mode === 'batch' || mode === 'vr3d';
  const encodePanel = document.getElementById('encodePanel');
  if (encodePanel) encodePanel.style.display = showEncode ? '' : 'none';

  // 目录批量导入面板：仅批量模式
  const batchImportPanel = document.getElementById('batchImportPanel');
  if (batchImportPanel) batchImportPanel.classList.toggle('hidden', mode !== 'batch');

  // ── 操作栏（v3.11.0：单一实例，所有模式共用）──────────────
  // 改造前此处会整体隐藏操作栏（元数据模式改用另一套独立操作栏），
  // 这正是进度 DOM 重复与"任务状态串台"的结构根源。
  // 现在操作栏常驻不隐藏，仅按模式切换"主按钮"，进度区始终可见。
  const isMetaMode = mode === 'metadata';
  const isReportMode = mode === 'report';
  setDisplay('startBtn', (isMetaMode || isReportMode) ? 'none' : '');
  setDisplay('metaApplyBtn', isMetaMode ? '' : 'none');
  // v3.13.14「加入批量列队」：与 #metaApplyBtn 同属一组（配队 → 执行），
  // 必须在 setDisplay 里显隐 —— 否则会在单文件/合并/批量/报告/VR3D 模式漏出，
  // 与转换族自己的 #addToBatchBtn（「加入批量队列」）同屏出现造成同名不同义。
  setDisplay('metaAddQueueBtn', isMetaMode ? '' : 'none');
  // v3.13.18「开始批量列队执行」：与 #metaApplyBtn 同属元数据族，但职责相反 ——
  // #metaApplyBtn 只跑界面当前单文件，本按钮只跑列队。两者都必须在 setDisplay 里
  // 显隐，否则会在单文件/合并/批量/报告/VR3D 模式漏出，与转换族按钮同屏混淆。
  setDisplay('metaBatchRunBtn', isMetaMode ? '' : 'none');
  // 转换专属控件在元数据 / 报告模式下隐藏
  setDisplay('addToBatchBtn', (mode === 'single' || mode === 'merge') ? '' : 'none');
  setDisplay('testEncodeLabel', (isMetaMode || isReportMode) ? 'none' : '');
  if (isMetaMode || isReportMode) setDisplay('testDurationField', 'none');
  else toggleTestEncode();      // 按复选框当前状态恢复显隐

  // VR 3D 模式：主按钮文案
  // FIX (v3.13.14 P0): 原为 textContent = '🎬 开始合成' / '🚀 开始转换'，
  // 两枚 emoji 命中 P0 正则。SVG 无法塞进 textContent，必须改用 innerHTML。
  const startBtn = document.getElementById('startBtn');
  if (startBtn) {
    startBtn.innerHTML = (mode === 'vr3d' ? ICON_PLAY_SVG + ' 开始合成' : ICON_ROCKET_SVG + ' 开始转换');
  }

  if (mode === 'single') updateSingleDatePreview();
}

// ── Collapse ───────────────────────────────────────

function toggleCollapse(id) {
  const el = document.getElementById(id);
  const toggle = el.previousElementSibling || el.closest('.card-title');
  el.classList.toggle('hidden');
  if (toggle && toggle.classList.contains('collapse-toggle'))
    toggle.classList.toggle('collapsed', el.classList.contains('hidden'));
}

// ── 参数分组折叠（手风琴，v3.12.0）───────────────────
// ⚠️ 折叠实现必须依赖 CSS 的 display:none（`.param-group.collapsed .param-group-body`），
// 绝对不能采用「惰性渲染 / innerHTML 清空」的方式 —— collectParams() 通过
// getElementById 逐个读取参数控件的值，折叠状态下控件必须仍存在于 DOM 中，
// 否则用户曾展开过又折叠的参数会在启动任务时被静默丢弃。
function toggleParamGroup(headEl) {
  const group = headEl.closest ? headEl.closest('.param-group') : null;
  if (group) group.classList.toggle('collapsed');
}

// 按 id 设置某分组的折叠状态（供初始化默认展开 / 预设加载后复位使用）
function setParamGroupCollapsed(groupId, collapsed) {
  const g = document.getElementById(groupId);
  if (g) g.classList.toggle('collapsed', !!collapsed);
}

// ── Rate Mode Toggle ───────────────────────────────

function toggleRateMode() {
  const mode = document.getElementById('p_rate_mode').value;
  document.getElementById('crfField').style.display = mode === 'crf' ? '' : 'none';
  document.getElementById('targetBitrateField').style.display = mode === '2pass' ? '' : 'none';
  // Hardware encoders don't support 2-pass (except CPU)
  const codec = document.getElementById('p_codec').value;
  const ci = codecInfo[codec];
  if (ci && ci.group !== 'cpu' && mode === '2pass') {
    alert('硬件编码器不支持 2-pass 模式，已切换为 CRF/CQ 模式');
    document.getElementById('p_rate_mode').value = 'crf';
    toggleRateMode();
  }
}

// ── Codec Change Handler ───────────────────────────

function toggleLocation() {
  const enabled = document.getElementById('p_set_location').checked;
  document.getElementById('locationOptions').classList.toggle('hidden', !enabled);
}


// 三套元数据设置区的子容器 id 命名法**各不相同**，无法由 prefix + 固定后缀推导：
//   p_/m_ 侧球面容器用 `_spherical_options`，唯 me_ 侧用 `_opts`；
//   日期容器更是三套三种（dateOptions / metaDateOptions / me_date_opts）。
// 因此统一用显式映射表，避免"改名后静默失效"（原实现只覆盖 p_/m_，me_ 侧走内联 onchange）。
const SPHERICAL_CONTAINER_IDS = {
  p:  'p_spherical_options',
  m:  'm_spherical_options',
  me: 'me_spherical_opts',
};

function toggleSphericalOptions(cb, prefix) {
  // prefix 可传字符串，也可传已勾选的 DOM 元素（原用法两种都有）
  if (cb && cb.nodeType === 1) prefix = prefix || cb.dataset.prefix;
  const id = SPHERICAL_CONTAINER_IDS[prefix];
  const opts = id && document.getElementById(id);
  if (!opts) return;
  const checked = cb && cb.nodeType === 1 ? cb.checked : !!cb;
  // 统一为 classList 机制（与项目既有 `.hidden { display:none !important }` 一致）。
  // 必须先清掉历史遗留的内联 display —— 原实现对 p_/m_ 用 style+!important 写入，
  // 残留的内联值会以 !important 覆盖类样式，导致后续切换失效。
  opts.style.removeProperty('display');
  opts.classList.toggle('hidden', !checked);
}

// 元数据批量编辑弹窗内的子区显隐。
// 改造前这三处（球面/日期/位置）是写死在 index.html 里的内联 onchange，
// 直接操作 document.getElementById('me_xxx_opts')，没有集中函数、也无法复用。
const META_EDIT_SECTION_IDS = {
  spherical: 'me_spherical_opts',
  date:      'me_date_opts',
  location:  'me_location_opts',
};

function toggleMetaEditSection(section, checked) {
  const id = META_EDIT_SECTION_IDS[section];
  const el = id && document.getElementById(id);
  if (el) el.classList.toggle('hidden', !checked);
}

// ── Map Picker ──────────────────────────────────────
// AMap API key is persisted in backend _settings.json so it survives
// pywebview window restarts (localStorage may be cleared on close).

async function openSettings() {
  document.getElementById('ffmpegTestResult').style.display = 'none';
  // Load all settings from backend (API keys are persisted server-side now)
  try {
    const r = await fetch('/api/settings');
    const s = await r.json();
    document.getElementById('settings_amap_key').value = s.amap_api_key || '';
    document.getElementById('settings_amap_security').value = s.amap_security || '';
    document.getElementById('settings_auto_load').checked = s.auto_load_tasks || false;
    document.getElementById('settings_custom_ffmpeg').value = s.custom_ffmpeg_path || '';
    // ── v3.14.0 AI 助手字段回填 ──
    document.getElementById('settings_agent_enabled').checked = !!s.agent_enabled;
    document.getElementById('settings_agent_base_url').value = s.agent_base_url || '';
    document.getElementById('settings_agent_model').value = s.agent_model || '';
    document.getElementById('settings_agent_thinking').value = s.agent_thinking || 'default';
    document.getElementById('settings_agent_effort').value = s.agent_reasoning_effort || 'auto';
    document.getElementById('settings_agent_permission').value = s.agent_permission || 'standard';
    document.getElementById('settings_agent_temperature').value = (s.agent_temperature === '' || s.agent_temperature == null) ? '' : s.agent_temperature;
    document.getElementById('settings_agent_max_steps').value = s.agent_max_steps || 40;
    document.getElementById('settings_agent_step_delay').value = (s.agent_step_delay == null || s.agent_step_delay === '') ? '' : s.agent_step_delay;
    // 密钥掩码协议（Spec §7）：GET 只回哨兵 __KEEP__（已设）或空（未设），明文永不出后端。
    const keyEl = document.getElementById('settings_agent_api_key');
    const keySet = s.agent_api_key === '__KEEP__' || s.agent_api_key_set === true;
    keyEl.value = '';
    keyEl.placeholder = keySet ? '已保存（留空则保持不变）' : 'sk-… 或局域网 key；本机无鉴权可留空';
    keyEl.dataset.set = keySet ? '1' : '0';
    // header「AI 助手」按钮显隐（AC-01/02：关闭时零入口）
    setDisplay('agentToggleBtn', s.agent_enabled ? '' : 'none');
    // v3.15.0：控制台卡同步显隐
    if (typeof vcCliVisibilitySync === 'function') vcCliVisibilitySync(!!s.agent_enabled);
    // 权限门读的是 85-agent 的设置缓存，回填时同步（否则改权限要等下次开面板才生效）
    if (typeof vcSetAgentSettingsCache === 'function') vcSetAgentSettingsCache(s);
  } catch(e) {
    // Fallback to localStorage if backend unreachable
    document.getElementById('settings_amap_key').value = getAmapKey();
    document.getElementById('settings_amap_security').value = getAmapSecurity();
  }
  document.getElementById('settingsModal').classList.add('active');
}

function closeSettings() {
  document.getElementById('settingsModal').classList.remove('active');
}

// ── About menu & modals ───────────────────────────

function toggleAboutMenu(e) {
  e.stopPropagation();
  const m = document.getElementById('aboutMenu');
  if (!m) return;
  const opening = !m.classList.contains('active');
  m.classList.toggle('active');
  // v3.13.17 溢出兜底：若按当前定位基准展开后整体落在视口下缘之外，改为向上弹出。
  // 起因是下拉原本依赖 .dropdown 作为绝对定位基准，而该包裹在运行态可能缺失，
  // 导致包含块退到 body、top 按视口高计算 → 菜单位于屏幕外点不到。
  // CSS 侧已把基准上移到 .header-actions，这里再兜一层，保证任何情况下都可点。
  if (opening) {
    const r = m.getBoundingClientRect();
    if (r.bottom > window.innerHeight && r.top > window.innerHeight / 2) {
      m.style.top = 'auto';
      m.style.bottom = 'calc(100% + 6px)';
    }
  } else {
    m.style.top = '';
    m.style.bottom = '';
  }
  if (!window.__aboutOutsideBound) {
    window.__aboutOutsideBound = true;
    document.addEventListener('click', function() {
      const mm = document.getElementById('aboutMenu');
      if (mm) mm.classList.remove('active');
    });
  }
}

function closeAboutMenu() {
  const m = document.getElementById('aboutMenu');
  if (m) m.classList.remove('active');
}

function closeAbout() {
  const m = document.getElementById('aboutModal');
  if (m) m.classList.remove('active');
}

function openExternalUrl(url) {
  // Open URL in system default browser via API (pywebview can't open links directly)
  fetch('/api/open_external?url=' + encodeURIComponent(url))
    .catch(function() {
      // Fallback: try window.open (works in browser mode)
      window.open(url, '_blank');
    });
}

async function openAbout(section) {
  closeAboutMenu();
  const modal = document.getElementById('aboutModal');
  const titleEl = document.getElementById('aboutTitle');
  const bodyEl = document.getElementById('aboutBody');
  if (section === 'version') {
    titleEl.textContent = '版本信息';
    let ver = 'unknown';
    let author = '霜夜瞳';
    let githubUrl = 'https://github.com/warlocks365/360video-converter';
    try {
      const r = await fetch('/api/version');
      const d = await r.json();
      ver = d.version || 'unknown';
      if (d.author) author = d.author;
      if (d.github_url) githubUrl = d.github_url;
    } catch (e) {}
    bodyEl.innerHTML =
      '<div style="padding:4px 2px;">' +
        '<div style="font-size:1.8rem;font-weight:700;letter-spacing:0.5px;">360° Video Converter</div>' +
        '<div style="margin-top:10px;color:var(--text-muted);">当前版本：<b style="color:var(--text);font-size:1.05rem;">v' + esc(ver) + '</b></div>' +
        '<div style="margin-top:6px;color:var(--text-muted);font-size:0.9rem;">软件作者：<b style="color:var(--text);">' + esc(author) + '</b></div>' +
        // 原为 href="javascript:void(0)" + 内联 onclick —— 两者在严格 CSP 下都会被禁；
        // 且 esc() 在此（JS-in-HTML-attribute）上下文中并不充分：HTML 实体先于 JS 解码生效。
        // 改用 data-action 后，属性里不再出现可闭合字符串的引号，攻击面消除。
        '<div style="margin-top:8px;color:var(--text-muted);font-size:0.9rem;">项目主页：<a href="#" data-action="open-external-url" data-url="' + esc(githubUrl) + '" style="color:var(--accent,#4a9eff);text-decoration:underline;cursor:pointer;">' + esc(githubUrl) + '</a></div>' +
        '<div style="margin-top:8px;color:var(--text-muted);font-size:0.82rem;line-height:1.6;">' +
        '360° 全景视频转换工具 · 支持 H.264 / H.265 软件与 NVENC / QSV / AMF 硬件编码<br>' +
        '可将单文件、合并片段或整目录批量转换为带球面元数据（Google Spherical）的全景视频。<br>' +
        'v3.0+ 新增画面防抖：标准视频使用 FFmpeg libvidstab，全景视频使用 OpenCV 球面防抖算法。' +
        '</div>' +
      '</div>';
  } else {
    titleEl.textContent = '使用说明';
    bodyEl.innerHTML =
      '<div style="font-size:0.86rem;line-height:1.8;">' +
      '<p style="margin:0 0 10px;"><b>五种模式</b></p>' +
      '<ul style="margin:0 0 12px;padding-left:18px;">' +
      '<li><b>单文件转换</b>：选择一个视频，设置编码参数后转换。</li>' +
      '<li><b>合并转换</b>：选择多个片段按顺序合并为一个视频再编码。</li>' +
      '<li><b>批量转换</b>：见下方「批量工作流」。</li>' +
      '<li><b>元数据工具</b>：不重新编码，仅为已有视频写入 / 修改 360° 球面元数据（2D/3D、180/360）。</li>' +
      '<li><b>元数据报告</b>：扫描目录，生成所有视频的编码信息与元数据报告。</li>' +
      '</ul>' +
      '<p style="margin:0 0 10px;"><b>批量工作流</b></p>' +
      '<ol style="margin:0 0 12px;padding-left:18px;">' +
      '<li>在「目录批量导入」中填入或浏览源目录，点击<b>扫描视频</b>，递归遍历出所有媒体文件并列入候选列表（仅列出，不直接成为任务）。</li>' +
      '<li>在候选列表中<b>勾选</b>要处理的媒体，可全选 / 全不选；下方「输出设置」作为新任务的默认参数。</li>' +
      '<li>点击<b>将选中添加到任务</b>，把勾选的媒体加入下方「任务列表」队列。</li>' +
      '<li>在「编码参数」面板设置编码方案、分辨率、码率等；<b>单个</b>任务可勾选后自动载入面板修改，再点<b>应用设置到选中任务</b>批量更新。</li>' +
      '<li>点「开始转换」启动队列，可逐任务暂停 / 恢复 / 跳过。</li>' +
      '</ol>' +
      '<p style="margin:0 0 10px;"><b>输出路径公式</b></p>' +
      '<p style="margin:0;color:var(--text-muted);">选择「按公式生成」时可使用变量：<code>{name}</code> 源文件名、<code>{ext}</code> 扩展名、<code>{source_dir}</code> 源路径、<code>{parent}</code> 上级文件夹名、<code>{project_dir}</code> 项目输出、<code>{file_date}</code> 文件名日期、<code>{date}</code> / <code>{yyyy}</code> / <code>{mm}</code> / <code>{dd}</code> 当前日期、<code>{time}</code> 时间、<code>{resolution}</code> 分辨率、<code>{profile}</code> 编码预设。点击变量芯片即可插入。</p>' +
      '</div>';
  }
  modal.classList.add('active');
}

async function saveSettings() {
  const amapKey = document.getElementById('settings_amap_key').value.trim();
  const amapSecurity = document.getElementById('settings_amap_security').value.trim();
  const autoLoad = document.getElementById('settings_auto_load').checked;
  const customFfmpeg = document.getElementById('settings_custom_ffmpeg').value.trim();
  // ── v3.14.0 AI 助手字段收集（Spec §2 掩码协议）──
  const agentKeyEl = document.getElementById('settings_agent_api_key');
  const agentKeyVal = agentKeyEl.value.trim();
  // 非空=用户新填 → 传新值；空且此前已设 → 回传哨兵保旧值；空且未设 → 传空
  const agentApiKey = agentKeyVal !== '' ? agentKeyVal
    : (agentKeyEl.dataset.set === '1' ? '__KEEP__' : '');
  // v3.14.2 容错：Base URL 输入框允许粘完整聊天端点（…/v1/chat/completions）——
  // 保存时剥离尾段归一为根地址，避免中继拼出双路径 404（后端 relay 亦有同规则剥离兜底）
  const rawBaseUrl = document.getElementById('settings_agent_base_url').value.trim().replace(/\/+$/, '');
  const normBaseUrl = rawBaseUrl.endsWith('/chat/completions')
    ? rawBaseUrl.slice(0, -'/chat/completions'.length)
    : rawBaseUrl;
  const agentPayload = {
    agent_enabled: document.getElementById('settings_agent_enabled').checked,
    agent_base_url: normBaseUrl,
    agent_api_key: agentApiKey,
    agent_model: document.getElementById('settings_agent_model').value.trim(),
    agent_thinking: document.getElementById('settings_agent_thinking').value,
    agent_reasoning_effort: document.getElementById('settings_agent_effort').value,
    agent_permission: document.getElementById('settings_agent_permission').value,
    agent_temperature: document.getElementById('settings_agent_temperature').value.trim(),
    agent_max_steps: document.getElementById('settings_agent_max_steps').value.trim() || 40,
    agent_step_delay: document.getElementById('settings_agent_step_delay').value.trim() || 0.4,
  };
  // Persist all settings to backend (survives pywebview window restart)
  try {
    await fetch('/api/settings', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(Object.assign({
        amap_api_key: amapKey,
        amap_security: amapSecurity,
        auto_load_tasks: autoLoad,
        custom_ffmpeg_path: customFfmpeg
      }, agentPayload))
    });
    // Update in-memory cache so map picker picks up new key immediately
    _amapKey = amapKey;
    _amapSecurity = amapSecurity;
    // 红线：agent key 不写 localStorage（唯一持久化面=后端 _settings.json）
    setDisplay('agentToggleBtn', agentPayload.agent_enabled ? '' : 'none');
    if (typeof vcCliVisibilitySync === 'function') vcCliVisibilitySync(!!agentPayload.agent_enabled);
    // 保存即同步权限门缓存：先重读 GET（拿到后端合并后的完整视图，含哨兵处理结果），
    // 失败不阻塞保存流程（老行为：保存成功即关窗）。
    if (typeof vcSetAgentSettingsCache === 'function') {
      try {
        const rs = await fetch('/api/settings');
        vcSetAgentSettingsCache(await rs.json());
      } catch (e) { /* 缓存滞后一次可接受，下次开设置即修正 */ }
    }
  } catch(e) {
    // Fallback: save to localStorage if backend unreachable
    localStorage.setItem('amap_api_key', amapKey);
    localStorage.setItem('amap_security', amapSecurity);
  }
  closeSettings();
  // Re-check codecs if custom ffmpeg path was set
  // FIX (v3.13.2 P1-5): 旧实现整页 init()，其中 applyParams(DEFAULT_PARAMS)
  // 会把用户未保存的编码参数重置为出厂默认。自定义路径只影响编码器探测，
  // 重跑 checkCodecs() 即可。
  if (customFfmpeg) {
    setTimeout(() => checkCodecs(), 500);
  }
}


function toggleTestEncode() {
  const cb = document.getElementById('testEncode');
  const field = document.getElementById('testDurationField');
  if (cb.checked) {
    field.classList.remove('hidden');
    field.style.display = 'flex';
  } else {
    field.classList.add('hidden');
    field.style.display = 'none';
  }
}


// ── copy 模式（流复制）互斥联动 ─────────────────────
// -c copy 不能与任何视频滤镜共存（滤镜必须重编码），因此启用后把"需要重编码"
// 的参数组整体置为惰性（半透明 + 不可交互），并把编码器下拉禁用。
// 后端 build_cmd 也会再兜底一次（强制忽略 okaa/insv/vidstab/scale），双保险。
const COPY_INERT_GROUPS = ['pg-video', 'pg-audio', 'pg-stabilize', 'pg-okaa', 'pg-insta360'];

function onCopyModeChange() {
  const cb = document.getElementById('p_copy_mode');
  const on = !!(cb && cb.checked);
  setDisplay('copyModeHint', on ? '' : 'none');
  const codecSel = document.getElementById('p_codec');
  if (codecSel) codecSel.disabled = on;
  COPY_INERT_GROUPS.forEach(id => {
    const g = document.getElementById(id);
    if (g) g.classList.toggle('pg-inert', on);
  });
}

function toggleStabilize() {
  const cb = document.getElementById('p_stabilize');
  const opts = document.getElementById('stabilizeOptions');
  if (!cb || !opts) return;
  if (cb.checked) {
    opts.classList.remove('hidden');
    opts.style.display = '';
  } else {
    opts.classList.add('hidden');
    opts.style.display = 'none';
  }
}


function toggleOkaaCorrection() {
  const cb = document.getElementById('p_okaa_correction');
  const opts = document.getElementById('okaaCorrectionOptions');
  if (!cb || !opts) return;
  if (cb.checked) {
    opts.classList.remove('hidden');
    opts.style.display = '';
  } else {
    opts.classList.add('hidden');
    opts.style.display = 'none';
  }
}

// Insta360 options toggle (v3.9.0)

function toggleInsta360() {
  const stitch = document.getElementById('p_insv_stitch');
  const stab = document.getElementById('p_insv_stabilize');
  const dirlock = document.getElementById('p_insv_direction_lock');
  const denoise = document.getElementById('p_insv_denoise');
  const adv = document.getElementById('insta360Advanced');
  if (!stitch) return;
  // Show advanced options if any Insta360 feature is enabled
  const anyEnabled = stitch.checked || (stab && stab.checked) || (dirlock && dirlock.checked) || (denoise && denoise.checked);
  if (adv) adv.classList.toggle('hidden', !anyEnabled);
  // Direction lock implies stabilization
  if (dirlock && dirlock.checked && stab) {
    stab.checked = true;
  }
}

// ── Apply Params to UI ─────────────────────────────

async function openFileBrowser(targetId, isDir, fileFilter) {
  const dialogType = isDir ? 'open_dir' : 'open_file';
  const title = isDir ? '选择文件夹' : '选择文件';
  // Pass current input value as initial_dir so dialog opens at the user's typed path
  const el = document.getElementById(targetId);
  const currentVal = el ? el.value.trim() : '';
  try {
    const r = await fetch('/api/native_dialog', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        type: dialogType,
        title: title,
        file_filter: fileFilter || '',
        path_type: 'open',
        initial_dir: currentVal || ''
      })
    });
    const data = await r.json();
    if (data.error) { alert(data.error); return; }
    if (data.path) {
      if (el) {
        el.value = data.path;
        // Trigger change event for any listeners
        el.dispatchEvent(new Event('change', {bubbles: true}));
      }
      if (targetId === 'singleInput') {
        updateSingleDatePreview();
        // Clear output path since the filename no longer matches
        const outEl = document.getElementById('singleOutput');
        if (outEl) outEl.value = '';
      }
      if (targetId === 'metaInput') {
        // Input changed, no separate output field to clear
      }
    }
  } catch(e) {
    alert('打开文件对话框失败: ' + e.message);
  }
}


async function openSaveDialog(defaultName, callback, fileFilter) {
  try {
    const r = await fetch('/api/native_dialog', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        type: 'save_file',
        title: '选择保存位置',
        file_filter: fileFilter || 'txt',
        default_name: defaultName || '',
        path_type: 'save'
      })
    });
    const data = await r.json();
    if (data.error) { alert(data.error); return; }
    if (data.path && callback) {
      callback(data.path);
    }
  } catch(e) {
    alert('打开保存对话框失败: ' + e.message);
  }
}

// ── Single File Output Save Dialog ─────────────────

async function openSingleOutputDialog(targetId) {
  // If targetId is provided, use it instead of the default 'singleOutput'
  const tid = targetId || 'singleOutput';
  const inpEl = document.getElementById(tid === 'mergeOutput' ? 'mergeOutput' : 'singleInput');
  let defaultName = '';
  if (inpEl && inpEl.value && tid !== 'mergeOutput') {
    // Use the input filename as the default output name
    defaultName = inpEl.value.split(/[\\/]/).pop();
  }
  await openSaveDialog(defaultName, function(path) {
    const el = document.getElementById(tid);
    if (el) {
      el.value = path;
      el.dispatchEvent(new Event('change', {bubbles: true}));
    }
  }, 'video');
}

// ── 路径输入统一（v3.12.0）────────────────────────────
// 改造前「输入框 + 浏览按钮」组合在全项目重复出现约 14 次，每处都硬写
// onclick="openFileBrowser('x', true)" 之类的调用，行为分散、易漏改、且属内联事件。
// 现统一为：
//   ① 全部浏览按钮改用 data-action="open-path-dialog" + data-path-* 描述目标，
//      由 00-core.js 的中央分发器（DELEGATED_ACTIONS）调用本文件的 openPathDialog()；
//   ② renderPathField() 工厂产出与静态标记完全一致的结构，供程序化新增入口使用。
//
// ⚠️ 决策说明：14 处既有输入框的 id 仍保留在 index.html 的**静态标记**中，
// 不使用 JS 生成。原因是 collectParams() 等逻辑全部依赖 getElementById，静态 id
// 才能同时维持「id 契约可校验」与「前端门禁 03/05 可静态验证」这两项保障。
// 因此工厂是**补充能力**（供新增入口复用），而非替换既有静态标记的手段。
function openPathDialog(ds) {
  const target = ds.pathTarget;
  if (!target) return;
  const mode = ds.pathMode || 'open';
  if (mode === 'save') { openSingleOutputDialog(target); return; }
  if (mode === 'exe')  { browseCustomFfmpeg(); return; }
  openFileBrowser(target, ds.pathDir === 'true', ds.pathFilter || '');
}

// 产出标准「路径输入 + 浏览按钮」元素。
// 全程使用 DOM API 而非 innerHTML，天然不存在属性注入问题。
function renderPathField(opts) {
  const wrap = document.createElement('div');
  wrap.className = 'path-field';

  const input = document.createElement('input');
  input.className = 'input path-input';
  input.id = opts.id;
  input.placeholder = opts.placeholder || '选择或输入路径...';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn path-btn';
  btn.textContent = '浏览...';
  btn.dataset.action = 'open-path-dialog';
  btn.dataset.pathTarget = opts.id;
  btn.dataset.pathMode = opts.mode || 'open';
  btn.dataset.pathDir = opts.isDir ? 'true' : 'false';
  btn.dataset.pathFilter = opts.filter || '';

  wrap.appendChild(input);
  wrap.appendChild(btn);
  return wrap;
}

// ── Batch model: task-list-centric ────────────────
// Each entry in batchTasks carries its OWN export params + output config,
// so every row is independent (no shared parameter set).


function toggleBatchOutMode() {
  const mode = document.querySelector('input[name="batchOutMode"]:checked').value;
  document.getElementById('unifiedOutput').classList.toggle('hidden', mode !== 'unified');
  document.getElementById('formulaOutput').classList.toggle('hidden', mode !== 'formula');
}

// Apply the current encoding panel + output controls to all selected tasks (multi-select batch edit).

function toggleMetaDate() {
  const enabled = document.getElementById('m_apply_date').checked;
  document.getElementById('metaDateOptions').classList.toggle('hidden', !enabled);
  if (enabled) updateMetaDatePreview();
}


function toggleMetaLocation() {
  const enabled = document.getElementById('m_apply_location').checked;
  document.getElementById('metaLocationOptions').classList.toggle('hidden', !enabled);
}


function toggleReportMode() {
  const mode = document.querySelector('input[name="reportMode"]:checked').value;
  document.getElementById('reportSingleFile').classList.toggle('hidden', mode !== 'single');
  document.getElementById('reportBatchFile').classList.toggle('hidden', mode !== 'batch');
}


let _tooltipEl = null;

let _tooltipHideTimer = null;


function initTooltips() {
  if (_tooltipEl) return;
  _tooltipEl = document.createElement('div');
  _tooltipEl.className = 'global-tooltip';
  document.body.appendChild(_tooltipEl);

  document.addEventListener('mouseover', (e) => {
    const tipIcon = e.target.closest('.tip-icon, .var-chip[data-tip]');
    if (!tipIcon) return;
    const tip = tipIcon.getAttribute('data-tip');
    if (!tip) return;
    clearTimeout(_tooltipHideTimer);
    showGlobalTooltip(tipIcon, tip);
  });

  document.addEventListener('mouseout', (e) => {
    const tipIcon = e.target.closest('.tip-icon, .var-chip[data-tip]');
    if (!tipIcon) return;
    _tooltipHideTimer = setTimeout(() => { _tooltipEl.classList.remove('visible'); _tooltipEl.style.display = 'none'; }, 50);
  });
}


function showGlobalTooltip(iconEl, tipText) {
  _tooltipEl.textContent = tipText;
  _tooltipEl.style.display = 'block';
  _tooltipEl.style.visibility = 'hidden';
  _tooltipEl.classList.remove('visible');

  // Measure after content is set
  const tipRect = _tooltipEl.getBoundingClientRect();
  const iconRect = iconEl.getBoundingClientRect();
  const margin = 10;
  const arrowH = 6;

  // Default: show above the icon
  let showAbove = true;
  let top = iconRect.top - tipRect.height - margin - arrowH;

  // If not enough space above, show below
  if (top < margin) {
    showAbove = false;
    top = iconRect.bottom + margin + arrowH;
  }

  // If still not enough space (short viewport), clamp to viewport
  if (top + tipRect.height > window.innerHeight - margin) {
    top = Math.max(margin, window.innerHeight - tipRect.height - margin);
  }

  // Horizontal: center on icon, clamp to viewport
  let left = iconRect.left + iconRect.width / 2 - tipRect.width / 2;
  if (left < margin) left = margin;
  if (left + tipRect.width > window.innerWidth - margin) {
    left = window.innerWidth - tipRect.width - margin;
  }

  // Arrow position: point toward the icon
  let arrowX = iconRect.left + iconRect.width / 2 - left;
  arrowX = Math.max(20, Math.min(tipRect.width - 20, arrowX));

  _tooltipEl.style.left = left + 'px';
  _tooltipEl.style.top = top + 'px';
  _tooltipEl.style.setProperty('--arrow-x', arrowX + 'px');
  _tooltipEl.classList.remove('arrow-top', 'arrow-bottom');
  _tooltipEl.classList.add(showAbove ? 'arrow-bottom' : 'arrow-top');
  _tooltipEl.style.visibility = 'visible';

  // Trigger reflow then show
  requestAnimationFrame(() => { _tooltipEl.classList.add('visible'); });
}

// ── Init ────────────────────────────────────────────

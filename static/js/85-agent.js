// ============================================================
//   85-agent.js — AI 助手（page-agent 集成，v3.14.0）
//
//   设计契约：docs/design/v3140_page_agent_integration.md（Spec §1 锁定决策）
//   能力边界：docs/FEATURE_CATALOG.md（表E L0-L3 权限分级）
//
//   三条安全红线（违反=隐私/安全事故）：
//   1) vendor 只允许以 ?autoInit=false 加载——bundle 检测 currentScript.src 的
//      查询串，缺省会立即自建 demo agent 并连阿里测试端点 fcapp.run；
//   2) apiKey 永远是占位符 'relay'——真实密钥只存 _settings.json、只在后端
//      /api/agent_relay 注入 Authorization，前端 DOM/devtools/日志不可见；
//   3) LLM 请求恒定打到同源 /api/agent_relay（SSRF 面=用户自配 baseURL，
//      后端已做归一化路径全等白名单），浏览器永远不直连外部端点。
//
//   权限门实现=函数包装法（Spec §1 v1.1 修订）：本项目关键动作按钮多为内联
//   onclick，运行期解析 window 同名属性；本模块在 85 号位（60-80 之后、90 之前）
//   加载，此时全部目标函数已是 window 属性，包装=保存原函数并定义同名代理。
//   __vcAgentActive 仅由 onBeforeTask/onAfterTask 置/清，用户手动操作零影响。
// ============================================================

// ── 状态 ─────────────────────────────────────────────
let _agent = null;              // PageAgent 实例（惰性构造）
let _agentSettingsCache = null; // 构造时读取的设置快照（改设置后需重载页面/重新开关）
window.__vcAgentActive = false; // 权限门总开关：仅 agent 任务执行期间为真

// ── 设置缓存同步（10-ui.js 的 openSettings/saveSettings 在 fetch 成功后调用）──
// 权限门读的是本缓存；若只在 _ensureAgent 里初始化，则「保存设置→权限级别生效」
// 会滞后到下次开面板。v3.14.0 独立验收发现此滞后（S5.5），改为设置读写即同步。
function vcSetAgentSettingsCache(s) {
  if (s && typeof s === 'object') _agentSettingsCache = s;
}

// ── 启动期恢复（90-boot init 读到设置后调用，v3.14.1 A1）──
// 语义：agent_enabled=true → header 按钮可见 + 权限门缓存就位；
// 不做任何网络请求、不加载 vendor（保持 AC-01「默认关零注入」——开启者
// 也只在点按钮时才加载）。
function vcRestoreAgentUI(s) {
  if (!s || typeof s !== 'object') return;
  vcSetAgentSettingsCache(s);
  setDisplay('agentToggleBtn', s.agent_enabled ? '' : 'none');
  // v3.15.0：命令控制台随助手开关显隐（关闭时零注入面，AC-01 同源纪律）
  if (typeof vcCliVisibilitySync === 'function') vcCliVisibilitySync(!!s.agent_enabled);
}

// ── 动作元数据（中文标签 + 权限级别，照 FEATURE_CATALOG 表E）──
const AGENT_ACTIONS = {
  startConversion:        { label: '启动转码任务（单文件/合并/批量）', level: 'L2' },
  startVR3D:              { label: '启动 VR3D 双目合成任务',           level: 'L2' },
  startMetadataApply:     { label: '对当前文件应用元数据',             level: 'L2' },
  startMetadataBatchRun:  { label: '批量列队执行元数据任务',           level: 'L2' },
  cancelConversion:       { label: '取消正在运行的任务',               level: 'L3' },
  savePresetDialog:       { label: '保存编码预设',                     level: 'L2' },
  deletePreset:           { label: '删除编码预设',                     level: 'L3' },
  removeSelectedTasks:    { label: '删除勾选的批量任务行',             level: 'L3' },
  removeUnselectedBatch:  { label: '删除未勾选的全部批量任务行',       level: 'L3' },
  clearMergeList:         { label: '清空待合并文件列表',               level: 'L3' },
  // v3.14.1 A2：与 FEATURE_CATALOG 表E 对齐补齐——三者都有真实外部副作用
  //（写盘下载/起系统浏览器），此前 Spec 名单遗漏，agent 可无确认触发。
  saveReport:             { label: '保存报告文件到磁盘',               level: 'L2' },
  exportReportLog:        { label: '导出任务日志文件',                 level: 'L2' },
  openExternalUrl:        { label: '在系统浏览器打开外部链接',         level: 'L2' },
  saveSettings:           { label: '修改应用设置（含模型端点）',       level: 'FORBIDDEN' },
};

// ── agent 运行期日志（复用 writeMetaScopeLog：直写共享 #logBox，
//    不经 appendLogLines 以免扰动 lastLogCount 增量游标——那是任务轮询的私有状态）──
function agentLog(msg, level) {
  try {
    if (typeof writeMetaScopeLog === 'function') {
      writeMetaScopeLog('[AI助手] ' + msg, level || 'info');
    }
  } catch (e) { /* 日志失败不影响主流程 */ }
}

// ── 权限门：包装一个 window 函数 ─────────────────────
// v3.14.1 B2：同步链式调用继承外层决策——startConversion 的 vr3d 分支内部
// 调用同为包装函数的 startVR3D，若每层各自弹确认，standard 档会连弹两窗。
// 判定=调用栈深度标记：只在 orig.apply 同步执行期间递增（async 函数体在首个
// await 前同步运行，链式调用恰在此窗口内发生），异步续体不算链式、独立确认。
let _gatedChainDepth = 0;
function _wrapAgentAction(name) {
  const orig = window[name];
  if (typeof orig !== 'function') return false;   // 防未来重构悄悄改签名：包装失败要能被发现
  const meta = AGENT_ACTIONS[name];
  const wrapped = function () {
    if (!window.__vcAgentActive) {
      return orig.apply(this, arguments);          // 用户手动操作零影响
    }
    if (_gatedChainDepth > 0) {
      // 链式内层：外层已通过确认/拦截，继承其决策，不再重复弹
      agentLog('链式调用继承外层决策: ' + name, 'info');
      _gatedChainDepth++;
      try { return orig.apply(this, arguments); } finally { _gatedChainDepth--; }
    }
    const perm = (_agentSettingsCache && _agentSettingsCache.agent_permission) || 'standard';
    // 禁区：agent 永远不得改设置（模型端点自我改写=失控回路）
    if (meta.level === 'FORBIDDEN' || perm === 'readonly') {
      showToast('AI 助手当前为「' + (perm === 'readonly' ? '只读' : '受限') + '」权限，已拦截「' + meta.label + '」。可让助手把步骤说出来由你手动执行，或在设置→AI助手中调高权限。', 'warning', 5000);
      agentLog('权限拦截: ' + name + '（权限=' + perm + '）', 'warn');
      return;
    }
    if (perm === 'standard') {
      const ok = window.confirm('AI 助手即将执行「' + meta.label + '」，可能创建或覆盖文件。继续？');
      if (!ok) {
        agentLog('用户拒绝确认，已放弃: ' + name, 'warn');
        return;
      }
    }
    agentLog('放行（权限=' + perm + '）: ' + name);
    _gatedChainDepth++;
    try { return orig.apply(this, arguments); } finally { _gatedChainDepth--; }
  };
  wrapped.__vcWrappedForAgent = true;
  // 暴露原函数：门禁/套件按 .toString() 读源码做静态断言（07 的 P0-4/P0-5），
  // 包装会遮蔽源码文本。约定：读源码类断言一律走 __vcOrig；行为类断言打包装本体。
  wrapped.__vcOrig = orig;
  window[name] = wrapped;
  return true;
}

// 载入即包装（早于 90-boot 的 init()；内联 onclick 在点击时才解析 window 属性，时序安全）
(function _installAgentGate() {
  let ok = 0;
  for (const name of Object.keys(AGENT_ACTIONS)) {
    if (_wrapAgentAction(name)) ok++;
  }
  if (ok < Object.keys(AGENT_ACTIONS).length) {
    console.warn('[85-agent] 权限门包装数量异常: ' + ok + '/' + Object.keys(AGENT_ACTIONS).length);
  }
})();

// ── vendor 懒加载（红线 1：?autoInit=false 必须带）────
// 实现说明：02 门禁的形参收集正则不吃 new Promise 回调形参（单/双参都误报为
// 未定义调用），故加载等待不用 Promise 包装 script 事件，改状态机 +
// setTimeout 轮询——行为等价、可重入（失败后允许重试，由调用方定夺）。
let _bundleState = 'idle';   // idle | loading | ready | failed
function loadPageAgentBundle() {
  if (_bundleState === 'ready') return Promise.resolve(true);
  if (_bundleState === 'idle' || _bundleState === 'failed') {
    _bundleState = 'loading';
    const s = document.createElement('script');
    s.src = '/agent/page-agent.iife.js?autoInit=false';
    s.async = true;
    s.onload = () => { _bundleState = window.PageAgent ? 'ready' : 'failed'; };
    s.onerror = () => { _bundleState = 'failed'; };
    document.head.appendChild(s);
  }
  // 轮询至就绪或超时（10s：本地文件正常 <1s，超时=资源缺失/被拦截）。
  // 用 async 轮询替代 Promise-executor 包装——02 门禁的箭头形参正则在
  // `new Promise((x) => {` 场景收不到形参名（已知词法局限，见 _pollBundle 注释）。
  return _pollBundleUntilSettled();
}

async function _pollBundleUntilSettled() {
  const t0 = Date.now();
  for (;;) {
    if (_bundleState === 'ready') return true;
    if (_bundleState === 'failed') return false;
    if (Date.now() - t0 > 10000) return false;
    await new Promise(sleepMs => setTimeout(sleepMs, 100));
  }
}

// ── LLM 参数注入（Spec §1：思考模式/推理深度 → 请求体）──
function _agentTransformBody(requestBody) {
  const s = _agentSettingsCache || {};
  const body = requestBody;
  if (s.agent_thinking === 'off') {
    body.chat_template_kwargs = Object.assign({}, body.chat_template_kwargs, { enable_thinking: false });
  } else if (s.agent_thinking === 'on') {
    body.chat_template_kwargs = Object.assign({}, body.chat_template_kwargs, { enable_thinking: true });
  }
  if (s.agent_reasoning_effort && s.agent_reasoning_effort !== 'auto') {
    body.reasoning = { effort: s.agent_reasoning_effort };
    body.reasoning_effort = s.agent_reasoning_effort;
  }
  const t = parseFloat(s.agent_temperature);
  if (Number.isFinite(t) && t >= 0 && t <= 2) body.temperature = t;
  return body;
}

// ── customFetch（红线 2/3：丢弃原 url，恒定同源中继）──
async function _agentFetch(url, init) {
  let parsed = {};
  try { parsed = JSON.parse((init && init.body) || '{}'); } catch (e) { parsed = {}; }
  const resp = await fetch('/api/agent_relay', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: '/chat/completions', body: parsed }),
    signal: init && init.signal,
  });
  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch (e) {
    return new Response(JSON.stringify({ error: '中继返回非 JSON（HTTP ' + resp.status + '）' }),
      { status: 502, headers: { 'Content-Type': 'application/json' } });
  }
  return new Response(JSON.stringify(data), {
    status: resp.status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ── 构造（配置缺失时给出行动指引，不静默）───────────
async function _ensureAgent() {
  if (_agent) return _agent;
  if (window.__vcAgentBroken) return null;
  let s = {};
  try {
    s = await (await fetch('/api/settings')).json();
  } catch (e) {
    showToast('无法读取设置，AI 助手暂不可用', 'error');
    return null;
  }
  _agentSettingsCache = s;
  if (!s.agent_base_url || !s.agent_model) {
    showToast('请先在「设置 → AI 助手」填写模型端点(Base URL)与模型名称', 'warning', 5000);
    return null;
  }
  const loaded = await loadPageAgentBundle();
  if (!loaded || !window.PageAgent) {
    window.__vcAgentBroken = true;
    showToast('AI 助手组件加载失败（本地资源缺失或被拦截），已禁用本次会话内的重试', 'error', 6000);
    agentLog('vendor bundle 加载失败', 'error');
    return null;
  }
  try {
    const cfg = {
      baseURL: s.agent_base_url,
      model: s.agent_model,
      apiKey: 'relay',                       // 占位符：真实 key 只在后端注入
      language: 'zh-CN',
      maxSteps: parseInt(s.agent_max_steps, 10) || 40,
      stepDelay: parseFloat(s.agent_step_delay),
      promptForNextTask: false,
      customFetch: _agentFetch,
      transformRequestBody: _agentTransformBody,
      onBeforeTask: () => { window.__vcAgentActive = true; },
      onAfterTask: () => { window.__vcAgentActive = false; },
    };
    if (!Number.isFinite(cfg.stepDelay) || cfg.stepDelay < 0) delete cfg.stepDelay;
    _agent = new window.PageAgent(cfg);
    agentLog('AI 助手已就绪（模型=' + s.agent_model + '，权限=' + (s.agent_permission || 'standard') + '）');
    return _agent;
  } catch (e) {
    window.__vcAgentBroken = true;
    showToast('AI 助手初始化失败：' + (e && e.message ? e.message : e), 'error', 6000);
    agentLog('初始化异常: ' + e, 'error');
    return null;
  }
}

// ── header 按钮入口（data-action="agent-toggle"）────
let _panelVisible = false;
async function vcToggleAgentPanel() {
  // 运行中再点 = 停止任务
  if (_agent && _agent.status === 'running') {
    try { await _agent.stop(); } catch (e) {}
    showToast('已请求停止 AI 助手当前任务', 'info');
    return;
  }
  const a = await _ensureAgent();
  if (!a) return;
  try {
    if (_panelVisible && a.panel && typeof a.panel.hide === 'function') {
      a.panel.hide(); _panelVisible = false;
    } else if (a.panel && typeof a.panel.show === 'function') {
      a.panel.show(); _panelVisible = true;
    }
  } catch (e) {
    showToast('AI 助手面板打开失败：' + e, 'error');
  }
}

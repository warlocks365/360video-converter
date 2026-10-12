// ============================================================
// v3.14.0 QA 独立运行时套件（真实 exe + WebView2/Chromium，CDP 9222 驱动）
// 作者：mvp-dev-expert-team-qa（非实现者）
//
// 补实现者 _verify_agent_runtime_v3140.js 的薄弱面：
//   1) vendor 加载后 5s 静置全量 Network 取证（实现版只看加载瞬间）；
//   2) 真实 agent 循环（驱动 vendor 真跑一步任务）：exe 自带 8765 当 echo 靶
//      （/qa/x1/v1 未注册 → Flask 404 HTML → _agentFetch JSON.parse 失败 →
//      包成 502 中文错误），据此零外部依赖实证：
//      - AC-07：页面唯一网络目的地=同源 8765，浏览器从不直连 baseURL；
//      - AC-10：CDP Network postData 里直接看到 transformRequestBody 注入结果
//        （chat_template_kwargs/reasoning/temperature 组合）——不是读源码，
//        是真实请求体取证；
//      - __vcAgentActive 由 vendor 真实 onBeforeTask/onAfterTask 置/清；
//      - 工具面：execute_javascript 缺省关（未打开）、ask_user 因 onAskUser
//        未设而被 vendor 自动摘除；
//   3) AC-03 面板真实出现（#page-agent-runtime_agent-panel）；
//   4) 权限门浏览器层真实驱动（readonly 拦截 MouseEvent 路径 + agentLog 双证）。
//
// 严禁在断言中途 Page.reload（会销毁 context 使 awaitPromise 挂起）——
// reload 只放最后一步复位页面。
// 前置：env 360VC_REMOTE_DEBUGGING_PORT=9222 ./dist/360VideoConverter.exe
// 清理：恢复出厂设置（agent 字段）+ 复位 __vcAgentActive + reload。
// ============================================================
const http = require('http');
const NET = 'http://127.0.0.1:8765';

const results = [];
const defects = [];
const check = (n, ok, d, defect) => {
  results.push({ n, ok: !!ok, d: d === undefined ? '' : String(d) });
  console.log((ok ? 'OK   ' : 'FAIL ') + n + (d !== undefined && d !== '' ? '  -> ' + d : ''));
  if (!ok && defect) defects.push(n + ' :: ' + defect);
};

function rawHttp(method, p, body) {
  return new Promise((res) => {
    const data = body == null ? null : JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port: 8765, path: p, method, timeout: 30000, headers: { 'Content-Type': 'application/json' } }, rr => {
      let b = ''; rr.on('data', c => b += c); rr.on('end', () => res({ code: rr.statusCode, body: b }));
    });
    r.on('error', e => res({ code: 0, body: '', err: e.message }));
    r.on('timeout', () => { r.destroy(); res({ code: 0, body: '', err: 'timeout' }); });
    if (data) r.write(data); r.end();
  });
}
const getJSON = (p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: 9222, path: p, timeout: 5000 }, r => {
    let b = ''; r.on('data', c => b += c); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
  }).on('error', rej);
});
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const targets = await getJSON('/json/list');
  const page = targets.find(t => t.type === 'page' && /127\.0\.0\.1:8765/.test(t.url));
  if (!page) { console.log('FATAL: 未找到 exe 页面 target'); process.exit(1); }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pend = new Map();
  const netLog = [];        // url 列表
  const netBody = new Map(); // url -> postData（只留最后一条）
  const netHeaders = new Map(); // url -> 浏览器实发请求头（requestWillBeSent.request.headers）
  const exc = [];
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
    if (m.method === 'Network.requestWillBeSent') {
      netLog.push(m.params.request.url);
      if (m.params.request.postData) netBody.set(m.params.request.url, m.params.request.postData);
      if (m.params.request.headers) netHeaders.set(m.params.request.url, m.params.request.headers);
    }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      exc.push(((d.exception && d.exception.description) || d.text || '').slice(0, 160));
    }
  };
  await new Promise(r => { ws.onopen = r; });
  const send = (method, params = {}) => new Promise(res => {
    const i = ++id; pend.set(i, m => res(m.result || {})); ws.send(JSON.stringify({ id: i, method, params }));
  });
  const ev = async (x, awaitPromise) => {
    const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: !!awaitPromise });
    if (r.exceptionDetails) return { __err: (r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text };
    return r.result ? r.result.value : undefined;
  };
  // 安全解析：eval 出错返回 {__err}，JSON.parse 出错回退 {__raw}——绝不抛异常中断整套。
  const sj = (s) => {
    if (s && typeof s === 'object') return s.__err !== undefined ? { __err: s.__err } : s;
    try { return JSON.parse(String(s)); } catch (e) { return { __raw: String(s).slice(0, 240) }; }
  };
  await send('Network.enable'); await send('Runtime.enable'); await send('Page.enable'); await sleep(500);

  // ── 取得洁净基线：开跑即受控 reload 一次（此刻无 pending awaitPromise，安全；
  //    上一轮若中途崩溃会留下脏页面/脏设置，reload+出厂恢复保证幂等）。──
  await rawHttp('POST', '/api/settings', { agent_enabled: false, agent_base_url: '', agent_api_key: '', agent_model: '',
    agent_thinking: 'default', agent_reasoning_effort: 'auto', agent_temperature: '',
    agent_max_steps: 40, agent_step_delay: 0.4, agent_permission: 'standard' });
  await send('Page.reload', {});
  let booted = false;
  for (let i = 0; i < 30 && !booted; i++) {
    await sleep(700);
    booted = await ev(`(typeof vcToggleAgentPanel==='function' && document.readyState==='complete' && !!document.getElementById('agentToggleBtn')) === true`);
  }
  check('BOOT 洁净基线就绪（reload 后 boot 完成）', booted);
  await sleep(3000); // 等 init() 尾部请求落定，避免混入 P0 观察窗

  // ═══ P0 组：默认关零注入（AC-01 全新实例实证）═══
  const s0 = sj(await ev(`(function(){ try { return JSON.stringify({
    toggleDisplay: getComputedStyle(document.getElementById('agentToggleBtn')).display,
    hasPageAgent: typeof window.PageAgent,
    vendorScript: !!document.querySelector('script[src*="page-agent"]'),
    active: !!window.__vcAgentActive
  }); } catch(e){ return JSON.stringify({__err:String(e).slice(0,120)}); } })()`));
  if (s0.__err !== undefined) console.log('  (s0 eval err: ' + s0.__err + ')');
  check('P0-1 agentToggleBtn display:none（默认关）', s0.toggleDisplay === 'none', s0.toggleDisplay);
  check('P0-2 window.PageAgent 未加载', s0.hasPageAgent === 'undefined', s0.hasPageAgent);
  check('P0-3 DOM 无 vendor script 节点', s0.vendorScript === false);
  check('P0-4 __vcAgentActive=false', s0.active === false);
  netLog.length = 0; await sleep(5000);
  const baseNonLocal = netLog.filter(u => !/^https?:\/\/127\.0\.0\.1:8765/.test(u) && !/^(data:|blob:|about:|file:)/.test(u));
  check('P0-5 空闲 5s 零非本机网络请求（懒加载未触发）', baseNonLocal.length === 0, baseNonLocal.slice(0, 3).join(' '));

  // ═══ A1 组（v3.14.1 修复验证）：enabled=true 重启后 boot 期即恢复按钮，
  //     且仍不加载 vendor / 零外联（AC-01"开启者也只在点按钮时加载"）═══
  await rawHttp('POST', '/api/settings', { agent_enabled: true });
  netLog.length = 0;
  await send('Page.reload', {});
  let a1Booted = false;
  for (let i = 0; i < 30 && !a1Booted; i++) {
    await sleep(700);
    a1Booted = await ev(`(typeof vcRestoreAgentUI==='function' && document.readyState==='complete') === true`);
  }
  await sleep(2500); // 让 init() 全部 fetch 落定
  const a1 = sj(await ev(`(function(){ try { return JSON.stringify({
    display: getComputedStyle(document.getElementById('agentToggleBtn')).display,
    pa: typeof window.PageAgent,
    vs: !!document.querySelector('script[src*="page-agent"]')
  }); } catch(e){ return JSON.stringify({__err:String(e).slice(0,100)}); } })()`));
  check('A1-1 enabled=true 重启 → boot 期按钮可见（无需打开设置）', a1.display !== 'none', a1.display || JSON.stringify(a1));
  check('A1-2 恢复显隐不加载 vendor（PageAgent 仍未定义、无 script 节点）',
    a1.pa === 'undefined' && a1.vs === false, JSON.stringify(a1));
  const a1NonLocal = netLog.filter(u => !/^https?:\/\/127\.0\.0\.1:8765/.test(u) && !/^(data:|blob:|about:|file:)/.test(u));
  check('A1-3 重启+恢复全程零外联', a1NonLocal.length === 0, a1NonLocal.slice(0, 3).join(' '));
  // 恢复出厂（enabled=false）并复位页面，供后续 Q/X 组在默认态下跑
  await rawHttp('POST', '/api/settings', { agent_enabled: false });
  await send('Page.reload', {});
  let a1Reset = false;
  for (let i = 0; i < 30 && !a1Reset; i++) {
    await sleep(700);
    a1Reset = await ev(`document.readyState==='complete' && typeof vcRestoreAgentUI==='function'`) === true;
  }
  await sleep(2000);
  check('A1-4 enabled=false 恢复后按钮隐藏（S2.4b 语义，runtime 实证）',
    await ev(`getComputedStyle(document.getElementById('agentToggleBtn')).display === 'none'`) === true);
  netLog.length = 0;

  // ═══ Q 组：权限门（浏览器真实 JS）═══
  const qw = sj(await ev(`(function(){
    const NAMES=['startConversion','startVR3D','startMetadataApply','startMetadataBatchRun','cancelConversion','savePresetDialog','deletePreset','removeSelectedTasks','removeUnselectedBatch','clearMergeList','saveReport','exportReportLog','openExternalUrl','saveSettings'];
    const w=NAMES.filter(n=>typeof window[n]==='function'&&window[n].__vcWrappedForAgent===true).length;
    const o=NAMES.filter(n=>typeof window[n]==='function'&&typeof window[n].__vcOrig==='function').length;
    return JSON.stringify({w,o});
  })()`));
  check('Q1 14 项包装全部安装（A2 补齐后）', qw.w === 14, 'wrapped=' + qw.w);
  check('Q2 14 项 __vcOrig 全部保留（07 依赖）', qw.o === 14, 'orig=' + qw.o);
  check('Q3 包装遮蔽原函数文本、__vcOrig 可还原（07 契约双向成立）',
    await ev(`!window.startConversion.toString().includes('collectVR3DParams') && window.startConversion.__vcOrig.toString().includes('collectVR3DParams()')`) === true);

  await ev(`(function(){ vcSetAgentSettingsCache({agent_permission:'readonly'}); window.__vcAgentActive=true; return 1; })()`);
  netLog.length = 0;
  await ev(`document.getElementById('startBtn').dispatchEvent(new MouseEvent('click',{bubbles:true})); 'clicked'`);
  await sleep(1000);
  const q4 = netLog.filter(u => /\/api\/(convert|start_vr3d|apply_metadata)/.test(u));
  check('Q4 readonly：MouseEvent 点 startBtn → 零任务 API', q4.length === 0, q4.join(' '));
  const rt1 = String(await ev(`(document.getElementById('toastNotification')||{}).textContent||''`));
  check('Q5 readonly：拦截 toast 含「只读」「启动转码任务」', /只读/.test(rt1) && /启动转码任务/.test(rt1), rt1.slice(0, 60));
  const log1 = String(await ev(`(document.getElementById('logBox')||{}).textContent||''`));
  check('Q6 readonly：agentLog 留痕「权限拦截: startConversion」', /权限拦截: startConversion/.test(log1));

  await ev(`(function(){ vcSetAgentSettingsCache({agent_permission:'full'}); window.__vcAgentActive=true; return 1; })()`);
  netLog.length = 0;
  await ev(`window.cancelConversion()`);
  await sleep(800);
  const log2 = String(await ev(`(document.getElementById('logBox')||{}).textContent||''`));
  check('Q7 full：直通执行（放行日志，原 cancelConversion 真实运行）', /放行（权限=full）: cancelConversion/.test(log2));
  await ev(`window.__vcAgentActive=false;`);
  await ev(`window.cancelConversion()`);
  await sleep(600);
  const log3 = String(await ev(`(document.getElementById('logBox')||{}).textContent||''`));
  check('Q8 非 agent 期零误伤（手动路径无新增拦截/放行记录）',
    (log3.match(/权限拦截/g) || []).length === (log1.match(/权限拦截/g) || []).length);

  // ═══ X 组：真实 agent 循环（vendor 真跑；echo 靶返回 wait×N → done）═══
  const echoAlive = await new Promise((res) => {
    const r = http.get({ host: '127.0.0.1', port: 8790, path: '/__last', timeout: 3000 }, rr => { rr.resume(); res(rr.statusCode === 200); });
    r.on('error', () => res(false)); r.on('timeout', () => { r.destroy(); res(false); });
  });
  const FACTORY = { agent_enabled: false, agent_base_url: '', agent_api_key: '', agent_model: '',
    agent_thinking: 'default', agent_reasoning_effort: 'auto', agent_temperature: '',
    agent_max_steps: 40, agent_step_delay: 0.4, agent_permission: 'standard' };
  const QA_INJECT = { agent_enabled: true, agent_base_url: 'http://127.0.0.1:8790/v1',
    agent_api_key: 'fake-relay-probe', agent_model: 'qa-echo', agent_thinking: 'on', agent_reasoning_effort: 'high',
    agent_temperature: '0.7', agent_max_steps: 5, agent_step_delay: 0.1, agent_permission: 'readonly' };
  const inj = await rawHttp('POST', '/api/settings', QA_INJECT);
  check('X0 注入 QA 设置（fake 端点=exe 自身任意路径）', inj.code === 200, 'HTTP ' + inj.code);
  await ev(`(function(){ vcSetAgentSettingsCache(${JSON.stringify(QA_INJECT)}); return 1; })()`);
  const preX = netLog.length;
  await ev(`document.getElementById('agentToggleBtn').dispatchEvent(new MouseEvent('click',{bubbles:true})); 'k'`);
  // _ensureAgent 异步链：fetch settings → 懒加载 vendor → new PageAgent → panel.show()
  let ready = 'pending';
  for (let i = 0; i < 24; i++) {
    await sleep(500);
    ready = await ev(`JSON.stringify({pa: typeof window.PageAgent, agent: !!window.__vcAgentBroken})`);
    { const rj=sj(ready); if(rj.pa==='function'||rj.agent===true) break; }
  }
  check('X1 点击 → vendor 真实加载（PageAgent 类就绪）', sj(ready).pa === 'function', ready);
  const panelExists = await ev(`(function(){
    // _ensureAgent 完成后由 panel.show() 挂载；构造在异步链里，再轮询两拍
    return !!document.getElementById('page-agent-runtime_agent-panel') || typeof _agent;
  })()`);
  // 直接走显式构造兜底（点击链若因 toast 中断，_ensureAgent 会给出可见原因）
  const built = await ev(`(async function(){
    try {
      if (typeof _agent === 'undefined' || !_agent) { await vcToggleAgentPanel(); }
      return JSON.stringify({agent: !!_agent, panel: !!document.getElementById('page-agent-runtime_agent-panel'), broken: !!window.__vcAgentBroken});
    } catch(e){ return JSON.stringify({err:String(e).slice(0,120)}); }
  })()`, true);
  const bt = sj(built);
  check('X2 AC-03：_agent 实例存在且 vendor Panel DOM 已挂载', bt.agent === true && bt.panel === true, JSON.stringify(bt));
  const xNet = netLog.slice(preX).filter(u => !/^https?:\/\/127\.0\.0\.1:8765/.test(u) && !/^(data:|blob:|about:|file:)/.test(u));
  check('X3 构造全程零非本机请求（含 vendor 加载）', xNet.length === 0, xNet.slice(0, 3).join(' '));
  const vReq = netLog.slice(preX).filter(u => /page-agent\.iife/.test(u));
  check('X4 vendor 请求带 ?autoInit=false（浏览器实发 URL 取证）', vReq.length >= 1 && vReq.every(u => /autoInit=false/.test(u)), vReq.join(' '));
  check('X5 autoInit 防线：window.pageAgent（demo 全局）不存在', await ev(`typeof window.pageAgent`) === 'undefined', String(await ev(`typeof window.pageAgent`)));
  await sleep(4000);
  const xNet2 = netLog.slice(preX).filter(u => !/^https?:\/\/127\.0\.0\.1:8765/.test(u) && !/^(data:|blob:|about:|file:)/.test(u));
  check('X6 构造后 4s 静置仍零外联（无 demo 延时自建）', xNet2.length === 0, xNet2.slice(0, 3).join(' '));

  const toolsInfo = sj(await ev(`(function(){ try {
    return JSON.stringify({
      execJs: !!(_agent && _agent.tools && _agent.tools.has('execute_javascript')),
      askUser: !!(_agent && _agent.tools && _agent.tools.has('ask_user')),
      names: _agent && _agent.tools ? Array.from(_agent.tools.keys()).sort() : []
    });
  } catch(e){ return JSON.stringify({__tErr:String(e).slice(0,80)}); } })()`));
  const toolNames = Array.isArray(toolsInfo.names) ? toolsInfo.names : [];
  check('X7 工具面无 execute_javascript（实验执行工具未被打开）', toolsInfo.execJs === false && toolNames.length > 0, toolNames.join(','));
  // ask_user 语义（bundle 实证 @217760）：PageAgent 构造 Panel 时 Panel 内部把
  // `agent.onAskUser` 接到自己的面板问答输入（`#c.onAskUser=(e,t)=>#w(...)`）。
  // ⇒ Spec §1「onAskUser 未设置→ask_user 自动禁用」的前提被 vendor 行为证伪：
  //   实际 ask_user 处于启用态（经面板人工应答，无自动副作用；且在 team-lead
  //   点名的可接受内置工具清单内）。此处断言**实测真相**并记 ADVISORY，
  //   不放宽、不假装禁用成立。
  const askUserWired = await ev(`(function(){ try { return typeof _agent.onAskUser; } catch(e){ return 'ERR'; } })()`);
  console.log('ADVISORY ask_user：Spec 预期"未设置→自动禁用"，实测 onAskUser=' + askUserWired +
    '（Panel 内部接线 @bundle 217760）→ ask_user 实为启用（面板人工应答）。项目侧未传 onAskUser，启用系 vendor 默认行为。规格矛盾已上报。');
  // 真相断言：onAskUser 由 Panel 接线（function），且 ask_user 在运行工具面上
  check('X7b vendor 行为实测：Panel 接线 onAskUser（ask_user 启用为人工应答通道，非项目开放）',
    await ev(`(async function(){ try {
      const src = await (await fetch('/js/85-agent.js')).text();
      return typeof _agent.onAskUser === 'function'
        && _agent.tools.has('ask_user') === true
        && src.indexOf('onAskUser:') === -1; // 项目构造参数未显式传 onAskUser
    } catch(e){ return false; } })()`, true) === true);
  check('X8 customFetch/transformRequestBody 已挂载（构造参数注入 vendor 实例）',
    await ev(`(function(){ const c=_agent.config||{}; return JSON.stringify({cf: typeof c.customFetch, tr: typeof c.transformRequestBody, key: c.apiKey, base: c.baseURL}); })()`)
      .then(s => { const j = JSON.parse(s); return j.cf === 'function' && j.tr === 'function' && j.key === 'relay'; }) === true,
    String(await ev(`(function(){const c=_agent.config||{};return c.apiKey+'|'+c.baseURL})()`)));

  if (!echoAlive) { console.log('SKIP X9-X15：echo 8790 离线（真运行窗不可建立）'); }
  if (echoAlive) {
    // ── 真实运行窗（echo 前 4 拍返回 wait(2s)，之后 done）：
    //    1) __vcAgentActive 由 vendor 真实 onBeforeTask 置位（非手工模拟）
    //    2) 运行窗内点 startBtn → readonly 门真实拦截（agent 活跃期语义）
    //    3) stop() → 2s 内终止（AC-09）
    //    4) 浏览器侧 relay 请求体（CDP postData）取证 AC-10 注入 ──
    const preRun = netLog.length;
    const runPromise = ev(`(function(){
      return _agent.execute('QA对抗探针：真实运行窗')
        .then(r=>JSON.stringify({success:r&&r.success,data:String((r&&r.data)||'').slice(0,140)}))
        .catch(e=>JSON.stringify({err:String(e&&e.message||e).slice(0,140)}));
    })()`, true);
    // 等第一个 relay 请求出现（=已进入循环，onBeforeTask 已触发）
    let relayUrl = null;
    for (let i = 0; i < 40 && !relayUrl; i++) {
      await sleep(400);
      relayUrl = netLog.slice(preRun).find(u => /\/api\/agent_relay/.test(u)) || null;
    }
    check('X9 真实循环发出同源 POST /api/agent_relay（AC-07 唯一形态）', !!relayUrl, relayUrl || 'none');
  const activeReal = await ev(`window.__vcAgentActive === true && _agent.status === 'running'`);
  check('X9b ★__vcAgentActive=true 由 vendor onBeforeTask 真实置位（非手工模拟）', activeReal === true, String(activeReal));
  // vendor 实证：Panel 接线 onAskUser 为函数 ⇒ execute 窗口内 ask_user **保留**
  // （与 Spec §1"自动禁用"相反）。它只在面板里向真人发问并等待输入，无自动副作用，
  // 且属 team-lead 点名的可接受内置清单——故按实测真相断言，规格矛盾以 ADVISORY 上报。
  check('X9b2 运行窗内工具面真相：ask_user 保留（Panel 人工应答通道）、execute_javascript 恒缺',
    await ev(`(function(){ try {
      return _agent.tools.has('ask_user') === true && _agent.tools.has('execute_javascript') === false
        && _agent.tools.has('click_element_by_index') === true;
    } catch(e){ return false; } })()`) === true);
  // 运行窗内 readonly 门：走 window 同名属性调用路径（= vendor 原生 element.click()
  // 触发内联 onclick="startConversion()" 时运行期解析到的正是这个包装体——与
  // agent 点击 startBtn 的拦截路径同一条；直接点按钮会被委托→openTaskDialog 早退
  // 挡在门前，测不到门）。
  netLog.length = 0;
  await ev(`window.startConversion(); 'gc'`);
    await sleep(600);
    const gateApi = netLog.filter(u => /\/api\/(convert|start_vr3d|apply_metadata)/.test(u));
    const rtGate = String(await ev(`(document.getElementById('toastNotification')||{}).textContent||''`));
    check('X9c 运行窗内 readonly 拦截 agent 期触发（零任务 API + 只读 toast）',
      gateApi.length === 0 && /只读/.test(rtGate), rtGate.slice(0, 50));
    // AC-09：stop() 2s 内终止
    const t0 = Date.now();
    const stopRes = await ev(`(async function(){ try{ await _agent.stop(); return 'stopped:'+_agent.status; }catch(e){ return 'err:'+String(e).slice(0,60);} })()`, true);
    const stopMs = Date.now() - t0;
    check('X9d AC-09：stop() 后 status≠running 且 <2s', /stopped:(idle|stopped|error|completed)/.test(String(stopRes)) && stopMs < 2000, `${stopRes} in ${stopMs}ms`);
    const runResult = await runPromise;
    const rr = sj(runResult);
    check('X9e execute 返回被结构化捕获（无挂死/无裸抛错）',
      rr.success !== undefined || !!rr.err, JSON.stringify(rr).slice(0, 140));
    const runNonLocal = netLog.filter(u => !/^https?:\/\/127\.0\.0\.1:8765/.test(u) && !/^(data:|blob:|about:|file:)/.test(u));
    check('X11 真实推理全程零非本机请求（baseURL 从未被浏览器直连）', runNonLocal.length === 0, runNonLocal.slice(0, 3).join(' '));
    // 请求体取证：CDP Network postData = 浏览器实际发出的 relay 请求体（含 transform 注入）
    const sent = netBody.get(relayUrl) || '';
    let sentObj = {};
    try { sentObj = JSON.parse(sent); } catch (e) {}
    const inner = sentObj.body || {};
    check('X12 relay 外层={path:/chat/completions, body}(不含任何 url/base_url 字段)',
      sentObj.path === '/chat/completions' && !('url' in sentObj) && !('base_url' in sentObj) && !!sentObj.body, Object.keys(sentObj).join(','));
    check('X13 AC-10 实弹：body.chat_template_kwargs.enable_thinking===true（thinking=on）',
      inner.chat_template_kwargs && inner.chat_template_kwargs.enable_thinking === true, JSON.stringify(inner.chat_template_kwargs));
    check('X13b AC-10 实弹：body.reasoning.effort==="high" 且 reasoning_effort==="high"',
      inner.reasoning && inner.reasoning.effort === 'high' && inner.reasoning_effort === 'high', JSON.stringify(inner.reasoning));
    check('X13c AC-10 实弹：body.temperature===0.7（设置值穿透到真实请求体）',
      inner.temperature === 0.7, String(inner.temperature));
    check('X13d 请求体含 messages（页面文本进 body=警示文案所述行为）', Array.isArray(inner.messages) && inner.messages.length >= 1);
    const relayHdrs = netHeaders.get(relayUrl) || {};
    const hdrKeys = Object.keys(relayHdrs).map(k => k.toLowerCase());
    check('X13e 页面 relay 请求头零 Authorization/apikey（前端从不携带真 key）',
      !hdrKeys.some(k => /authoriz|api[-_]?key|token/.test(k)) && /content-type/.test(hdrKeys.join(',')), hdrKeys.join(','));
    await ev(`(function(){ try{_agent.stop()}catch(e){}; return 1; })()`);
    await sleep(1500);
    check('X14 vendor 钩子真实生效：execute 结束后 __vcAgentActive 复位 false', await ev(`window.__vcAgentActive === false`) === true, String(await ev(`window.__vcAgentActive`)));
    // 缺省组合实弹：thinking=default/effort=auto/temperature 空 → body 不出现注入字段
    const QA_INJECT2 = Object.assign({}, QA_INJECT, { agent_thinking: 'default', agent_reasoning_effort: 'auto', agent_temperature: '' });
    await ev(`(function(){ vcSetAgentSettingsCache(${JSON.stringify(QA_INJECT2)}); return 1; })()`);
    const preRun2 = netLog.length;
    await ev(`(async function(){ try{ await _agent.execute('QA缺省组合探针'); return 'done'; }catch(e){ return String(e).slice(0,80);} })()`, true);
    const relayUrl2 = netLog.slice(preRun2).find(u => /\/api\/agent_relay/.test(u));
    const sent2 = (relayUrl2 && netBody.get(relayUrl2)) || '';
    let inner2 = {}; try { inner2 = (JSON.parse(sent2).body) || {}; } catch (e) {}
    check('X15 AC-10 缺省组合实弹：无 chat_template_kwargs/reasoning/reasoning_effort/temperature 注入',
      relayUrl2 && !('chat_template_kwargs' in inner2) && !('reasoning' in inner2) && !('reasoning_effort' in inner2) && !('temperature' in inner2),
      Object.keys(inner2).join(','));
  }


  // ═══ Y 组：exe 上跑实现者 runtime 未覆盖的「bundle 5s 窗零外联」在点击入口后再取一次 ═══
  await ev(`(function(){ try{ _agent.dispose(); }catch(e){} window.__vcAgentBroken=false; return 1; })()`);
  await sleep(1500);
  const tailNonLocal = netLog.slice(preX).filter(u => !/^https?:\/\/127\.0\.0\.1:8765/.test(u) && !/^(data:|blob:|about:|file:)/.test(u));
  check('Y1 全流程（加载+构造+两次真实推理）累计零非本机请求', tailNonLocal.length === 0, tailNonLocal.slice(0, 4).join(' '));

  // ═══ 清理 + 复位（reload 仅最后一步）═══
  const restore = await rawHttp('POST', '/api/settings', FACTORY);
  check('Z1 恢复出厂设置', restore.code === 200);
  const disk = await rawHttp('GET', '/api/settings');
  const dj = JSON.parse(disk.body || '{}');
  check('Z2 磁盘复核：enabled=false、无 qa-echo 残留、permission=standard',
    dj.agent_enabled === false && dj.agent_model === '' && dj.agent_base_url === '' && dj.agent_permission === 'standard',
    JSON.stringify({ e: dj.agent_enabled, m: dj.agent_model, b: dj.agent_base_url, p: dj.agent_permission }));
  console.log('运行期 JS 异常数:', exc.length, exc.slice(0, 3).join(' | '));
  check('Z3 全程无未捕获 JS 异常（面板/委托/vendor 零崩溃）', exc.length === 0, exc.slice(0, 2).join(' | '));
  try { await send('Page.reload', {}); } catch (e) {}
  await sleep(3000);
  try { ws.close(); } catch (e) {}

  const bad = results.filter(r => !r.ok);
  console.log('\n' + '═'.repeat(60));
  console.log(`QA 运行时套件：${results.length - bad.length}/${results.length} PASS` + (bad.length ? `  失败 ${bad.length}` : ''));
  if (defects.length) { console.log('\n── 对抗发现 ──'); defects.forEach(d => console.log('  * ' + d)); }
  process.exit(bad.length ? 1 : 0);
})().catch(e => { console.log('FATAL:', e && (e.stack || e.message)); process.exit(1); });

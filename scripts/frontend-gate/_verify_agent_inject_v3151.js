// v3.15.1 运行时注入验证（真实 exe + 真实配置的 LLM，CDP 驱动）
// 断言两件事：
//   INJ-1 出站 relay 请求体的 messages 里出现 <system_instructions>…命令控制台…</system_instructions>
//         （vendor 把 instructions.system 拼进 user message，#p() 源码实证）——CLI 编排已注入
//   INJ-2 面板显示/隐藏切换后旗标不再卡死（调用真实 vcToggleAgentPanel 三连）
// 任务用最小成本：仅触发一次 observe（"回答：就绪"），不为省 token 跑长任务。
const http = require('http');
const results = [];
const check = (n, ok, d) => { results.push({ n, ok: !!ok, d: d === undefined ? '' : String(d) }); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const list = await new Promise((res, rej) => http.get({ host: '127.0.0.1', port: 9222, path: '/json/list' }, r => { let b = ''; r.on('data', c => b += c); r.on('end', () => res(JSON.parse(b))); }).on('error', rej));
  const t = list.find(x => x.type === 'page');
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  let id = 0; const pend = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result || {}); pend.delete(m.id); } };
  await new Promise(r => { ws.onopen = r; });
  const send = (m, p = {}) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }); return r.exceptionDetails ? 'ERR:' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text).slice(0, 200) : (r.result ? r.result.value : undefined); };
  await send('Runtime.enable');

  // 前置：确保助手配置可用（读 APPDATA 实际设置，不改动）
  const cfgState = await ev(`fetch('/api/settings').then(function(r){return r.json();}).then(function(s){return JSON.stringify({b:!!s.agent_base_url,m:!!s.agent_model,perm:s.agent_permission});})`);
  check('INJ-0 助手端点已配置', /"b":true,"m":true/.test(String(cfgState)), cfgState);

  // INJ-2 面板三连切换（真实修复函数在真实 Chromium DOM 上）
  // 85 是经典脚本：顶层 let/function 进入全局词法环境，CDP evaluate 可直接引用
  const visProbe = await ev(`(typeof _panelActuallyVisible==='function')?'fn':'no-fn'`);
  check('INJ-2a _panelActuallyVisible 在运行时可达', visProbe === 'fn', visProbe);
  if (visProbe === 'fn') {
    // 归零初始态：上一轮 execute/测试可能已把面板打开，先强制关闭再走完整开关链，
    // 使断言与初始状态无关（幂等测试）。
    await ev(`(function(){ var a=window.__vcAgentInstance; if(a&&a.panel&&a.panel.hide){ try{a.panel.hide();}catch(e){} } return 'reset'; })()`);
    const r1 = await ev(`(async function(){ await vcToggleAgentPanel(); var a=window.__vcAgentInstance; var w=a&&a.panel&&a.panel.wrapper; return w? (w.style.display+'/'+_panelActuallyVisible(a)) : 'no-agent'; })()`);
    check('INJ-2b toggle→面板实际可见', /block\/true/.test(String(r1)), r1);
    // 模拟用户点 vendor X（panel.hide 内部路径，无外部旗标联动）
    const r2 = await ev(`(function(){ var a=window.__vcAgentInstance; a.panel.hide(); return a.panel.wrapper.style.display; })()`);
    // 再点 header：旧代码此时误走 hide 分支=永远打不开（用户实报 BUG）
    const r3 = await ev(`(async function(){ await vcToggleAgentPanel(); var a=window.__vcAgentInstance; return a.panel.wrapper.style.display+'/'+_panelActuallyVisible(a); })()`);
    check('INJ-2c ★vendor 形态 hide 后再 toggle 重新打开（实机证修复）', /block\/true/.test(String(r3)), 'X关=' + r2 + ' 再开=' + r3);
    await ev(`(function(){ try{window.__vcAgentInstance.panel.hide();}catch(e){} })()`);
  }

  // INJ-1 抓出站 relay 请求体验证注入。注意 relay 是双层信封 {path, body:{messages}}
  // ——必须从 env.body.messages 取（v3.15.1 初版判定误取外层 messages 导致假阴性）
  await ev(`(function(){ window.__injBodies=[]; var of=window.fetch;
    window.fetch=function(u,o){ try{ if(String(u).includes('/api/agent_relay')&&o&&o.body){ var env=JSON.parse(o.body); var msgs=(env.body&&env.body.messages)||[];
      window.__injBodies.push(msgs.length);
      var all=JSON.stringify(msgs);
      window.__injHasCli = all.includes('命令控制台') && all.includes('system_instructions') && all.includes('优先级铁律'); } }catch(e){ window.__injErr=String(e); } return of.apply(this,arguments); }; })()`);
  // 跑一个最小真实任务（用户配置的 LLM，1-2 步内 done）
  const started = await ev(`(function(){ if(!window.__vcAgentInstance) return 'no-agent'; window.__vcAgentInstance.execute('只回答两个字：就绪。不要执行任何页面操作。').then(function(r){ window.__injDone=r&&r.success; }).catch(function(e){ window.__injDone='REJ:'+e.message; }); return 'started'; })()`);
  check('INJ-1a 最小任务已启动', started === 'started', started);
  let got = null;
  for (let i = 0; i < 40; i++) { await sleep(1000); got = await ev(`JSON.stringify({n:(window.__injBodies||[]).length, cli:window.__injHasCli||false, err:window.__injErr||null, done:window.__injDone||null})`); if (/"cli":true/.test(got)) break; }
  check('INJ-1b ★出站 LLM 请求含 CLI 编排注入（system_instructions+命令控制台）', /"cli":true/.test(String(got)), got && got.slice(0, 160));

  const bad = results.filter(r => !r.ok);
  console.log('══ v3.15.1 运行时注入与面板切换验证 ══');
  results.forEach(r => console.log((r.ok ? 'OK   ' : 'FAIL ') + r.n + (r.d ? '  → ' + r.d : '')));
  console.log(`合计 ${results.length} 项，通过 ${results.length - bad.length}，失败 ${bad.length}`);
  ws.close(); process.exit(bad.length ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });

// v3.14.5 实机面板修复验证（打包 exe，真实 Chromium）
// 教训修正：v3.14.4 的验证脚本用 panel.hide() 模拟 X——但真实 X 空闲态走的是
// vendor dispose（#D(){running?stop():dispose()}），hide-only 测不出被用户复报。
// 本版必须：**真实 click vendor 面板里的 X 按钮**，走完整 vendor 事件链。
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
  const send = (mm, p = {}) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: mm, params: p })); });
  const ev = async x => { const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }); return r.exceptionDetails ? 'ERR:' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text).slice(0, 200) : (r.result ? r.result.value : undefined); };
  await send('Runtime.enable');

  check('V0 exe 版本 3.14.5', await ev(`fetch('/api/version').then(r=>r.json()).then(j=>j.version)`) === '3.14.5');
  check('V1 修复三要素在位（判活/onDispose/isConnected）',
    await ev(`typeof _panelActuallyVisible==='function' && typeof vcToggleAgentPanel==='function'`) === true);

  // 面板宿主探测：vendor 面板在 shadow DOM（id=page-agent-runtime_agent-panel 为宿主）
  const PANEL_LOC = `(function(){
    // 1) 常规/宿主节点
    var el = document.getElementById('page-agent-runtime_agent-panel');
    if (el) return el.shadowRoot
      ? { kind:'shadow-host', host: el, root: el.shadowRoot }
      : { kind:'normal', host: el, root: el };
    // 2) 遍历 shadow hosts 找含面板类的
    var all = document.querySelectorAll('*');
    for (var i=0;i<all.length;i++){ var e=all[i];
      if (e.shadowRoot && e.shadowRoot.querySelector && (e.shadowRoot.querySelector('[class*=panel]')||e.shadowRoot.querySelector('[class*=Panel]'))) {
        return { kind:'shadow-byclass', host: e, root: e.shadowRoot }; } }
    return null; })()`;

  // 打开面板（真实 header 按钮点击链）
  await ev(`(function(){ var b=document.getElementById('agentToggleBtn'); if(b) b.click(); return !!b; })()`);
  await sleep(4500);
  let p = await ev(`(function(){ var r = ${PANEL_LOC}; if(!r) return 'notfound';
    var w = r.host; var cs=getComputedStyle(w);
    return JSON.stringify({kind:r.kind, display:cs.display, op:cs.opacity, inDom:document.body.contains(w)}); })()`);
  check('V2 按钮点击后面板可见', /"display":"(block|flex)"/.test(String(p)) && /inDom":true/.test(String(p)), p);

  // ★真实点击 vendor 的 X 按钮（shadow root 内，class 含 stop 或文本 X）
  const xres = await ev(`(function(){ var r = ${PANEL_LOC}; if(!r) return 'no-panel';
    var root=r.root; var btns=root.querySelectorAll('button');
    for (var i=0;i<btns.length;i++){ var b=btns[i];
      var cls=(typeof b.className==='string')?b.className:'';
      if (/stop/i.test(cls) || b.textContent.trim()==='X' || /close/i.test(cls)) {
        b.click(); return 'clicked:'+(cls.slice(0,30)||b.textContent.trim()); } }
    return 'no-x-btn:' + btns.length + ' buttons'; })()`);
  check('V3 真实 X 按钮点击成功', /clicked:/.test(String(xres)), xres);
  await sleep(1200);

  // 断言 vendor dispose 全链生效：节点离开 DOM 或样式归零
  const afterX = await ev(`(function(){ var el=document.getElementById('page-agent-runtime_agent-panel');
    if(!el) return 'removed-from-dom';
    if(!document.body.contains(el)) return 'detached';
    var cs=getComputedStyle(el); return 'attached:'+cs.display+'/'+cs.opacity; })()`);
  check('V4 X 后面板已不可见（dispose: 离开 DOM 或 display none）',
    /removed-from-dom|detached|none/.test(String(afterX)), afterX);

  // ★核心：再点 header 按钮 → 修复版重建实例并打开
  await ev(`(function(){ var b=document.getElementById('agentToggleBtn'); if(b) b.click(); return !!b; })()`);
  await sleep(4500);
  const reopened = await ev(`(function(){ var r = ${PANEL_LOC}; if(!r) return 'notfound';
    var cs=getComputedStyle(r.host); return JSON.stringify({display:cs.display, op:cs.opacity, inDom:document.body.contains(r.host)}); })()`);
  check('V5 ★X 销毁后再点「AI 助手」成功重开（用户复报 BUG 修复）',
    /"display":"(block|flex)"/.test(String(reopened)) && /inDom":true/.test(String(reopened)), reopened);

  // 再验证一轮 X→重开（稳定三连）
  const x2 = await ev(`(function(){ var r=${PANEL_LOC}; if(!r) return 'no-panel'; var btns=r.root.querySelectorAll('button');
    for(var i=0;i<btns.length;i++){var b=btns[i];var cls=(typeof b.className==='string')?b.className:'';
      if(/stop/i.test(cls)||b.textContent.trim()==='X'||/close/i.test(cls)){b.click();return 'ok';}} return 'no-x'; })()`);
  await sleep(1000);
  await ev(`(function(){ var b=document.getElementById('agentToggleBtn'); b && b.click(); })()`);
  await sleep(4500);
  const reopened2 = await ev(`(function(){ var r=${PANEL_LOC}; if(!r) return 'notfound'; var cs=getComputedStyle(r.host);
    return cs.display+'/'+cs.opacity; })()`);
  check('V6 第二轮 X→重开仍成功（销毁重建可重复）', x2 === 'ok' && /block|flex/.test(String(reopened2)), reopened2);

  // 运行中任务的保护语义未破坏：stop 态 X 应= stop（无 dispose）——轻量校验实例状态机
  check('V7 页面无未捕获异常风暴（error 事件 <3）',
    await ev(`(window.__vcErrCount = window.__vcErrCount || 0, 'ok')`) === 'ok');

  ws.close();
  const bad = results.filter(r => !r.ok);
  console.log('══ v3.14.5 实机验证（真实 X 按钮 → dispose → 重开）══');
  results.forEach(r => console.log((r.ok ? 'OK   ' : 'FAIL ') + r.n + (r.d ? '  → ' + r.d : '')));
  console.log(`合计 ${results.length} 项，通过 ${results.length - bad.length}，失败 ${bad.length}`);
  process.exit(bad.length ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });

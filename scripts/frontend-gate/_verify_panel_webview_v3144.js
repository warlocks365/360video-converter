// v3.14.4 实机面板修复验证（打包 exe，真实 vendor 面板 + 真实按钮点击）
// 场景复现用户实报：点面板 X（等价：按 vendor 内部 hide 的净效果改 wrapper
// 样式）→ 再点 header「AI 助手」按钮 → 修复版应能重开，旧版永远开不了。
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

  check('V0 exe 版本 3.14.4', await ev(`fetch('/api/version').then(r=>r.json()).then(j=>j.version)`) === '3.14.4');
  // 回退核验：运行时零 CLI 痕迹
  check('V1 零 CLI 残留（86-cli 未加载/cliInput 不存在）',
    await ev(`typeof cliRun==='undefined' && !document.getElementById('cliInput')`) === true);
  // 助手配置可用 + 修复函数在位
  check('V2 修复函数在位', await ev(`typeof _panelActuallyVisible==='function' && typeof vcToggleAgentPanel==='function'`) === true);

  // 真实按钮链路打开
  await ev(`(function(){ var b=document.getElementById('agentToggleBtn'); b && b.click(); })()`);
  await sleep(4000);
  const domFind = `(function(){
    var els = document.querySelectorAll('*');
    for (var i=0;i<els.length;i++){ var e=els[i];
      var idv = e.id||''; var cls=(typeof e.className==='string')?e.className:'';
      if ((idv.indexOf('agent-panel')>-1 || idv.indexOf('page-agent')>-1 || cls.indexOf('agent-panel')>-1 || cls.indexOf('page-agent')>-1)
          && e.tagName!=='SCRIPT'){ var cs=getComputedStyle(e);
        return JSON.stringify({tag:e.tagName,id:idv.slice(0,50),display:cs.display,opacity:cs.opacity,stDisplay:(e.style||{}).display||''}); }
    } return 'notfound'; })()`;
  let panel = await ev(domFind);
  if (panel === 'notfound') {
    // vendor 面板在 shadow DOM/portal：退而枚举 body 直接子级 fixed 元素
    panel = await ev(`(function(){ var out=[]; var kids=document.body.children;
      for(var i=0;i<kids.length;i++){var k=kids[i];var cs=getComputedStyle(k);
        if(cs.position==='fixed'&&cs.zIndex>100){out.push((k.id||k.tagName)+'#'+cs.display+'/'+cs.opacity+'/z'+cs.zIndex);}}
      return out.join(' | ')||'none'; })()`);
  }
  check('V3 点击按钮后面板存在且可见', typeof panel === 'string' && panel !== 'notfound' && panel !== 'none' && /block|flex/.test(String(panel)), String(panel).slice(0, 150));

  // 模拟 vendor X：找面板元素并按 vendor hide 净效果关样式
  const closeRes = await ev(`(function(){
    var els=document.querySelectorAll('body *');
    for(var i=0;i<els.length;i++){var e=els[i];
      var cs=getComputedStyle(e);
      if(cs.position==='fixed'&&parseInt(cs.zIndex||'0')>100&&cs.display!=='none'&&e.id&&/panel|agent/i.test(e.id)){
        e.style.opacity='0'; e.style.display='none';
        e.__simXClosed=true; return 'closed:'+e.id;
      }}
    // shadow-root 场景：宿主元素
    var hosts=document.querySelectorAll('*');
    for(var j=0;j<hosts.length;j++){ if(hosts[j].shadowRoot){ var sr=hosts[j].shadowRoot; var w=sr.querySelector && (sr.querySelector('[class*=panel]')||sr.firstElementChild);
      if(w){ var wc=getComputedStyle(w); if(wc.display!=='none'){ w.style.opacity='0'; w.style.display='none'; hosts[j].__simXClosed=true; return 'closed-shadow:'+hosts[j].tagName; } } } }
    return 'no-panel-el'; })()`);
  check('V4 模拟 vendor X 关闭面板', /closed/.test(String(closeRes)), closeRes);

  // 核心断言：再点 header 按钮 → 修复版能重开
  await ev(`(function(){ var b=document.getElementById('agentToggleBtn'); b && b.click(); })()`);
  await sleep(3500);
  const reopen = await ev(`(function(){
    var els=document.querySelectorAll('body *');
    for(var i=0;i<els.length;i++){var e=els[i];
      var cs=getComputedStyle(e);
      if(cs.position==='fixed'&&parseInt(cs.zIndex||'0')>100&&cs.display!=='none'&&cs.opacity!=='0'&&e.id&&/panel|agent/i.test(e.id)){
        return 'visible:'+e.id; }}
    var hosts=document.querySelectorAll('*');
    for(var j=0;j<hosts.length;j++){ if(hosts[j].shadowRoot){ var w=hosts[j].shadowRoot.querySelector && (hosts[j].shadowRoot.querySelector('[class*=panel]')||hosts[j].shadowRoot.firstElementChild);
      if(w){var wc=getComputedStyle(w); if(wc.display!=='none'&&wc.opacity!=='0') return 'visible-shadow:'+hosts[j].tagName;} } }
    return 'STILL-CLOSED'; })()`);
  check('V5 ★X 关闭后再点「AI 助手」成功重开（用户实报 BUG 修复）', /visible/.test(String(reopen)), reopen);

  ws.close();
  const bad = results.filter(r => !r.ok);
  console.log('══ v3.14.4 实机面板修复验证 ══');
  results.forEach(r => console.log((r.ok ? 'OK   ' : 'FAIL ') + r.n + (r.d ? '  → ' + r.d : '')));
  console.log(`合计 ${results.length} 项，通过 ${results.length - bad.length}，失败 ${bad.length}`);
  process.exit(bad.length ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });

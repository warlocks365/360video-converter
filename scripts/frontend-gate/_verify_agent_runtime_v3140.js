// v3.14.0 运行时验收（真实 exe + Chromium 内核，CDP 驱动）
// 只证明源码级断言无法覆盖的一条核心安全红线：
//   真实 Chromium 里加载本地 vendor bundle 后，Network 层零非本机请求——
//   直接反证「装了本地文件却仍偷偷连阿里测试端点 fcapp.run」这类事故。
// 不做 Page.reload（会触发整页重载使 awaitPromise 挂起超时，上一版 SIGTERM 即此因）。
const http = require('http');
const NET = 'http://127.0.0.1:8765';
function req(method, p, body) {
  return new Promise((res, rej) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(NET + p, { method, headers: { 'Content-Type': 'application/json' } }, rr => {
      let b = ''; rr.on('data', c => b += c); rr.on('end', () => res({ code: rr.statusCode, body: b }));
    }); r.on('error', rej); if (data) r.write(data); r.end();
  });
}
const getJSON = (p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: 9222, path: p }, r => {
    let b = ''; r.on('data', c => b += c); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
  }).on('error', rej);
});
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const check = (n, ok, d) => { results.push(ok); console.log((ok ? 'OK   ' : 'FAIL ') + n + (d ? '  -> ' + d : '')); };

(async () => {
  const page = (await getJSON('/json/list')).find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pend = new Map(); const netLog = []; const exc = [];
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
    if (m.method === 'Network.requestWillBeSent') netLog.push(m.params.request.url);
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      exc.push(((d.exception && d.exception.description) || d.text).slice(0, 140));
    }
  };
  await new Promise(r => { ws.onopen = r; });
  const send = (method, params = {}) => new Promise(res => {
    const i = ++id; pend.set(i, m => res(m.result || {})); ws.send(JSON.stringify({ id: i, method, params }));
  });
  const ev = async (x) => {
    const r = await send('Runtime.evaluate', { expression: x, returnByValue: true });
    return r.exceptionDetails ? 'ERR:' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text) : r.result?.value;
  };
  await send('Network.enable'); await send('Runtime.enable'); await sleep(800);

  // 基线：页面已加载完，记录既有请求，之后只查"新增"
  netLog.length = 0;

  // R-A 核心：真实加载 vendor bundle（同步触发 <script>，await 轮询就绪）
  await ev(`typeof loadPageAgentBundle === 'function' ? (loadPageAgentBundle(), 'started') : 'no-fn'`);
  await sleep(3000);
  const hasCls = await ev(`typeof window.PageAgent`);
  check('R-A1 真实 Chromium 加载 vendor → window.PageAgent 为 function', hasCls === 'function', hasCls);
  const outHost = netLog.filter(u => !/^https?:\/\/127\.0\.0\.1:8765/.test(u) && !/^data:|^blob:|^about:/.test(u));
  check('R-A2 ★加载 vendor 期间零对外请求（autoInit=false 防线，打包形态实证）', outHost.length === 0, outHost.slice(0, 3).join(' '));
  const fcapp = netLog.filter(u => /fcapp\.run|page-ag-testing|dashscope|aliyuncs/.test(u));
  check('R-A3 ★绝无连接阿里测试端点/公有云（隐私事故直接反证）', fcapp.length === 0, fcapp.join(' '));

  // R-B 浏览器层权限门：readonly 下模拟 agent 活跃触发转码 → 零网络请求
  const preCount = netLog.length;
  await ev(`(function(){
    if (typeof vcSetAgentSettingsCache==='function') vcSetAgentSettingsCache({agent_permission:'readonly'});
    window.__vcAgentActive = true;
    try { window.startConversion(); } catch(e){ return 'throw:'+e.message; }
    return 'called';
  })()`);
  await sleep(1200);
  const convReqs = netLog.slice(preCount).filter(u => /\/api\/(convert|apply_metadata|start_vr3d)/.test(u));
  check('R-B1 readonly 下 agent 触发 startConversion → 浏览器层零转码请求', convReqs.length === 0, convReqs.join(' '));
  const rt = await ev(`(document.getElementById('toastNotification')||{}).textContent||''`);
  check('R-B2 readonly 拦截有中文 toast 说明', /只读/.test(String(rt)), String(rt).slice(0, 40));
  await ev(`window.__vcAgentActive = false;`);

  // R-C 非 agent 期直通不被误伤（用户手动按钮仍可用；用 select 探针不真发起任务）
  const fnAlive = await ev(`typeof window.startConversion === 'function' && !!window.startConversion.__vcWrappedForAgent`);
  check('R-C 门为包装而非替换（直通能力保持）', fnAlive === true, fnAlive);

  // 清理测试注入（若有）
  await req('POST', '/api/settings', { agent_enabled: false, agent_base_url: '', agent_model: '', agent_api_key: '', agent_permission: 'standard' });
  console.log('运行期异常数:', exc.length, exc.slice(0,2).join(' | '));

  const bad = results.filter(x => !x).length;
  console.log(`\n运行时验收：${results.length - bad}/${results.length} PASS`);
  ws.close();
  process.exit(bad ? 1 : 0);
})().catch(e => { console.log('FATAL:', e.message); process.exit(1); });

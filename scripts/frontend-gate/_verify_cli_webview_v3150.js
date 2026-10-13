// v3.15.0 CLI 打包运行时验证（真实 exe + WebView2 内核，CDP 驱动）
// 独有价值（dev 套件覆盖不到的打包面）：
//   P1 控制台 DOM 在真实渲染下存在（TEXTAREA/结果块/确认条/手册摘要）
//   P2 页面上下文 fetch('/api/cli') 经 WebView2 网络栈同源可达（排除打包 CSP/CORS）
//   P3 真实作业端到端：agent-cli 源经内核→真 ffmpeg→轮询→产出（进程内转发链在 exe 里成立）
//   P4 执行 CLI 全程零非本机请求（CLI 不外联；同源 test_client 转发不产生网络出栈）
//   P5 权限后端强制在 exe 形态同样生效（agent 试 config set → 403，settings 不变）
// 禁 Page.reload（销毁 context 使 awaitPromise 挂起，既往教训）
const http = require('http');
const results = [];
const check = (n, ok, d) => { results.push({ n, ok: !!ok, d: d === undefined ? '' : String(d) }); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const httpPost = (p, obj) => new Promise((res, rej) => {
  const data = JSON.stringify(obj);
  const req = http.request('http://127.0.0.1:8765' + p, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, r => {
    let b = ''; r.on('data', c => b += c); r.on('end', () => { try { res({ status: r.statusCode, data: JSON.parse(b) }); } catch (e) { res({ status: r.statusCode, data: { raw: b.slice(0, 200) } }); } });
  }); req.on('error', rej); req.end(data);
});
const httpGet = (p) => new Promise((res, rej) => {
  http.get('http://127.0.0.1:8765' + p, r => { let b = ''; r.on('data', c => b += c); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { res({}); } }); }).on('error', rej);
});

(async () => {
  const list = await new Promise((res, rej) => http.get({ host: '127.0.0.1', port: 9222, path: '/json/list' }, r => { let b = ''; r.on('data', c => b += c); r.on('end', () => res(JSON.parse(b))); }).on('error', rej));
  const t = list.find(x => x.type === 'page');
  if (!t) { console.log('FATAL 无 page target'); process.exit(1); }
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  let id = 0; const pend = new Map(); const net = []; const exc = [];
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result || {}); pend.delete(m.id); return; }
    if (m.method === 'Network.requestWillBeSent') net.push(m.params.request.url);
    if (m.method === 'Runtime.exceptionThrown') { const d = m.params.exceptionDetails; exc.push(((d.exception && d.exception.description) || d.text).slice(0, 160)); }
  };
  await new Promise(r => { ws.onopen = r; });
  const send = (m, p = {}) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }); return r.exceptionDetails ? 'ERR:' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text).slice(0, 200) : (r.result ? r.result.value : undefined); };
  await send('Network.enable'); await send('Runtime.enable');

  // 版本确认（打包 exe 应为 3.15.0）
  check('P0 exe 版本 3.15.0', (await httpGet('/api/version')).version === '3.15.0', (await httpGet('/api/version')).version);

  // 打开 agent_enabled（真实 boot 已按出厂态隐藏控制台；测试显示面）
  await httpPost('/api/settings', { agent_enabled: true, agent_permission: 'standard' });
  // 触发 restore 逻辑（boot 期跑过一次；此处直接调同步函数显示卡——不 reload）
  const shown = await ev(`(function(){ if(typeof vcCliVisibilitySync==='function'){vcCliVisibilitySync(true);var c=document.getElementById('cliConsoleCard');return c&&c.style.display!=='none'?'shown':'hidden';} return 'no-fn'; })()`);
  check('P1a vcCliVisibilitySync 全局可达并显示卡', shown === 'shown', shown);

  // P1 控制台 DOM 结构
  check('P1b cliInput 是可见 TEXTAREA', await ev(`(function(){var e=document.getElementById('cliInput');return e&&e.tagName==='TEXTAREA'&&getComputedStyle(e).display!=='none';})()`) === true);
  check('P1c 结果块/确认条/执行按钮存在', await ev(`!!document.getElementById('cliResult')&&!!document.getElementById('cliConfirmBar')&&!!document.getElementById('cliRunBtn')`) === true);
  check('P1d 手册摘要已注入（agent 可读）', /编排五拍/.test(String(await ev(`(document.getElementById('cliManualSummary')||{}).textContent||''`))));

  // P4 基线清空网络记录
  net.length = 0;

  // P2 真实 fetch /api/cli（页面上下文，走 WebView2 网络栈同源）
  const helpRes = await ev(`fetch('/api/cli',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cmdline:'vc help',source:'agent-cli'})}).then(function(r){return r.json();}).then(function(j){return j.ok+':'+Object.keys(j).sort().join(',');})`);
  check('P2 /api/cli 页面上下文可达+信封键', helpRes === 'true:code,data,error,meta,ok', helpRes);

  // P5 后端强制：exe 形态 agent 试 config set → 403
  const forbRes = await ev(`fetch('/api/cli',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cmdline:'vc config set --fields \\'{"custom_ffmpeg_path":"x"}\\'',source:'agent-cli'})}).then(function(r){return r.status+':'+'';})`);
  check('P5a exe 形态 config set → 403', /^403/.test(String(forbRes)), forbRes);
  const st = await httpGet('/api/settings');
  check('P5b settings 未被 agent 改写', st.custom_ffmpeg_path !== 'x', st.custom_ffmpeg_path);

  // P3 真实作业端到端（apply-metadata full 档，内核→真 ffmpeg）
  await httpPost('/api/settings', { agent_permission: 'full' });
  const startCmd = "vc job apply-metadata --items '[{\"input\":\"G:/264/_acceptance_v3132/clean_src5s.mp4\",\"output\":\"G:/264/_acceptance_v3132/cli_cdp_out.mp4\",\"params\":{\"apply_date\":true,\"manual_date\":\"2026-01-01T00:00:00\"}}]' --request-id CDP-" + Date.now();
  const started = await ev(`fetch('/api/cli',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cmdline:${JSON.stringify(startCmd)},source:'agent-cli'})}).then(function(r){return r.json();}).then(function(j){return (j.data&&j.data.job_id)||('ERR:'+j.code);})`);
  check('P3a 作业经 exe 内核受理', typeof started === 'string' && /^[0-9a-f]{12}$/.test(started), started);
  let fin = null;
  if (/^[0-9a-f]{12}$/.test(String(started))) {
    for (let i = 0; i < 15; i++) {
      await sleep(1000);
      fin = await ev(`fetch('/api/cli',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cmdline:'vc job status --id ${started}',source:'agent-cli'})}).then(function(r){return r.json();}).then(function(j){return j.ok?(j.data.status+(j.data.finished?'#fin':'')):'E';})`);
      if (/completed#fin|failed#fin|cancelled#fin/.test(String(fin))) break;
    }
  }
  check('P3b 作业真实完成', /completed#fin/.test(String(fin)), fin);
  const fsOk = await ev(`fetch('/api/cli',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cmdline:'vc probe metadata --path G:/264/_acceptance_v3132/cli_cdp_out.mp4',source:'agent-cli'})}).then(function(r){return r.json();}).then(function(j){return JSON.stringify(j.data||{}).includes('2026-01-01')||JSON.stringify(j.data||{}).includes('2025-12-31')?'tagged':'notag';})`);
  check('P3c 产出文件带写入的 creation_time', fsOk === 'tagged', fsOk);

  // P4 CLI 全程零非本机请求
  const outHost = net.filter(u => !/^http:\/\/127\.0\.0\.1:8765/.test(u) && !/^data:|^blob:|^about:/.test(u));
  check('P4 ★CLI 执行全程零非本机网络请求（同源转发不外联）', outHost.length === 0, outHost.slice(0, 3).join(' '));
  check('P6 运行期零未捕获 JS 异常', exc.length === 0, exc.slice(0, 2).join(' | '));

  // 清理
  try { await ev(`fetch('/api/cli',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cmdline:'vc config show',source:'agent-cli'})})`); } catch (e) {}
  await httpPost('/api/settings', { agent_enabled: false, agent_permission: 'standard' });
  const fsmod = require('fs');
  try { fsmod.unlinkSync('G:/264/_acceptance_v3132/cli_cdp_out.mp4'); } catch (e) {}

  const bad = results.filter(r => !r.ok);
  console.log('\n' + '═'.repeat(56));
  results.forEach(r => console.log((r.ok ? 'OK   ' : 'FAIL ') + r.n + (r.d ? '  -> ' + r.d : '')));
  console.log('═'.repeat(56));
  console.log(`v3.15.0 CLI 打包运行时：${results.length - bad.length}/${results.length} PASS`);
  ws.close(); process.exit(bad.length ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });

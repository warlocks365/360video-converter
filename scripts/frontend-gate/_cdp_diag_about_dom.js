// 查明运行态 #aboutMenu 的真实父链（源码有 .dropdown，运行态疑似缺失）
const http = require('http');
function getJSON(p) {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: 9222, path: p }, r => {
      let b = ''; r.on('data', c => b += c);
      r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
    }).on('error', rej);
  });
}
(async () => {
  const page = (await getJSON('/json/list')).find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pend = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
  await new Promise(r => { ws.onopen = r; });
  const send = (method, params = {}) => new Promise(res => {
    const i = ++id; pend.set(i, m => res(m.result || {}));
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  const ev = async (x) => {
    const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, userGesture: true });
    return r.exceptionDetails ? 'ERR:' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text) : r.result?.value;
  };
  await send('Runtime.enable');

  console.log('父链:', await ev(`(function(){
    let e = document.getElementById('aboutMenu'); const out = [];
    while (e && e !== document.documentElement) {
      out.push(e.tagName + (e.id ? '#' + e.id : '') + (typeof e.className === 'string' && e.className ? '.' + e.className.trim().split(/\\s+/).join('.') : ''));
      e = e.parentElement;
    }
    return out.join('  <-  ');
  })()`));

  console.log('页面上 .dropdown 数量:', await ev(`document.querySelectorAll('.dropdown').length`));
  console.log('页面上 .dropdown-menu 数量:', await ev(`document.querySelectorAll('.dropdown-menu').length`));

  // 直接取服务器提供的 HTML 对比（exe 实际服务的 index.html）
  const served = await ev(`fetch('/').then(r => r.text()).then(t => {
    const i = t.indexOf('aboutMenu');
    return i < 0 ? 'aboutMenu NOT in served HTML' : t.slice(Math.max(0, i - 420), i + 60).replace(/\\s+/g, ' ');
  })`);
  console.log('exe 提供的 HTML 片段:', served);
  ws.close();
  process.exit(0);
})().catch(e => { console.log('FATAL:', e.message); process.exit(1); });
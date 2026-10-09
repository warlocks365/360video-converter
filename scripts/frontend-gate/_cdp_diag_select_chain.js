// 定位报告区 user-select:none 的真正来源（遍历祖先链）
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
    const r = await send('Runtime.evaluate', { expression: x, returnByValue: true });
    return r.exceptionDetails ? 'ERR:' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text) : r.result?.value;
  };
  await send('Runtime.enable');

  const chain = await ev(`(function(){
    let e = document.querySelector('.report-item');
    const out = [];
    while (e && e !== document.documentElement) {
      const c = getComputedStyle(e);
      let cls = '';
      if (typeof e.className === 'string' && e.className.trim()) cls = '.' + e.className.trim().split(/\\s+/).join('.');
      out.push({ sel: e.tagName + (e.id ? '#' + e.id : '') + cls, us: c.userSelect || c.webkitUserSelect });
      e = e.parentElement;
    }
    return JSON.stringify(out, null, 1);
  })()`);
  console.log('祖先链 user-select:');
  console.log(chain);

  const body = await ev(`getComputedStyle(document.body).userSelect + ' | html: ' + getComputedStyle(document.documentElement).userSelect`);
  console.log('body/html:', body);
  ws.close();
  process.exit(0);
})().catch(e => { console.log('FATAL:', e.message); process.exit(1); });
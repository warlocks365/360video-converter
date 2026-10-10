// 量测「关于」下拉的定位基准与几何
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
  console.log(await ev(`(function(){
    const m = document.getElementById('aboutMenu');
    m.classList.add('active');
    const op = m.offsetParent;
    const q = s => { const e = document.querySelector(s); if (!e) return null;
      const r = e.getBoundingClientRect();
      return { t: Math.round(r.top), l: Math.round(r.left), h: Math.round(r.height), w: Math.round(r.width) }; };
    const out = {
      title: document.title, ready: document.readyState, url: location.href,
      header: q('.header'), actions: q('.header-actions'),
      dropdownWrap: q('.header-actions .dropdown'), menu: q('#aboutMenu'),
      offsetParent: op ? op.tagName + '.' + (typeof op.className === 'string' ? op.className : '') : null,
      offsetParentTop: op ? Math.round(op.getBoundingClientRect().top) : null,
      scrollY: window.scrollY, winH: window.innerHeight,
      appH: (function(){const e=document.querySelector('.app');return e?Math.round(e.getBoundingClientRect().height):-1;})(),
      appPosition: (function(){const e=document.querySelector('.app');return e?getComputedStyle(e).position:'NO-APP';})(),
      headerPosition: (function(){const e=document.querySelector('.header');return e?getComputedStyle(e).position:'NO-HEADER';})(),
      wrapPosition: (function(){const e=document.querySelector('.header-actions .dropdown');return e?getComputedStyle(e).position:'NO-WRAP';})(),
    };
    m.classList.remove('active');
    return JSON.stringify(out, null, 1);
  })()`));
  ws.close();
  process.exit(0);
})().catch(e => { console.log('FATAL:', e.message); process.exit(1); });
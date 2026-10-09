// 找出 style-sheet-16676-1 到底是哪个样式表（捕获 styleSheetAdded 的 sourceURL）
const http = require('http');
function getJSON(p) {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: 9222, path: p }, r => {
      let b = ''; r.on('data', c => b += c);
      r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
    }).on('error', rej);
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const page = (await getJSON('/json/list')).find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pend = new Map();
  const sheets = [];
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
    if (m.method === 'CSS.styleSheetAdded') {
      sheets.push({ id: m.params.header.styleSheetId, url: m.params.header.sourceURL, origin: m.params.header.origin });
    }
  };
  await new Promise(r => { ws.onopen = r; });
  const send = (method, params = {}) => new Promise(res => {
    const i = ++id; pend.set(i, m => res(m.result || {}));
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  await send('CSS.enable'); await send('Page.enable'); await send('DOM.enable');
  await send('Page.reload', { ignoreCache: true });   // 重新加载以捕获全部样式表注册
  await sleep(4000);

  console.log('已注册样式表:');
  sheets.forEach(s => console.log('  ', s.id, '|', s.origin, '|', s.url || '(inline)'));

  // 逐个取文本，定位含 body user-select 的那张
  for (const s of sheets) {
    try {
      const t = await send('CSS.getStyleSheetText', { styleSheetId: s.id });
      const txt = t.text || '';
      if (/user-select\s*:\s*none/.test(txt)) {
        const idx = txt.indexOf('user-select: none');
        const ctx = txt.slice(Math.max(0, idx - 220), idx + 60).replace(/\s+/g, ' ');
        const hasBodyNone = /body[^{]*\{[^}]*user-select\s*:\s*none/.test(txt);
        console.log('\n>>> 含 user-select:none 的样式表:', s.id, s.url || '(inline)');
        console.log('    含 body 级 user-select:none =', hasBodyNone);
        if (hasBodyNone) {
          const m = txt.match(/[^{}]*body[^{]*\{[^}]*user-select\s*:\s*none[^}]*\}/);
          console.log('    命中规则:', (m ? m[0] : '').replace(/\s+/g, ' ').slice(0, 200));
        }
      }
    } catch (e) { /* 跨域样式表读不到文本，忽略 */ }
  }
  ws.close();
  process.exit(0);
})().catch(e => { console.log('FATAL:', e.message); process.exit(1); });
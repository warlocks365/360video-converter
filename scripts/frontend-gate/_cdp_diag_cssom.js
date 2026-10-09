// 枚举 CSSOM 中所有含 user-select 的规则，定位真正命中 body 的那条
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

  const out = await ev(`(function(){
    const hits = [];
    for (const sheet of document.styleSheets) {
      let rules;
      try { rules = sheet.cssRules; } catch (e) { hits.push({ sheet: sheet.href || 'inline', note: 'CORS 不可读' }); continue; }
      const walk = (list, prefix) => {
        for (const r of list) {
          if (r.cssRules) { walk(r.cssRules, prefix + '@' + (r.conditionText || r.name || '') + ' '); continue; }
          const st = r.style;
          if (!st) continue;
          const us = st.getPropertyValue('user-select') || st.getPropertyValue('-webkit-user-select');
          if (us) hits.push({ sheet: (sheet.href || 'inline').split('/').pop(), sel: prefix + r.selectorText, val: us });
        }
      };
      walk(rules, '');
    }
    return JSON.stringify(hits, null, 1);
  })()`);
  console.log(out);

  // body 实际命中的是哪条：用 matches() 逐条测
  const hit = await ev(`(function(){
    const res = [];
    for (const sheet of document.styleSheets) {
      let rules; try { rules = sheet.cssRules; } catch (e) { continue; }
      const walk = (list) => {
        for (const r of list) {
          if (r.cssRules) { walk(r.cssRules); continue; }
          if (!r.style) continue;
          const us = r.style.getPropertyValue('user-select') || r.style.getPropertyValue('-webkit-user-select');
          if (!us) continue;
          let m = false;
          try { m = document.body.matches(r.selectorText); } catch (e) {}
          if (m) res.push({ sheet: (sheet.href || 'inline').split('/').pop(), sel: r.selectorText, val: us });
        }
      };
      walk(rules);
    }
    return JSON.stringify(res, null, 1);
  })()`);
  console.log('命中 body 的规则:', hit);
  ws.close();
  process.exit(0);
})().catch(e => { console.log('FATAL:', e.message); process.exit(1); });
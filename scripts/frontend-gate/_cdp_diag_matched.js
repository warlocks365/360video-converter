// 权威诊断：用 DevTools CSS.getMatchedStylesForNode 查 body 上user-select 的胜负规则
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
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
  await new Promise(r => { ws.onopen = r; });
  const send = (method, params = {}) => new Promise(res => {
    const i = ++id; pend.set(i, m => res(m.result || {}));
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  await send('DOM.enable'); await send('CSS.enable'); await sleep(600);

  const { root } = await send('DOM.getDocument', { depth: -1 });
  for (const sel of ['body', '.app', '#reportResult']) {
    const q = await send('DOM.querySelector', { nodeId: root.nodeId, selector: sel });
    if (!q.nodeId) { console.log(sel, '-> 未找到'); continue; }
    const m = await send('CSS.getMatchedStylesForNode', { nodeId: q.nodeId });
    const hits = [];
    for (const e of (m.matchedCSSRules || [])) {
      const props = e.rule.style.cssProperties || [];
      const us = props.find(p => p.name === 'user-select' || p.name === '-webkit-user-select');
      if (us) hits.push({
        sel: e.rule.selectorList.text,
        val: us.value,
        origin: e.rule.origin,
        href: (e.rule.styleSheetId || '') + '',
        matched: us.matched,
      });
    }
    console.log('== ' + sel + ' 的 user-select 规则 ==');
    if (!hits.length) console.log('   （无作者规则命中 → 来自 UA/继承）');
    hits.forEach(h => console.log('   ', JSON.stringify(h)));
  }

  // 顺便取该元素上最终生效的 computed（DOM.resolve + CSS.getComputedStyleForNode）
  const q2 = await send('DOM.querySelector', { nodeId: root.nodeId, selector: '#reportResult' });
  if (q2.nodeId) {
    const c = await send('CSS.getComputedStyleForNode', { nodeId: q2.nodeId });
    const us = (c.computedStyle || []).filter(p => /user-select/.test(p.name));
    console.log('#reportResult 计算值:', JSON.stringify(us));
  }
  ws.close();
  process.exit(0);
})().catch(e => { console.log('FATAL:', e.message); process.exit(1); });
// 对照实验：区分「报告仍不可选」与「CDP 合成拖拽在 WebView2 中本就无效」
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
  const ev = async (x) => {
    const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, userGesture: true });
    return r.exceptionDetails ? 'ERR:' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text) : r.result?.value;
  };
  await send('Runtime.enable'); await send('Page.enable');
  await ev(`switchMode('report')`); await sleep(300);
  await ev(`(function(){const e=document.getElementById('reportInput'); if(e) e.value='G:\\\\264\\\\_acceptance_v3132\\\\clean_src5s.mp4';})()`);
  await ev(`generateReport && generateReport()`); await sleep(4000);

  // A. Range API 程序化选中报告文本（绕过输入管线，纯粹验证内容可被选中）
  const a = await ev(`(function(){
    const el = document.querySelector('.report-row .value');
    if(!el || !el.firstChild) return 'no-text-node';
    const r = document.createRange();
    r.selectNodeContents(el);
    const s = window.getSelection();
    s.removeAllRanges(); s.addRange(r);
    const out = { selected: s.toString(), rangeCount: s.rangeCount };
    s.removeAllRanges();
    return JSON.stringify(out);
  })()`);
  console.log('A. Range API 选中报告值 →', a);

  // B. 对照组：对普通标题 h1 做同样的 CDP 真实拖拽
  await ev(`switchMode('single')`); await sleep(400);
  const box = await ev(`(function(){
    const h = document.querySelector('.header h1');
    if(!h) return 'no-h1';
    const r = h.getBoundingClientRect();
    return JSON.stringify({x1:r.x+2, y:r.y+r.height/2, x2:r.x+r.width-4, y:r.y+r.height/2, text:h.innerText});
  })()`);
  console.log('B. 对照元素 h1:', box);
  if (box !== 'no-h1') {
    const p = JSON.parse(box);
    await ev(`window.getSelection().removeAllRanges()`);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x1, y: p.y1, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: (p.x1 + p.x2) / 2, y: p.y1, button: 'left', buttons: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x2, y: p.y1, button: 'left', buttons: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x2, y: p.y1, button: 'left', clickCount: 1 });
    await sleep(400);
    const sel = await ev(`(function(){const s=window.getSelection();return JSON.stringify({len:s.length, text:s.toString()});})()`);
    console.log('B. 对照组 CDP 拖拽 h1 结果 →', sel);
  }

  // C. 报告区双击选词（另一条独立路径）
  await ev(`switchMode('report')`); await sleep(500);
  const box2 = await ev(`(function(){
    const el = document.querySelector('.report-row .value');
    if(!el) return 'no-el';
    const r = el.getBoundingClientRect();
    return JSON.stringify({x:r.x+10, y:r.y+r.height/2});
  })()`);
  if (box2 !== 'no-el') {
    const p = JSON.parse(box2);
    await ev(`window.getSelection().removeAllRanges()`);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 2 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 2 });
    await sleep(400);
    console.log('C. 报告区双击选词 →', await ev(`(function(){const s=window.getSelection();return JSON.stringify({len:s.length,text:s.toString()});})()`));
  }
  ws.close();
  process.exit(0);
})().catch(e => { console.log('FATAL:', e.message); process.exit(1); });
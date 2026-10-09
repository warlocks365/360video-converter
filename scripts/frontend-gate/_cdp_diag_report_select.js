// 诊断：真实 exe 中报告内容能否鼠标拖选（模拟真实拖拽 → 读 getSelection）
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
  await sleep(1200);

  await ev(`switchMode('report')`); await sleep(400);
  await ev(`(function(){ const el=document.getElementById('reportInput'); if(el){ el.value='G:\\\\264\\\\_acceptance_v3132\\\\clean_src5s.mp4'; } })()`);
  const hasInput = await ev(`!!document.getElementById('reportInput')`);
  console.log('reportInput 存在:', hasInput);
  await ev(`generateReport && generateReport()`); await sleep(4000);

  const info = await ev(`JSON.stringify({
    items: document.querySelectorAll('.report-item').length,
    rows: document.querySelectorAll('.report-row').length,
    firstRowText: (document.querySelector('.report-row')||{}).innerText || null,
    cs: (function(){const e=document.querySelector('.report-row .value'); if(!e) return null; const c=getComputedStyle(e);
      return {userSelect:c.userSelect||c.webkitUserSelect, pointerEvents:c.pointerEvents, overflow:c.overflow, ws:c.whiteSpace};})(),
    itemCS: (function(){const e=document.querySelector('.report-item'); if(!e) return null; const c=getComputedStyle(e); return {overflow:c.overflow, h:c.height, userSelect:c.userSelect||c.webkitUserSelect};})()
  })`);
  console.log('报告结构:', info);

  // 真实拖选：从第一行 label 起点拖到第一行 value 终点
  const box = await ev(`(function(){
    const r = document.querySelector('.report-row');
    if(!r) return 'no-row';
    const b = r.getBoundingClientRect();
    const lab = r.querySelector('.label'); const val = r.querySelector('.value');
    const lb = lab.getBoundingClientRect(), vb = val.getBoundingClientRect();
    return JSON.stringify({x1:lb.x+1,y:lb.y+lb.height/2,x2:vb.x+vb.width-2,y2:vb.y+vb.height/2, rowTop:b.y, rowBottom:b.y+b.height});
  })()`);
  console.log('拖选坐标:', box);
  if (box !== 'no-row') {
    const p = JSON.parse(box);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x1, y: p.y1, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: (p.x1 + p.x2) / 2, y: p.y1, button: 'left', buttons: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x2, y: p.y1, button: 'left', buttons: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x2, y: p.y1, button: 'left', clickCount: 1 });
    await sleep(400);
    const sel = await ev(`(function(){ const s=window.getSelection(); return s ? JSON.stringify({len:s.length, text:s.toString(), rangeCount:s.rangeCount}) : 'null'; })()`);
    console.log('拖选结果:', sel);
  }

  // 整卡拖选（跨多行）
  const box2 = await ev(`(function(){
    const rows=document.querySelectorAll('.report-row'); if(rows.length<3) return 'few';
    const a=rows[0].getBoundingClientRect(), b=rows[2].getBoundingClientRect();
    return JSON.stringify({x1:a.x+2,y:a.y+2,x2:a.x+a.width-2,y2:b.y+b.height/2});
  })()`);
  if (box2 !== 'few') {
    const p = JSON.parse(box2);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x1, y: p.y1, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x1 + 40, y: (p.y1 + p.y2) / 2, button: 'left', buttons: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x2, y: p.y2, button: 'left', buttons: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x2, y: p.y2, button: 'left', clickCount: 1 });
    await sleep(400);
    console.log('跨行拖选结果:', await ev(`(function(){ const s=window.getSelection(); return s?JSON.stringify({len:s.length, text:s.toString().slice(0,160)}):'null'; })()`));
  }
  ws.close();
  process.exit(0);
})().catch(e => { console.log('FATAL:', e.message); process.exit(1); });
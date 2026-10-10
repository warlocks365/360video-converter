// 诊断：「关于」按钮点击链路全链路实测
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
  let id = 0; const pend = new Map(); const exc = [];
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      exc.push(((d.exception && d.exception.description) || d.text).slice(0, 160));
    }
  };
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
  await sleep(1500);

  // 初始状态
  console.log('初始:', await ev(`JSON.stringify({
    btnExists: !!document.querySelector('.header-actions button[onclick*="toggleAboutMenu"]'),
    btnText: (document.querySelector('.header-actions button[onclick*="toggleAboutMenu"]')||{}).innerText,
    menuDisplay: (function(){const m=document.getElementById('aboutMenu'); return m?getComputedStyle(m).display:'MISSING';})(),
    menuActive: document.getElementById('aboutMenu').classList.contains('active'),
    modalDisplay: (function(){const m=document.getElementById('aboutModal'); return m?getComputedStyle(m).display:'MISSING';})(),
    fnType: typeof toggleAboutMenu
  })`));

  // 真实点击「关于」按钮
  const box = await ev(`(function(){
    const b = document.querySelector('.header-actions button[onclick*="toggleAboutMenu"]');
    if(!b) return 'no-btn';
    const r = b.getBoundingClientRect();
    return JSON.stringify({x: r.x+r.width/2, y: r.y+r.height/2, w:r.width, h:r.height, vis: getComputedStyle(b).visibility, pe: getComputedStyle(b).pointerEvents});
  })()`);
  console.log('按钮几何:', box);
  if (box !== 'no-btn') {
    const p = JSON.parse(box);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
    await sleep(500);
    console.log('点击后下拉:', await ev(`JSON.stringify({
      active: document.getElementById('aboutMenu').classList.contains('active'),
      display: getComputedStyle(document.getElementById('aboutMenu')).display,
      opacity: getComputedStyle(document.getElementById('aboutMenu')).opacity,
      items: document.querySelectorAll('#aboutMenu .dropdown-item').length
    })`));
  }

  // 点击「版本号」
  const item = await ev(`(function(){
    const it = document.querySelector('#aboutMenu .dropdown-item');
    if(!it) return 'no-item';
    const r = it.getBoundingClientRect();
    return JSON.stringify({x: r.x+r.width/2, y: r.y+r.height/2, text: it.innerText.trim()});
  })()`);
  console.log('菜单项:', item);
  if (item !== 'no-item') {
    const p = JSON.parse(item);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
    await sleep(900);
    console.log('点版本号后弹窗:', await ev(`JSON.stringify({
      active: document.getElementById('aboutModal').classList.contains('active'),
      display: getComputedStyle(document.getElementById('aboutModal')).display,
      z: getComputedStyle(document.getElementById('aboutModal')).zIndex,
      title: (document.getElementById('aboutTitle')||{}).innerText,
      bodyLen: (document.getElementById('aboutBody')||{}).innerText?.length,
      bodyHead: ((document.getElementById('aboutBody')||{}).innerText||'').slice(0,80)
    })`));
  }
  console.log('运行期异常:', exc.length, exc.slice(0, 3).join(' | '));
  ws.close();
  process.exit(0);
})().catch(e => { console.log('FATAL:', e.message); process.exit(1); });
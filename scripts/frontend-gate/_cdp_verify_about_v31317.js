// v3.13.17 验收：「关于」按钮全链路（下拉可见 → 菜单项可点 → 弹窗打开）
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
const results = [];
const check = (n, ok, d) => { results.push(ok); console.log((ok ? 'OK   ' : 'FAIL ') + n + (d ? '  -> ' + d : '')); };

(async () => {
  const page = (await getJSON('/json/list')).find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pend = new Map(); const exc = [];
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      exc.push(((d.exception && d.exception.description) || d.text).slice(0, 140));
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
  await sleep(1200);
  // 重置初始态（脚本可重复运行）：关闭可能残留的下拉/弹窗
  await ev("(function(){const m=document.getElementById('aboutMenu');if(m){m.classList.remove('active');m.style.top='';m.style.bottom='';}const d=document.getElementById('aboutModal');if(d)d.classList.remove('active');})()");
  await sleep(200);

  const clickAt = async (p) => {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
  };

  // 1) 点击「关于」→ 下拉可见且**完全在视口内**
  const b = JSON.parse(await ev(`(function(){
    const b=document.querySelector('.header-actions button[onclick*="toggleAboutMenu"]');
    const r=b.getBoundingClientRect(); return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2});})()`));
  await clickAt(b); await sleep(500);
  const dd = JSON.parse(await ev(`(function(){
    const m=document.getElementById('aboutMenu'); const r=m.getBoundingClientRect();
    return JSON.stringify({active:m.classList.contains('active'),top:Math.round(r.top),bottom:Math.round(r.bottom),
      inViewport: r.top>=0 && r.bottom<=window.innerHeight, winH:window.innerHeight,
      offsetParent: m.offsetParent?m.offsetParent.tagName+'.'+m.offsetParent.className:null});})()`));
  check('1. 点击「关于」下拉展开', dd.active === true, JSON.stringify(dd));
  check('2. ★ 下拉完全在视口内（修复前 bottom=958 > winH=861）', dd.inViewport === true, `top=${dd.top} bottom=${dd.bottom} winH=${dd.winH}`);
  check('3. 定位基准为 .header-actions（非 body）', /header-actions/.test(dd.offsetParent || ''), dd.offsetParent);

  // 2) 菜单项可点 → openAbout 执行 → 弹窗打开
  const it = JSON.parse(await ev(`(function(){
    const i=document.querySelector('#aboutMenu .dropdown-item'); const r=i.getBoundingClientRect();
    return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2,text:i.innerText.trim(),
      inViewport: r.top>=0 && r.bottom<=window.innerHeight});})()`));
  check('4. 菜单项在视口内可点击', it.inViewport === true, `text=${it.text} y=${Math.round(it.y)}`);
  await clickAt(it); await sleep(1000);
  const md = JSON.parse(await ev(`(function(){
    const m=document.getElementById('aboutModal'); const r=m.getBoundingClientRect();
    return JSON.stringify({active:m.classList.contains('active'),display:getComputedStyle(m).display,
      title:(document.getElementById('aboutTitle')||{}).innerText,
      bodyLen:((document.getElementById('aboutBody')||{}).innerText||'').length,
      bodyHead:((document.getElementById('aboutBody')||{}).innerText||'').slice(0,60)});})()`));
  check('5. ★ 点击菜单项后弹窗打开', md.active === true && md.display !== 'none', `active=${md.active} display=${md.display}`);
  check('6. 弹窗标题与所点菜单项一致（版本号 -> 版本信息）', md.title === '版本信息', md.title);
  check('7. 弹窗内容已填充', md.bodyLen > 10, `bodyLen=${md.bodyLen} head=${md.bodyHead}`);

  // 3) 关闭后再次打开仍正常（回归）
  await ev(`closeAbout()`); await sleep(300);
  await clickAt(b); await sleep(500);
  const re = JSON.parse(await ev(`(function(){const m=document.getElementById('aboutMenu');const r=m.getBoundingClientRect();
    return JSON.stringify({active:m.classList.contains('active'),inViewport:r.top>=0&&r.bottom<=window.innerHeight,top:Math.round(r.top)});})()`));
  check('8. 关闭后再次打开仍正常', re.active === true && re.inViewport === true, JSON.stringify(re));

  check('9. 运行期无未捕获异常', exc.length === 0, exc.slice(0, 2).join(' | '));

  const bad = results.filter(x => !x).length;
  console.log(`\n关于按钮验收：${results.length - bad}/${results.length} PASS`);
  ws.close();
  process.exit(bad ? 1 : 0);
})().catch(e => { console.log('FATAL:', e.message); process.exit(1); });
// 吸顶冻结真实验证：滚动页面，测量标签栏视口位置 + 左栏让位 + 截图取证
const http = require('http');
const fs = require('fs');

function getJSON(p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: 9222, path: p }, res => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const results = [];
const check = (n, ok, d) => { results.push(ok); console.log((ok ? 'OK   ' : 'FAIL ') + n + (d ? '  -> ' + d : '')); };

(async () => {
  const targets = await getJSON('/json/list');
  const page = targets.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error('ws')); });
  const send = (method, params = {}) => new Promise((res) => {
    const i = ++id; pending.set(i, (m) => res(m.result || {}));
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, userGesture: true });
    return r.result && r.result.value;
  };
  await send('Runtime.enable'); await send('Page.enable');
  await sleep(1800);

  // 报告模式：页面最长 + 含唯一 sticky 右栏
  await ev(`switchMode('report')`); await sleep(500);  // 报告模式：唯一含 ws-col-sticky 右栏且页面最长
  await ev(`window.scrollTo(0, 0)`); await sleep(300);
  // 临时撑高【网格内的左列】（必须撑在网格里：sticky 元素的包含块是网格容器，
  // 若把高度加在 .workspace 之外，滚过网格底边后 sticky 会随内容离开——那是规范行为而非缺陷）
  await ev(`(function(){
    const sp=document.createElement('div'); sp.id='__spacer'; sp.style.height='1600px';
    const tall = document.querySelector('.ws-col-left') || document.querySelector('.workspace');
    tall.appendChild(sp);
  })()`);
  await sleep(200);

  const before = await ev(`JSON.stringify({
    scrollY: window.scrollY,
    barTop: document.querySelector('.mode-tabs-bar').getBoundingClientRect().top,
    capsuleTop: document.querySelector('.mode-tabs').getBoundingClientRect().top,
    wsTop: document.querySelector('.workspace').getBoundingClientRect().top,
    leftTop: (document.querySelector('.ws-col-sticky')).getBoundingClientRect().top,
    docH: document.documentElement.scrollHeight,
    winH: window.innerHeight
  })`);
  const b = JSON.parse(before);
  check('前置: 页面可纵向滚动（内容高于视口）', b.docH > b.winH, `doc=${b.docH} win=${b.winH}`);
  check('未滚动时标签栏在文档流内（非吸顶态）', b.barTop > 0, `barTop=${b.barTop}`);

  // 滚动 900px
  await ev(`window.scrollTo(0, 800)`); await sleep(600);
  const after = await ev(`JSON.stringify({
    scrollY: window.scrollY,
    barTop: document.querySelector('.mode-tabs-bar').getBoundingClientRect().top,
    barBottom: document.querySelector('.mode-tabs-bar').getBoundingClientRect().bottom,
    capsuleTop: document.querySelector('.mode-tabs').getBoundingClientRect().top,
    wsTop: document.querySelector('.workspace').getBoundingClientRect().top,
    leftTop: (document.querySelector('.ws-col-sticky')).getBoundingClientRect().top,
    leftBottom: (document.querySelector('.ws-col-sticky')).getBoundingClientRect().bottom,
    barPos: getComputedStyle(document.querySelector('.mode-tabs-bar')).position,
    barZ: getComputedStyle(document.querySelector('.mode-tabs-bar')).zIndex,
    barBg: getComputedStyle(document.querySelector('.mode-tabs-bar')).backgroundColor
  })`);
  const a = JSON.parse(after);
  check('滚动生效', a.scrollY > 600, `scrollY=${a.scrollY}`);
  check('标签栏吸顶：position=sticky', a.barPos === 'sticky', a.barPos);
  check('★ 滚动后标签栏仍钉在视口顶（top=0）', Math.abs(a.barTop) <= 1, `barTop=${a.barTop}`);
  check('★ 内部胶囊标签同步冻结（不随内容滚走）', a.capsuleTop >= a.barTop - 1 && a.capsuleTop < a.barBottom, `capsuleTop=${a.capsuleTop} barBottom=${a.barBottom}`);
  check('下方内容确实滚走了（workspace 已上移）', a.wsTop < 0, `wsTop=${a.wsTop}`);
  check('层级正确（z-index 高于内容、低于弹窗 100）', Number(a.barZ) >= 20 && Number(a.barZ) < 100, `z=${a.barZ}`);
  check('标签栏底色不透明（内容不从缝隙透出）', a.barBg && a.barBg !== 'rgba(0, 0, 0, 0)', a.barBg);
  check('右栏 sticky 已让位标签栏（top ≥ 标签栏底部）',
    a.leftTop === null || a.leftTop >= a.barBottom - 1, `leftTop=${a.leftTop} barBottom=${a.barBottom}`);
  check('sticky 列底部未伸进底部动作栏区', a.leftBottom === null || a.leftBottom <= b.winH + 1, `leftBottom=${a.leftBottom} win=${b.winH}`);

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('docs/design/ui_redesign/v31315_吸顶验证_滚动900px.png', Buffer.from(shot.data, 'base64'));

  // 切模式后仍应吸顶
  await ev(`switchMode('metadata')`); await sleep(400);
  const afterSwitch = JSON.parse(await ev(`JSON.stringify({ y: window.scrollY, barTop: document.querySelector('.mode-tabs-bar').getBoundingClientRect().top })`));
  check('切换模块后仍保持吸顶', Math.abs(afterSwitch.barTop) <= 1, `y=${afterSwitch.y} barTop=${afterSwitch.barTop}`);
  const shot2 = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('docs/design/ui_redesign/v31315_吸顶验证_切模块后.png', Buffer.from(shot2.data, 'base64'));

  // 浅色主题复核（标签栏高度不同，同样必须吸顶 + 右栏让位）
  await ev(`document.documentElement.setAttribute('data-theme','light')`); await sleep(400);
  const light = JSON.parse(await ev(`JSON.stringify({barTop: Math.round(document.querySelector('.mode-tabs-bar').getBoundingClientRect().top), barBottom: Math.round(document.querySelector('.mode-tabs-bar').getBoundingClientRect().bottom), right: Math.round(document.querySelector('.ws-col-sticky').getBoundingClientRect().top)})`));
  check('浅色主题下标签栏同样吸顶', Math.abs(light.barTop) <= 1, `barTop=${light.barTop}`);
  check('浅色主题下右栏同样让位标签栏', light.right >= light.barBottom - 1, `right=${light.right} barBottom=${light.barBottom}`);
  const shot3 = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('docs/design/ui_redesign/v31315_吸顶验证_浅色主题.png', Buffer.from(shot3.data, 'base64'));
  await ev(`document.documentElement.setAttribute('data-theme','dark')`);
  await ev(`(function(){const e=document.getElementById('__spacer'); if(e) e.remove(); window.scrollTo(0,0);})()`);
  const bad = results.filter(x => !x).length;
  console.log(`\n吸顶冻结验证：${results.length - bad}/${results.length} PASS`);
  ws.close();
  process.exit(bad ? 1 : 0);
})().catch(e => { console.log('FATAL:', e.message); process.exit(1); });
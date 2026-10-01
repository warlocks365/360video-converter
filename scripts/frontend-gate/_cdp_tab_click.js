// CDP 真实运行时页签点击验证：Input.dispatchMouseEvent 真实鼠标点击页签，
// 验证 currentMode 切换 + 截图取证（切到元数据工具页）。
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

(async () => {
  const targets = await getJSON('/json/list');
  const page = targets.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let msgId = 0;
  const pending = new Map();
  const exceptions = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') {
      const det = m.params.exceptionDetails;
      exceptions.push(((det.exception && det.exception.description) || det.text).slice(0, 150));
    }
  };
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); });
  const send = (method, params = {}) => new Promise((resolve) => {
    const id = ++msgId;
    pending.set(id, (m) => resolve(m.result || {}));
    ws.send(JSON.stringify({ id, method, params }));
  });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) {
      exceptions.push('[evaluate] ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text).slice(0, 150));
      return null;
    }
    return r.result && r.result.value;
  };
  await send('Runtime.enable');
  await send('Page.enable');
  await sleep(1200);

  console.log('当前模式:', await ev('currentMode'));

  // 真实鼠标点击「元数据工具」页签
  const rect = await ev(`(function(){ const t = document.querySelector('.mode-tab[data-mode="metadata"]'); const r = t.getBoundingClientRect(); return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2}); })()`);
  const { x, y } = JSON.parse(rect);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  await sleep(400);
  const afterMeta = await ev('currentMode');
  console.log('真实点击「元数据工具」后 currentMode:', afterMeta);

  // 真实鼠标点击「批量转换」页签
  const rect2 = await ev(`(function(){ const t = document.querySelector('.mode-tab[data-mode="batch"]'); const r = t.getBoundingClientRect(); return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2}); })()`);
  const p2 = JSON.parse(rect2);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p2.x, y: p2.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p2.x, y: p2.y, button: 'left', clickCount: 1 });
  await sleep(400);
  const afterBatch = await ev('currentMode');
  console.log('真实点击「批量转换」后 currentMode:', afterBatch);

  // 截图取证（批量页 + 元数据页）
  const shot1 = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('docs/design/ui_redesign/实施截图_批量页_点击切换后.png', Buffer.from(shot1.data, 'base64'));
  await ev(`switchMode('metadata')`);
  await sleep(300);
  const shot2 = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('docs/design/ui_redesign/实施截图_元数据页_点击切换后.png', Buffer.from(shot2.data, 'base64'));

  const ok = afterMeta === 'metadata' && afterBatch === 'batch';
  console.log('真实点击切换:', ok ? 'PASS' : 'FAIL', '| 运行期异常:', exceptions.length);
  exceptions.slice(0, 5).forEach(e => console.log('  ' + e));
  ws.close();
  process.exit(ok && exceptions.length === 0 ? 0 : 1);
})().catch(e => { console.log('FATAL:', e.message); process.exit(1); });

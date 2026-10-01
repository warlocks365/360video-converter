// CDP 截图取证：捕获 v3.13.12 深海钴蓝主题的真实运行画面（暗色 + 浅色各一张）
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
  if (!page) { console.log('FAIL: no page target'); process.exit(1); }
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
  await send('Runtime.enable');
  await send('Page.enable');
  await sleep(1500);

  // 暗色（默认主题）
  const shot1 = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('docs/design/ui_redesign/实施截图_深海钴蓝_暗色.png',
                   Buffer.from(shot1.data, 'base64'));
  console.log('暗色截图 saved');

  // 浅色（伴生主题，验证切换）
  await send('Runtime.evaluate', { expression: "document.documentElement.setAttribute('data-theme','light')" });
  await sleep(500);
  const shot2 = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('docs/design/ui_redesign/实施截图_深海钴蓝_浅色.png',
                   Buffer.from(shot2.data, 'base64'));
  console.log('浅色截图 saved');

  // 恢复暗色（默认）
  await send('Runtime.evaluate', { expression: "document.documentElement.setAttribute('data-theme','dark')" });

  console.log('运行期未捕获异常:', exceptions.length);
  exceptions.slice(0, 5).forEach(e => console.log('  ' + e));
  ws.close();
  process.exit(exceptions.length ? 1 : 0);
})().catch(e => { console.log('FATAL:', e.message); process.exit(1); });

// CDP 真实运行时诊断：连接 v3.13.9 exe 的 WebView2 调试端口，
// 在真实运行时里驱动用户旅程，捕获 Runtime.exceptionThrown（弹窗根源）。
const http = require('http');
const os = require('os');
const path = require('path');

const PORT = 8765;

function getJSON(p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: 9222, path: p }, res => {
      let b = ''; res.on('data', c => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  // 1. 找页面 target
  let targets;
  try { targets = await getJSON('/json/list'); }
  catch (e) { console.log('FAIL: 无法连接 9222 调试端口 —', e.message); process.exit(1); }
  const page = targets.find(t => t.type === 'page');
  if (!page) { console.log('FAIL: 无页面 target'); process.exit(1); }
  console.log('target:', page.title.slice(0, 40));

  // 2. WebSocket 连接（Node 22 内置 WebSocket）
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let msgId = 0;
  const pending = new Map();
  const exceptions = [];
  const consoleCalls = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') {
      const det = m.params.exceptionDetails;
      const txt = det.exception && det.exception.description ? det.exception.description : det.text;
      exceptions.push((det.url || '') + ':' + (det.lineNumber + 1) + ' → ' + String(txt).slice(0, 180));
    }
    if (m.method === 'Runtime.consoleAPICalled') {
      const p = m.params.args.map(a => a.value !== undefined ? String(a.value) : (a.description || '')).join(' ');
      if (m.params.type === 'error' || m.params.type === 'warning') consoleCalls.push(m.params.type + ': ' + p.slice(0, 180));
    }
  };
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = (e) => rej(new Error('ws error')); });
  const send = (method, params = {}) => new Promise((resolve) => {
    const id = ++msgId;
    pending.set(id, (m) => resolve(m.result || m.error || {}));
    ws.send(JSON.stringify({ id, method, params }));
  });
  await send('Runtime.enable');

  // 3. 驱动用户旅程（真实运行时内 evaluate）
  const ev = async (expr, label) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) exceptions.push('[evaluate] ' + label + ' → ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text).slice(0, 180));
    return r.result && r.result.value;
  };

  console.log('== 旅程1: 报告模式 + 筛选 + 加入元数据队列 ==');
  await ev(`(function(){ switchMode('report');
    reportData = [
      { filename: 'A.mp4', path: 'G:/x/A.mp4', size: 100, moov: { has_moov: true, moov_position: 'front' },
        probeData: { format: { tags: { comment: 'GSpherical x' }, duration: '10' }, streams: [ { codec_type: 'video', codec_name: 'h264', width: 4096, height: 2048, r_frame_rate: '30/1', bit_rate: '5000000', pix_fmt: 'yuv420p', tags: { location: '+36.7+116.8/', location_name: '凤凰岭' } }, { codec_type: 'audio', codec_name: 'aac', tags: {} } ] } },
      { filename: 'B.mp4', path: 'G:/x/B.mp4', size: 200, moov: { has_moov: true, moov_position: 'end' },
        probeData: { format: { tags: {}, duration: '20' }, streams: [ { codec_type: 'video', codec_name: 'hevc', width: 4096, height: 2048, r_frame_rate: '30/1', bit_rate: '8000000', pix_fmt: 'yuv420p' } ] } },
    ]; renderReport(); })()`, 'reportData+render');
  await ev(`reportFilterList = [ { field: 'vcodec', value: 'h264' }, { field: 'moov', value: '是' } ]; renderReportFilterRows(); renderReport();`, 'filters');
  await ev(`reportSelectedPaths = new Set(['G:/x/A.mp4','G:/x/B.mp4']); document.getElementById('reportQueueTarget').value = 'meta';`, 'select');
  await ev(`addSelectedReportToQueue()`, 'addToMetaQueue');
  await sleep(1200);

  console.log('== 旅程2: 元数据工具（真实探测载荷的探测/复用/弹窗保存）==');
  await ev(`switchMode('metadata');
    document.getElementById('metaInput').value = 'G:/264/20260526 欧乐堡骑士酒店温泉.mp4';
    addToMetaBatchList()`, 'addToMetaBatchList');
  await sleep(1500);   // 等真实 probe（后端真实 ffprobe）
  await ev(`editMetaFileSettings(0)`, 'openModal');
  await ev(`(function(){ const b = document.querySelector('#metaEditReuse [data-action="reuse-source-gps"]'); if (b) b.click(); })()`, 'reuseGPS');
  await sleep(800);    // 等异步逆地理（真实网络）
  await ev(`saveMetaFileSettings()`, 'save');
  await ev(`closeMetaEditModal()`, 'close');

  console.log('== 旅程3: 元数据批量应用（真实运行 4 秒，轮询期观察）==');
  await ev(`metaBatchItems.forEach(m => { m.selected = true; }); renderMetaBatchTable(); startMetadataApply()`, 'startApply');
  await sleep(4000);

  console.log('== 旅程4: 地图选点（真实逆地理网络）==');
  await ev(`switchMode('metadata'); openMapPicker('meta')`, 'openMapPicker');
  await sleep(500);
  await ev(`mapSelectedLocation = { name: { zh: '真实对象名' }, lat: 40.1, lon: 116.0, address: '' }; confirmMapSelection()`, 'confirmMap');
  await sleep(300);

  console.log('\n== 汇总 ==');
  console.log('未捕获异常（=弹窗来源）:', exceptions.length);
  exceptions.slice(0, 15).forEach(e => console.log('  ' + e));
  console.log('console error/warning:', consoleCalls.length);
  consoleCalls.slice(0, 10).forEach(e => console.log('  ' + e));
  ws.close();
  process.exit(0);
})().catch(e => { console.log('FATAL:', e.message); process.exit(1); });

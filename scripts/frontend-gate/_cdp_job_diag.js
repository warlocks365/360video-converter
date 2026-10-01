// CDP 任务运行期诊断：驱动报告/转码/元数据三类真实任务的轮询期，
// 捕获轮询路径上的未捕获异常（弹窗 = 周期性异常触发的 toast）。
const http = require('http');

function getJSON(p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: 9222, path: p }, res => {
      let b = ''; res.on('data', c => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
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
  let phase = 'boot';
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') {
      const det = m.params.exceptionDetails;
      const txt = det.exception && det.exception.description ? det.exception.description : det.text;
      exceptions.push(`[${phase}] ${det.url || ''}:${det.lineNumber + 1} → ${String(txt).slice(0, 200)}`);
    }
  };
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); });
  const send = (method, params = {}) => new Promise((resolve) => {
    const id = ++msgId;
    pending.set(id, (m) => resolve(m.result || {}));
    ws.send(JSON.stringify({ id, method, params }));
  });
  const ev = async (expr, label) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) {
      const det = r.exceptionDetails;
      exceptions.push(`[evaluate:${label}] ${((det.exception && det.exception.description) || det.text).slice(0, 200)}`);
      return null;
    }
    return r.result && r.result.value;
  };
  await send('Runtime.enable');

  // ── 阶段1: 报告任务（真实 9 文件，分钟级轮询观察 45 秒）──
  phase = 'report-job';
  console.log('[阶段1] 报告任务（真实 9 文件，观察 45s 轮询期）...');
  await ev(`startReportJob({ paths: [
    'G:/264/20260503 凤凰岭爬山.mp4', 'G:/264/20260504 超级飞侠主题乐园及游泳.mp4',
    'G:/264/20260523 欧乐堡极地海洋世界.mp4', 'G:/264/20260524 欧乐堡梦幻世界.mp4',
    'G:/264/20260524 欧乐堡梦幻世界露营车.mp4', 'G:/264/20260525 欧乐堡动物园手持拍摄.mp4',
    'G:/264/20260525 欧乐堡动物园露营车.mp4', 'G:/264/20260526 欧乐堡骑士酒店温泉.mp4',
    'G:/264/20260529 青岛54广场.mp4' ] })`, 'startReportJob');
  await sleep(45000);
  const repStatus = await ev(`reportJobId ? pollReportJobData || (typeof reportJobStatus !== 'undefined' ? reportJobStatus : null) : 'n/a'`, 'statusProbe') || 'unknown';
  console.log('  报告任务运行中（观测窗结束）exceptions:', exceptions.length);

  // ── 阶段2: 转码批量任务（test_duration 短任务 ×3，观察 25 秒）──
  phase = 'convert-job';
  console.log('[阶段2] 批量转码任务（test_duration=2 ×3，观察 25s）...');
  await ev(`(function(){
    switchMode('batch');
    document.getElementById('testEncode').checked = true;
    document.getElementById('testDurationField') && (document.getElementById('testDuration').value = '2');
    batchTasks = batchTasks.filter(t => t.path === 'G:/264/_acceptance_v3132/clean_src5s.mp4');
    const cfg = buildTaskConfig();
    ['1','2','3'].forEach(n => {
      batchTasks.push(makeTask({ path: 'G:/264/_acceptance_v3132/clean_src5s.mp4', name: 'clean_src5s.mp4',
        size_mb: 34.5, dir: 'G:\\\\264\\\\_acceptance_v3132',
        custom_output: 'G:\\\\264\\\\_acceptance_v3132\\\\conv_' + n + '.mp4', params: JSON.parse(JSON.stringify(cfg)) }));
    });
    renderBatchTable();
    return batchTasks.length;
  })()`, 'makeBatchTasks');
  await ev(`startConversion()`, 'startConversion');
  await sleep(25000);
  console.log('  转码任务（观测窗结束）exceptions:', exceptions.length);

  // ── 阶段3: 元数据批量应用（test_duration=2 ×3，观察 15 秒）──
  phase = 'meta-apply';
  console.log('[阶段3] 元数据批量应用（test_duration=2 ×3，观察 15s）...');
  await ev(`(function(){
    switchMode('metadata');
    metaBatchItems.forEach(m => { m.selected = true; if (m.settings) { m.settings.test_duration = 2; m.settings.set_file_created = false; m.settings.set_file_modified = false; } });
    renderMetaBatchTable();
    return metaBatchItems.length;
  })()`, 'metaSetup');
  await ev(`startMetadataApply()`, 'startMetaApply');
  await sleep(15000);
  console.log('  元数据应用（观测窗结束）exceptions:', exceptions.length);

  console.log('\n== 汇总 ==');
  console.log('任务运行期未捕获异常总数:', exceptions.length);
  exceptions.slice(0, 20).forEach(e => console.log('  ' + e));
  ws.close();
  process.exit(exceptions.length ? 1 : 0);
})().catch(e => { console.log('FATAL:', e.message); process.exit(1); });

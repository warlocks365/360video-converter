// 全用户旅程弹窗诊断：模拟报告→筛选→入队→元数据工具→编辑→保存全流程，
// 捕获 window error 事件 / showToast / alert 调用，定位"不停弹窗"的抛错源。
const path = require('path');
const os = require('os');
const WS = path.join(os.homedir(), '.workbuddy', 'binaries', 'node', 'workspace', 'node_modules');
const { JSDOM, VirtualConsole } = require(path.join(WS, 'jsdom'));

const PORT = 8800;
const URL = `http://127.0.0.1:${PORT}/`;
const API = (url) => {
  const u = String(url);
  if (u.includes('/api/version')) return { version: '3.13.9' };
  if (u.includes('/api/probe_metadata')) return {
    has_spherical: true, spherical: { pano_type: '360', stereo_mode: 'mono' },
    has_date: true, creation_time: '2026-05-26T12:12:41.000000Z',
    has_gps: true, gps: { lat: 36.7458, lon: 116.8331, raw: '' },
    location_name: '', location_address: '', file_size_mb: 34.5, date_in_name: '', filename: 'X.mp4',
  };
  if (u.includes('/api/probe-source')) return { has_gps: true, gps: { lat: 36.7458, lon: 116.8331 }, has_time: true, creation_time: '2026-05-26T12:12:41.000000Z', location_name: '', location_address: '', filename: 'X.mp4' };
  if (u.includes('/api/geocode') && u.includes('__regeo__')) return { status: '1', regeocode: { formatted_address: '山东省济南市历城区旅游路1号', addressComponent: { province: '山东省', city: '济南市', district: '历城区', township: '旅游路', building: {}, neighborhood: {} } } };
  if (u.includes('/api/extract_date')) return { date_str: '2026-05-26T10:30:00' };
  if (u.includes('/api/codecs')) return { codecs: { libx264: { label: 'H.264 (libx264)', group: 'cpu', presets: [], default_preset: '', has_profile: true, has_level: true, has_bf_refs: true, has_x264_params: true, x265_params: false }, libx265: { label: 'H.265', group: 'cpu', presets: [], default_preset: '', has_profile: true, has_level: true, has_bf_refs: true, has_x264_params: false, x265_params: true } } };
  if (u.includes('/api/codec_check')) return { available: {}, error_details: {}, ffmpeg_info: {}, runtime_dlls: {}, fix_hints: {} };
  if (u.includes('/api/presets')) return { presets: [] };
  if (u.includes('/api/tasks/load')) return { tasks: [] };
  if (u.includes('/api/settings')) return {};
  if (u.includes('/api/sysmon')) return { cpu: 10, mem: 40, disk: 0, net: 0, gpu: 0, gpu_name: 'RTX 3090', cpu_percent: 10, mem_percent: 40, gpu_percent: 5, gpu_enc_percent: 0, gpu_dec_percent: 0, cpu_count: 32 };
  if (u.includes('/api/status/')) return { overall_progress: 0, file_progress: 0, items: [], log: [], status: 'running' };
  if (u.includes('/api/report') || u.includes('/api/scan')) return { ok: true };
  return {};
};

const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', e => errors.push('jsdomError: ' + (e.detail && e.detail.message ? e.detail.message : e.message || String(e)).slice(0, 150)));
vc.on('error', (...a) => errors.push('console.error: ' + a.map(String).join(' ').slice(0, 150)));

(async () => {
  let dom;
  try {
    dom = await JSDOM.fromURL(URL, {
      runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true,
      virtualConsole: vc,
      beforeParse(window) {
        window.fetch = async (u) => ({ ok: true, status: 200, json: async () => API(u), text: async () => JSON.stringify(API(u)) });
        window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
        window.AbortController = window.AbortController || AbortController;
        window.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
        window.__popupLog = [];
      },
    });
  } catch (e) {
    console.log('FAIL load:', e.message);
    console.log('STACK:', (e.stack || '').split('\n').slice(0, 6).join('\n'));
    console.log('VC errors:', JSON.stringify(errors.slice(0, 6)));
    process.exit(1);
  }
  await new Promise(r => setTimeout(r, 2500));
  // 页面加载完成后再挂钩弹窗捕获（beforeParse 内覆盖 alert 会破坏 jsdom 资源加载）
  dom.window.__popupLog = [];
  dom.window.addEventListener('error', (e) => {
    dom.window.__popupLog.push('window.error: ' + (e.message || 'unknown') + ' @ ' + String(e.filename || '').split('/').pop() + ':' + e.lineno);
  });
  dom.window.alert = (m) => { dom.window.__popupLog.push('alert: ' + m); };
  dom.window.confirm = (m) => { dom.window.__popupLog.push('confirm: ' + m); return false; };
  const d = dom.window.document;
  const $ = id => d.getElementById(id);
  const log = () => dom.window.eval('JSON.stringify(window.__popupLog || [])');

  console.log('== 旅程1: 报告模式全流程 ==');
  dom.window.switchMode('report');
  // 模拟报告数据
  dom.window.eval(`reportData = [
    { filename: 'A.mp4', path: 'G:/x/A.mp4', size: 100, moov: { has_moov: true, moov_position: 'front' },
      probeData: { format: { tags: { comment: 'GSpherical x' }, duration: '10' }, streams: [ { codec_type: 'video', codec_name: 'h264', width: 4096, height: 2048, r_frame_rate: '30/1', bit_rate: '5000000', pix_fmt: 'yuv420p', tags: { location: '+36.7+116.8/', location_name: '凤凰岭' } }, { codec_type: 'audio', codec_name: 'aac', tags: {} } ] } },
    { filename: 'B.mp4', path: 'G:/x/B.mp4', size: 200, moov: { has_moov: true, moov_position: 'end' },
      probeData: { format: { tags: {}, duration: '20' }, streams: [ { codec_type: 'video', codec_name: 'hevc', width: 4096, height: 2048, r_frame_rate: '30/1', bit_rate: '8000000', pix_fmt: 'yuv420p' } ] } },
  ]; renderReport();`);
  // 加两行筛选并变更
  dom.window.eval(`document.getElementById('reportFilterAddBtn').click(); document.getElementById('reportFilterAddBtn').click();`);
  dom.window.eval(`reportFilterList = [ { field: 'vcodec', value: 'h264' }, { field: 'moov', value: '是' } ]; renderReportFilterRows(); renderReport();`);
  // 通过真实 change 事件触发行变更（走中央委托）
  const rowSel = d.querySelector('#reportFilterRows select[data-part="field"]');
  rowSel.value = 'resolution';
  rowSel.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  // 全选 + 加入元数据队列
  dom.window.eval(`reportSelectedPaths = new Set(['G:/x/A.mp4', 'G:/x/B.mp4']); document.getElementById('reportQueueTarget').value = 'meta';`);
  await dom.window.addSelectedReportToQueue();
  await new Promise(r => setTimeout(r, 700));   // 等探测完成
  console.log('popup after journey1:', log());

  console.log('== 旅程2: 元数据工具（全局面板 + 编辑弹窗）==');
  dom.window.eval(`document.getElementById('metaInput').value = 'G:/x/A.mp4';`);
  await dom.window.probeSourceVideo('G:/x/A.mp4', 'm');
  // 复用按钮
  const reuseGps = [...d.querySelectorAll('#metaSourceInfo [data-action="reuse-source-gps"]')][0];
  if (reuseGps) reuseGps.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  const reuseTime = [...d.querySelectorAll('#metaSourceInfo [data-action="reuse-source-time"]')][0];
  if (reuseTime) reuseTime.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await new Promise(r => setTimeout(r, 300));
  console.log('popup after reuse:', log());
  // 批量编辑弹窗开合
  dom.window.editMetaFileSettings(0);
  const gpsBtn = [...d.querySelectorAll('#metaEditReuse [data-action="reuse-source-gps"]')][0];
  if (gpsBtn) gpsBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  dom.window.saveMetaFileSettings();
  dom.window.closeMetaEditModal();
  console.log('popup after modal:', log());

  console.log('== 旅程3: 元数据批量应用（轮询运行 3 秒）==');
  dom.window.eval(`document.getElementById('metaBatchOutDir') && (document.getElementById('metaBatchOutDir').value = '');`);
  dom.window.eval(`metaBatchItems.forEach(m => { m.selected = true; }); renderMetaBatchTable();`);
  await dom.window.startMetadataApply();
  await new Promise(r => setTimeout(r, 3000));   // 任务轮询期观察
  console.log('popup during job:', log());

  console.log('== 旅程4: 地图选点（模拟点击选择 + 确认）==');
  dom.window.switchMode('metadata');
  dom.window.eval(`openMapPicker('meta');`);
  await new Promise(r => setTimeout(r, 300));
  dom.window.eval(`mapSelectedLocation = { name: { zh: '对象名测试' }, lat: 40.1, lon: 116.0, address: '' };`);
  try { dom.window.confirmMapSelection(); } catch (e) { console.log('confirm threw:', e.message); }
  console.log('popup after map confirm:', log());

  console.log('\n== 汇总 ==');
  const popupLog = dom.window.eval('JSON.stringify(window.__popupLog || [])');
  const pops = JSON.parse(popupLog);
  console.log('弹窗类调用总数:', pops.length);
  pops.slice(0, 15).forEach(p => console.log('  ' + p.slice(0, 130)));
  console.log('JS 错误捕获:', errors.length);
  errors.slice(0, 10).forEach(e => console.log('  ' + e.slice(0, 150)));
  process.exit(0);
})();

// 真实数据全流程诊断：把 G:/264 九个文件的真实 probe_metadata 载荷喂进前端
// 全部代码路径（批量列表/编辑弹窗/报告渲染），捕获任何未捕获异常（弹窗根源）。
const path = require('path');
const os = require('os');
const fs = require('fs');
const WS = path.join(os.homedir(), '.workbuddy', 'binaries', 'node', 'workspace', 'node_modules');
const { JSDOM, VirtualConsole } = require(path.join(WS, 'jsdom'));

const PORT = 8800;
const URL = `http://127.0.0.1:${PORT}/`;
const REAL = JSON.parse(fs.readFileSync('G:/264/_acceptance_v3132/real_probe_payloads.json', 'utf8'));
const REAL_BY_PATH = {};
for (const [name, payload] of Object.entries(REAL)) REAL_BY_PATH['G:/264/' + name] = payload;

const API = (url) => {
  const u = String(url);
  if (u.includes('/api/probe_metadata')) {
    const m = u.match(/path=([^&]+)/);
    let p = m ? decodeURIComponent(m[1]) : '';
    if (REAL_BY_PATH[p]) return REAL_BY_PATH[p];
    for (const k of Object.keys(REAL_BY_PATH)) if (p.endsWith(k) || k.endsWith(p.replace(/\//g, '\\'))) return REAL_BY_PATH[k];
  }
  if (u.includes('/api/version')) return { version: '3.13.9' };
  if (u.includes('/api/extract_date')) return { date_str: null };
  if (u.includes('/api/codecs')) return { codecs: { libx264: { label: 'H.264 (libx264)', group: 'cpu', presets: [], default_preset: '', has_profile: true, has_level: true, has_bf_refs: true, has_x264_params: true, x265_params: false } } };
  if (u.includes('/api/codec_check')) return { available: {}, error_details: {}, ffmpeg_info: {}, runtime_dlls: {}, fix_hints: {} };
  if (u.includes('/api/presets')) return { presets: [] };
  if (u.includes('/api/tasks/load')) return { tasks: [] };
  if (u.includes('/api/settings')) return {};
  if (u.includes('/api/sysmon')) return { cpu: 10, mem: 40, disk: 0, net: 0, gpu: 0, cpu_percent: 10, mem_percent: 40, gpu_percent: 5, gpu_enc_percent: 0, gpu_dec_percent: 0, gpu_name: 'RTX 3090', cpu_count: 32 };
  if (u.includes('/api/status/')) return { overall_progress: 0, file_progress: 0, items: [], log: [], status: 'running' };
  return {};
};

const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', e => errors.push('jsdomError: ' + (e.detail && e.detail.message ? e.detail.message : e.message || String(e)).slice(0, 200)));
vc.on('error', (...a) => errors.push('console.error: ' + a.map(String).join(' ').slice(0, 200)));

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
      },
    });
  } catch (e) {
    console.log('FAIL load:', e.message);
    process.exit(1);
  }
  await new Promise(r => setTimeout(r, 2500));
  const d = dom.window.document;
  const caught = [];
  const guard = (label, fn) => {
    try { fn(); } catch (e) { caught.push(label + ': ' + e.message.slice(0, 160)); }
  };

  // ── 流程1: 九个真实文件逐个加入批量列表（探测→列表渲染）──
  for (const name of Object.keys(REAL)) {
    const p = 'G:/264/' + name;
    guard('入队 ' + name, () => {
      d.getElementById('metaInput').value = p;
      dom.window.addToMetaBatchList();
    });
    await new Promise(r => setTimeout(r, 120));   // 探测 fetch（真实载荷）
  }
  await new Promise(r => setTimeout(r, 500));
  console.log('流程1 完成: metaBatchItems =', dom.window.eval('metaBatchItems.length'),
    '| settings.date_from_filename 样本:', dom.window.eval('JSON.stringify(metaBatchItems.map(m => m.settings.date_from_filename))'),
    '| manual_date 样本:', dom.window.eval('JSON.stringify(metaBatchItems.map(m => m.settings.manual_date).slice(0,3))'));
  guard('渲染批量表', () => dom.window.renderMetaBatchTable());

  // ── 流程2: 每个条目打开编辑弹窗 → 复用按钮 → 保存 ──
  for (let i = 0; i < 9; i++) {
    guard(`编辑弹窗 #${i}`, () => {
      dom.window.editMetaFileSettings(i);
      const gps = [...d.querySelectorAll('#metaEditReuse [data-action="reuse-source-gps"]')][0];
      if (gps) gps.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      const t = [...d.querySelectorAll('#metaEditReuse [data-action="reuse-source-time"]')][0];
      if (t) t.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      dom.window.saveMetaFileSettings();
    });
  }
  console.log('流程2 完成: 编辑+复用+保存 x9');

  // ── 流程3: 报告模式渲染真实数据 ──
  guard('报告渲染(真实 probeData)', () => {
    dom.window.eval(`reportData = ${JSON.stringify(Object.entries(REAL).map(([name, payload]) => ({
      filename: name, path: 'G:/264/' + name, size: payload.file_size_mb || 0,
      moov: { has_moov: true, moov_position: 'front' }, probeData: payload,
    })))}; renderReport();`);
  });
  // 报告字段值函数对真实数据全字段扫描
  guard('报告全字段扫描', () => {
    const fields = ['moov','container_format','file_size','duration','vcodec','resolution','fps','vbitrate','pix_fmt','acodec','sample_rate','channels','gspherical','pano_type','stereo_mode','creation_time','gps_coord','location_name','location_address'];
    dom.window.eval(`reportData.forEach(item => { ${JSON.stringify(fields)}.forEach(f => reportItemFilterValue(item, f)); });`);
  });

  // ── 流程4: 汇总 ──
  console.log('\n== 汇总 ==');
  console.log('捕获异常数:', caught.length);
  caught.slice(0, 12).forEach(c => console.log('  ' + c));
  console.log('JS 错误捕获:', errors.length);
  errors.slice(0, 12).forEach(e => console.log('  ' + e.slice(0, 180)));
  process.exit(0);
})();

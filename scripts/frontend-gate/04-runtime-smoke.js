// 运行时冒烟测试：将 10 个模块按加载顺序跑在同一个 vm 上下文中
// 复现浏览器"经典脚本共享全局作用域"语义 → 可捕获顶层执行错误、跨模块 TDZ、init() 崩溃
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const JS_DIR = path.resolve(__dirname, '../../static/js');
const files = fs.readdirSync(JS_DIR).filter(f => f.endsWith('.js')).sort();

// ── 宽松 DOM 桩：未知属性返回同构对象，避免逐个补 API ──
// 桩数据：形状必须与后端真实响应一致，否则会产生假阳性错误
const codecEntry = (label, group, extra) => Object.assign({
  label, group, presets: [], default_preset: '',
  has_profile: true, has_level: true, has_bf_refs: true,
  has_x264_params: group === 'cpu', x265_params: group === 'cpu',
}, extra || {});
const CODECS = {
  libx264: codecEntry('H.264 (libx264)', 'cpu', { has_x264_params: true, x265_params: false }),
  libx265: codecEntry('H.265 (libx265)', 'cpu', { has_x264_params: false, x265_params: true }),
  h264_nvenc: codecEntry('H.264 (NVENC)', 'cuda', { has_bf_refs: false }),
  hevc_nvenc: codecEntry('H.265 (NVENC)', 'cuda', { has_bf_refs: false }),
  h264_qsv: codecEntry('H.264 (QSV)', 'qsv', { has_bf_refs: false }),
  hevc_qsv: codecEntry('H.265 (QSV)', 'qsv', { has_bf_refs: false }),
  h264_amf: codecEntry('H.264 (AMF)', 'amf', { has_bf_refs: false }),
  hevc_amf: codecEntry('H.265 (AMF)', 'amf', { has_bf_refs: false }),
};
const API_RESP = (url) => {
  if (url.includes('/api/codecs')) return { codecs: CODECS };
  if (url.includes('/api/codec_check')) return { available: { libx264: true, libx265: true }, error_details: {}, ffmpeg_info: {}, runtime_dlls: {}, fix_hints: {} };
  if (url.includes('/api/presets')) return { presets: [] };
  if (url.includes('/api/version')) return { version: '3.11.0-smoke' };
  if (url.includes('/api/tasks/load')) return { tasks: [] };
  if (url.includes('/api/settings')) return {};
  if (url.includes('/api/sysmon')) return { cpu: 10, mem: 40, disk: 0, net: 0, gpu: 0 };
  if (url.includes('/api/extract_date')) return { date_str: null };
  if (url.includes('/api/status/')) return { overall_progress: 0, file_progress: 0, items: [], log: [], status: 'running' };
  return {};
};

// 需要返回具体值的元素（否则 getElementById 的 value 默认为 ''，会让部分分支走不到）
const EL_VALUES = { p_codec: 'libx264', p_resolution: '4096x2048', p_rate_mode: 'crf', p_pix_fmt: 'yuv420p' };

function makeEl(id) {
  const t = function () { return makeEl(); };
  return new Proxy(t, {
    get(tt, p) {
      if (p === Symbol.toPrimitive) return () => '';
      if (p === 'then') return undefined;
      if (p === 'value') return EL_VALUES[id] !== undefined ? EL_VALUES[id] : (tt.value !== undefined ? tt.value : '');
      if (p === 'checked') return tt.checked !== undefined ? tt.checked : false;
      if (p in tt && tt[p] !== undefined) return tt[p];
      if (p === 'length') return 0;
      if (p === 'textContent' || p === 'innerHTML' || p === 'id' || p === 'src') return '';
      if (p === 'getBoundingClientRect') return () => ({ top: 0, left: 0, width: 0, height: 0 });
      return makeEl();
    },
    set(tt, p, v) { tt[p] = v; return true; },
    apply() { return makeEl(); },
    has() { return true; },
  });
}

const errors = [];
const rejections = [];

const sandbox = {
  console: { log: () => {}, warn: () => {}, error: (...a) => errors.push('console.error: ' + a.join(' ')), info: () => {}, debug: () => {} },
  document: {
    getElementById: (id) => makeEl(id),
    querySelector: () => makeEl(),
    querySelectorAll: () => [],
    createElement: () => makeEl(),
    createDocumentFragment: () => makeEl(),
    addEventListener: () => {},
    removeEventListener: () => {},
    documentElement: makeEl(),
    body: makeEl(),
    head: makeEl(),
    cookie: '',
    readyState: 'loading',
  },
  window: {
    addEventListener: () => {},
    removeEventListener: () => {},
    matchMedia: () => ({ matches: false, addEventListener: () => {} }),
    location: { href: 'http://127.0.0.1:8800/', search: '', hash: '' },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    innerWidth: 1600, innerHeight: 900, devicePixelRatio: 1,
  },
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {} },
  navigator: { userAgent: 'node-smoke', language: 'zh-CN', clipboard: { writeText: async () => {} } },
  location: { href: 'http://127.0.0.1:8800/', search: '', hash: '', reload: () => {} },
  history: { pushState: () => {}, replaceState: () => {} },
  fetch: async (url) => ({
    ok: true, status: 200,
    json: async () => API_RESP(String(url)),
    text: async () => JSON.stringify(API_RESP(String(url))),
  }),
  setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
  alert: () => {}, confirm: () => true, prompt: () => '',
  requestAnimationFrame: (cb) => setTimeout(cb, 0),
  cancelAnimationFrame: clearTimeout,
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
  matchMedia: () => ({ matches: false, addEventListener: () => {} }),
  Image: function () { return makeEl(); },
  Audio: function () { return makeEl(); },
  AbortController: class { constructor() { this.signal = {}; } abort() {} },
  FileReader: function () { return makeEl(); },
  Blob: function () {}, URL: { createObjectURL: () => '', revokeObjectURL: () => {} },
  MutationObserver: class { observe() {} disconnect() {} },
  // 桩掉 Leaflet，避免真实地图库依赖真实 DOM/CSS
  L: undefined,
};
sandbox.window.document = sandbox.document;
sandbox.window.localStorage = sandbox.localStorage;
sandbox.globalThis = sandbox;
sandbox.self = sandbox;

vm.createContext(sandbox);

process.on('unhandledRejection', (r) => rejections.push(String(r && r.stack || r)));

let loaded = 0, failed = 0;
for (const f of files) {
  const code = fs.readFileSync(path.join(JS_DIR, f), 'utf8');
  try {
    vm.runInContext(code, sandbox, { filename: f, timeout: 15000 });
    console.log(`OK   加载 ${f}`);
    loaded++;
  } catch (e) {
    failed++;
    console.log(`FAIL 加载 ${f}`);
    console.log(`       ${e.name}: ${e.message}`);
    const st = String(e.stack || '').split('\n').slice(0, 4).join('\n         ');
    console.log(`         ${st}`);
  }
}

// 让 init() 内的异步流程跑完
setTimeout(() => {
  console.log(`\n模块加载: ${loaded}/${files.length} 成功, ${failed} 失败`);
  if (errors.length) { console.log(`\nconsole.error 输出 (${errors.length}):`); errors.slice(0, 10).forEach(e => console.log('  ' + e.slice(0, 200))); }
  else console.log('console.error: 无');
  if (rejections.length) { console.log(`\n未处理的 Promise 拒绝 (${rejections.length}):`); rejections.slice(0, 10).forEach(r => console.log('  ' + r.split('\n').slice(0, 3).join(' | ').slice(0, 240))); }
  else console.log('未处理 Promise 拒绝: 无');
  process.exit(failed ? 1 : 0);
}, 1200);

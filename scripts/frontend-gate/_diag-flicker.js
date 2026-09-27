/**
 * 闪烁问题诊断脚本（取证用，不修改任何业务代码）
 *
 * 思路：「频繁弹出未知窗口的闪烁」最可能是三类来源之一：
 *   ① showToast 被高频调用（每次全局 JS 错误都会弹一个 8 秒的错误提示）；
 *   ② alert() 被调用（WebView2 会弹原生对话框）；
 *   ③ window.open 被调用。
 * 本脚本在真实 DOM（jsdom）里跑 15 秒，把这三类调用全部计数并记录内容与时间，
 * 同时捕获 console.error 与未捕获异常 —— 用数据定位来源，而不是猜。
 */
const path = require('path');
const WS = 'C:/Users/warlocks/.workbuddy/binaries/node/workspace/node_modules';
const { JSDOM, VirtualConsole } = require(path.join(WS, 'jsdom'));

const PORT = 8800;
const RUN_MS = 15000;

const CODECS = {
  libx264: { label: 'H.264 (libx264)', group: 'cpu', presets: [], default_preset: '', has_profile: true, has_level: true, has_bf_refs: true, has_x264_params: true, x265_params: false },
  libx265: { label: 'H.265 (libx265)', group: 'cpu', presets: [], default_preset: '', has_profile: true, has_level: true, has_bf_refs: true, has_x264_params: false, x265_params: true },
  hevc_nvenc: { label: 'H.265 (NVENC)', group: 'cuda', presets: [], default_preset: '', has_profile: true, has_bf_refs: false },
};
const API = (url) => {
  if (url.includes('/api/codecs')) return { codecs: CODECS };
  if (url.includes('/api/codec_check')) return { available: { libx264: true, libx265: true }, error_details: {}, ffmpeg_info: {}, runtime_dlls: {}, fix_hints: {} };
  if (url.includes('/api/presets')) return { presets: [] };
  if (url.includes('/api/version')) return { version: '3.12.2', name: '360 Video Converter' };
  if (url.includes('/api/tasks/load')) return { tasks: [] };
  if (url.includes('/api/settings')) return {};
  if (url.includes('/api/sysmon')) return { cpu: 10, mem: 40, disk: 0, net: 0, gpu: 0 };
  if (url.includes('/api/extract_date')) return { date_str: null };
  return {};
};

const events = [];           // {t, kind, detail}
const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', e => errors.push('jsdomError: ' + (e.detail && e.detail.message || e.message || e)));
vc.on('error', (...a) => errors.push('console.error: ' + a.map(x => String(x)).join(' ')));
vc.on('warn', (...a) => errors.push('console.warn: ' + a.map(x => String(x)).join(' ')));

(async () => {
  const t0 = Date.now();
  const rel = () => ((Date.now() - t0) / 1000).toFixed(2) + 's';
  const log = (kind, detail) => events.push({ t: rel(), kind, detail: String(detail).slice(0, 160) });

  const dom = await JSDOM.fromURL(`http://127.0.0.1:${PORT}/`, {
    runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(window) {
      window.fetch = async (u) => ({ ok: true, status: 200, json: async () => API(String(u)), text: async () => JSON.stringify(API(String(u))) });
      window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
      window.AbortController = window.AbortController || AbortController;
      window.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
      // 取证钩子：记录而非阻断
      window.__diag = { toast: 0, alert: 0, open: 0, confirm: 0 };
      window.alert = (m) => { window.__diag.alert++; log('alert', m); };
      window.confirm = (m) => { window.__diag.confirm++; log('confirm', m); };
      window.open = (u) => { window.__diag.open++; log('window.open', u); };
    },
  });

  await new Promise(r => setTimeout(r, 1200));   // 等 init 完成

  const w = dom.window;
  // showToast 是顶层 function 声明 → 挂在 window 上，可安全替换
  if (typeof w.showToast === 'function') {
    const orig = w.showToast;
    w.showToast = function (msg, type, ms) {
      w.__diag.toast++;
      log('showToast', `[${type || 'info'}] ${msg}`);
      return orig.call(this, msg, type, ms);
    };
  } else log('warn', 'showToast 未在 window 上找到');

  // 记录所有定时器启动（找高频轮询源）
  const origSI = w.setInterval.bind(w);
  w.setInterval = (fn, ms, ...rest) => {
    log('setInterval', `${ms}ms`);
    return origSI(fn, ms, ...rest);
  };

  log('info', '开始观测 ' + (RUN_MS / 1000) + 's …');
  await new Promise(r => setTimeout(r, RUN_MS));

  // ── 汇总 ──
  const d = w.__diag;
  console.log('══ 闪烁问题诊断（真实 DOM 运行 ' + (RUN_MS / 1000) + 's）══\n');
  console.log(`showToast 调用 : ${d.toast} 次`);
  console.log(`alert 调用     : ${d.alert} 次`);
  console.log(`confirm 调用   : ${d.confirm} 次`);
  console.log(`window.open    : ${d.open} 次`);
  console.log(`console 错误   : ${errors.length} 条`);
  console.log('');
  console.log('── setInterval 注册情况 ──');
  events.filter(e => e.kind === 'setInterval').forEach(e => console.log(`  [${e.t}] ${e.detail}`));
  console.log('');
  console.log('── showToast / alert 事件明细（前 20 条）──');
  const hits = events.filter(e => e.kind === 'showToast' || e.kind === 'alert' || e.kind === 'confirm' || e.kind === 'window.open');
  if (!hits.length) console.log('  （无 —— 15 秒内没有任何弹窗类调用）');
  hits.slice(0, 20).forEach(e => console.log(`  [${e.t}] ${e.kind}: ${e.detail}`));
  if (hits.length > 20) console.log(`  …共 ${hits.length} 条`);
  console.log('');
  console.log('── console 错误明细（前 10 条）──');
  if (!errors.length) console.log('  （无）');
  errors.slice(0, 10).forEach(e => console.log('  ' + e.slice(0, 200)));

  // 结论提示
  console.log('');
  if (d.toast > 5) console.log('⚠️ showToast 被高频调用 —— 大概率是「频繁弹窗闪烁」的来源，需追查其触发链');
  else if (d.alert > 0) console.log('⚠️ 存在 alert 调用 —— WebView2 会弹原生对话框');
  else if (errors.length > 5) console.log('⚠️ console 错误较多，需检查是否与轮询相关');
  else console.log('✓ 静置状态下未复现高频弹窗 —— 问题可能出现在特定交互或任务运行期');
  process.exit(0);
})();

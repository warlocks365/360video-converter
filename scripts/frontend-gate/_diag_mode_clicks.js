// 六模式页签真实点击派发测试（jsdom 加载真实页面）
// 验证: 每个页签 MouseEvent click → switchMode → currentMode + 面板可见性
const path = require('path');
const os = require('os');
const WS = path.join(os.homedir(), '.workbuddy', 'binaries', 'node', 'workspace', 'node_modules');
const { JSDOM, VirtualConsole } = require(path.join(WS, 'jsdom'));

const API = (url) => {
  const u = String(url);
  if (u.includes('/api/version')) return { version: '3.13.13' };
  if (u.includes('/api/codecs')) return { codecs: { libx264: { label: 'H.264', group: 'cpu', presets: [], default_preset: '', has_profile: true, has_level: true, has_bf_refs: true, has_x264_params: true, x265_params: false } } };
  if (u.includes('/api/codec_check')) return { available: {}, error_details: {}, ffmpeg_info: {}, runtime_dlls: {}, fix_hints: {} };
  if (u.includes('/api/presets')) return { presets: [] };
  if (u.includes('/api/tasks/load')) return { tasks: [] };
  if (u.includes('/api/settings')) return {};
  if (u.includes('/api/sysmon')) return { cpu: 10, mem: 40, gpu: 0, cpu_percent: 10, mem_percent: 40, gpu_percent: 5 };
  if (u.includes('/api/extract_date')) return { date_str: null };
  if (u.includes('/api/status/')) return { overall_progress: 0, file_progress: 0, items: [], log: [], status: 'running' };
  return {};
};

const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', e => errors.push('jsdomError: ' + (e.detail && e.detail.message ? e.detail.message : e.message).slice(0, 150)));
vc.on('error', (...a) => errors.push('console.error: ' + a.map(String).join(' ').slice(0, 150)));

(async () => {
  let dom;
  try {
    dom = await JSDOM.fromURL('http://127.0.0.1:8800/', {
      runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true,
      virtualConsole: vc,
      beforeParse(window) {
        window.fetch = async (u) => ({ ok: true, status: 200, json: async () => API(u), text: async () => JSON.stringify(API(u)) });
        window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
        window.AbortController = window.AbortController || AbortController;
        window.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
      },
    });
  } catch (e) { console.log('FAIL load:', e.message, '（需 8800 桩服务器）'); process.exit(1); }
  await new Promise(r => setTimeout(r, 2500));
  const d = dom.window.document;

  // 每个模式的可见面板 id（与 switchMode 实现一致）
  const MODE_PANEL = {
    single: 'singleMode', merge: 'mergeMode', batch: 'batchMode',
    metadata: 'metadataMode', report: 'reportMode', vr3d: 'vr3dMode',
  };
  const results = [];
  const check = (name, ok, detail) => {
    results.push(ok);
    console.log((ok ? 'OK  ' : 'FAIL') + ' ' + name + (detail ? '  -> ' + detail : ''));
  };
  const modeVisible = (mode) => {
    const pid = MODE_PANEL[mode];
    const panel = pid ? d.getElementById(pid) : null;
    if (!panel) return 'no-panel';
    const cs = dom.window.getComputedStyle(panel);
    return (cs.display !== 'none' && !panel.classList.contains('hidden')) ? 'visible' : 'hidden';
  };

  for (const mode of Object.keys(MODE_PANEL)) {
    // 真实点击：找到对应页签元素派发 click（走中央委托 + onclick 属性）
    const tab = d.querySelector(`.mode-tab[data-mode="${mode}"]`);
    if (!tab) { check(`页签 ${mode} 存在`, false, '元素缺失'); continue; }
    tab.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    const cur = dom.window.eval('currentMode');
    const vis = modeVisible(mode);
    const tabOn = tab.classList.contains('active');
    check(`点击页签 ${mode} → currentMode + 面板可见 + 页签激活`,
      cur === mode && vis === 'visible' && tabOn,
      `mode=${cur} panel=${vis} active=${tabOn}`);
  }

  check('页面无 JS 错误', errors.length === 0, errors.slice(0, 3).join(' | '));
  const failed = results.filter(x => !x).length;
  console.log(`\n══ 模式页签点击测试: ${results.length - failed}/${results.length} PASS ══`);
  process.exit(failed ? 1 : 0);
})();

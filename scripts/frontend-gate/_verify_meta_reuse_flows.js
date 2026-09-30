// 元数据工具「复用」四场景修复验证（jsdom 真实页面加载）— v3.13.4
// 场景1 弹窗内复用 GPS/地名 ｜ 场景2 地图选点地名兜底+队列徽章 ｜ 场景3 日期互斥 ｜ 场景4 UTC 归一化
const path = require('path');
const os = require('os');
const WS = path.join(os.homedir(), '.workbuddy', 'binaries', 'node', 'workspace', 'node_modules');
const { JSDOM, VirtualConsole } = require(path.join(WS, 'jsdom'));

const PORT = 8800;
const URL = `http://127.0.0.1:${PORT}/`;

const PROBE_SOURCE = {
  has_gps: true, gps: { lat: 36.7458, lon: 116.8331, raw: '+36.7458+116.8331/' },
  has_time: true, creation_time: '2026-05-26T12:12:41.000000Z',
  has_location_name: false, location_name: '', location_address: '山东省济南市历城区某某路1号',
  filename: 'X.mp4',
};
const API = (url) => {
  const u = String(url);
  if (u.includes('/api/probe-source')) return { ...PROBE_SOURCE, error: undefined };
  if (u.includes('/api/probe_metadata')) return {
    has_spherical: true, spherical: { pano_type: '360', stereo_mode: 'mono' },
    has_date: true, creation_time: '2026-05-26T12:12:41.000000Z',
    has_gps: true, gps: { lat: 36.7458, lon: 116.8331, raw: '' },
    location_name: '', location_address: '山东省济南市历城区某某路1号',
    file_size_mb: 34.5, date_in_name: '', filename: 'X.mp4',
  };
  if (u.includes('/api/extract_date')) return { date_str: '2026-05-26T10:30:00' };
  if (u.includes('/api/codecs')) return { codecs: { libx264: { label: 'x', group: 'cpu', presets: [], default_preset: '', has_profile: true, has_level: true, has_bf_refs: true, has_x264_params: false, x265_params: false } } };
  if (u.includes('/api/codec_check')) return { available: {}, error_details: {}, ffmpeg_info: {}, runtime_dlls: {}, fix_hints: {} };
  if (u.includes('/api/presets')) return { presets: [] };
  if (u.includes('/api/version')) return { version: '3.13.4', name: '360 Video Converter' };
  if (u.includes('/api/tasks/load')) return { tasks: [] };
  if (u.includes('/api/settings')) return {};
  if (u.includes('/api/sysmon')) return { cpu: 10, mem: 40, disk: 0, net: 0, gpu: 0 };
  if (u.includes('/api/status/')) return { overall_progress: 0, file_progress: 0, items: [], log: [], status: 'running' };
  return {};
};

const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', e => errors.push('jsdomError: ' + (e.detail || e.message || e)));
vc.on('error', (...a) => errors.push('console.error: ' + a.map(String).join(' ')));

const results = [];
const check = (name, cond, detail) => {
  results.push({ name, ok: !!cond, detail: detail === undefined ? '' : String(detail) });
  console.log((cond ? 'OK  ' : 'FAIL') + ' ' + name + (detail ? '  → ' + detail : ''));
};

(async () => {
  let dom;
  try {
    dom = await JSDOM.fromURL(URL, {
      runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true,
      virtualConsole: vc,
      beforeParse(window) {
        window.fetch = async (u) => ({
          ok: true, status: 200,
          json: async () => API(u),
          text: async () => JSON.stringify(API(u)),
        });
        window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
        window.AbortController = window.AbortController || AbortController;
        window.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
      },
    });
  } catch (e) {
    console.log('FAIL 无法加载页面:', e.message, '（需 8800 桩服务器）');
    process.exit(1);
  }
  await new Promise(r => setTimeout(r, 3000));
  const d = dom.window.document;
  const $ = id => d.getElementById(id);

  // ── 准备：批量列表加入一个文件（触发探测链路）──
  $('metaInput').value = 'G:/264/_acceptance_v3132/clean_src5s.mp4';
  await dom.window.addToMetaBatchList();
  await new Promise(r => setTimeout(r, 500));   // 等待 probeMetaFile 完成

  // ══ 场景4（前置验证）：probe 的 UTC 时间已归一化为本地 naive ══
  const norm = dom.window.eval(`utcToLocalNaive('2026-05-26T12:12:41.000000Z')`);
  const localShift = new Date('2026-05-26T12:12:41Z');
  const p = n => String(n).padStart(2, '0');
  const expected = `${localShift.getFullYear()}-${p(localShift.getMonth() + 1)}-${p(localShift.getDate())}T${p(localShift.getHours())}:${p(localShift.getMinutes())}:${p(localShift.getSeconds())}`;
  check('场景4: utcToLocalNaive 归一化（Z → 本地 naive）', norm === expected,
    `got=${norm} expected=${expected}`);
  const storedManual = dom.window.eval('metaBatchItems[0].settings.manual_date');
  check('场景4: 探测自动填充的 manual_date 已无 Z/UTC 偏差',
    storedManual === expected && !/Z$/.test(storedManual), `manual_date="${storedManual}"`);

  // ══ 场景1：弹窗内复用 GPS 及地名 ══
  dom.window.editMetaFileSettings(0);
  const reuseHtml = $('metaEditReuse').innerHTML;
  check('场景1: 弹窗出现复用按钮（GPS+时间）',
    reuseHtml.includes('reuse-source-gps') && reuseHtml.includes('reuse-source-time') && reuseHtml.includes('data-target="me"'),
    `buttons=${(reuseHtml.match(/si-btn/g) || []).length}`);
  // 点击「复用素材 GPS 及地名」（事件委托路径）
  const gpsBtn = [...d.querySelectorAll('#metaEditReuse [data-action="reuse-source-gps"]')][0];
  gpsBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  check('场景1: me_ 纬度/经度已填充',
    $('me_location_lat').value === '36.745800' && $('me_location_lon').value === '116.833100',
    `lat=${$('me_location_lat').value} lon=${$('me_location_lon').value}`);
  check('场景1: me_ 拍摄地点已填充（地名缺失 → 地址首段兜底）',
    $('me_location_name').value === '山东省济南市历城区某某路1号',
    `name="${$('me_location_name').value}"`);
  check('场景1: me_ 详细地址已填充', $('me_location_address').value === '山东省济南市历城区某某路1号',
    `addr="${$('me_location_address').value}"`);
  check('场景1: me_ 位置总开关自动开启 + 区块可见',
    $('me_apply_location').checked && !$('me_location_opts').classList.contains('hidden'),
    `checked=${$('me_apply_location').checked} hidden=${$('me_location_opts').classList.contains('hidden')}`);
  check('场景1: 弹窗 GPS 信息行反馈', $('me_location_info').classList.contains('hidden') === false
    && $('me_location_info').textContent.includes('已复用'), $('me_location_info').textContent.slice(0, 60));

  // ══ 场景3：勾选「从文件名提取」清空手动日期（弹窗 + 全局）══
  $('me_manual_date').value = '2026-05-26T20:12:41';   // 模拟复用拍摄时间后的残留
  $('me_date_from_filename').checked = true;
  dom.window.onMetaDateFromNameChange('me');
  check('场景3: 弹窗勾选文件名提取 → 手动日期被清空（互斥）', $('me_manual_date').value === '',
    `manual="${$('me_manual_date').value}"`);
  $('m_manual_date').value = '2026-05-26T20:12:41';
  $('m_date_from_filename').checked = true;
  dom.window.onMetaDateFromNameChange('m');
  check('场景3: 全局面板勾选文件名提取 → 手动日期被清空', $('m_manual_date').value === '',
    `manual="${$('m_manual_date').value}"`);

  // ══ 场景1b：弹窗内复用拍摄时间 ══
  dom.window.eval('metaBatchItems[0].settings.date_from_filename = false');
  $('me_date_from_filename').checked = false;
  const timeBtn = [...d.querySelectorAll('#metaEditReuse [data-action="reuse-source-time"]')][0];
  timeBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  check('场景1b: 复用拍摄时间 → me_manual_date = 本地 naive（无 Z）',
    $('me_manual_date').value === expected && !$('me_date_from_filename').checked,
    `manual="${$('me_manual_date').value}"`);
  check('场景1b: 日期总开关自动开启 + 信息行反馈',
    $('me_apply_date').checked && !$('me_date_opts').classList.contains('hidden')
    && $('me_date_info').textContent.includes('已复用'),
    `checked=${$('me_apply_date').checked}`);

  // 保存 → 设置写回 per-item
  dom.window.saveMetaFileSettings();
  const saved = dom.window.eval('JSON.stringify(metaBatchItems[0].settings)');
  check('场景1c: 保存后 per-item settings 携带复用结果（manual_date 本地 naive + GPS）',
    saved.includes(expected) && saved.includes('36.7458'),
    saved.slice(0, 160));

  // ══ 场景2：地图选点名称兜底 + 队列徽章显示地名 ══
  dom.window.eval(`mapPickerTarget = 'me'; mapSelectedLocation = { name: '36.7458, 116.8331', lat: 36.7458, lon: 116.8331, address: '山东省济南市历城区旅游路1号' };`);
  dom.window.confirmMapSelection();
  check('场景2: 选点名称为坐标串时 → 拍摄地点从地址首段兜底',
    $('me_location_name').value === '山东省济南市历城区旅游路1号',
    `name="${$('me_location_name').value}"`);
  dom.window.eval(`mapPickerTarget = 'meta'; mapSelectedLocation = { name: '', lat: 31.2304, lon: 121.4737, address: '上海市人民广场' };`);
  dom.window.confirmMapSelection();
  check('场景2: 全局面板选点名称为空 → 地址兜底填充拍摄地点',
    $('m_location_name').value === '上海市人民广场', `name="${$('m_location_name').value}"`);
  // 队列徽章：设置 location_name 后重渲染，徽章应含地名
  dom.window.eval('metaBatchItems[0].settings.location_name = "泉城广场"; metaBatchItems[0].settings.location_lat = "36.7458"; metaBatchItems[0].settings.location_lon = "116.8331"; renderMetaBatchTable();');
  check('场景2: 队列徽章显示拍摄地点（不再只有坐标）',
    $('metaBatchTableBody').innerHTML.includes('泉城广场'), 'badge 含地名');

  // ══ 收尾 ══
  check('页面无 JS 错误', errors.length === 0, errors.slice(0, 3).join(' | '));

  const failed = results.filter(r => !r.ok).length;
  console.log(`\n══ 元数据复用四场景验证：${results.length - failed}/${results.length} PASS ══`);
  process.exit(failed ? 1 : 0);
})();

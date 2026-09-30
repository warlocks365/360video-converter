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
  if (u.includes('/api/geocode') && u.includes('__regeo__')) return {
    status: '1',
    regeocode: {
      formatted_address: '山东省济南市历城区旅游路1号',
      addressComponent: { province: '山东省', city: '济南市', district: '历城区', township: '旅游路', building: {}, neighborhood: {} },
    },
  };
  if (u.includes('/api/nominatim') && u.includes('reverse=1')) return {
    display_name: '山东省济南市历城区旅游路1号', name: '',
    address: { state: '山东省', city: '济南市' },
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
  const storedFromName = dom.window.eval('metaBatchItems[0].settings.date_from_filename');
  check('场景4: 探测自动填充的 manual_date 已无 Z/UTC 偏差（探测不覆盖用户选择）',
    storedManual === '' && storedFromName === true,
    `manual_date="${storedManual}" date_from_filename=${storedFromName}`);
  check('场景6a: 全局选了「从文件名提取」→ 探测不覆盖（弹窗与外部预览一致）',
    storedManual === '' && storedFromName === true,
    `manual_date="${storedManual}" date_from_filename=${storedFromName}`);
  // 场景4 显示层：源信息面板展示本地墙钟（旧实现展示 UTC 墙钟 → 用户按显示值
  // 设定即产生 ±8h 偏差）
  await dom.window.probeSourceVideo('X.mp4', 'm');
  check('场景4: 源信息面板拍摄时间显示本地墙钟（非 UTC）',
    $('metaSourceInfo').innerHTML.includes('20:12:41')
    && !$('metaSourceInfo').innerHTML.includes('12:12:41'),
    $('metaSourceInfo').innerHTML.replace(/<[^>]+>/g, ' ').slice(0, 120));

  // ══ 场景6b/6c：日期来源优先级（探测只在"未选择任何来源"时兜底）══
  dom.window.eval('metaBatchItems[0].settings.date_from_filename = false; metaBatchItems[0].settings.manual_date = "";');
  await dom.window.probeMetaFile(0);
  check('场景6b: 未选择任何来源 → 探测默认复用源拍摄时间（本地 naive）',
    dom.window.eval('metaBatchItems[0].settings.manual_date') === expected
    && dom.window.eval('metaBatchItems[0].settings.date_from_filename') === false,
    `manual="${dom.window.eval('metaBatchItems[0].settings.manual_date')}"`);
  dom.window.eval('metaBatchItems[0].settings.date_from_filename = false; metaBatchItems[0].settings.manual_date = "2026-01-01T08:00:00";');
  await dom.window.probeMetaFile(0);
  check('场景6c: 手动指定日期已填 → 探测不覆盖',
    dom.window.eval('metaBatchItems[0].settings.manual_date') === '2026-01-01T08:00:00',
    `manual="${dom.window.eval('metaBatchItems[0].settings.manual_date')}"`);

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

  // ══ 场景5（v3.13.5 回归）：非字符串 name/address 不再抛 TypeError ══
  // 线上实测：Nominatim 的 name 字段可能是本地化名映射对象 → nameVal.trim 抛
  // "Uncaught TypeError: nameVal.trim is not a function"（v3.13.4 回归）
  dom.window.eval(`mapPickerTarget = 'meta'; mapSelectedLocation = { name: { zh: '凤凰岭景区', en: 'Fenghuangling' }, lat: 40.1052, lon: 116.0786, address: {} };`);
  let threw5 = false;
  try { dom.window.confirmMapSelection(); } catch (e) { threw5 = true; }
  check('场景5: name/address 为对象 → 不抛 TypeError 且取本地化名',
    !threw5 && $('m_location_name').value === '凤凰岭景区',
    `threw=${threw5} name="${$('m_location_name').value}"`);
  dom.window.eval(`mapPickerTarget = 'meta'; mapSelectedLocation = { name: 12345, lat: 40.1, lon: 116.0, address: null };`);
  threw5 = false;
  try { dom.window.confirmMapSelection(); } catch (e) { threw5 = true; }
  check('场景5: name 为数字 → 收敛为字符串不抛错',
    !threw5 && $('m_location_name').value === '12345',
    `threw=${threw5} name="${$('m_location_name').value}"`);

  // ══ 场景7（v3.13.7）：纯坐标源复用 GPS → 逆地理补全地名/地址 ══
  dom.window.eval(`metaBatchItems[0].probeData = { has_gps: true, gps: { lat: 36.7458, lon: 116.8331 }, has_time: true, creation_time: '2026-05-26T12:12:41.000000Z', location_name: '', location_address: '' };`);
  dom.window.editMetaFileSettings(0);
  const gpsBtn7 = [...d.querySelectorAll('#metaEditReuse [data-action="reuse-source-gps"]')][0];
  gpsBtn7.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await new Promise(r => setTimeout(r, 600));   // 等待异步逆地理
  check('场景7: 纯坐标源复用 GPS → 逆地理补全拍摄地点',
    $('me_location_name').value !== '' && !$('me_location_name').value.startsWith('36.'),
    `name="${$('me_location_name').value}"`);
  check('场景7: 逆地理补全详细地址',
    $('me_location_address').value.includes('旅游路'),
    `addr="${$('me_location_address').value}"`);

  check('场景7: 逆地理补全详细地址',
    $('me_location_address').value.includes('旅游路'),
    `addr="${$('me_location_address').value}"`);

  // ══ 场景8（v3.13.8）：元数据报告显示拍摄时间 = 本地墙钟 ══
  // 旧实现透传 ffprobe 原始 UTC 标签值（2026-05-26T12:12:41Z），与元数据工具
  // 写入口径（本地墙钟 20:12:41）相差 8 小时——同 app 两处显示互相矛盾。
  const item8 = { probeData: { format: { tags: { creation_time: '2026-05-26T12:12:41.000000Z' } }, streams: [] } };
  check('场景8: 报告字段值 = 本地墙钟（非 UTC 原串）',
    dom.window.reportItemFilterValue(item8, 'creation_time') === '2026-05-26 20:12:41',
    dom.window.reportItemFilterValue(item8, 'creation_time'));
  check('场景8: fmtCreationTimeDisplay 空值安全',
    dom.window.fmtCreationTimeDisplay('') === '' && dom.window.fmtCreationTimeDisplay(null) === '',
    '空值不抛错');
  // 真实产物数据核验：v3.13.4 e2e 写入的 out_t1.mp4（naive 15:30 → 标签 07:30Z）。
  // REAL_TAG 由外层 bash 用 ffprobe 读取后经环境变量传入（规避 node spawnSync EBUSY）。
  try {
    const realRaw = process.env.REAL_TAG || '';
    if (!realRaw) { check('场景8: 真实产物标签核验', false, 'REAL_TAG 未传入'); }
    else {
      const realDisp = dom.window.fmtCreationTimeDisplay(realRaw);
      check('场景8: 真实产物标签 → 报告显示本地墙钟 15:30',
        realDisp === '2026-05-26 15:30:00', `raw="${realRaw}" display="${realDisp}"`);
    }
  } catch (e) {
    check('场景8: 真实产物标签核验', false, e.message.slice(0, 120));
  }

  // ══ 场景9（v3.13.9）：报告多条件筛选叠加 + 值集合下拉 + 加入元数据队列 ══
  dom.window.eval(`reportData = [
    { filename: 'A.mp4', path: 'G:/x/A.mp4', size: 100, moov: { has_moov: true, moov_position: 'front' },
      probeData: { format: { tags: {}, duration: '10' }, streams: [ { codec_type: 'video', codec_name: 'h264', width: 4096, height: 2048, r_frame_rate: '30/1', bit_rate: '5000000', pix_fmt: 'yuv420p' }, { codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 2 } ] } },
    { filename: 'B.mp4', path: 'G:/x/B.mp4', size: 200, moov: { has_moov: true, moov_position: 'end' },
      probeData: { format: { tags: {}, duration: '20' }, streams: [ { codec_type: 'video', codec_name: 'hevc', width: 4096, height: 2048, r_frame_rate: '30/1', bit_rate: '8000000', pix_fmt: 'yuv420p' } ] } },
    { filename: 'C.mp4', path: 'G:/x/C.mp4', size: 300, moov: { has_moov: false },
      probeData: { format: { tags: {}, duration: '30' }, streams: [ { codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, r_frame_rate: '30/1', bit_rate: '3000000', pix_fmt: 'yuv420p' } ] } },
  ];`);
  dom.window.eval(`reportFilterList = [ { field: 'vcodec', value: 'h264' }, { field: 'resolution', value: '4096x2048' } ]; renderReportFilterRows(); renderReport();`);
  check('场景9: 双条件 AND 叠加（vcodec=h264 且 4096x2048 → 仅 A）',
    dom.window.eval('getVisibleReportItems().length') === 1
    && dom.window.eval("getVisibleReportItems()[0].item.filename") === 'A.mp4',
    `visible=${dom.window.eval('getVisibleReportItems().length')}`);
  check('场景9: 值集合下拉收集（vcodec 去重值 h264/hevc）',
    dom.window.eval("JSON.stringify(collectReportFieldValues('vcodec'))") === '["h264","hevc"]',
    dom.window.eval("JSON.stringify(collectReportFieldValues('vcodec'))"));
  check('场景9: 筛选行渲染出值下拉（report-filter-value）',
    $('reportFilterRows').innerHTML.split('report-filter-value').length - 1 === 2,
    `值下拉数=${$('reportFilterRows').innerHTML.split('report-filter-value').length - 1}`);
  // 加入元数据批量队列（目标选择器 = meta）
  dom.window.eval(`reportSelectedPaths = new Set(['G:/x/A.mp4', 'G:/x/B.mp4']); document.getElementById('reportQueueTarget').value = 'meta';`);
  const before9 = dom.window.eval('metaBatchItems.length');
  dom.window.addSelectedReportToQueue();
  check('场景9: 加入元数据批量队列（新增 2 项）',
    dom.window.eval('metaBatchItems.length') === before9 + 2,
    `metaBatchItems=${dom.window.eval('metaBatchItems.length')} (was ${before9})`);
  check('场景9: 自动切换到元数据模式',
    dom.window.eval('currentMode') === 'metadata',
    `currentMode=${dom.window.eval('currentMode')}`);
  // 目标=convert 回归：重复文件跳过
  dom.window.eval(`document.getElementById('reportQueueTarget').value = 'convert'; reportSelectedPaths = new Set(['G:/x/A.mp4']);`);
  dom.window.addSelectedReportToQueue();
  check('场景9: 目标=convert 回归（加入转换批量队列）',
    dom.window.eval('typeof batchTasks') !== 'undefined' && dom.window.eval('batchTasks.length') >= 1,
    `batchTasks=${dom.window.eval('batchTasks.length')}`);

  // ══ 收尾 ══
  check('页面无 JS 错误', errors.length === 0, errors.slice(0, 3).join(' | '));

  const failed = results.filter(r => !r.ok).length;
  console.log(`\n══ 元数据复用四场景验证：${results.length - failed}/${results.length} PASS ══`);
  process.exit(failed ? 1 : 0);
})();

// v3.13.9 元数据报告增强验证（jsdom 真实页面 + 全业务脚本 + 桩 API）
// 覆盖：R1 值集合下拉 / R2 多条件叠加 / R3 队列目标 / R4 设计探查
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
    has_spherical: false, spherical: { pano_type: null, stereo_mode: null },
    has_date: false, creation_time: '',
    has_gps: false, gps: null, location_name: '', location_address: '',
    file_size_mb: 123.4, date_in_name: '', filename: 'X.mp4',
  };
  if (u.includes('/api/extract_date')) return { date_str: null };
  if (u.includes('/api/codecs')) return { codecs: { libx264: { label: 'H.264 (libx264)', group: 'cpu', presets: [], default_preset: '', has_profile: true, has_level: true, has_bf_refs: true, has_x264_params: true, x265_params: false } } };
  if (u.includes('/api/codec_check')) return { available: {}, error_details: {}, ffmpeg_info: {}, runtime_dlls: {}, fix_hints: {} };
  if (u.includes('/api/presets')) return { presets: [] };
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
  await new Promise(r => setTimeout(r, 2500));
  const d = dom.window.document;
  const $ = id => d.getElementById(id);

  // 三份探测数据各异的条目：A 有全景/地点/经纬度；B 无地点无音频；C 纯 h264 1080p 无 moov
  dom.window.eval(`reportData = [
    { filename: 'A.mp4', path: 'G:/x/A.mp4', size: 100, moov: { has_moov: true, moov_position: 'front' },
      probeData: { format: { tags: { comment: 'GSpherical equirectangular' }, duration: '10' },
        streams: [ { codec_type: 'video', codec_name: 'h264', width: 4096, height: 2048, r_frame_rate: '30/1', bit_rate: '5000000', pix_fmt: 'yuv420p', tags: { location: '+36.7458+116.8331/', location_name: '凤凰岭景区' } },
                   { codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 2, tags: {} } ] } },
    { filename: 'B.mp4', path: 'G:/x/B.mp4', size: 200, moov: { has_moov: true, moov_position: 'end' },
      probeData: { format: { tags: {}, duration: '20' },
        streams: [ { codec_type: 'video', codec_name: 'hevc', width: 4096, height: 2048, r_frame_rate: '30/1', bit_rate: '8000000', pix_fmt: 'yuv420p' } ] } },
    { filename: 'C.mp4', path: 'G:/x/C.mp4', size: 300, moov: { has_moov: false },
      probeData: { format: { tags: {}, duration: '30' },
        streams: [ { codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, r_frame_rate: '30/1', bit_rate: '3000000', pix_fmt: 'yuv420p' } ] } },
  ];`);

  // ══ R1 值集合下拉 ══
  check('R1.1: vcodec 值集合 = 去重排序 [h264, hevc]',
    dom.window.eval("JSON.stringify(collectReportFieldValues('vcodec'))") === '["h264","hevc"]',
    dom.window.eval("JSON.stringify(collectReportFieldValues('vcodec'))"));
  // 行渲染：加一行选 resolution，断言值下拉选项重建
  dom.window.eval(`reportFilterList = [{ field: '', value: '' }]; renderReportFilterRows();`);
  const rowSel = d.querySelector('#reportFilterRows select[data-part="field"]');
  rowSel.value = 'resolution';
  rowSel.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  const valOpts = [...d.querySelectorAll('#reportFilterRows select[data-part="value"] option')].map(o => o.value).filter(v => Boolean(v) && v !== '__EMPTY__');
  check('R1.2: 字段切换 → 值集合重建为 resolution 的去重集（含空值选项）',
    JSON.stringify(valOpts.sort()) === JSON.stringify(['1920x1080', '4096x2048']),
    valOpts.join(' | '));
  // R1.3: 空值剔除 —— location_name 仅 A 有
  dom.window.eval(`reportFilterList = [{ field: 'location_name', value: '' }]; renderReportFilterRows();`);
  const locOpts = [...d.querySelectorAll('#reportFilterRows select[data-part="value"] option')].map(o => o.value).filter(v => Boolean(v) && v !== '__EMPTY__');
  check('R1.3: location_name 值集合不含空串（仅凤凰岭景区）',
    locOpts.length === 1 && locOpts[0] === '凤凰岭景区', locOpts.join(' | '));
  // R1.4: 布尔字段 是/否
  dom.window.eval(`reportFilterList = [{ field: 'moov', value: '' }]; renderReportFilterRows();`);
  const boolOpts = [...d.querySelectorAll('#reportFilterRows select[data-part="value"] option')].map(o => o.value);
  check('R1.4: moov 布尔字段值下拉 = 是/否',
    boolOpts[0] === '是' && boolOpts[1] === '否', boolOpts.join('|'));
  // R1.5: 空数据健壮性
  dom.window.eval('reportData = [];');
  let threw = false;
  try { dom.window.eval(`reportFilterList = [{ field: 'vcodec', value: '' }]; renderReportFilterRows();`); dom.window.collectReportFieldValues('vcodec'); } catch (e) { threw = true; }
  check('R1.5: reportData 清空后收集/渲染不崩', !threw, threw ? '异常' : 'ok');
  dom.window.eval('reportData = ' + JSON.stringify([
    { filename: 'A.mp4', path: 'G:/x/A.mp4', size: 100, moov: { has_moov: true, moov_position: 'front' },
      probeData: { format: { tags: { comment: 'GSpherical equirectangular' }, duration: '10' }, streams: [ { codec_type: 'video', codec_name: 'h264', width: 4096, height: 2048, r_frame_rate: '30/1', bit_rate: '5000000', pix_fmt: 'yuv420p', tags: { location: '+36.7458+116.8331/', location_name: '凤凰岭景区' } }, { codec_type: 'audio', codec_name: 'aac', tags: {} } ] } },
    { filename: 'B.mp4', path: 'G:/x/B.mp4', size: 200, moov: { has_moov: true, moov_position: 'end' },
      probeData: { format: { tags: {}, duration: '20' }, streams: [ { codec_type: 'video', codec_name: 'hevc', width: 4096, height: 2048, r_frame_rate: '30/1', bit_rate: '8000000', pix_fmt: 'yuv420p' } ] } },
    { filename: 'C.mp4', path: 'G:/x/C.mp4', size: 300, moov: { has_moov: false },
      probeData: { format: { tags: {}, duration: '30' }, streams: [ { codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, r_frame_rate: '30/1', bit_rate: '3000000', pix_fmt: 'yuv420p' } ] } },
  ]));

  // ══ R2 多条件叠加 ══
  dom.window.eval(`reportFilterList = [ { field: 'vcodec', value: 'h264' }, { field: 'resolution', value: '4096x2048' } ]; renderReportFilterRows(); renderReport();`);
  check('R2.1: 双条件 AND（h264 + 4096x2048 → 仅 A）',
    dom.window.eval('getVisibleReportItems().length') === 1
    && dom.window.eval("getVisibleReportItems()[0].item.filename") === 'A.mp4',
    `visible=${dom.window.eval('getVisibleReportItems().length')}`);
  dom.window.eval(`reportFilterList.push({ field: 'duration', value: '30' }); renderReport();`);
  check('R2.2: 三条件 AND（+duration=30 → 0 结果）',
    dom.window.eval('getVisibleReportItems().length') === 0,
    `visible=${dom.window.eval('getVisibleReportItems().length')}`);
  check('R2.6: 无匹配 → 渲染空态文案',
    ($('reportResult') || d.body).textContent.includes('没有符合筛选条件'),
    ($('reportResult') ? $('reportResult').textContent : d.body.textContent).slice(0, 30));
  dom.window.eval(`reportFilterList.pop(); renderReport();`);
  check('R2.4: 删除 duration 行 → 恢复 1 结果',
    dom.window.eval('getVisibleReportItems().length') === 1,
    `visible=${dom.window.eval('getVisibleReportItems().length')}`);
  dom.window.eval(`reportFilterList.push({ field: 'moov', value: '是' }); renderReport();`);
  check('R2.5: 布尔行叠加（moov=是 + vcodec=h264 → A）',
    dom.window.eval('getVisibleReportItems().length') === 1
    && dom.window.eval("getVisibleReportItems()[0].item.filename") === 'A.mp4',
    `visible=${dom.window.eval('getVisibleReportItems().length')}`);
  // R2.7: 条件跨数据重载保持（数据逆序模拟重读）
  const keptConds = dom.window.eval('JSON.stringify(reportFilterList)');
  dom.window.eval('reportData = reportData.slice().reverse(); renderReport();');
  check('R2.7: 筛选条件跨数据重载保持且仍生效',
    dom.window.eval('JSON.stringify(reportFilterList)') === keptConds
    && dom.window.eval('getVisibleReportItems().length') === 1,
    `conds=${keptConds}`);
  dom.window.eval('reportData = reportData.slice().reverse(); renderReport();');   // 恢复顺序

  // ══ R3 队列目标 ══
  // R3.5: 按钮文案
  dom.window.eval(`reportSelectedPaths = new Set(['G:/x/A.mp4', 'G:/x/C.mp4']); renderReport();`);
  check('R3.5: 按钮文案 = 加入队列（已选 2）',
    ($('reportAddToQueueBtn') || {}).textContent === '加入队列（已选 2）',
    `text="${($('reportAddToQueueBtn') || {}).textContent}"`);
  // R3.4: 未勾选防护
  dom.window.eval(`reportSelectedPaths = new Set();`);
  const bt0 = dom.window.eval('batchTasks.length'), mb0 = dom.window.eval('metaBatchItems.length');
  dom.window.addSelectedReportToQueue();
  check('R3.4: 未勾选 → 两队列均不变',
    dom.window.eval('batchTasks.length') === bt0 && dom.window.eval('metaBatchItems.length') === mb0,
    `batch=${dom.window.eval('batchTasks.length')} meta=${dom.window.eval('metaBatchItems.length')}`);
  // R3.1: convert 目标
  dom.window.eval(`reportSelectedPaths = new Set(['G:/x/A.mp4', 'G:/x/C.mp4']); document.getElementById('reportQueueTarget').value = 'convert';`);
  dom.window.addSelectedReportToQueue();
  check('R3.1: convert 目标 → batchTasks +2 且切 batch 模式',
    dom.window.eval('batchTasks.length') === bt0 + 2 && dom.window.eval('currentMode') === 'batch',
    `batchTasks=${dom.window.eval('batchTasks.length')} mode=${dom.window.eval('currentMode')}`);
  // R3.3: 重复路径跳过（convert）
  const btBefore = dom.window.eval('batchTasks.length');
  dom.window.addSelectedReportToQueue();
  check('R3.3a: convert 重复跳过（列表不变）', dom.window.eval('batchTasks.length') === btBefore,
    `batchTasks=${dom.window.eval('batchTasks.length')}`);
  // R3.2: meta 目标 + 自动探测
  dom.window.eval(`document.getElementById('reportQueueTarget').value = 'meta'; reportSelectedPaths = new Set(['G:/x/A.mp4', 'G:/x/C.mp4']);`);
  const mbBefore = dom.window.eval('metaBatchItems.length');
  dom.window.addSelectedReportToQueue();
  await new Promise(r => setTimeout(r, 600));   // 等待自动探测
  check('R3.2: meta 目标 → metaBatchItems +2 且切 metadata 模式',
    dom.window.eval('metaBatchItems.length') === mbBefore + 2 && dom.window.eval('currentMode') === 'metadata',
    `metaBatchItems=${dom.window.eval('metaBatchItems.length')} mode=${dom.window.eval('currentMode')}`);
  check('R3.2b: 新条目已自动探测（probed + size_mb 来自探测）',
    dom.window.eval(`metaBatchItems.slice(${mbBefore}).every(m => m.probed === true && m.size_mb === 123.4)`),
    dom.window.eval(`JSON.stringify(metaBatchItems.slice(${mbBefore}).map(m => ({ probed: m.probed, size: m.size_mb })))`));
  // R3.3: meta 重复路径跳过
  dom.window.addSelectedReportToQueue();
  check('R3.3b: meta 重复路径跳过（列表不变）',
    dom.window.eval('metaBatchItems.length') === mbBefore + 2,
    `metaBatchItems=${dom.window.eval('metaBatchItems.length')}`);

  // ══ R4 设计探查 ══
  const durVals = dom.window.eval("JSON.stringify(collectReportFieldValues('duration'))");
  check('R4.1(观察): 连续值字段 duration 的值集合 = 每项唯一（10/20/30）',
    durVals === '["10","20","30"]', durVals);
  dom.window.eval(`reportFilterList = [{ field: 'vcodec', value: 'hevc' }]; renderReport(); reportSelectClear();`);
  check('R4.2-预置: 过滤 hevc 后可见 = 仅 B', dom.window.eval('getVisibleReportItems().length') === 1,
    `visible=${dom.window.eval('getVisibleReportItems().length')}`);
  dom.window.reportSelectVisibleAll();
  const selAll = dom.window.eval('JSON.stringify([...reportSelectedPaths].sort())');
  check('R4.2: 筛选后全选只作用于可见（恰选中 B，历史勾选已清）',
    selAll === '["G:/x/B.mp4"]', selAll);
  dom.window.reportSelectInvert();
  const selInv = dom.window.eval('reportSelectedPaths.size');
  check('R4.3: 反选只作用于可见（B 被移除 → 勾选集为空）',
    selInv === 0, `size=${selInv}`);

  // ══ R5（v3.13.11）：空值筛选 —— 筛出该元数据项无内容的文件 ══
  dom.window.eval(`reportFilterList = [{ field: 'location_name', value: '__EMPTY__' }]; renderReportFilterRows(); renderReport();`);
  const locOpts5 = [...d.querySelectorAll('#reportFilterRows select[data-part="value"] option')].map(o => ({ v: o.value, t: o.textContent }));
  check('R5.1: 值下拉含（空值）选项',
    locOpts5.some(o => o.v === '__EMPTY__' && o.t === '（空值）'), JSON.stringify(locOpts5));
  check('R5.2: location_name 选空值 → 仅无地名条目可见（B、C）',
    dom.window.eval("JSON.stringify(getVisibleReportItems().map(v => v.item.filename))") === '["B.mp4","C.mp4"]',
    dom.window.eval("JSON.stringify(getVisibleReportItems().map(v => v.item.filename))"));
  dom.window.eval(`reportFilterList = [{ field: 'location_name', value: '__EMPTY__' }, { field: 'vcodec', value: 'h264' }]; renderReport();`);
  check('R5.3: 空值 AND 编码器=h264 → 仅 C（B 是 hevc）',
    dom.window.eval("JSON.stringify(getVisibleReportItems().map(v => v.item.filename))") === '["C.mp4"]',
    dom.window.eval("JSON.stringify(getVisibleReportItems().map(v => v.item.filename))"));
  dom.window.eval(`reportFilterList = [{ field: 'vcodec', value: '__EMPTY__' }]; renderReport();`);
  check('R5.4: 全部条目都有值的字段选空值 → 0 结果不崩溃',
    dom.window.eval('getVisibleReportItems().length') === 0,
    `visible=${dom.window.eval('getVisibleReportItems().length')}`);

  // ══ 收尾 ══
  check('页面无 JS 错误', errors.length === 0, errors.slice(0, 3).join(' | '));

  const failed = results.filter(r => !r.ok).length;
  console.log(`\n══ 报告增强验证：${results.length - failed}/${results.length} PASS ══`);
  process.exit(failed ? 1 : 0);
})();

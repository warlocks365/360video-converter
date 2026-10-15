// v3.14.6 元数据工具三功能验收（真实 DOM + dev 后端）
// 覆盖：
//   F1 GPS 选点层级/保窗/回写/批量赋值规则
//   F2 批量列表筛选（AND 叠加）+ 与勾选/批量应用的协同
//   F3 JSON 导入导出（后端端点级往返 + 异常分支）
const path = require('path');
const os = require('os');
const http = require('http');
const WS = path.join(os.homedir(), '.workbuddy', 'binaries', 'node', 'workspace', 'node_modules');
const { JSDOM, VirtualConsole } = require(path.join(WS, 'jsdom'));
const STUB = 'http://127.0.0.1:8800';
const DEV = 'http://127.0.0.1:8766';
const R = path.resolve(__dirname, '..', '..');
const results = [];
const check = (n, ok, d) => { results.push({ n, ok: !!ok, d: d === undefined ? '' : String(d) }); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const getJSON = (base, p) => new Promise((res, rej) => {
  http.get(base + p, r => { let b = ''; r.on('data', c => b += c); r.on('end', () => { try { res({ status: r.statusCode, data: JSON.parse(b) }); } catch (e) { rej(e); } }); }).on('error', rej);
});
const postJSON = (base, p, obj) => new Promise((res, rej) => {
  const data = JSON.stringify(obj);
  const req = http.request(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, r => {
    let b = ''; r.on('data', c => b += c);
    r.on('end', () => { try { res({ status: r.statusCode, data: JSON.parse(b) }); } catch (e) { res({ status: r.statusCode, data: { raw: b.slice(0, 200) } }); } });
  });
  req.on('error', rej); req.end(data);
});

(async () => {
  let dev = true;
  try { await getJSON(DEV, '/api/version'); } catch (e) { dev = false; }
  check('F0 dev 8766 在线', dev);

  // ── F3a 后端端点级往返（绕过浏览器对话框，直接读写端点）──
  if (dev) {
    const state = { kind: 'meta-batch-state', version: 1, filters: [{ field: 'filename', op: 'contains', value: 'x' }], items: [{ path: 'G:/a.mp4', selected: true, settings: { apply_date: true }, outDir: { mode: 'global', value: '' } }] };
    const tmp = 'G:/264/_acceptance_v3132/_meta_state_test.json';
    const w = await postJSON(DEV, '/api/write_json_file', { path: tmp, content: JSON.stringify(state) });
    check('F3a 写端点返回 success', w.data && w.data.success === true, JSON.stringify(w.data).slice(0, 120));
    const r = await postJSON(DEV, '/api/read_json_file', { path: tmp });
    check('F3b 读端点往返一致', r.data && r.data.content && JSON.parse(r.data.content).kind === 'meta-batch-state', JSON.stringify(r.data).slice(0, 100));
    const r404 = await postJSON(DEV, '/api/read_json_file', { path: 'G:/nope/notexist.json' });
    check('F3c 读不存在文件→404', r404.status === 404, r404.status);
    const rBad = await postJSON(DEV, '/api/read_json_file', { path: 'G:/264/_acceptance_v3132/out_t1.mp4' });
    check('F3d 读非 .json 扩展→400', rBad.status === 400, rBad.status);
    try { require('fs').unlinkSync(tmp); } catch (e) {}
  }

  // ── jsdom 真实 DOM：筛选/勾选协同/批量规则 ──
  const dom = await JSDOM.fromURL(STUB + '/', {
    runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, virtualConsole: new VirtualConsole(),
    beforeParse(w) {
      let realFetch = null;
      w.fetch = async (u, o) => {
        const p = String(u);
        if (p.includes('/api/native_dialog')) return { ok: true, status: 200, json: async () => ({ path: 'G:/264/_acceptance_v3132/_dom_state.json' }) };
        if (p.includes('/api/write_json_file')) {
          w.__lastWrite = JSON.parse(o.body);
          return { ok: true, status: 200, json: async () => ({ success: true, path: w.__lastWrite.path }) };
        }
        if (p.includes('/api/read_json_file')) {
          w.__readCalls = (w.__readCalls || 0) + 1;
          return { ok: true, status: 200, json: async () => ({ content: JSON.stringify(w.__stateFile || {}) }) };
        }
        if (p.includes('/api/codecs')) return { ok: true, status: 200, json: async () => ({ codecs: {}, video: [], audio: [] }) };
        if (p.includes('/api/codec_check')) return { ok: true, status: 200, json: async () => ({ available: {}, error_details: {}, ffmpeg_info: {}, runtime_dlls: {}, fix_hints: {} }) };
        if (p.includes('/api/settings')) return { ok: true, status: 200, json: async () => ({ auto_load_tasks: false, amap_api_key: 'k', amap_security: 's', custom_ffmpeg_path: '', agent_enabled: false, agent_base_url: '', agent_api_key: '', agent_model: '', agent_thinking: 'default', agent_reasoning_effort: 'auto', agent_permission: 'standard', agent_temperature: '', agent_max_steps: 40, agent_step_delay: 0.4 }) };
        if (p.includes('/api/presets')) return { ok: true, status: 200, json: async () => ({ presets: [] }) };
        if (p.includes('/api/version')) return { ok: true, status: 200, json: async () => ({ version: '3.14.6-test' }) };
        if (p.includes('/api/tasks/load')) return { ok: true, status: 200, json: async () => ({ tasks: [] }) };
        if (p.includes('/api/sysmon')) return { ok: true, status: 200, json: async () => ({}) };
        if (!realFetch) realFetch = w.__proto__ && w.__proto__.fetch ? w.__proto__.fetch.bind(w) : null;
        if (realFetch) return realFetch(u, o);
        return { ok: true, status: 200, json: async () => ({}) };
      };
      w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
      w.confirm = () => true;
    },
  });
  const win = dom.window, doc = win.document;
  await sleep(3200);

  // 构造批量列队（含不同 GPS/日期/文件名特征）
  const seed = [
    { path: 'G:/v/a_beijing.mp4', name: 'a_beijing.mp4', size_mb: 10, selected: true, status: 'pending', probed: true, settings: { apply_date: true, apply_location: true, apply_spherical: false, pano_type: '360', stereo_mode: 'mono', location_name: '北京故宫', location_address: '东城区景山前街4号', location_lat: '39.916', location_lon: '116.397' }, outDir: { mode: 'global', value: '' } },
    { path: 'G:/v/b_shanghai.mp4', name: 'b_shanghai.mp4', size_mb: 20, selected: true, status: 'done', probed: true, settings: { apply_date: false, apply_location: false, apply_spherical: true, pano_type: '180', stereo_mode: 'top-bottom' }, outDir: { mode: 'snapshot', value: 'G:/out' } },
    { path: 'G:/v/c_noloc.mp4', name: 'c_noloc.mp4', size_mb: 30, selected: false, status: 'pending', probed: true, settings: { apply_date: true, apply_location: false, apply_spherical: false }, outDir: { mode: 'global', value: '' } },
  ];
  await win.eval(`metaBatchItems = ${JSON.stringify(seed)}; renderMetaBatchTable();`);
  const rowCount = () => doc.querySelectorAll('#metaBatchTableBody tr').length;
  check('F2a 初始 3 行可见', rowCount() === 3, rowCount());

  // F2b 字符串 contains 筛选（文件名含 b_）
  await win.eval(`metaFilterList = [{field:'filename', op:'contains', value:'b_'}]; renderMetaBatchTable();`);
  const visibleIdx = await win.eval(`JSON.stringify(metaBatchItems.map((f,i)=>({i, v: !_metaBatchVisibleSet || _metaBatchVisibleSet.has(i)})))`);
  const v = JSON.parse(visibleIdx).filter(x => x.v).map(x => x.i);
  check('F2b contains 筛选命中第2项', JSON.stringify(v) === '[1]', JSON.stringify(v));

  // F2c 多条件 AND（contains 文件名 + 状态已完成）
  await win.eval(`metaFilterList = [{field:'filename', op:'contains', value:'.mp4'},{field:'status', op:'equals', value:'已完成'}]; renderMetaBatchTable();`);
  const v2 = JSON.parse(await win.eval(`JSON.stringify(metaBatchItems.map((f,i)=>({i, v: !_metaBatchVisibleSet || _metaBatchVisibleSet.has(i)})))`)).filter(x => x.v).map(x => x.i);
  check('F2c AND 叠加命中仅已完成项', JSON.stringify(v2) === '[1]', JSON.stringify(v2));

  // F2d 空值/非空（location_address 为空）
  await win.eval(`metaFilterList = [{field:'location_address', op:'empty', value:''}]; renderMetaBatchTable();`);
  const v3 = JSON.parse(await win.eval(`JSON.stringify(metaBatchItems.map((f,i)=>({i, v: !_metaBatchVisibleSet || _metaBatchVisibleSet.has(i)})))`)).filter(x => x.v).map(x => x.i);
  check('F2d 空值筛选命中无地址的 2 项', JSON.stringify(v3) === '[1,2]', JSON.stringify(v3));

  // F2e 不包含（文件名不含 a_）
  await win.eval(`metaFilterList = [{field:'filename', op:'not_contains', value:'a_'}]; renderMetaBatchTable();`);
  const v4 = JSON.parse(await win.eval(`JSON.stringify(metaBatchItems.map((f,i)=>({i, v: !_metaBatchVisibleSet || _metaBatchVisibleSet.has(i)})))`)).filter(x => x.v).map(x => x.i);
  check('F2e not_contains 命中后两项', JSON.stringify(v4) === '[1,2]', JSON.stringify(v4));

  // F2f 全选只作用于可见（先清零勾选，模拟用户从零开始；筛 a_beijing → 全选后仅该项 selected）
  await win.eval(`metaBatchItems.forEach(f=>f.selected=false); metaFilterList = [{field:'filename', op:'contains', value:'a_beijing'}]; renderMetaBatchTable(); selectAllMetaFiles(true); metaFilterList=[]; renderMetaBatchTable();`);
  const selStates = await win.eval(`JSON.stringify(metaBatchItems.map(f=>!!f.selected))`);
  check('F2f 筛选后全选只选可见项（隐藏项不动）', JSON.stringify(JSON.parse(selStates)) === '[true,false,false]', selStates);

  // F2g 全不选清全部
  await win.eval(`selectAllMetaFiles(false);`);
  const sel2 = JSON.parse(await win.eval(`JSON.stringify(metaBatchItems.map(f=>!!f.selected))`));
  check('F2g 全不选清空全部勾选', sel2.every(s => s === false), JSON.stringify(sel2));

  // F2h 批量应用（界面设置→勾选项）：GPS 同值复制规则
  await win.eval(`metaBatchItems.forEach(f=>f.selected=true); metaBatchItems[0].settings = {apply_date:true, apply_location:true, apply_spherical:false, pano_type:'360', stereo_mode:'mono', location_name:'测试坐标点', location_address:'测试地址1号', location_lat:'39.9000', location_lon:'116.4000'}; _metaEditIndex=-1; applyMetaEditToChecked();`);
  const after = JSON.parse(await win.eval(`JSON.stringify(metaBatchItems.map(f=>({n:f.settings.location_name, lat:f.settings.location_lat, addr:f.settings.location_address})))`));
  check('F2h 批量应用 GPS 同值复制到全部勾选项', after.every(x => x.n === '测试坐标点' && x.lat === '39.9000' && x.addr === '测试地址1号'), JSON.stringify(after));

  // F1 地图弹窗层级（CSS 断言 + DOM 结构）
  const css = require('fs').readFileSync(path.join(R, 'static', 'css', 'app.css'), 'utf8');
  check('F1a #mapModal z-index 高于 .modal-overlay(100)', /#mapModal\s*\{\s*z-index:\s*130/.test(css));
  const domChain = await win.eval(`(function(){var m=document.getElementById('mapModal'),e=document.getElementById('metaEditModal');return JSON.stringify({siblings: !m.contains(e)&&!e.contains(m), mapBefore: m.compareDocumentPosition(e) & Node.DOCUMENT_POSITION_FOLLOWING ? true:false});})()`);
  const chain = JSON.parse(domChain);
  check('F1b 两 modal 为兄弟且 mapModal 在前（z-index 130 生效的 DOM 前提）', chain.siblings === true && chain.mapBefore === true, domChain);

  // F1c 编辑弹窗打开态下地图可开（不触发编辑窗关闭）
  const kept = await win.eval(`(function(){ editMetaFileSettings(0); var before = !!document.getElementById('metaEditModal').classList.contains('active'); openMapPicker('me'); var mapActive = document.getElementById('mapModal').classList.contains('active'); var stillOpen = document.getElementById('metaEditModal').classList.contains('active'); return JSON.stringify({before:before, mapActive:mapActive, stillOpen:stillOpen}); })()`);
  const k = JSON.parse(kept);
  check('F1c 编辑窗打开时地图可开且编辑窗保持（z-index 修复后互不影响）', k.before && k.mapActive && k.stillOpen, kept);

  // F3 DOM 级导出：走 fetch 桩捕获写入体
  await win.eval(`metaFilterList=[{field:'status',op:'equals',value:'已完成'}];`);
  await win.eval(`exportMetaBatchState();`);
  await sleep(600);
  const wrote = win.__lastWrite;
  check('F3e 导出经对话框+写端点（含筛选/勾选/设置）',
    !!wrote && wrote.path.endsWith('.json') && JSON.parse(wrote.content).kind === 'meta-batch-state'
    && JSON.parse(wrote.content).filters.length === 1
    && JSON.parse(wrote.content).items.length === 3,
    wrote ? wrote.path : 'no-write');

  // F3f DOM 级导入还原（含筛选条件还原）
  const roundtrip = JSON.parse(wrote.content);
  await win.eval(`metaBatchItems=[]; metaFilterList=[]; renderMetaBatchTable();`);
  await win.eval(`window.__stateFile = ${JSON.stringify(roundtrip).replace(/</g, '\\u003c')}; importMetaBatchState();`);
  await sleep(900);
  const restored = await win.eval(`JSON.stringify({n: metaBatchItems.length, sel: metaBatchItems.filter(f=>f.selected).length, filt: metaFilterList.length, lat: metaBatchItems[0].settings.location_lat})`);
  const rj = JSON.parse(restored);
  check('F3f 导入还原条目/勾选/筛选/GPS', rj.n === 3 && rj.sel === 3 && rj.filt === 1 && rj.lat === '39.9000', restored);

  // F3g 导入非法 JSON → 明确错误提示，队列不被破坏
  await win.eval(`window.__stateFile = null; window.__readErr = null;`);
  await win.eval(`(function(){ var of = window.fetch; window.fetch = function(u,o){ if(String(u).includes('/api/read_json_file')){ return Promise.resolve({ok:true,status:200,json:()=>Promise.resolve({content:'{not json'})}); } return of.apply(this,arguments); }; importMetaBatchState(); })()`);
  await sleep(700);
  const errToast = await win.eval(`(document.getElementById('toastNotification')||{}).textContent || ''`);
  check('F3g 非法 JSON 导入给出错误提示', /不是合法 JSON/.test(String(errToast)), String(errToast).slice(0, 80));

  dom.window.close();

  const bad = results.filter(r => !r.ok);
  console.log('══ v3.14.6 元数据三功能验收 ══');
  results.forEach(r => console.log((r.ok ? 'OK   ' : 'FAIL ') + r.n + (r.d ? '  → ' + r.d : '')));
  console.log(`合计 ${results.length} 项，通过 ${results.length - bad.length}，失败 ${bad.length}`);
  process.exit(bad.length ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });

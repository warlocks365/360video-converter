// v3.14.6 打包 exe 实机验证（真实 WebView2 + CDP）
// 三功能在冻结形态下的最终取证：
//   P1 GPS 选点：编辑窗开→真点地图→编辑窗保持→确认回写→批量同值规则
//   P2 筛选：AND 叠加 + 全选只作用可见 + 批量应用协同
//   P3 状态导出/导入：真对话框走系统原生（远程调试环境下 dialog 会阻塞，
//      故用后端端点直验证证写入内容+前端调用链已被 jsdom 套件覆盖，
//      此处聚焦 exe 形态下的 DOM 接线与按钮可用性）
const http = require('http');
const results = [];
const check = (n, ok, d) => { results.push({ n, ok: !!ok, d: d === undefined ? '' : String(d) }); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const list = await new Promise((res, rej) => http.get({ host: '127.0.0.1', port: 9222, path: '/json/list' }, r => { let b = ''; r.on('data', c => b += c); r.on('end', () => res(JSON.parse(b))); }).on('error', rej));
  const t = list.find(x => x.type === 'page');
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  let id = 0; const pend = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result || {}); pend.delete(m.id); } };
  await new Promise(r => { ws.onopen = r; });
  const send = (mm, p = {}) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: mm, params: p })); });
  const ev = async x => { const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }); return r.exceptionDetails ? 'ERR:' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text).slice(0, 200) : (r.result ? r.result.value : undefined); };
  await send('Runtime.enable');

  check('W0 exe 版本 3.14.6', await ev(`fetch('/api/version').then(r=>r.json()).then(j=>j.version)`) === '3.14.6');
  check('W1 45-filter 引擎已随包（filterVisibleIndexSet 在运行时）',
    await ev(`typeof filterVisibleIndexSet === 'function' && typeof renderFilterRowsHtml === 'function'`) === true);

  // W2 新 DOM 接线在位（按钮/筛选栏）——每项单独断言，避免 && 链返回末值
  check('W2a 筛选栏 DOM 在位', await ev(`!!document.getElementById('metaFilterBar') && !!document.getElementById('metaFilterAddBtn') && !!document.getElementById('metaFilterCount')`) === true);
  check('W2b 导入/导出按钮在位', await ev(`!!document.querySelector('[data-action="meta-io-export"]') && !!document.querySelector('[data-action="meta-io-import"]')`) === true);

  // W3 GPS：编辑窗打开 + 地图打开（真实 DOM 链路），断言编辑窗保持 active
  const gps = await ev(`(function(){
    metaBatchItems = [{ path:'G:/v/gps_test.mp4', name:'gps_test.mp4', selected:true, status:'pending', probed:true,
      settings:{ apply_date:false, apply_location:false, apply_spherical:false }, outDir:{mode:'global',value:''} }];
    renderMetaBatchTable();
    editMetaFileSettings(0);
    var editorOpen = document.getElementById('metaEditModal').classList.contains('active');
    openMapPicker('me');
    var mapOpen = document.getElementById('mapModal').classList.contains('active');
    var editorStill = document.getElementById('metaEditModal').classList.contains('active');
    var mapZ = getComputedStyle(document.getElementById('mapModal')).zIndex;
    return JSON.stringify({ editorOpen:editorOpen, mapOpen:mapOpen, editorStill:editorStill, mapZ:mapZ });
  })()`);
  const g = JSON.parse(gps);
  check('W3 GPS 链路：编辑窗开→地图开→编辑窗保持且地图层级更高',
    g.editorOpen && g.mapOpen && g.editorStill && parseInt(g.mapZ, 10) > 100, gps);

  // W4 地图选点回写（模拟选中后确认 → me_ 字段写入且编辑窗不关）
  const back = await ev(`(function(){
    mapSelectedLocation = { lat: 31.2304, lon: 121.4737, name: '上海外滩', address: '黄浦区中山东一路' };
    confirmMapSelection();
    var lat = document.getElementById('me_location_lat').value;
    var name = document.getElementById('me_location_name').value;
    var master = document.getElementById('me_apply_location').checked;
    var editorStill = document.getElementById('metaEditModal').classList.contains('active');
    var mapClosed = !document.getElementById('mapModal').classList.contains('active');
    return JSON.stringify({ lat:lat, name:name, master:master, editorStill:editorStill, mapClosed:mapClosed });
  })()`);
  const bk = JSON.parse(back);
  check('W4 GPS 回写：坐标/地名写入表单、主开关勾上、编辑窗保持、地图关闭',
    bk.lat === '31.230400' && bk.name === '上海外滩' && bk.master && bk.editorStill && bk.mapClosed, back);

  // W5 保存 → 条目 settings 落地
  const saved = await ev(`(function(){ saveMetaFileSettings(); var f = metaBatchItems[0];
    return JSON.stringify({ lat: f.settings.location_lat, name: f.settings.location_name, apply: f.settings.apply_location }); })()`);
  const sv = JSON.parse(saved);
  check('W5 GPS 保存到条目 settings', sv.lat === '31.230400' && sv.name === '上海外滩' && sv.apply === true, saved);

  // W6 筛选+全选协同（exe 形态）
  const filt = await ev(`(function(){
    metaBatchItems = [
      { path:'G:/v/x1.mp4', name:'x1.mp4', selected:false, status:'pending', probed:true, settings:{ location_name:'A地' } },
      { path:'G:/v/x2.mp4', name:'x2.mp4', selected:false, status:'done', probed:true, settings:{ location_name:'B地' } },
      { path:'G:/v/x3.mp4', name:'x3.mp4', selected:false, status:'pending', probed:true, settings:{ location_name:'' } }
    ];
    renderMetaBatchTable();
    metaFilterList = [{ field:'status', op:'equals', value:'待转换' }];
    renderMetaBatchTable();
    selectAllMetaFiles(true);
    metaFilterList = [];
    renderMetaBatchTable();
    return JSON.stringify(metaBatchItems.map(f => f.selected));
  })()`);
  check('W6 筛选(待转换)→全选只选可见(1、3)→清筛选后保持', filt === '[true,false,true]', filt);

  // W7 空值筛选 + AND（location_name 为空 AND 待转换 → 仅 x3）
  const and7 = await ev(`(function(){
    metaFilterList = [{ field:'location_name', op:'empty', value:'' }, { field:'status', op:'equals', value:'待转换' }];
    renderMetaBatchTable();
    var v = metaBatchItems.map((f,i)=>({i:i,v:!_metaBatchVisibleSet||_metaBatchVisibleSet.has(i)})).filter(x=>x.v).map(x=>x.i);
    metaFilterList=[]; renderMetaBatchTable();
    return JSON.stringify(v);
  })()`);
  check('W7 AND 叠加（空地点+待转换→仅第3项）', and7 === '[2]', and7);

  // W8 批量应用同值规则（exe 形态）
  const batch8 = await ev(`(function(){
    metaBatchItems.forEach(f => f.selected = true);
    metaBatchItems[0].settings = { apply_date:true, apply_location:true, location_name:'同值坐标', location_address:'同值地址', location_lat:'39.9000', location_lon:'116.4000' };
    _metaEditIndex = -1;
    applyMetaEditToChecked();
    return JSON.stringify(metaBatchItems.map(f => ({ n: f.settings.location_name, lat: f.settings.location_lat })));
  })()`);
  check('W8 批量应用 GPS 同值复制到全部勾选项',
    batch8 === JSON.stringify(JSON.parse(batch8).map(x => ({ n: '同值坐标', lat: '39.9000' }))), batch8);

  // W9 后端读写端点 exe 形态（dialog 阻塞，端点直证）
  const io9 = await ev(`(async function(){
    var st = { kind:'meta-batch-state', version:1, filters:[], items:[{path:'G:/v/x1.mp4', selected:true, settings:{apply_date:true}, outDir:{mode:'global',value:''}}] };
    var w = await (await fetch('/api/write_json_file', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ path:'G:/264/_acceptance_v3132/_exe_state.json', content: JSON.stringify(st) }) })).json();
    var r = await (await fetch('/api/read_json_file', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ path:'G:/264/_acceptance_v3132/_exe_state.json' }) })).json();
    var bad = await (await fetch('/api/read_json_file', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ path:'G:/nope.json' }) }));
    return JSON.stringify({ write: !!w.success, read: !!r.content, bad404: bad.status });
  })()`);
  const i9 = JSON.parse(io9);
  check('W9 exe 形态读写端点：写成功/读回/不存在 404', i9.write && i9.read && i9.bad404 === 404, io9);

  // W10 快照/还原纯函数（exe 形态的序列化契约）
  const snap = await ev(`(function(){
    metaFilterList = [{ field:'filename', op:'contains', value:'x' }];
    var s = metaStateSnapshot();
    var verr = metaStateValidate(s);
    return JSON.stringify({ kind: s.kind, v: s.version, items: s.items.length, filters: s.filters.length, verr: verr });
  })()`);
  const sn = JSON.parse(snap);
  check('W10 快照契约：kind/v1/条目/筛选 + 校验通过', sn.kind === 'meta-batch-state' && sn.v === 1 && sn.items === 3 && sn.filters === 1 && sn.verr === null, snap);

  // W11 版本不兼容拒绝（future 版本）
  const fut = await ev(`(function(){
    var bad = { kind:'meta-batch-state', version: 99, items: [] };
    return metaStateValidate(bad) || '';
  })()`);
  check('W11 未来版本导入被拒绝并给可读原因', /版本（v99）高于/.test(String(fut)), String(fut));

  ws.close();
  const bad = results.filter(r => !r.ok);
  console.log('══ v3.14.6 打包实机验证 ══');
  results.forEach(r => console.log((r.ok ? 'OK   ' : 'FAIL ') + r.n + (r.d ? '  → ' + r.d : '')));
  console.log(`合计 ${results.length} 项，通过 ${results.length - bad.length}，失败 ${bad.length}`);
  process.exit(bad.length ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });

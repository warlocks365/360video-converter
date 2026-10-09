// v3.13.14 第二例「读展示文案反推状态」修复验证
// 缺陷：消费方靠 startsWith('(地址获取失败') 嗅探 resolveReverseGeo 的错误提示文案，
//       来决定「不要把提示抄进地址输入框」。文案一改即静默失效。
// 修法：生产方增 addrFailed 布尔字段；消费方改判该字段。错误文案本身保留（用户要看到）。
//
// 本套件验证两个必须同时成立的不变量（只测后者会漏掉「错误反馈被误删」的回归）：
//   ① 逆地理失败 → 地图面板仍显示「地址获取失败」（用户反馈未丢）
//   ② 逆地理失败 → 表单「详细地址」为空（错误文案没被当成地址抄进去）
//   ③ 逆地理成功但无地址 → addrFailed=false 且 address 为空串（不被误判为失败）
const path = require('path');
const os = require('os');
const WS = path.join(os.homedir(), '.workbuddy', 'binaries', 'node', 'workspace', 'node_modules');
const { JSDOM, VirtualConsole } = require(path.join(WS, 'jsdom'));

const PORT = Number(process.env.META_QUEUE_PORT || 8800);
const URL = `http://127.0.0.1:${PORT}/`;

// 可变后端：控制逆地理成功/失败
const BACKEND = { regeoFails: true };
const API = (url) => {
  const u = String(url);
  // AMap regeo（国内路径）
  if (u.includes('/api/geocode') && u.includes('__regeo__')) {
    if (BACKEND.regeoFails) return { status: '0', info: 'INVALID_USER_KEY' };
    return {
      status: '1',
      regeocode: {
        formatted_address: '山东省济南市历城区旅游路1号',
        addressComponent: { province: '山东省', city: '济南市', district: '历城区', township: '旅游路', building: {}, neighborhood: {} },
      },
    };
  }
  // Nominatim reverse（海外路径）
  if (u.includes('/api/nominatim') && u.includes('reverse=1')) {
    if (BACKEND.regeoFails) return { error: 'Unable to geocode' };
 return { display_name: '', name: '', address: {} };
  }
  if (u.includes('/api/probe_metadata')) return {
    has_spherical: false, has_date: false, has_gps: true,
    gps: { lat: 36.7458, lon: 116.8331, raw: '' },
    creation_time: null, spherical: null,
    location_name: '', location_address: '', file_size_mb: 1, date_in_name: '', filename: 'X.mp4',
  };
  if (u.includes('/api/probe-source')) return { has_gps: true, has_time: false, creation_time: null, filename: 'X.mp4', gps: { lat: 36.7458, lon: 116.8331 } };
  if (u.includes('/api/codecs')) return { codecs: { libx264: { label: 'x', group: 'cpu', presets: [], default_preset: '', has_profile: true, has_level: true, has_bf_refs: true, has_x264_params: false, x265_params: false } } };
  if (u.includes('/api/codec_check')) return { available: {}, error_details: {}, ffmpeg_info: {}, runtime_dlls: {}, fix_hints: {} };
  if (u.includes('/api/presets')) return { presets: [] };
  if (u.includes('/api/version')) return { version: '3.13.14', name: '360 Video Converter' };
  if (u.includes('/api/tasks/load')) return { tasks: [] };
  if (u.includes('/api/settings')) return {};
  if (u.includes('/api/sysmon')) return { cpu: 1, mem: 1, disk: 0, net: 0, gpu: 0 };
  return {};
};

const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', e => errors.push('jsdomError: ' + (e.detail || e.message || e)));
vc.on('error', (...a) => errors.push('console.error: ' + a.map(String).join(' ')));

const results = [];
const check = (name, cond, detail) => {
  results.push({ name, ok: !!cond });
  console.log((cond ? 'OK  ' : 'FAIL') + ' ' + name + (detail ? '  → ' + detail : ''));
};

(async () => {
  const dom = await JSDOM.fromURL(URL, {
    runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) {
 w.alert = () => {};
      w.confirm = () => true;
    w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
      w.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
      // Leaflet 在 jsdom 下不可用，这里只为让 mapInstance 存在，便于直接驱动解析函数
      w.L = { map: () => ({ setView() {}, removeLayer() {} }), marker: () => ({ addTo() { return this; } }) };
      w.fetch = async (u) => {
        const r = API(u);
  return { ok: true, status: 200, json: async () => r, text: async () => JSON.stringify(r) };
      };
    },
  });
  await new Promise(r => setTimeout(r, 1200));
  const d = dom.window.document;
  const $ = id => d.getElementById(id);
  const ev = f => dom.window.eval(f);

  // 固定为海外坐标（走 Nominatim 路径，绕开 AMap key 依赖）
  ev('window.__amapKeyOverride = "";');

  // ══ ① 逆地理失败：生产方给出 addrFailed + 保留错误文案 ═════════
  BACKEND.regeoFails = true;
  const failRes = await ev('resolveReverseGeo(40.1052, 116.0786, "", "").then(r => JSON.stringify(r))');
  const failObj = JSON.parse(failRes);
  check('①失败时 addrFailed === true', failObj.addrFailed === true, `addrFailed=${failObj.addrFailed}`);
  check('①失败时 address 仍保留错误提示文案（用户反馈未丢）',
    String(failObj.address).includes('地址获取失败'), `"${failObj.address}"`);

  // ══ ② 消费方 A（地图面板）：错误提示必须继续可见 —— 一行未改 ══
  // 直接复刻 reverseGeocode 的「解析 + 渲染」两段，绕开 Leaflet 地图 API
  // （jsdom 下真实 Leaflet 的 marker/setView 不可用；本断言要验的是
  //  「r.address 是否被原样送到面板」，不是地图渲染本身）。
  await ev(`(async () => {
    const r = await resolveReverseGeo(40.1052, 116.0786, '', '');
    mapSelectedLocation = { name: r.name, lat: 40.1052, lon: 116.0786, address: r.address, addrFailed: r.addrFailed };
    document.getElementById('mapSelectedName').textContent = r.name;
    document.getElementById('mapSelectedCoords').textContent = '40.105200, 116.078600';
    document.getElementById('mapSelectedAddress').textContent = r.address || '(无地址信息)';
  })()`);
  await new Promise(r => setTimeout(r, 400));
  check('②消费方A：地图面板仍显示「地址获取失败」（错误反馈对用户可见）',
    $('mapSelectedAddress').textContent.includes('地址获取失败'),
    `"${$('mapSelectedAddress').textContent}"`);

  // ══ ③ 消费方 B（GPS 复用回填）：错误文案不得抄进地址输入框 ══════
  ev(`(function(){
    metaBatchItems = [{ path:'D:/videos/x.mp4', name:'x.mp4', size_mb:'', date_in_name:'',
      selected:true, status:'pending', statusMsg:'', duration:'',
  settings:{ apply_location:false, apply_date:false, apply_spherical:false, spherical_mode:'360-mono' },
      outDir:{mode:'inplace',value:''}, probed:true,
      probeData:{ has_gps:true, gps:{lat:40.1052, lon:116.0786}, has_time:false, location_name:'', location_address:'' } }];
    _metaEditIndex = 0;
  })()`);
  await ev('reuseSourceGPS("me")');
  await new Promise(r => setTimeout(r, 500));
  check('③消费方B：GPS 复用后 me_location_address 为空（未抄错误文案）',
    $('me_location_address').value === '', `addr="${$('me_location_address').value}"`);
  check('③消费方B：经纬度仍正确回填（未被addrFailed 误伤）',
    $('me_location_lat').value === '40.105200' && $('me_location_lon').value === '116.078600',
    `lat=${$('me_location_lat').value} lon=${$('me_location_lon').value}`);

  // ══ ④ 第三条消费路径：confirmMapSelection 不得把提示写进表单 ══════
  // ⚠ 目标值必须是 'meta' —— 这是 index.html:919 openMapPicker('meta') 的实参。
  //   传 'm' 会掉进 else 分支（p_ 前缀），断言会读到 #p_location_* 而误判为失败。
  ev('mapSelectedLocation = { name:"40.1052, 116.0786", lat:40.1052, lon:116.0786, address:"(地址获取失败 — OSM: x)", addrFailed:true };');
  ev('mapPickerTarget = "meta";');
  ev('confirmMapSelection();');
  check('④confirmMapSelection：失败态下 m_location_address 为空（提示未流入表单）',
    $('m_location_address').value === '', `addr="${$('m_location_address').value}"`);
  check('④confirmMapSelection：经纬度仍回填正确（未被 addrFailed 误伤）',
    $('m_location_lat').value === '40.105200' && $('m_location_lon').value === '116.078600',
    `lat=${$('m_location_lat').value} lon=${$('m_location_lon').value}`);
  check('④confirmMapSelection：拍摄地点有兜底内容（不被空地址拖累）',
    $('m_location_name').value !== '', `name="${$('m_location_name').value}"`);

  // ══ ⑤ 逆地理成功但无地址 → addrFailed=false（不被误判为失败）════
  BACKEND.regeoFails = false;
  const emptyRes = await ev('resolveReverseGeo(40.1052, 116.0786, "", "").then(r => JSON.stringify(r))');
  const emptyObj = JSON.parse(emptyRes);
  check('⑤成功但无地址 → addrFailed === false',
    emptyObj.addrFailed === false, `addrFailed=${emptyObj.addrFailed} address="${emptyObj.address}"`);
  ev('mapSelectedLocation = { name:"某地", lat:40.1052, lon:116.0786, address:"", addrFailed:false };');
  ev('mapPickerTarget = "meta"; confirmMapSelection();');
  check('⑤成功但无地址 → 地址栏为空且未被标记失败（与失败态区分）',
    $('m_location_address').value === '' && ev('mapSelectedLocation.addrFailed') === false,
    `addr="${$('m_location_address').value}" addrFailed=${ev('mapSelectedLocation.addrFailed')}`);

  // ══ ⑥ 逆地理成功且有地址 → 正常回填（修复不能误伤正常路径）══════
  // 显式给 fallbackAddress，避开 Nominatim 返回空 display_name 的分支歧义
  const okRes = await ev('resolveReverseGeo(36.7458, 116.8331, "", "山东省济南市历城区旅游路1号").then(r => JSON.stringify(r))');
  const okObj = JSON.parse(okRes);
  check('⑥成功且有地址 → addrFailed=false 且 address 非空',
    okObj.addrFailed === false && String(okObj.address).length > 0, `addr="${okObj.address}"`);
  ev(`mapSelectedLocation = { name:"某地", lat:40.1052, lon:116.0786, address:"山东省济南市历城区旅游路1号", addrFailed:false };`);
  ev('mapPickerTarget = "meta"; confirmMapSelection();');
  check('⑥成功且有地址 → 地址正常写入表单（修复未误伤正常路径）',
    $('m_location_address').value === '山东省济南市历城区旅游路1号', `addr="${$('m_location_address').value}"`);

  // ══ ⑦ 源码层：哨兵嗅探已彻底移除 ════════════════════════════════
  const mapJs = require('fs').readFileSync(path.resolve(__dirname, '../../static/js/20-map.js'), 'utf8');
  const metaJs = require('fs').readFileSync(path.resolve(__dirname, '../../static/js/50-meta.js'), 'utf8');
  // ⚠ 必须先剥注释：本修复在两处都留了「此前靠 startsWith(...) 嗅探」的说明注释，
  //   裸文本匹配会把注释当成残留代码 —— 我第一版就误报了自己写的注释。
  const stripComments = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/).map(l => l.replace(/(^|[^:"'\\])\/\/.*$/, '$1')).join('\n');
  const mapCode = stripComments(mapJs);
  const metaCode = stripComments(metaJs);
  check('⑦20-map.js 生产方声明并返回 addrFailed',
    /let addrFailed = false;/.test(mapCode) && /addrFailed: addrFailed/.test(mapCode), '');
  check('⑦可执行代码中无startsWith(\'(地址获取失败 嗅探残留',
    !/startsWith\('\(地址获取失败/.test(mapCode) && !/startsWith\('\(地址获取失败/.test(metaCode), '');
  check('⑦消费方 B 改判 r.addrFailed',
    /r\.addrFailed \? '' : \(r\.address \|\| ''\)/.test(metaCode), '');
  check('⑦消费方 A 未被改动（地图面板仍直显 r.address）',
    /mapSelectedAddress'\)\.textContent = r\.address \|\| '\(无地址信息\)'/.test(mapCode), '');
  check('⑦confirmMapSelection 亦按 addrFailed 拦截（第三路径）',
    /mapSelectedLocation\.addrFailed \? '' : addrRaw/.test(mapCode), '');

  check('页面无 JS 错误', errors.length === 0, errors.slice(0, 3).join(' | '));

  const failed = results.filter(r => !r.ok).length;
  console.log(`\n══ 第二例文案反推修复验证：${results.length - failed}/${results.length} PASS ══`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('运行异常:', e); process.exit(1); });
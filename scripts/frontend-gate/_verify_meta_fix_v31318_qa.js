// ════════════════════════════════════════════════════════════════════
//  v3.13.18 元数据三项修复 —— 独立验收（QA / 严过关）
//
//  本套件为「验证者套件」，与实现者写的 _verify_meta_geo_bulk_v31318.js
//  相互独立：断言不复用其源码正则，全部以运行时行为为准。
//
//  设计原则：
//   ① 全部交互走真实 MouseEvent 派发 + 中央委托 DELEGATED_ACTIONS，
//      绝不直接调函数 —— 直接调会绕过注册面，测不到「action 名失配」。
//   ② fetch 全量 URL 轨迹记录，不只看函数返回值。
//   ③ 重点证伪五点（见各组标题），每点均以「反例能否构造」为准。
//   ④ 前缀语料全中文，避免脚本自身含 emoji 被 P0 扫描误报。
//
//  用法：node scripts/frontend-gate/_verify_meta_fix_v31318_qa.js
//        （需先起 8800 桩服务器：node scripts/frontend-gate/_stub-server.js 8800）
// ════════════════════════════════════════════════════════════════════
const path = require('path');
const os = require('os');
const fs = require('fs');

const WS = path.join(os.homedir(), '.workbuddy', 'binaries', 'node', 'workspace', 'node_modules');
const { JSDOM, VirtualConsole } = require(path.join(WS, 'jsdom'));

const ROOT = path.resolve(__dirname, '../..');
const PORT = Number(process.env.META_QA_PORT || 8800);
const URL = `http://127.0.0.1:${PORT}/`;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail !== undefined && detail !== '' ? '  -> ' + detail : ''}`);
}

const metaJs = fs.readFileSync(path.join(ROOT, 'static/js/50-meta.js'), 'utf8');
const jobsJs = fs.readFileSync(path.join(ROOT, 'static/js/60-jobs.js'), 'utf8');

const BACKEND = { applied: [], fetchLog: [], bodies: [] };
const errors = [];
const jsonRes = obj => ({ ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) });

// ════════════════════════════════════════════════════════════════════
console.log('──── 第 0 组：DOM 契约（真实解析 index.html）────');
// ════════════════════════════════════════════════════════════════════
{
  const doc = new JSDOM(fs.readFileSync(path.join(ROOT, 'static/index.html'), 'utf8')).window.document;

  // ── 需求 1：批量按钮存在性与位置 ────────────────────────────
  const runBtn = doc.getElementById('metaBatchRunBtn');
  check('Q0.1 #metaBatchRunBtn 存在且挂 meta-batch-run 委托动作',
    !!runBtn && runBtn.getAttribute('data-action') === 'meta-batch-run', '');
  const addQ = doc.getElementById('metaAddQueueBtn');
  // 位置契约：必须紧跟在「加入批量列队」之后（用户阅读顺序：配队 -> 执行）
  // 用数值常量而非全局 Node —— Node 不是 Node.js 运行时里的全局对象。
  const FOLLOWING = 4;
  const posOk = !!(runBtn && addQ) &&
    (addQ.compareDocumentPosition(runBtn) & FOLLOWING) !== 0;
  check('Q0.2 #metaBatchRunBtn 排在 #metaAddQueueBtn 之后（配队->执行阅读顺序）', posOk, '');
  check('Q0.3 两按钮默认 display:none（非元数据模式不得漏出）',
    !!runBtn && /display:\s*none/.test(runBtn.getAttribute('style') || '')
    && /display:\s*none/.test((doc.getElementById('metaApplyBtn').getAttribute('style') || '')), '');

  // ── 需求 3：三前缀 GPS 按钮对称性 ─────────────────────────
  const prefixes = ['p', 'm', 'me'];
  const actions = ['geo-map-pick', 'geo-copy', 'geo-paste'];
  let sym = true, symDetail = [];
  for (const act of actions) {
    for (const p of prefixes) {
      const n = doc.querySelectorAll(`[data-action="${act}"][data-geo-prefix="${p}"]`);
      if (n.length !== 1) { sym = false; symDetail.push(`${act}/${p}=${n.length}`); }
    }
  }
  check('Q0.4 三前缀 x 三动作 = 9 个 GPS 按钮齐全且各唯一（需求3e 交互一致）',
    sym, sym ? '9/9' : symDetail.join(' '));

  // 每个 GPS 按钮必须带 type="button"，否则在 <form> 内会误提交
  let noType = [];
  for (const act of actions) for (const p of prefixes) {
    const el = doc.querySelector(`[data-action="${act}"][data-geo-prefix="${p}"]`);
    if (el && el.getAttribute('type') !== 'button') noType.push(`${act}/${p}`);
  }
  check('Q0.5 GPS 按钮均带 type="button"（防误提交）', noType.length === 0, noType.join(' '));

  // GEO_TARGETS 引用的元素必须真实存在（幻觉依赖检测）
  const T = {
    p:  { lat: 'p_location_lat', lon: 'p_location_lon', name: 'p_location_name', address: 'p_location_address', info: 'locationInfo' },
    m:  { lat: 'm_location_lat', lon: 'm_location_lon', name: 'm_location_name', address: 'm_location_address', info: 'metaLocationInfo' },
    me: { lat: 'me_location_lat', lon: 'me_location_lon', name: 'me_location_name', address: 'me_location_address', info: 'me_location_info' },
  };
  let miss = [];
  for (const p of prefixes) for (const k of Object.keys(T[p])) {
    if (!doc.getElementById(T[p][k])) miss.push(`${p}.${k}#${T[p][k]}`);
  }
  check('Q0.6 GEO_TARGETS 映射的 15 个元素 id 全部真实存在（无幻觉引用）',
    miss.length === 0, miss.length ? miss.join(' ') : '15/15');

  // ── P0 视觉合规：emoji 图标扫描（本套件自检）────────────────
  const emojiRe = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u;
  let emojiHits = [];
  for (const act of actions) for (const p of prefixes) {
    const el = doc.querySelector(`[data-action="${act}"][data-geo-prefix="${p}"]`);
    if (el && emojiRe.test(el.textContent)) emojiHits.push(`${act}/${p}`);
  }
  check('Q0.7 GPS 按钮文案零 emoji（P0 团队铁律：禁 emoji 作功能图标）',
    emojiHits.length === 0, emojiHits.join(' '));
}

// ════════════════════════════════════════════════════════════════════
console.log('\n──── 第 1 组：重点证伪一 —— 「按界面设置应用」绝不执行转换 ────');
// ════════════════════════════════════════════════════════════════════

(async () => {
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => errors.push('jsdomError: ' + ((e.detail && e.detail.message) || e.message || e)));
  vc.on('error', (...a) => errors.push('console.error: ' + a.map(String).join(' ')));

  let dom;
  try {
    dom = await JSDOM.fromURL(URL, {
      runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true,
      virtualConsole: vc,
      beforeParse(w) {
        w.alert = (m) => { w.__lastAlert = String(m); };
        w.confirm = () => true;
        w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
        w.AbortController = w.AbortController || AbortController;
        w.requestAnimationFrame = cb => setTimeout(() => cb(Date.now()), 0);
        w.__clip = '';
        w.__clipboardFails = false;
        Object.defineProperty(w.navigator, 'clipboard', {
          configurable: true,
          value: {
            writeText: async (t) => { if (w.__clipboardFails) throw new Error('denied'); w.__clip = t; },
            readText: async () => { if (w.__clipboardFails) throw new Error('denied'); return w.__clip; },
          },
        });
        w.fetch = async (u, opt) => {
          const url = String(u);
          const method = (opt && opt.method) || 'GET';
          BACKEND.fetchLog.push({ url, method });
          if (url.includes('/api/apply_metadata')) {
            let body = null;
            try { body = JSON.parse(opt.body); } catch (e) { /* 记录原始即可 */ }
            BACKEND.bodies.push(body);
            BACKEND.applied.push(...((body && body.items) || []));
            // 复刻后端 4699-4711 的功能门（已按 v3.13.18 修复后的口径）：
            // 顶层开启 **或** 任一项的 per-item params 开启，即放行。
            const FEATURE_KEYS = ['apply_date', 'apply_location', 'apply_spherical'];
            const enabled = o => !!o && FEATURE_KEYS.some(k => o[k]);
            const p = (body && body.params) || {};
            const items = (body && body.items) || [];
            const anyItem = items.some(it => it && enabled(it.params || {}));
            if (!enabled(p) && !anyItem) {
              return { ok: false, status: 400, json: async () => ({ error: 'No metadata features enabled' }) };
            }
            return { ok: true, status: 200, json: async () => ({ job_id: 'job-qa-' + Date.now() }) };
          }
          if (url.includes('/api/presets')) return jsonRes({ presets: [], error: null });
          if (url.includes('/api/codecs')) return jsonRes({ codecs: {} });
          return jsonRes({});
        };
      },
    });
  } catch (e) {
    console.log('FAIL 无法加载页面: ' + e.message + '  （需先起 8800 桩服务器）');
    process.exit(1);
  }
  await new Promise(r => setTimeout(r, 2500));

  const w = dom.window, d = w.document;
  const $ = id => d.getElementById(id);
  const ev = f => w.eval(f);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const click = sel => {
    const el = typeof sel === 'string' ? d.querySelector(sel) : sel;
    if (!el) return false;
    el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
    return true;
  };
  const toastText = () => { const t = $('toastNotification'); return t ? (t.textContent || '') : ''; };
  const logText = () => { const b = $('logBox'); return b ? (b.textContent || '') : ''; };

  // 切到元数据模式（后续所有断言都在此模式下进行）
  const toMetaMode = async () => {
    d.querySelector('.mode-tab[data-mode="metadata"]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await wait(60);
  };

  // 三项队列：各自 settings / outDir / status 互不相同，用于检出「误改」「误跑」
  const seedQueue = () => {
    ev(`metaBatchItems = [
      {path:"D:\\\\v\\\\a.mp4",name:"a.mp4",size_mb:"1",date_in_name:"",selected:true,status:"pending",statusMsg:"",duration:"",
       settings:{apply_date:true,manual_date:"2001-01-01",apply_spherical:false,apply_location:false},
       outDir:{mode:"snapshot",value:"D:\\\\snapA"},probed:true},
      {path:"D:\\\\v\\\\b.mp4",name:"b.mp4",size_mb:"2",date_in_name:"",selected:true,status:"error",statusMsg:"boom",duration:"7s",
       settings:{apply_date:false,apply_spherical:false,apply_location:false},
       outDir:{mode:"global",value:""},probed:true},
      {path:"D:\\\\v\\\\c.mp4",name:"c.mp4",size_mb:"3",date_in_name:"",selected:false,status:"done",statusMsg:"ok",duration:"9s",
       settings:{apply_date:true,manual_date:"2003-03-03",apply_spherical:false,apply_location:false},
       outDir:{mode:"inplace",value:""},probed:true}
    ]; renderMetaBatchTable();`);
  };

  await toMetaMode();
  seedQueue();
  await wait(80);

  // 界面上放一组可辨识设置
  $('m_apply_date').checked = true;
  $('m_date_from_filename').checked = false;
  $('m_manual_date').value = '2024-12-25T08:30:00';
  ev('renderMetaBatchTable();');
  await wait(60);

  // ── 采集「点击前」的全量状态快照 ────────────────────────────
  const snap = () => ev(`JSON.stringify({
    items: metaBatchItems.map(f => ({selected:f.selected, status:f.status, statusMsg:f.statusMsg,
                                      duration:f.duration, outDir:f.outDir, settings:f.settings})),
    activeJobId: (typeof ActiveJob !== 'undefined' && ActiveJob.id) ? ActiveJob.id : null,
    activeJobType: (typeof ActiveJob !== 'undefined' && ActiveJob.type) ? ActiveJob.type : null,
    mapIdx: (typeof _metaProcessingIndices !== 'undefined') ? _metaProcessingIndices : null
  })`);
  const before = JSON.parse(snap());
  BACKEND.fetchLog = []; BACKEND.applied = []; BACKEND.bodies = [];
  const toastBefore = toastText();
  const logBefore = logText();
  const alertBefore = w.__lastAlert || '';

  // ★ 真实 MouseEvent 走中央委托 —— 若 action 名失配，这里会是空操作
  const delegated = click('[data-action="meta-force-form-run"]');
  await wait(150);

  const after = JSON.parse(snap());

  check('Q1.1 点击真的触发了处理器（非 action 名失配的静默空操作）',
    delegated === true && (toastText() !== toastBefore || logText() !== logBefore),
    `toast="${toastText()}"`);
  check('Q1.2 fetch 全量轨迹中 0 次 /api/apply_metadata（重点：不执行转换）',
    BACKEND.fetchLog.filter(x => x.url.includes('/api/apply_metadata')).length === 0,
    `trace=${JSON.stringify(BACKEND.fetchLog.map(x => x.url))}`);
  check('Q1.3 整轮零网络写入（连其他 /api 写接口也不该被碰）',
    BACKEND.fetchLog.filter(x => x.method !== 'GET').length === 0,
    `writes=${JSON.stringify(BACKEND.fetchLog.filter(x => x.method !== 'GET').map(x => x.url))}`);
  check('Q1.4 ActiveJob.id 未变（未启动任何作业）',
    before.activeJobId === after.activeJobId, `${before.activeJobId} -> ${after.activeJobId}`);
  check('Q1.5 ActiveJob.type 未变', before.activeJobType === after.activeJobType,
    `${before.activeJobType} -> ${after.activeJobType}`);
  check('Q1.6 无任何队列项 status 变化（参数编辑不得隐式重排队）',
    JSON.stringify(before.items.map(x => x.status)) === JSON.stringify(after.items.map(x => x.status)),
    JSON.stringify(after.items.map(x => x.status)));
  check('Q1.7 无任何队列项 statusMsg / duration 变化',
    JSON.stringify(before.items.map(x => [x.statusMsg, x.duration])) ===
    JSON.stringify(after.items.map(x => [x.statusMsg, x.duration])), '');
  check('Q1.8 outDir 完全未被改写（三态各自保持）',
    JSON.stringify(before.items.map(x => x.outDir)) === JSON.stringify(after.items.map(x => x.outDir)),
    JSON.stringify(after.items.map(x => x.outDir)));
  check('Q1.9 _metaProcessingIndices 未建立映射（未跑任何项）',
    JSON.stringify(before.mapIdx) === JSON.stringify(after.mapIdx), `${after.mapIdx}`);
  check('Q1.10 未弹 alert（用户没被误导去执行）',
    (w.__lastAlert || '') === alertBefore, `"${w.__lastAlert || ''}"`);

  // ── settings 是否真的被写入（正向）────────────────────────
  const expectForm = JSON.parse(ev(`JSON.stringify(collectMetaSettings('m'))`));
  const bItem = after.items[1].settings;
  check('Q1.11 勾选项 settings 被整体替换为界面设置（映射完整）',
    bItem.apply_date === true && bItem.manual_date === '2024-12-25T08:30:00',
    JSON.stringify(bItem));
  check('Q1.12 整体替换而非合并（关不掉的残留 true 已被清掉）',
    bItem.apply_spherical === expectForm.apply_spherical
    && bItem.apply_location === expectForm.apply_location,
    `item=${JSON.stringify([bItem.apply_spherical, bItem.apply_location])} form=${JSON.stringify([expectForm.apply_spherical, expectForm.apply_location])}`);
  check('Q1.13 未勾选项（第3项）settings 不得被改写',
    after.items[2].settings.manual_date === '2003-03-03',
    JSON.stringify(after.items[2].settings));
  check('Q1.14 成功路径有明确 toast 反馈（需求2：成功提示）',
    /已.*应用/.test(toastText()) || /应用/.test(toastText()), `"${toastText()}"`);
  check('Q1.15 成功路径写入执行日志（事后可分辨）',
    logText().indexOf('设置同步') >= 0, `"${logText().slice(-80)}"`);

  // ── 无勾选 → 必须提示且零改动 ─────────────────────────────
  ev('metaBatchItems.forEach(f => f.selected = false); renderMetaBatchTable();');
  await wait(60);
  const preNone = JSON.parse(snap());
  BACKEND.fetchLog = [];
  const toastPre = toastText();
  click('[data-action="meta-force-form-run"]');
  await wait(120);
  const postNone = JSON.parse(snap());
  check('Q1.16 无勾选时给出明确提示且 toast 类型为 warning',
    toastText() !== toastPre && /勾选/.test(toastText()), `"${toastText()}"`);
  check('Q1.17 无勾选时零网络请求',
    BACKEND.fetchLog.filter(x => x.url.includes('/api/apply_metadata')).length === 0, '');
  // 逐字段定位差异，避免把「快照里有 volatile 字段」误判为产品缺陷
  const diffKeys = [];
  for (let i = 0; i < preNone.items.length; i++) {
    for (const k of ['selected', 'status', 'statusMsg', 'duration', 'outDir', 'settings']) {
      const a = JSON.stringify(preNone.items[i][k]), b = JSON.stringify(postNone.items[i][k]);
      if (a !== b) diffKeys.push(`item${i}.${k}: ${a} -> ${b}`);
    }
  }
  check('Q1.18 无勾选时列队数据零变化', diffKeys.length === 0,
    diffKeys.length ? diffKeys.join(' | ') : 'items 全部字段逐一比对无差异');

  // ── 执行中项必须被排除 ───────────────────────────────────
  seedQueue();
  await wait(60);
  ev('metaBatchItems[0].status = "processing"; metaBatchItems[0].selected = true; renderMetaBatchTable();');
  await wait(60);
  const preRun = JSON.parse(snap());
  click('[data-action="meta-force-form-run"]');
  await wait(120);
  const postRun = JSON.parse(snap());
  check('Q1.19 status=processing 的勾选项不被改写（避免界面与实际写入不一致）',
    preRun.items[0].settings.manual_date === postRun.items[0].settings.manual_date,
    `${preRun.items[0].settings.manual_date} -> ${postRun.items[0].settings.manual_date}`);
  check('Q1.20 执行中项被跳过时有明确提示',
    /执行中/.test(toastText()), `"${toastText()}"`);

  // ══════════════════════════════════════════════════════════════
  console.log('\n──── 第 2 组：重点证伪二 —— 批量执行只跑列队、忽略界面设置 ────');
  // ══════════════════════════════════════════════════════════════
  await toMetaMode();
  seedQueue();
  await wait(80);
  ev(`metaBatchItems[1].status = "pending";`);
  // 界面上放一组与列队「故意不同」的设置
  $('m_apply_date').checked = true;
  $('m_date_from_filename').checked = false;
  $('m_manual_date').value = '2099-12-31T23:59:59';
  ev('renderMetaBatchTable();');
  await wait(60);

  ev('if (isJobRunning()) endJob();');
  BACKEND.applied = []; BACKEND.fetchLog = []; BACKEND.bodies = [];
  click('#metaBatchRunBtn');
  await wait(200);

  const body = BACKEND.bodies[0];
  check('Q2.1 点击批量按钮真的提交了作业（有 POST /api/apply_metadata）',
    BACKEND.fetchLog.some(x => x.url.includes('/api/apply_metadata') && x.method === 'POST'),
    JSON.stringify(BACKEND.fetchLog.map(x => x.method + ' ' + x.url)));
  check('Q2.2 只提交「勾选且未完成」的 2 项（done 的第3项不跑）',
    BACKEND.applied.length === 2 && BACKEND.applied.every(i => i.input.indexOf('c.mp4') < 0),
    `n=${BACKEND.applied.length} ${JSON.stringify(BACKEND.applied.map(i => i.input))}`);
  check('Q2.3 ★下发的是各项自己的 settings，而非界面 collectMetaSettings(\'m\')',
    BACKEND.applied[0].params.manual_date === '2001-01-01'
    && BACKEND.applied[0].params.manual_date !== '2099-12-31T23:59:59',
    `下发 manual_date=${BACKEND.applied[0].params.manual_date} 界面为 2099-12-31T23:59:59`);
  check('Q2.4 每项各自携带 settings（未合并成同一份）',
    BACKEND.applied[0].params.manual_date !== BACKEND.applied[1].params.manual_date
    || BACKEND.applied[0].params.apply_date !== BACKEND.applied[1].params.apply_date,
    JSON.stringify(BACKEND.applied.map(i => i.params.manual_date)));
  check('Q2.5 输出按各自 outDir 分派（快照项落快照目录）',
    BACKEND.applied[0].output === 'D:\\snapA\\a.mp4',
    JSON.stringify(BACKEND.applied.map(i => i.output)));
  check('Q2.6 顶层 params 仍带 faststart（提交尾段共用后端契约完整）',
    !!(body && body.params && body.params.faststart === true),
    JSON.stringify(body && body.params && body.params.faststart));
  check('Q2.7 日志说明本次忽略界面设置（事后可分辨）',
    /忽略界面设置/.test(logText()), `"${logText().slice(-90)}"`);

  // ── ★ 重点：顶层 params 与后端功能门的交互（真实后端语义）──
  // 场景：界面三项开关全关（用户不碰界面），但列队项各自有功能开关。
  // 前端 hasAnyFeature 看的是 per-item 快照，后端 4699 看的是顶层 params。
  ev('metaBatchItems[0].status = "pending"; metaBatchItems[1].status = "pending";');
  ev('metaBatchItems[0].settings = {apply_date:true, manual_date:"2001-01-01", apply_spherical:false, apply_location:false};');
  ev('metaBatchItems[1].settings = {apply_date:true, manual_date:"2002-02-02", apply_spherical:false, apply_location:false};');
  // ⚠ 必须连子开关一起关：collectMetaSettings('m') 的 apply_date 取 m_apply_date，
  //   而 date_from_filename / set_creation_time 等子项默认是 checked，
  //   只关主开关会残留「界面仍开着日期功能」的语义。
  //   这里直接在 DOM 上逐个置false（含 Q2.3 留下的 checked=true 与 manual_date），
  //   随后回读确认，避免「以为关掉了其实没关」导致断言前提失真。
  ev('if (isJobRunning()) endJob();');
  ['m_apply_date', 'm_apply_location', 'm_apply_spherical',
   'm_set_creation_time', 'm_set_file_created', 'm_set_file_modified',
   'm_date_from_filename'].forEach(id => { const e = $(id); if (e) e.checked = false; });
  ev('renderMetaBatchTable();');
  await wait(80);
  const formOff = ev('JSON.stringify(collectMetaSettings("m"))');
  const formOffObj = JSON.parse(formOff);
  check('Q2.7b ★前置自检：界面三项主开关确已全关（否则本组断言前提失真）',
    formOffObj.apply_date === false && formOffObj.apply_location === false
    && formOffObj.apply_spherical === false,
    `apply_date=${formOffObj.apply_date} apply_location=${formOffObj.apply_location} apply_spherical=${formOffObj.apply_spherical}`);
  BACKEND.applied = []; BACKEND.fetchLog = []; BACKEND.bodies = [];
  w.__lastAlert = '';
  click('#metaBatchRunBtn');
  await wait(200);
  const bodyGate = BACKEND.bodies[0];
  const gateParams = (bodyGate && bodyGate.params) || {};
  const gateOpen = !!(gateParams.apply_date || gateParams.apply_location || gateParams.apply_spherical);
  // 修复后前端加了 batchParams 并集兜底，故顶层 apply_date 应为 true（= 本轮功能并集），
  // 且各per-item 仍是各自快照。并集与后端放宽是两层独立防线，两者都要成立。
  check('Q2.8 ★界面三项全关但列队项各自带功能时，批量提交必须被放行（不得 400）',
    BACKEND.applied.length === 2 && !/No metadata features/.test(w.__lastAlert || ''),
    `顶层params(并集)=${JSON.stringify([gateParams.apply_date, gateParams.apply_location, gateParams.apply_spherical])} alert="${w.__lastAlert || ''}" 已提交=${BACKEND.applied.length}（期望 2 且无 400）`);
  check('Q2.8b ★顶层 params 取本轮功能并集（与 per-item 语义一致，不再是界面快照）',
    gateParams.apply_date === true,
    `顶层 apply_date=${gateParams.apply_date}（界面三项已全关，故此true 只能来自并集兜底）`);
  check('Q2.9 放行后不弹任何后端错误（用户点按钮即真正跑起来）',
    !/No metadata features/.test(w.__lastAlert || ''), `"${w.__lastAlert || ''}"`);
  // 回归护栏：顶层与 per-item 全关时，仍须拦下（放宽不得丢掉防护目的）。
  // 修复后由前端 hasAnyFeature 提前拦下，故这里只要求「拦下 + 不发请求」，
  // 不再限定措辞来源（前端中文提示 或 后端英文 400 都算合规拦截）。
  ev(`if (isJobRunning()) endJob();
      metaBatchItems[0].settings = {apply_date:false, apply_spherical:false, apply_location:false};
      metaBatchItems[1].settings = {apply_date:false, apply_spherical:false, apply_location:false};`);
  await wait(60);
  BACKEND.applied = []; BACKEND.fetchLog = []; w.__lastAlert = '';
  click('#metaBatchRunBtn');
  await wait(200);
  const blockedAlert = w.__lastAlert || '';
  check('Q2.9b ★顶层与各项功能全关时仍须拦下（功能门不得被放宽成永不拦截）',
    BACKEND.applied.length === 0 && /未启用任何元数据功能|No metadata features/.test(blockedAlert),
    `已提交=${BACKEND.applied.length} alert="${blockedAlert.slice(0, 60)}"`);
  check('Q2.9c ★拦截提示为中文且给出可操作出路（不再直出英文后端原文）',
    /未启用任何元数据功能/.test(blockedAlert) && !/No metadata features/.test(blockedAlert)
    && /勾选上方|逐行/.test(blockedAlert),
    `alert="${blockedAlert.slice(0, 50)}"`);

  // ══════════════════════════════════════════════════════════════
  console.log('\n──── 第 3 组：重点证伪三 —— 6 模式显隐互斥 ──────────────');
  // ══════════════════════════════════════════════════════════════
  const MODES = ['single', 'merge', 'batch', 'metadata', 'report', 'vr3d'];
  let detail = [], okAll = true;
  for (const m of MODES) {
    const tab = d.querySelector(`.mode-tab[data-mode="${m}"]`);
    if (!tab) { okAll = false; detail.push(m + ':tab缺失'); continue; }
    tab.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await wait(50);
    const a = $('metaApplyBtn').style.display, b = $('metaBatchRunBtn').style.display;
    const want = (m === 'metadata') ? '' : 'none';
    if (a !== want || b !== want) {
      okAll = false;
      detail.push(`${m}: apply="${a || '(显示)'}" run="${b || '(显示)'}" 期望"${want || '(显示)'}"`);
    }
  }
  check('Q3.1 ★6 模式逐一断言：仅 metadata 模式下两按钮均可见，其余 5 个模式均隐藏',
    okAll, okAll ? '6/6 通过' : detail.join(' | '));

  await toMetaMode();
  check('Q3.2 元数据模式下与转换族「加入批量队列」不同时出现（防同名不同义）',
    $('metaBatchRunBtn').style.display !== 'none' && $('addToBatchBtn').style.display === 'none',
    `run="${$('metaBatchRunBtn').style.display}" addToBatch="${$('addToBatchBtn').style.display}"`);
  check('Q3.3 「加入批量列队」与「开始批量列队执行」不同时缺失（两按钮并存）',
    !!$('metaAddQueueBtn') && !!$('metaBatchRunBtn'), '');
  check('Q3.4 #metaApplyBtn 文案恒为单文件语义（不随队列状态切换）',
    $('metaApplyBtn').textContent === '应用元数据（当前文件）', `"${$('metaApplyBtn').textContent}"`);
  seedQueue();
  ev('metaBatchItems[1].status = "pending";');
  ev('metaBatchItems.forEach(f => f.status = "done");');
  ev('renderMetaBatchTable();');
  await wait(80);
  check('Q3.5 全部完成后 #metaApplyBtn 文案仍恒定（不被列队改写）',
    $('metaApplyBtn').textContent === '应用元数据（当前文件）', `"${$('metaApplyBtn').textContent}"`);
  check('Q3.6 待转换计数显示在批量按钮上（计数信息未随拆分丢失）',
    /开始批量列队执行/.test($('metaBatchRunBtn').textContent), `"${$('metaBatchRunBtn').textContent}"`);
  check('Q3.7 说明条出口文案为设置同步语义（与旧「仍按界面设置执行这一轮」不同）',
    (d.querySelector('[data-action="meta-force-form-run"]') || {}).textContent === '把界面设置应用到勾选项',
    `"${(d.querySelector('[data-action="meta-force-form-run"]') || {}).textContent}"`);

  // 批量按钮在「任务运行中」是否被禁用
  ev(`if (isJobRunning()) endJob();
      metaBatchItems = [{path:"D:\\\\v\\\\z.mp4",name:"z.mp4",size_mb:"1",selected:true,status:"pending",statusMsg:"",duration:"",
        settings:{apply_date:true,manual_date:"2001-01-01",apply_spherical:false,apply_location:false},
        outDir:{mode:"inplace",value:""},probed:true}]; renderMetaBatchTable();`);
  await wait(80);
  ev(`ActiveJob.id = 'job-fake-running'; ActiveJob.type = 'metadata';
      ActiveJob.timer = setInterval(function(){}, 1000); setPrimaryButtonsEnabled(false);`);
  await wait(60);
  check('Q3.8 ★任务运行中「开始批量列队执行」必须被禁用（须在 PRIMARY_BTN_IDS 内）',
    $('metaBatchRunBtn').disabled === true && $('metaApplyBtn').disabled === true
    && ev('PRIMARY_BTN_IDS.join(",")').indexOf('metaBatchRunBtn') >= 0,
    `run.disabled=${$('metaBatchRunBtn').disabled} apply.disabled=${$('metaApplyBtn').disabled} PRIMARY=[${ev('PRIMARY_BTN_IDS.join(",")')}]`);

  // ── Q3.9/Q3.10：Q3.8 的真实后果（不是理论推断）─────────────
  // 任务运行中点批量按钮：submitMetadataItems 是「先 fetch 再 beginJob」，
  // 故 POST 会真的发出去 —— 后端起一个孤儿作业写同一批文件，
  // 而 beginJob 才因已有任务而拒绝接管。用户只看到一句「已有任务正在运行」。
  BACKEND.applied = []; BACKEND.fetchLog = []; BACKEND.bodies = [];
  w.__lastAlert = '';
  const jobIdBefore = ev('ActiveJob.id');
  click('#metaBatchRunBtn');
  await wait(250);
  const dupPost = BACKEND.fetchLog.filter(x => x.url.includes('/api/apply_metadata') && x.method === 'POST').length;
  check('Q3.9 ★已有任务运行时零网络请求（不得发出孤儿作业）',
    dupPost === 0 && BACKEND.applied.length === 0,
    `POST 次数=${dupPost} 已下发 items=${BACKEND.applied.length} ActiveJob.id ${jobIdBefore}->${ev('ActiveJob.id')}`);
  check('Q3.10 ★已有任务运行时点批量按钮有可操作的中文提示（而非静默无反应）',
    /已有任务/.test(toastText()), `"${toastText()}"`);
  // 运行中项的状态被改写：processing -> pending，UI 与后端实际进度脱节
  ev('if (isJobRunning()) endJob();');
  ev(`metaBatchItems = [{path:"D:\\\\v\\\\y.mp4",name:"y.mp4",size_mb:"1",selected:true,status:"processing",statusMsg:"",duration:"",
        settings:{apply_date:true,manual_date:"2001-01-01",apply_spherical:false,apply_location:false},
        outDir:{mode:"inplace",value:""},probed:true}]; renderMetaBatchTable();`);
  await wait(80);
  ev(`ActiveJob.id = 'job-running-2'; ActiveJob.type='metadata'; ActiveJob.timer = setInterval(function(){},1000);`);
  const stBefore = ev('metaBatchItems[0].status');
  click('#metaBatchRunBtn');
  await wait(220);
  const stAfter = ev('metaBatchItems[0].status');
  check('Q3.11 ★运行中点击批量按钮不把 processing 项改写成 pending（进度不错节）',
    stBefore === 'processing' && stAfter === 'processing', `${stBefore} -> ${stAfter}`);
  ev('if (isJobRunning()) endJob();');

  // ── Q3.12 「按数量反推状态」反模式护栏（frontend 自查时发现并修掉的缺陷）──
  // 反模式：const running = queue.length - 可执行数。会把已done 项也算成 running，
  // 于是「全部完成」被误报成「正在执行中，等本轮结束后再点」—— 而此时并没有
  // 任何任务在跑，用户等的是永远不会到来的下一轮（死等）。
  ev(`metaBatchItems = [
        {path:"D:\\\\v\\\\d1.mp4",name:"d1.mp4",selected:true,status:"done",statusMsg:"ok",duration:"1s",
         settings:{apply_date:true,manual_date:"2001-01-01",apply_spherical:false,apply_location:false},
         outDir:{mode:"inplace",value:""},probed:true},
        {path:"D:\\\\v\\\\d2.mp4",name:"d2.mp4",selected:true,status:"done",statusMsg:"ok",duration:"2s",
         settings:{apply_date:true,manual_date:"2002-02-02",apply_spherical:false,apply_location:false},
         outDir:{mode:"inplace",value:""},probed:true}];
      renderMetaBatchTable();`);
  await wait(80);
  const allDoneToast0 = toastText();
  click('#metaBatchRunBtn');
  await wait(200);
  const allDoneToast = toastText();
  check('Q3.12 ★全部完成时不得误报「正在执行中」（按数量反推状态的反模式护栏）',
    !/正在执行中/.test(allDoneToast) && allDoneToast !== allDoneToast0,
    `toast="${allDoneToast}"（期望提示「均已完成/重新排队」，而非「正在执行中等本轮结束」）`);
  check('Q3.12b ★全部完成时提示指向「重新排队」出口（用户有可操作出路）',
    /已完成|重新排队/.test(allDoneToast), `"${allDoneToast}"`);

  // ══════════════════════════════════════════════════════════════
  console.log('\n──── 第 4 组：重点证伪四 —— GPS 复制/粘贴真实往返 ────────');
  // ══════════════════════════════════════════════════════════════
  const setGeo = (p, v) => ev(`(() => {
    const T = GEO_TARGETS['${p}'];
    document.getElementById(T.lat).value = '${v.lat}';
    document.getElementById(T.lon).value = '${v.lon}';
    document.getElementById(T.name).value = ${JSON.stringify(v.name)};
    document.getElementById(T.address).value = ${JSON.stringify(v.address)};
  })()`);
  const getGeo = p => JSON.parse(ev(`(() => {
    const T = GEO_TARGETS['${p}'];
    const g = id => { const e = document.getElementById(id); return e ? e.value : null; };
    return JSON.stringify({lat:g(T.lat),lon:g(T.lon),name:g(T.name),address:g(T.address)});
  })()`));
  const clipOf = () => w.__clip;
  const setClip = t => { w.__clip = t; };

  // ── 场景 A：同前缀 p_ → p_ 往返 ────────────────────────────
  const SRC = { lat: '39.9042', lon: '116.4074', name: '故宫博物院', address: '北京市东城区景山前街4号' };
  await setGeo('p', { lat: '', lon: '', name: '', address: '' });
  setGeo('p', SRC);
  w.__clip = '';
  click('[data-action="geo-copy"][data-geo-prefix="p"]');
  await wait(150);
  const clipP = clipOf();
  let cpObj = null;
  try { cpObj = JSON.parse(clipP); } catch (e) { /* 留给断言 */ }
  check('Q4.1 复制产出合法 JSON 文本（需求3c）', !!cpObj, clipP ? clipP.slice(0, 90) : '(空)');
  check('Q4.2 复制内容含该条目下所有拍摄位置数据',
    !!cpObj && String(cpObj.lat) === SRC.lat && String(cpObj.lon) === SRC.lon
    && cpObj.name === SRC.name && cpObj.address === SRC.address,
    cpObj ? JSON.stringify({ lat: cpObj.lat, lon: cpObj.lon, name: cpObj.name, address: cpObj.address }) : '');
  check('Q4.3 复制内容带 schema / source / updatedAt（可溯源、可判版本）',
    !!cpObj && cpObj.schema === 'meta-geo/v1' && cpObj.source === 'copy'
    && !isNaN(Date.parse(cpObj.updatedAt)),
    cpObj ? `schema=${cpObj.schema} source=${cpObj.source} updatedAt=${cpObj.updatedAt}` : '');

  // 粘贴到 p_ 的另一处（先清空，再粘贴）
  await setGeo('p', { lat: '', lon: '', name: '', address: '' });
  const toastPreA = toastText();
  click('[data-action="geo-paste"][data-geo-prefix="p"]');
  await wait(200);
  const gotP = getGeo('p');
  check('Q4.4 ★同前缀真实往返：逐字段一致（含 lat/lon/name/address）',
    gotP.lat === SRC.lat && gotP.lon === SRC.lon
    && gotP.name === SRC.name && gotP.address === SRC.address,
    JSON.stringify(gotP));
  check('Q4.5 粘贴成功有明确提示（需求3：成功提示）',
    toastText() !== toastPreA && /粘贴/.test(toastText()), `"${toastText()}"`);

  // ── 场景 B：跨前缀 p_ 复制 → me_ 粘贴（验证三前缀 JSON 一致）──
  setClip(clipP);
  await setGeo('me', { lat: '', lon: '', name: '', address: '' });
  click('[data-action="geo-paste"][data-geo-prefix="me"]');
  await wait(200);
  const gotMe = getGeo('me');
  check('Q4.6 ★跨前缀往返（p_ -> me_）逐字段一致（三前缀 JSON 契约统一）',
    gotMe.lat === SRC.lat && gotMe.lon === SRC.lon
    && gotMe.name === SRC.name && gotMe.address === SRC.address,
    JSON.stringify(gotMe));
  check('Q4.7 跨前缀粘贴后自动勾选「写入拍摄位置」总开关',
    $('me_apply_location').checked === true, `checked=${$('me_apply_location').checked}`);

  // ── 场景 C：m_ 侧往返 + 复制内容字段与 p_ 完全同构 ─────────
  click('[data-action="geo-copy"][data-geo-prefix="me"]');
  await wait(150);
  const clipMe = clipOf();
  let meObj = null;
  try { meObj = JSON.parse(clipMe); } catch (e) { /* 留给断言 */ }
  check('Q4.8 me_ 复制产出的 JSON 字段集合与 p_ 完全相同（需求3e 交互与格式一致）',
    !!cpObj && !!meObj &&
    JSON.stringify(Object.keys(cpObj).sort()) === JSON.stringify(Object.keys(meObj).sort()),
    `p=${cpObj ? Object.keys(cpObj).sort().join(',') : ''} me=${meObj ? Object.keys(meObj).sort().join(',') : ''}`);
  setClip(clipMe);
  await setGeo('m', { lat: '', lon: '', name: '', address: '' });
  click('[data-action="geo-paste"][data-geo-prefix="m"]');
  await wait(200);
  const gotM = getGeo('m');
  check('Q4.9 me_ -> m_ 跨前缀往返一致（第三前缀同样通）',
    gotM.lat === SRC.lat && gotM.lon === SRC.lon
    && gotM.name === SRC.name && gotM.address === SRC.address,
    JSON.stringify(gotM));

  // ── 场景 D：地图选点入口（需求3a）─────────────────────────
  await setGeo('me', { lat: '1', lon: '2', name: '旧值', address: '旧址' });
  ev('window.__pickArgs = null; window.openMapPicker = function(t){ window.__pickArgs = t; };');
  click('[data-action="geo-map-pick"][data-geo-prefix="me"]');
  await wait(80);
  check('Q4.10 me_ 地图选点被正确路由到 target=\'me\'（此前唯一缺口，需求3a）',
    ev('window.__pickArgs') === 'me', `args=${JSON.stringify(ev('window.__pickArgs'))}`);
  ev('window.__pickArgs = null; window.openMapPicker = function(t){ window.__pickArgs = t; };');
  click('[data-action="geo-map-pick"][data-geo-prefix="m"]');
  await wait(60);
  check('Q4.11 m_ 地图选点路由到 target=\'meta\'', ev('window.__pickArgs') === 'meta',
    `args=${JSON.stringify(ev('window.__pickArgs'))}`);
  ev('window.__pickArgs = null; window.openMapPicker = function(t){ window.__pickArgs = t; };');
  click('[data-action="geo-map-pick"][data-geo-prefix="p"]');
  await wait(60);
  check('Q4.12 p_ 地图选点路由到 target=\'encode\'（不得落 else 分支写错输入框）',
    ev('window.__pickArgs') === 'encode', `args=${JSON.stringify(ev('window.__pickArgs'))}`);

  // ══════════════════════════════════════════════════════════════
  console.log('\n──── 第 5 组：重点证伪五 —— 非法输入拦截且绝不部分写入 ────');
  // ══════════════════════════════════════════════════════════════
  const ORIG = { lat: '31.2304', lon: '121.4737', name: '外滩', address: '上海市黄浦区中山东一路' };
  await setGeo('m', ORIG);
  const pristine = () => JSON.stringify(getGeo('m'));

  const BAD = [
    ['非 JSON 文本', '这不是 JSON 只是一段普通文字', /不是合法 JSON|JSON/],
    ['空字符串', '', /剪贴板为空/],
    ['合法 JSON 但非对象（数组）', '[1,2,3]', /必须是一个对象/],
    ['合法 JSON 但为 null', 'null', /必须是一个对象/],
    ['缺字段（无 lat/lon）', JSON.stringify({ name: '某地', address: '某址' }), /缺少字段/],
    ['经纬度越界（lat=999）', JSON.stringify({ lat: 999, lon: 100, name: 'x', address: 'y' }), /超出范围/],
    ['经度越界（lon=-999）', JSON.stringify({ lat: 30, lon: -999, name: 'x', address: 'y' }), /超出范围/],
    ['坐标为空串', JSON.stringify({ lat: '', lon: '', name: 'x', address: 'y' }), /不能为空/],
  ];
  let passCnt = 0, failDetail = [];
  for (const [label, payload, toastRe] of BAD) {
    const pre = pristine();
    setClip(payload);
    // 先弹一个哨兵 toast，再清空文本：这样「toast 变了」才是可靠信号。
    // 否则相邻两 case 提示文案相同时（如数组与 null 都命中同一条），
    // 会因文本未变而误判为「没提示」—— 那是测试的假阴性，不是产品缺陷。
    ev(`showToast('哨兵', 'info', 100);`);
    await wait(20);
    const t0 = toastText();
    click('[data-action="geo-paste"][data-geo-prefix="m"]');
    await wait(180);
    const post = pristine();
    const toast = toastText();
    const toastOk = toast !== t0 && toastRe.test(toast);
    const intact = pre === post;
    if (toastOk && intact) passCnt++;
    else failDetail.push(`${label}: 哨兵="${t0}" 现="${toast}" 原值${intact ? '完好' : '已被破坏=' + post}`);
  }
  check('Q5.1 ★8 种非法输入全部被拦截：有提示 + 原值零破坏（无部分写入）',
    passCnt === BAD.length, `${passCnt}/${BAD.length}` + (failDetail.length ? ' | ' + failDetail.join(' ; ') : ''));

  // 逐项复验「原值未被破坏」——这是最易漏的一半
  let intactCount = 0;
  for (const [label, payload] of BAD) {
    await setGeo('m', ORIG);
    setClip(payload);
    click('[data-action="geo-paste"][data-geo-prefix="m"]');
    await wait(170);
    if (JSON.stringify(getGeo('m')) === JSON.stringify(ORIG)) intactCount++;
  }
  check('Q5.2 8 种非法输入后原值逐字节完好（无「部分写入」错配状态）',
    intactCount === BAD.length, `${intactCount}/${BAD.length}`);

  // 「lat 合法 / lon 缺失」这类半合法输入不得写入 lat
  await setGeo('m', ORIG);
  setClip(JSON.stringify({ lat: 12.3456 }));
  click('[data-action="geo-paste"][data-geo-prefix="m"]');
  await wait(180);
  check('Q5.3 半合法输入（只有 lat）被整体拒绝，lat 未被单独写入',
    JSON.stringify(getGeo('m')) === JSON.stringify(ORIG), JSON.stringify(getGeo('m')));
  check('Q5.4 半合法输入给出可操作的原因提示',
    /缺少字段/.test(toastText()), `"${toastText()}"`);

  // 剪贴板完全不可用时必须如实上报，不得静默
  await setGeo('m', ORIG);
  w.__clipboardFails = true;
  const t1 = toastText();
  click('[data-action="geo-paste"][data-geo-prefix="m"]');
  await wait(200);
  check('Q5.5 剪贴板被拒绝时如实上报错误（不静默失败）',
    toastText() !== t1 && /剪贴板/.test(toastText()), `"${toastText()}"`);
  w.__clipboardFails = false;

  // 全空数据时复制应拦截而非产出空 JSON
  await setGeo('m', { lat: '', lon: '', name: '', address: '' });
  w.__clip = '';
  const t2 = toastText();
  click('[data-action="geo-copy"][data-geo-prefix="m"]');
  await wait(180);
  check('Q5.6 无数据时复制被拦截并提示，不产出误导性空 JSON',
    toastText() !== t2 && /没有拍摄位置数据/.test(toastText()) && (clipOf() === '' || clipOf() === undefined),
    `toast="${toastText()}" clip="${clipOf()}"`);

  // 未知前缀必须报错而不是静默写错框
  const t3 = toastText();
  ev('copyGeoEntry("zzz");');
  await wait(120);
  check('Q5.7 未知前缀如实报错（不静默写到别的输入框）',
    /未知的拍摄位置区域/.test(toastText()), `"${toastText()}"`);

  // ══════════════════════════════════════════════════════════════
  console.log('\n──── 第 6 组：P0 视觉合规 + 运行期无异常 ──────────────');
  // ══════════════════════════════════════════════════════════════
  check('Q6.1 运行期无未捕获异常（沉默逻辑错误探测）',
    errors.length === 0, errors.slice(0, 3).join(' | '));
  // ⚠ 口径必须与项目自身 A16 门禁一致：只管 UI 渲染点，纯注释行豁免。
  //   否则「代码注释里的 ⚠ 警告符」会被误判为 emoji 图标 —— 那是我的假阳性。
  //   基线佐证：改动前 50-meta.js 已有 11 处注释内 ⚠，属既有约定，非本次引入。
  const EMOJI_RE = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u;
  const isCommentLine = line => {
    const t = line.trim();
    if (!t) return false;
    if (t.startsWith('//') || t.startsWith('/*') || t.startsWith('*')) return true;
    const m = t.match(EMOJI_RE);
    if (!m) return false;
    const idx = t.indexOf(m[0]);
    const before = t.slice(0, idx);
    return before.lastIndexOf('//') > Math.max(before.lastIndexOf("'"), before.lastIndexOf('"'));
  };
  let codeEmoji = [];
  for (const src of [metaJs, jobsJs]) {
    src.split(/\r?\n/).forEach((line, i) => {
      if (line.includes('//') && isCommentLine(line)) return;
      // 去掉行注释后再判定
      const noComment = line.replace(/\/\/.*$/, '');
      const m = noComment.match(EMOJI_RE);
      if (m) codeEmoji.push(`${m[0]} @${i + 1}: ${noComment.trim().slice(0, 50)}`);
    });
  }
  check('Q6.2 生产代码 UI 渲染点零 emoji（P0 铁律；注释内警告符按项目口径豁免）',
    codeEmoji.length === 0, codeEmoji.slice(0, 3).join(' | '));
  check('Q6.3 已无「按界面设置应用」旧文案残留（代码层，排除注释）',
    !/按界面设置应用/.test(metaJs.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')), '');
  check('Q6.4 forceFormRun 死变量确已清除（无残留可执行引用）',
    !/forceFormRun/.test(metaJs.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''))
    && !/forceFormRun/.test(jobsJs.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')), '');
  check('Q6.5 提交尾段 submitMetadataItems 空数组时早退（不发空作业请求）',
    /async function submitMetadataItems\(items, globalParams\) \{\s*\n?\s*if \(!items \|\| !items\.length\) return;/.test(jobsJs), '');

  // 汇总
  const pass = results.filter(r => r.ok).length;
  const fail = results.filter(r => !r.ok);
  console.log(`\n${'═'.repeat(64)}`);
  console.log(`独立验收结果：${pass}/${results.length} 通过，${fail.length} 条失败`);
  if (fail.length) {
    console.log('\n失败明细：');
    fail.forEach(f => console.log(`  FAIL ${f.name}`));
  }
  console.log('═'.repeat(64));
  process.exit(fail.length ? 1 : 0);
})().catch(e => { console.log('套件异常终止: ' + e.stack); process.exit(2); });
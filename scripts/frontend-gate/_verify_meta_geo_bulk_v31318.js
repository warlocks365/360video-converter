// ════════════════════════════════════════════════════════════════════
//  v3.13.18 元数据工具三项修复验收（贾思敏 / 前端）
//
//  覆盖：
//   ① 两按钮显隐互斥（#metaApplyBtn 只跑界面单文件 / #metaBatchRunBtn 只跑列队）
//   ② 「把界面设置应用到勾选项」同步器（写 settings、不动 outDir、跳过执行中）
//   ③ 拍摄位置 GPS 增强（复制→粘贴往返、非法 JSON 拦截、地图选点回填）
//
//  设计原则（沿用 v3.13.14 套件）：
//   · 全部交互走真实 MouseEvent 派发 + 中央委托，绝不直接调函数 ——
//     直接调函数会绕开 DELEGATED_ACTIONS，测不到「action 名拼错 → 静默失效」
//     这一本项目最高频的失效模式。
//   · 前缀语料用中文断言文案，避免脚本自身含 emoji/字符图标（门禁 A16.5）。
//
//  用法：node scripts/frontend-gate/_verify_meta_geo_bulk_v31318.js
//        （需先起 8800 桩服务器：node scripts/frontend-gate/_stub-server.js 8800）
// ════════════════════════════════════════════════════════════════════
const path = require('path');
const os = require('os');
const fs = require('fs');

const WS = path.join(os.homedir(), '.workbuddy', 'binaries', 'node', 'workspace', 'node_modules');
const { JSDOM, VirtualConsole } = require(path.join(WS, 'jsdom'));

const ROOT = path.resolve(__dirname, '../..');
const PORT = Number(process.env.META_GEO_PORT || 8800);
const URL = `http://127.0.0.1:${PORT}/`;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail !== undefined && detail !== '' ? '  -> ' + detail : ''}`);
}

const metaJs = fs.readFileSync(path.join(ROOT, 'static/js/50-meta.js'), 'utf8');
const jobsJs = fs.readFileSync(path.join(ROOT, 'static/js/60-jobs.js'), 'utf8');
const coreJs = fs.readFileSync(path.join(ROOT, 'static/js/00-core.js'), 'utf8');
const uiJs = fs.readFileSync(path.join(ROOT, 'static/js/10-ui.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'static/index.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'static/css/theme-cobalt.css'), 'utf8');

// ════════════════════════════════════════════════════════════════════
//  第 0 组：源码层断言
// ════════════════════════════════════════════════════════════════════
console.log('──── 第 0 组：源码层断言（静态）────');

// ── S1 需求 1：两按钮职责分离 ───────────────────────────────
check('S1.1 #metaBatchRunBtn 存在于动作栏且带 meta-batch-run 委托动作',
  /id="metaBatchRunBtn"[\s\S]{0,400}?data-action="meta-batch-run"/.test(html), '');
check('S1.2 #metaBatchRunBtn 文案为「开始批量列队执行」',
  /id="metaBatchRunBtn"[\s\S]{0,700}?开始批量列队执行/.test(html), '');
check('S1.3 #metaBatchRunBtn 内联 20px SVG（非 emoji、非 undersized）',
  /id="metaBatchRunBtn"[\s\S]{0,400}?<svg[^>]*width="20"[^>]*height="20"/.test(html)
  && /id="metaBatchRunBtn"[\s\S]{0,400}?<polygon points="6 3 20 12 6 21 6 3"/.test(html), '');
check('S1.4 startMetadataApply 内不再出现列队分支（useFormRun 恒定移除）',
  !/useFormRun/.test(jobsJs), '');
check('S1.5 startMetadataBatchRun 存在且以 async 函数声明',
  /async function startMetadataBatchRun\(\)/.test(jobsJs), '');
check('S1.6 列队执行保留两段过滤（queue + runnable，未合成一次）',
  /const queue = metaBatchItems\.filter\(f => f\.selected\)/.test(jobsJs)
  && /const runnable = metaBatchItems\.filter\(f => f\.selected && f\.status !== 'done'\)/.test(jobsJs), '');
check('S1.7 #metaApplyBtn 文案恒定，不再随队列状态切换',
  /btn\.textContent = '应用元数据（当前文件）'/.test(metaJs)
  && !/应用元数据 · \$\{/.test(metaJs), '');
check('S1.8 10-ui.js 显隐逻辑含 metaBatchRunBtn（否则非元数据模式会漏出）',
  /setDisplay\('metaBatchRunBtn', isMetaMode \? '' : 'none'\)/.test(uiJs), '');
// 剥掉注释再查：解释旧设计时必然要引用旧文案，那是文档不是残留代码。
const codeOf = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
check('S1.9 「应用元数据」按钮文案不再出现「按界面设置应用」（旧兜底文案已清除）',
  !/按界面设置应用/.test(codeOf(metaJs)), '');

// ── S2 需求 2：设置同步器 ───────────────────────────────────
check('S2.1 applyFormSettingsToQueue 存在（forceFormRunOnce 已被替换）',
  /function applyFormSettingsToQueue\(\)/.test(metaJs) && !/function forceFormRunOnce/.test(metaJs), '');
check('S2.2 forceFormRun 死变量已彻底删除（无残留可执行引用）',
  !/forceFormRun/.test(metaJs.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''))
  && !/forceFormRun/.test(jobsJs.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')), '');
check('S2.3 同步器映射以 collectMetaSettings(\'m\') 为准（三类字段全覆盖）',
  /const formSettings = collectMetaSettings\('m'\)/.test(metaJs), '');
check('S2.4 同步器绝不把 out_dir 并入 collectMetaSettings（三前缀共用的采集层不得污染）',
  !/out_dir|outDir/.test(metaJs.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    .slice(metaJs.indexOf('function applyFormSettingsToQueue'), metaJs.indexOf('function applyFormSettingsToQueue') + 2600)), '');
check('S2.5 同步器显式排除 status === processing 的项',
  /selected\.filter\(f => f\.status !== 'processing'\)/.test(metaJs), '');
check('S2.6 同步器整体替换 settings（而非 Object.assign 合并，避免关不掉的残留 true）',
  /f\.settings = \{ \.\.\.formSettings \}/.test(metaJs), '');
check('S2.7 同步器不启动任何转换（不引用执行入口）',
  !/startMetadata/.test(metaJs.replace(/\/\*[\s\S]*?\*\//g, '')
    .slice(metaJs.indexOf('function applyFormSettingsToQueue'), metaJs.indexOf('function applyFormSettingsToQueue') + 2600)), '');
check('S2.8 同步器四条反馈路径齐备（无勾选/部分跳过/成功/异常均有 toast）',
  /请先勾选要应用设置的列队项/.test(metaJs)
  && /执行中已跳过/.test(metaJs)
  && /已将界面设置应用到/.test(metaJs)
  && /应用界面设置失败/.test(metaJs), '');
check('S2.9 成功路径同时写 showLog（writeMetaScopeLog），非静默',
  /\[设置同步\]/.test(metaJs), '');
check('S2.10 data-action="meta-force-form-run" 名称保持不变（门禁 06 注册面未动）',
  /'meta-force-form-run':\s*\(\) => applyFormSettingsToQueue\(\)/.test(coreJs)
  && /data-action="meta-force-form-run"/.test(html), '');
// 同理：HTML 注释里记录了旧文案，断言只认按钮实际文本。
const btnTextOf = act => {
  const m = new RegExp(`data-action="${act}"[^>]*>([\\s\\S]{0,200}?)</button>`).exec(html);
  return m ? m[1].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim() : '';
};
check('S2.11 出口按钮文案已从「仍按界面设置执行这一轮」改为设置同步语义',
  btnTextOf('meta-force-form-run') === '把界面设置应用到勾选项', `实际="${btnTextOf('meta-force-form-run')}"`);

// ── S3 需求 3：GPS 增强 ─────────────────────────────────────
check('S3.1 三条 GPS 委托动作全部注册（geo-map-pick / geo-copy / geo-paste）',
  /'geo-map-pick':/.test(coreJs) && /'geo-copy':/.test(coreJs) && /'geo-paste':/.test(coreJs), '');
check('S3.2 三前缀各自持有 map-pick 按钮（p_/m_/me_ 对称，无前缀缺口）',
  ['p', 'm', 'me'].every(p => new RegExp(`data-action="geo-map-pick" data-geo-prefix="${p}"`).test(html)), '');
check('S3.3 三前缀各自持有 copy / paste 按钮（各 3 枚，共 6 枚）',
  (html.match(/data-action="geo-copy"/g) || []).length === 3
  && (html.match(/data-action="geo-paste"/g) || []).length === 3, '');
check('S3.4 原内联 onclick 地图按钮已全部改为委托（消除事件处理器内联残留）',
  !/onclick="openMapPicker/.test(html), '');
check('S3.5 GEO_TARGETS 表三前缀字段命名完全一致（同一套 JSON 契约的前提）',
  /const GEO_TARGETS = \{/.test(metaJs) && /p:\s*\{ lat: 'p_location_lat'/.test(metaJs)
  && /m:\s*\{ lat: 'm_location_lat'/.test(metaJs) && /me:\s*\{ lat: 'me_location_lat'/.test(metaJs), '');
check('S3.6 me_ 前缀补齐 mapTarget（此前编辑弹窗无地图选点入口，是三前缀唯一缺口）',
  /me:\s*\{[^}]*mapTarget: 'me'/.test(metaJs), '');
check('S3.7 导出 JSON 带 schema 版本号（字段改名时可升版本，不破坏旧文本）',
  /const GEO_JSON_SCHEMA = 'meta-geo\/v1'/.test(metaJs)
  && /schema: GEO_JSON_SCHEMA/.test(metaJs), '');
check('S3.8 导出 JSON 含来源与时间戳（source / updatedAt）',
  /source: 'copy'/.test(metaJs) && /updatedAt: new Date\(\)\.toISOString\(\)/.test(metaJs), '');
check('S3.9 剪贴板走 Clipboard API 且带 execCommand 回退（WebView2 可能不可用）',
  /navigator\.clipboard\.writeText/.test(metaJs) && /execCommand\('copy'\)/.test(metaJs), '');
check('S3.10 读取剪贴板同样带回退，且两条路都失败时如实上报',
  /navigator\.clipboard\.readText/.test(metaJs) && /execCommand\('paste'\)/.test(metaJs)
  && /无法读取剪贴板/.test(metaJs), '');
check('S3.11 坐标校验显式拒绝空串（绝不用 isNaN —— isNaN("") 为 false 会把空值当 0）',
  /if \(lat === '' \|\| lon === ''\)/.test(metaJs)
  && !/Number\.isNaN\(/.test(metaJs), '');
check('S3.12 坐标范围校验存在（纬度 -90..90 / 经度 -180..180）',
  /nlat < -90 \|\| nlat > 90/.test(metaJs) && /nlon < -180 \|\| nlon > 180/.test(metaJs), '');
check('S3.13 粘贴校验拒绝非对象（数组 / null 过得了 JSON.parse，必须显式判）',
  /!obj \|\| typeof obj !== 'object' \|\| Array\.isArray\(obj\)/.test(metaJs), '');
check('S3.14 粘贴前先校验后写入，绝不部分写入',
  /const missing = \['lat', 'lon'\]\.filter/.test(metaJs)
  && metaJs.indexOf('const coordErr = geoCoordError') < metaJs.indexOf('writeGeoEntry(prefix, {'), '');
check('S3.15 粘贴失败四类原因文案各自可区分（空/非法JSON/缺字段/超范围）',
  /剪贴板为空/.test(metaJs) && /不是合法 JSON/.test(metaJs)
  && /JSON 缺少字段/.test(metaJs) && /粘贴失败：/.test(metaJs), '');
check('S3.16 复制/粘贴按钮使用 ico 同源内联 SVG，非 emoji、非字符图标',
  /data-action="geo-copy"[\s\S]{0,300}?<svg/.test(html)
  && /data-action="geo-paste"[\s\S]{0,300}?<svg/.test(html), '');
check('S3.17 ICON_PATHS 已补 copy / paste 图标（不新造内联 path 字面量）',
  /copy:\s*'<rect x="9" y="9"/.test(coreJs) && /paste:\s*'<path d="M16 4h2/.test(coreJs), '');
check('S3.18 工具条样式走 CSS 类而非内联硬编码色值',
  /\.geo-actions \{/.test(css) && !/geo-actions[^}]*#[0-9a-fA-F]{3,6}/.test(css), '');
check('S3.19 地图选点复用既有 openMapPicker（不新写一套选点逻辑）',
  /openGeoMapPicker[\s\S]{0,400}?openMapPicker\(t\.mapTarget\)/.test(metaJs), '');
check('S3.20 逆地理失败仍由既有 addrFailed 标志位拦截（不新增 startsWith 文案判断）',
  !/address\.startsWith\('\(地址获取失败/.test(metaJs), '');

// ════════════════════════════════════════════════════════════════════
//  第 1 组：运行时断言（jsdom 真实 DOM + MouseEvent + 中央委托）
// ════════════════════════════════════════════════════════════════════
console.log('\n──── 第 1 组：运行时断言（jsdom 真实 DOM + MouseEvent 派发）────');

const BACKEND = { applied: [], fetchLog: [] };
const errors = [];
const jsonRes = obj => ({ ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) });
const vc = new VirtualConsole();
vc.on('jsdomError', e => errors.push('jsdomError: ' + ((e.detail && e.detail.message) || e.message || e)));
vc.on('error', (...a) => errors.push('console.error: ' + a.map(String).join(' ')));

(async () => {
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
        // 剪贴板桩：真实浏览器在无用户手势/非安全上下文下会拒绝，
        // 这里提供可控实现，使「复制内容」与「粘贴内容」可断言。
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
          BACKEND.fetchLog.push({ url, method: (opt && opt.method) || 'GET' });
          if (url.includes('/api/apply_metadata')) {
            BACKEND.applied.push(...JSON.parse(opt.body).items);
            return { ok: true, status: 200, json: async () => ({ job_id: 'job-geo-' + Date.now() }) };
          }
          // 启动期接口必须给出结构正确的空响应：90-boot/30-params 在
          // DOMContentLoaded 立即消费它们，缺字段会抛 TypeError 并中断
          // 整个脚本的后续加载（本套件关心的委托注册就在这些脚本里）。
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

  const w = dom.window;
  const d = w.document;
  const $ = id => d.getElementById(id);
  const ev = f => w.eval(f);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  // 真实 MouseEvent：必须冒泡到 document 才会被中央委托捕获。
  // 直接调函数会完全绕过 DELEGATED_ACTIONS，测不到注册面失配。
  const click = sel => {
    const el = typeof sel === 'string' ? d.querySelector(sel) : sel;
    if (!el) return false;
    el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
    return true;
  };
  const toastText = () => { const t = $('toastNotification'); return t ? (t.textContent || '') : ''; };
  const setClip = t => { w.__clip = t; };
  const getClip = () => w.__clip;

  // ── 构造 3 项队列：快照 / 全局 / 原地，且各自参数互不相同 ──
  const seedQueue = () => {
    ev(`metaBatchItems = [
      {path:"D:\\\\v\\\\a.mp4",name:"a.mp4",size_mb:"1",date_in_name:"",selected:true,status:"pending",statusMsg:"",duration:"",
       settings:{apply_date:true,manual_date:"2001-01-01",apply_spherical:false,apply_location:false},
       outDir:{mode:"snapshot",value:"D:\\\\out1"},probed:true,probeData:{has_gps:false,has_time:false}},
      {path:"D:\\\\v\\\\b.mp4",name:"b.mp4",size_mb:"2",date_in_name:"",selected:true,status:"pending",statusMsg:"",duration:"",
       settings:{apply_date:false,apply_spherical:false,apply_location:false},
       outDir:{mode:"global",value:""},probed:true},
      {path:"D:\\\\v\\\\c.mp4",name:"c.mp4",size_mb:"3",date_in_name:"",selected:false,status:"pending",statusMsg:"",duration:"",
       settings:{apply_date:true,manual_date:"2003-03-03",apply_spherical:false,apply_location:false},
       outDir:{mode:"inplace",value:""},probed:true}
    ]; renderMetaBatchTable();`);
  };
  seedQueue();
  await wait(60);

  // ══ R1 两按钮显隐互斥 ═══════════════════════════════════════
  const NON_META = ['single', 'merge', 'batch', 'report', 'vr3d'];
  let visOk = true, visDetail = [];
  for (const m of NON_META) {
    const tab = d.querySelector(`.mode-tab[data-mode="${m}"]`);
    if (!tab) { visOk = false; visDetail.push(m + ':tab缺失'); continue; }
    tab.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await wait(30);
    const a = $('metaApplyBtn').style.display, b = $('metaBatchRunBtn').style.display;
    if (a !== 'none' || b !== 'none') { visOk = false; visDetail.push(`${m}:apply=${a || '显示'} run=${b || '显示'}`); }
  }
  d.querySelector('.mode-tab[data-mode="metadata"]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await wait(50);
  check('R1.1 五个非元数据模式下两按钮均隐藏、元数据模式下均显示',
    visOk && $('metaApplyBtn').style.display !== 'none' && $('metaBatchRunBtn').style.display !== 'none',
    visOk ? 'currentMode=' + ev('currentMode') : visDetail.join(' '));
  check('R1.2 元数据模式下不与转换族「加入批量队列」同屏出现',
    $('metaBatchRunBtn').style.display !== 'none' && $('addToBatchBtn').style.display === 'none',
    `run=${$('metaBatchRunBtn').style.display || '显示'} convert=${$('addToBatchBtn').style.display || '显示'}`);
  check('R1.3 「应用元数据」文案恒为单文件语义，不随队列状态改变',
    $('metaApplyBtn').textContent === '应用元数据（当前文件）', `"${$('metaApplyBtn').textContent}"`);
  check('R1.4 待转换计数显示在「开始批量列队执行」上（计数信息未随拆分丢失）',
    $('metaBatchRunBtn').textContent === '开始批量列队执行 · 2 项', `"${$('metaBatchRunBtn').textContent}"`);

  // ══ R2 两按钮各走各的执行路径 ══════════════════════════════
  ev('if (isJobRunning()) endJob();');
  $('metaInput').value = 'D:\\v\\single.mp4';
  BACKEND.applied = [];
  await ev('startMetadataApply()');
  await wait(120);
  check('R2.1 点「应用元数据」只提交 1 项（界面单文件），不碰列队',
    BACKEND.applied.length === 1 && BACKEND.applied[0].input === 'D:\\v\\single.mp4',
    JSON.stringify(BACKEND.applied.map(i => i.input)));
  check('R2.2 单文件路径不建立队列行映射（否则结果会错记到某个队列行）',
    ev('_metaProcessingIndices.length') === 0, `len=${ev('_metaProcessingIndices.length')}`);

  ev('if (isJobRunning()) endJob();');
  BACKEND.applied = [];
  await ev('startMetadataBatchRun()');
  await wait(120);
  check('R2.3 点「开始批量列队执行」只提交勾选且未完成的 2 项（未勾选项不跑）',
    BACKEND.applied.length === 2 && BACKEND.applied.every(i => i.input.indexOf('c.mp4') < 0),
    `n=${BACKEND.applied.length} inputs=${JSON.stringify(BACKEND.applied.map(i => i.input))}`);
  check('R2.4 列队输出按各自 outDir.mode 分派（快照项落 D:\\out1，未分派项跟随全局）',
    BACKEND.applied[0].output === 'D:\\out1\\a.mp4', JSON.stringify(BACKEND.applied.map(i => i.output)));
  check('R2.5 列队执行忽略界面设置（用 per-item settings 快照）',
    BACKEND.applied[0].params.manual_date === '2001-01-01', JSON.stringify(BACKEND.applied[0].params));

  // 全部完成 -> 按钮禁用 + title 说明原因，且点击不发请求
  ev('if (isJobRunning()) endJob();');
  ev('metaBatchItems.forEach(f => { f.status = "done"; }); renderMetaBatchTable();');
  await wait(40);
  check('R2.6 全部完成时列队按钮禁用且 title 指明重排队出口',
    $('metaBatchRunBtn').disabled === true && ($('metaBatchRunBtn').title || '').indexOf('重新排队') >= 0,
    `disabled=${$('metaBatchRunBtn').disabled} title="${$('metaBatchRunBtn').title}"`);
  BACKEND.applied = [];
  click('#metaBatchRunBtn');
  await wait(100);
  check('R2.7 禁用态点击不发任何请求（done 项不被重复处理）',
    BACKEND.applied.length === 0, `n=${BACKEND.applied.length}`);

  // 空队列早退路径也必须刷新按钮（A11.6 抓到过的真实缺陷的定点回归）
  ev('metaBatchItems = []; renderMetaBatchTable();');
  await wait(40);
  check('R2.8 清空列队后按钮文案回落（空队列早退路径不得漏刷按钮）',
    $('metaBatchRunBtn').textContent === '开始批量列队执行' && $('metaBatchRunBtn').disabled === true,
    `text="${$('metaBatchRunBtn').textContent}" disabled=${$('metaBatchRunBtn').disabled}`);

  // ══ R3 设置同步器 ═════════════════════════════════════════
  seedQueue();
  await wait(60);
  // 先在界面上设置一组可辨识的日期
  $('m_apply_date').checked = true;
  $('m_date_from_filename').checked = false;
  $('m_manual_date').value = '2024-12-25T08:30:00';
  const outDirBefore = ev('JSON.stringify(metaBatchItems.map(f => f.outDir))');
  ev('renderMetaBatchTable();');
  await wait(40);

  check('R3.1 说明条出口按钮文案为设置同步语义',
    (d.querySelector('[data-action="meta-force-form-run"]') || {}).textContent === '把界面设置应用到勾选项',
    `"${(d.querySelector('[data-action="meta-force-form-run"]') || {}).textContent}"`);

  BACKEND.applied = [];
  click('[data-action="meta-force-form-run"]');
  await wait(80);
  check('R3.2 同步器把界面设置写入全部勾选项（覆盖各自旧设置）',
    ev('metaBatchItems[0].settings.manual_date') === '2024-12-25T08:30:00'
    && ev('metaBatchItems[1].settings.manual_date') === '2024-12-25T08:30:00',
    `a=${ev('metaBatchItems[0].settings.manual_date')} b=${ev('metaBatchItems[1].settings.manual_date')}`);
  check('R3.3 未勾选项不被改写（同步范围 = selected 集合）',
    ev('metaBatchItems[2].settings.manual_date') === '2003-03-03',
    `c=${ev('metaBatchItems[2].settings.manual_date')}`);
  check('R3.4 同步器绝不改写 outDir（输出位置与标签内容是两件事）',
    ev('JSON.stringify(metaBatchItems.map(f => f.outDir))') === outDirBefore,
    ev('JSON.stringify(metaBatchItems.map(f => f.outDir))'));
  check('R3.5 同步器不启动任何转换（零 fetch 提交）',
    BACKEND.applied.length === 0, `n=${BACKEND.applied.length}`);
  check('R3.6 同步成功有 toast 反馈（非静默）',
    toastText().indexOf('已将界面设置应用到 2 个列队项') >= 0, toastText());
  check('R3.7 同步器不隐式重排队（done 项仍为 done）',
    ev('metaBatchItems.filter(f => f.status === "done").length') === 0, '');

  // 执行中项必须被排除且提示原因
  seedQueue();
  ev('metaBatchItems[0].status = "processing"; renderMetaBatchTable();');
  $('m_manual_date').value = '2030-01-01';
  await wait(40);
  click('[data-action="meta-force-form-run"]');
  await wait(80);
  check('R3.8 执行中项被排除且其设置未被改写',
    ev('metaBatchItems[0].settings.manual_date') === '2001-01-01',
    `a=${ev('metaBatchItems[0].settings.manual_date')}`);
  check('R3.9 部分跳过时 toast 注明跳过数量与原因',
    toastText().indexOf('执行中已跳过') >= 0 && toastText().indexOf('1 项执行中') >= 0, toastText());

  // 无勾选 -> 警告而非静默
  ev('metaBatchItems.forEach(f => f.selected = false); renderMetaBatchTable();');
  await wait(40);
  click('[data-action="meta-force-form-run"]');
  await wait(60);
  check('R3.10 无勾选项时给明确警告（非静默失败）',
    toastText().indexOf('请先勾选要应用设置的列队项') >= 0, toastText());

  // ══ R4 GPS：复制 -> 粘贴往返 ═══════════════════════════════
  $('m_location_lat').value = '39.9042';
  $('m_location_lon').value = '116.4074';
  $('m_location_name').value = '北京市东城区';
  $('m_location_address').value = '东长安街 1 号';
  setClip('');
  click('[data-action="geo-copy"][data-geo-prefix="m"]');
  await wait(120);
  const copied = getClip();
  check('R4.1 复制产出合法 JSON 且含 lat/lon/name/address',
    (() => { try { const o = JSON.parse(copied); return o.lat === '39.9042' && o.lon === '116.4074'
      && o.name === '北京市东城区' && o.address === '东长安街 1 号'; } catch (e) { return false; } })(),
    copied.slice(0, 120));
  check('R4.2 复制内容带 schema / source / updatedAt（来源信息可追溯）',
    (() => { try { const o = JSON.parse(copied); return o.schema === 'meta-geo/v1' && o.source === 'copy'
      && !!(o.updatedAt && !isNaN(Date.parse(o.updatedAt))); } catch (e) { return false; } })(), '');
  check('R4.3 复制成功有 toast 反馈',
    toastText().indexOf('已复制') >= 0, toastText());

  // 清空 me_ 侧后粘贴，验证跨前缀往返
  ev('applyMetaSettings("me", {}); me_location_lat.value=""; me_location_lon.value=""; me_location_name.value=""; me_location_address.value="";');
  click('[data-action="geo-paste"][data-geo-prefix="me"]');
  await wait(150);
  check('R4.4 粘贴把经纬度写入目标前缀（复制到粘贴往返一致）',
    $('me_location_lat').value === '39.9042' && $('me_location_lon').value === '116.4074',
    `lat="${$('me_location_lat').value}" lon="${$('me_location_lon').value}"`);
  check('R4.5 粘贴把地点名与详细地址一并写入',
    $('me_location_name').value === '北京市东城区' && $('me_location_address').value === '东长安街 1 号',
    `name="${$('me_location_name').value}" addr="${$('me_location_address').value}"`);
  check('R4.6 粘贴成功有 toast 反馈',
    toastText().indexOf('已从剪贴板粘贴') >= 0, toastText());

  // ══ R5 GPS：非法输入拦截 ═══════════════════════════════════
  const before = () => ({ lat: $('m_location_lat').value, lon: $('m_location_lon').value });
  const cases = [
    ['R5.1 非 JSON 文本被拦截', '这不是 JSON', '不是合法 JSON'],
    ['R5.2 JSON 数组被拦截（非对象）', '[1,2,3]', '必须是一个对象'],
    ['R5.3 JSON null 被拦截（非对象）', 'null', '必须是一个对象'],
    ['R5.4 缺少 lat 字段被拦截', '{"lon":"116.4","name":"x"}', '缺少字段'],
    ['R5.5 缺少 lon 字段被拦截', '{"lat":"39.9","name":"x"}', '缺少字段'],
    ['R5.6 纬度超范围被拦截（95 > 90）', '{"lat":"95","lon":"116.4"}', '纬度超出范围'],
    ['R5.7 经度超范围被拦截（181 > 180）', '{"lat":"39.9","lon":"181"}', '经度超出范围'],
    ['R5.8 非数字经纬度被拦截', '{"lat":"abc","lon":"116.4"}', '不是有效数字'],
  ];
  for (const [name, payload, expect] of cases) {
    $('m_location_lat').value = '10.0';
    $('m_location_lon').value = '20.0';
    setClip(payload);
    click('[data-action="geo-paste"][data-geo-prefix="m"]');
    await wait(110);
    const b = before();
    check(name, toastText().indexOf(expect) >= 0
      && b.lat === '10.0' && b.lon === '20.0',
      `toast="${toastText()}" 写入后lat=${b.lat} lon=${b.lon}`);
  }
  // 空剪贴板
  setClip('');
  click('[data-action="geo-paste"][data-geo-prefix="m"]');
  await wait(110);
  check('R5.9 空剪贴板被拦截并明确提示',
    toastText().indexOf('剪贴板为空') >= 0 && $('m_location_lat').value === '10.0', toastText());

  // 剪贴板完全不可用 -> 如实上报，不静默
  ev('__clipboardFails = true;');
  setClip('');
  click('[data-action="geo-copy"][data-geo-prefix="m"]');
  await wait(140);
  check('R5.10 剪贴板 API 被拒时走 execCommand 回退并如实上报（非静默失败）',
    toastText().indexOf('复制') >= 0 || toastText().indexOf('剪贴板') >= 0, toastText());
  ev('__clipboardFails = false;');

  // ══ R6 GPS：地图选点回填（三前缀各自写对目标控件）═══════
  for (const [prefix, tag] of [['p', 'locationInfo'], ['m', 'metaLocationInfo'], ['me', 'me_location_info']]) {
    ev(`mapSelectedLocation = { name: "天安门广场", lat: 39.9055, lon: 116.3976, address: "北京市东城区东长安街" };`);
    click(`[data-action="geo-map-pick"][data-geo-prefix="${prefix}"]`);
    await wait(60);
    check(`R6.${prefix} 地图选点打开后置位正确的 mapPickerTarget`,
      ev('mapPickerTarget') === (prefix === 'p' ? 'encode' : prefix === 'm' ? 'meta' : 'me'),
      `target=${ev('mapPickerTarget')} 期望=${prefix === 'p' ? 'encode' : prefix === 'm' ? 'meta' : 'me'}`);
    ev('confirmMapSelection();');
    await wait(40);
    const latEl = $(`${prefix}_location_lat`), lonEl = $(`${prefix}_location_lon`);
    check(`R6.${prefix}b 选点结果回填到该前缀的经纬度输入框（不串前缀）`,
      latEl.value === '39.905500' && lonEl.value === '116.397600',
      `lat="${latEl.value}" lon="${lonEl.value}"`);
  }
  // addrFailed 哨兵不得流入地址框（显式标志位拦截，非文案匹配）。
  // 先清空地址框再测：断言的是「失败态不写入」，若框里还留着上一轮
  // 的成功值，仅看值无法区分「被拦截」与「压根没执行」。
  // ⚠ mapPickerTarget 必须是 'meta'（不是字段前缀 'm'）—— 传 'm' 会掉进
  //   confirmMapSelection 的 else 分支（p_ 前缀），断言会读到 #p_location_*
  //   而误判。本条同时是对「前缀不对称」这一高发缺陷的定点防护。
  $('m_location_address').value = '';
  ev(`mapSelectedLocation = { name:"39.9055, 116.3976", lat:39.9055, lon:116.3976, address:"(地址获取失败 — OSM: x)", addrFailed:true };
      mapPickerTarget = "meta"; confirmMapSelection();`);
  await wait(40);
  check('R6.3 逆地理失败时地址框为空（addrFailed 标志位拦截错误文案）',
    $('m_location_address').value === '' && $('m_location_lat').value === '39.905500',
    `addr="${$('m_location_address').value}" lat="${$('m_location_lat').value}"`);

  // 未知前缀不得静默（防 data-geo-prefix 写错的静默失效）
  ev('applyFormSettingsToQueue();');
  await wait(40);
  check('R6.4 未知前缀不抛未捕获异常且有提示（防前缀写错静默失效）',
    errors.length === 0 && toastText().length > 0, `toast="${toastText()}" errors=${errors.length}`);

  // ══ 收尾 ═════════════════════════════════════════════════
  check('R9.1 页面无 JS 运行时错误', errors.length === 0, errors.slice(0, 3).join(' | '));
  check('R9.2 本轮无未注册 data-action 触发 console.error（委托面完好）',
    !errors.some(e => e.indexOf('未注册的 data-action') >= 0), errors.filter(e => e.indexOf('data-action') >= 0).slice(0, 2).join(' | '));

  const failed = results.filter(r => !r.ok).length;
  console.log('\n═══════════════════════════════════════════════════════════════════');
  if (failed) {
    console.log(` 失败 ${failed} 条：`);
    results.filter(r => !r.ok).forEach(r => console.log('   - ' + r.name));
  }
  console.log(` v3.13.18 元数据三项修复验收：${results.length - failed}/${results.length} PASS`);
  console.log('═══════════════════════════════════════════════════════════════════');
  process.exit(failed ? 1 : 0);
})();
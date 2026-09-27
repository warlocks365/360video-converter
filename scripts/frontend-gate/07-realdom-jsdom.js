// 门禁 07：真实 DOM 验证（jsdom）
// 前 6 项门禁中，04 用的是自定义 DOM 桩（宽松 Proxy），只能证明"脚本不崩"，
// 无法验证真实 DOM 行为。本门禁用 jsdom 提供真实 DOM 实现 + 真实脚本加载，
// 端到端验证：页面解析 → 脚本按序执行 → init() 完成 → DOM 结构正确 → 事件委托可用。
//
// 依赖：jsdom 已安装于托管 node 工作区；桩服务器需在 8800 端口运行。
const path = require('path');
const WS = 'C:/Users/warlocks/.workbuddy/binaries/node/workspace/node_modules';
const { JSDOM, VirtualConsole } = require(path.join(WS, 'jsdom'));

const PORT = 8800;
const URL = `http://127.0.0.1:${PORT}/`;

// 与后端真实响应形状一致的桩（形状不符会产生假阳性）
const CODECS = {
  libx264: { label: 'H.264 (libx264)', group: 'cpu', presets: [], default_preset: '', has_profile: true, has_level: true, has_bf_refs: true, has_x264_params: true, x265_params: false },
  libx265: { label: 'H.265 (libx265)', group: 'cpu', presets: [], default_preset: '', has_profile: true, has_level: true, has_bf_refs: true, has_x264_params: false, x265_params: true },
  hevc_nvenc: { label: 'H.265 (NVENC)', group: 'cuda', presets: [], default_preset: '', has_profile: true, has_bf_refs: false },
};
const API = (url) => {
  if (url.includes('/api/codecs')) return { codecs: CODECS };
  if (url.includes('/api/codec_check')) return { available: { libx264: true, libx265: true }, error_details: {}, ffmpeg_info: {}, runtime_dlls: {}, fix_hints: {} };
  if (url.includes('/api/presets')) return { presets: [] };
  if (url.includes('/api/version')) return { version: '3.12.0-test', name: '360 Video Converter' };
  if (url.includes('/api/tasks/load')) return { tasks: [] };
  if (url.includes('/api/settings')) return {};
  if (url.includes('/api/sysmon')) return { cpu: 10, mem: 40, disk: 0, net: 0, gpu: 0 };
  if (url.includes('/api/extract_date')) return { date_str: null };
  if (url.includes('/api/status/')) return { overall_progress: 0, file_progress: 0, items: [], log: [], status: 'running' };
  return {};
};

const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', e => errors.push('jsdomError: ' + (e.detail || e.message || e)));
vc.on('error', (...a) => errors.push('console.error: ' + a.map(String).join(' ')));

const results = [];
const check = (name, cond, detail) => {
  results.push({ name, ok: !!cond, detail: detail === undefined ? '' : String(detail) });
};

(async () => {
  let dom;
  try {
    dom = await JSDOM.fromURL(URL, {
      runScripts: 'dangerously',
      resources: 'usable',
      pretendToBeVisual: true,
      virtualConsole: vc,
      beforeParse(window) {
        window.fetch = async (u) => ({
          ok: true, status: 200,
          json: async () => API(String(u)),
          text: async () => JSON.stringify(API(String(u))),
        });
        window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
        window.AbortController = window.AbortController || AbortController;
        window.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
      },
    });
  } catch (e) {
    console.log('FAIL 无法加载页面:', e.message);
    console.log('（请确认桩服务器已在 ' + PORT + ' 端口运行）');
    process.exit(1);
  }

  // 等待脚本加载与 init() 完成
  await new Promise(r => setTimeout(r, 3000));

  const d = dom.window.document;
  const $ = id => d.getElementById(id);

  // ── 1. 脚本加载与 init() ──
  // 注意：模块用 const 声明 DELEGATED_ACTIONS，顶层 const/let 进入全局"词法"作用域，
  // 不挂在 window 上 —— 必须用 window.eval 在全局作用域求值才能访问
  const actionCount = (() => {
    try { return Number(dom.window.eval('Object.keys(DELEGATED_ACTIONS).length')); } catch (e) { return -1; }
  })();
  const fnNames = dom.window.eval("(typeof switchMode) + ',' + (typeof collectParams) + ',' + (typeof toggleParamGroup)");

  check('10 个业务脚本全部执行且委托表就绪', actionCount === 20, `注册 action 数 = ${actionCount}`);
  check('init() 完成：版本号已回填', $('appVersionTag') && $('appVersionTag').textContent.includes('3.12.0'),
    `appVersionTag = "${$('appVersionTag') && $('appVersionTag').textContent}"`);
  check('关键函数已导出为全局', fnNames === 'function,function,function', fnNames);

  // ── 2. 手风琴结构（item 1）──
  const groups = d.querySelectorAll('#encodeParams .param-group');
  check('手风琴：9 个 .param-group 已生成', groups.length === 9, `实际 ${groups.length} 个`);
  const groupIds = [...groups].map(g => g.id);
  const expectIds = ['pg-codec','pg-video','pg-audio','pg-container','pg-stabilize','pg-okaa','pg-insta360','pg-date','pg-location'];
  check('手风琴：分组 id 齐全', expectIds.every(id => groupIds.includes(id)), groupIds.join(','));
  check('手风琴：默认折叠 2 组（设备专项）',
    d.querySelectorAll('#encodeParams .param-group.collapsed').length === 2,
    `折叠 ${d.querySelectorAll('#encodeParams .param-group.collapsed').length} 组`);

  // 折叠不得移除 DOM（收集参数的前提）
  const beforeCount = d.querySelectorAll('#encodeParams input, #encodeParams select').length;
  check('手风琴：折叠态下参数控件仍在 DOM（collectParams 不丢参）', beforeCount > 50, `#encodeParams 内控件 ${beforeCount} 个`);
  check('手风琴：折叠用的是 display:none 而非移除 DOM',
    d.querySelectorAll('.param-group.collapsed .param-group-body').length === 2,
    '两个折叠组的 body 元素均存在');

  // ── 3. toggleParamGroup 行为 ──
  const head = d.querySelector('#pg-okaa .param-group-head');
  const grp = $('pg-okaa');
  const wasCollapsed = grp.classList.contains('collapsed');
  dom.window.toggleParamGroup(head);
  check('toggleParamGroup：点击分组头切换折叠态', grp.classList.contains('collapsed') !== wasCollapsed,
    `${wasCollapsed} → ${grp.classList.contains('collapsed')}`);

  // ── 4. collectParams 在折叠态下仍能读到折叠组内的值 ──
  const pgInsFov = $('p_insv_fov');
  pgInsFov.value = '210';                     // 设置折叠组（Insta360）内的一个参数
  let collected = null, collectErr = null;
  try { collected = dom.window.collectParams(); } catch (e) { collectErr = e.message; }
  check('collectParams() 可执行（无异常）', !collectErr, collectErr || '');
  check('collectParams() 能读到折叠组内的参数值（关键回归点）',
    collected && String(collected.insv_fov) === '210',
    collected ? `insv_fov = ${collected.insv_fov}` : 'N/A');

  // ── copy 模式（流复制）开关 ──
  check('copy 模式：开关与提示框存在', !!$('p_copy_mode') && !!$('copyModeHint'));
  const pCopy = $('p_copy_mode');
  pCopy.checked = true;
  dom.window.onCopyModeChange();
  const inertGroups = ['pg-video', 'pg-audio', 'pg-stabilize', 'pg-okaa', 'pg-insta360']
    .filter(id => $(id).classList.contains('pg-inert')).length;
  check('copy 模式：启用后 5 个"需重编码"参数组被置为惰性', inertGroups === 5, `惰性 ${inertGroups}/5`);
  check('copy 模式：启用后编码器下拉被禁用', $('p_codec').disabled === true);
  check('copy 模式：提示框显示', $('copyModeHint').style.display !== 'none');
  const collectedCopy = (() => { try { return dom.window.collectParams(); } catch (e) { return null; } })();
  check('copy 模式：collectParams 采集到 copy_mode=true',
    collectedCopy && collectedCopy.copy_mode === true,
    collectedCopy ? `copy_mode = ${collectedCopy.copy_mode}` : 'N/A');
  pCopy.checked = false;
  dom.window.onCopyModeChange();
  check('copy 模式：关闭后恢复可交互',
    $('p_codec').disabled === false && !$('pg-video').classList.contains('pg-inert'));

  // ── 5. 事件委托可用性（item 2）──
  // 构造一个带 data-action 的元素并派发 click，验证 document 级委托确实能分发
  let delegatedHit = false;
  const origShowDetail = dom.window.showEncoderDetail;
  dom.window.showEncoderDetail = () => { delegatedHit = true; };
  const probe = d.createElement('button');
  probe.setAttribute('data-action', 'encoder-detail');
  probe.setAttribute('data-encoder', 'libx264');
  d.body.appendChild(probe);
  probe.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  check('事件委托：click 能分发到 DELEGATED_ACTIONS', delegatedHit, delegatedHit ? '已命中' : '未命中');
  dom.window.showEncoderDetail = origShowDetail;

  // change 事件（表单控件路径）
  let changeHit = false;
  const origImport = dom.window.updateImportCount;
  dom.window.updateImportCount = () => { changeHit = true; };
  const cbox = d.createElement('input');
  cbox.type = 'checkbox';
  cbox.setAttribute('data-action', 'update-import-count');
  d.body.appendChild(cbox);
  cbox.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  check('事件委托：change 能分发（表单控件路径）', changeHit, changeHit ? '已命中' : '未命中');
  dom.window.updateImportCount = origImport;

  // ── 6. 路径按钮（item 4）──
  const pathBtns = d.querySelectorAll('[data-action="open-path-dialog"]');
  check('路径输入：14 个浏览按钮已改为 data-action', pathBtns.length === 14, `实际 ${pathBtns.length} 个`);
  check('路径输入：浏览按钮均带 data-path-target',
    [...pathBtns].every(b => b.dataset.pathTarget), '');

  // ── 7. 三栏布局结构（v3.11.0）──
  check('三栏工作台：.workspace 与 3 个 .ws-col 已生成',
    d.querySelectorAll('.workspace').length === 1 && d.querySelectorAll('.workspace .ws-col').length === 3,
    `.workspace=${d.querySelectorAll('.workspace').length} .ws-col=${d.querySelectorAll('.workspace .ws-col').length}`);
  check('三栏工作台：操作栏位于工作台之后（吸底布局前提）',
    (() => { const ws = d.querySelector('.workspace'), ab = $('mainActionBar');
      return ws && ab && (ws.compareDocumentPosition(ab) & 4) !== 0; })());

  // ── 8. 单一操作栏（P0-④）──
  check('单一操作栏：全页仅一个 .action-bar', d.querySelectorAll('.action-bar').length === 1,
    `实际 ${d.querySelectorAll('.action-bar').length} 个`);
  check('单一操作栏：进度 DOM 无 meta* 重复', !$('metaOverallProgress') && !!$('overallProgress'));

  // ── 9. 统一轻提示（P1-⑧）──
  check('统一轻提示：showToast 支持时长参数', dom.window.showToast.length >= 3, `showToast.length=${dom.window.showToast.length}`);

  // ── 10. 模式切换 ──
  let switchErr = null;
  try {
    ['single','merge','batch','metadata','report','vr3d'].forEach(m => dom.window.switchMode(m));
  } catch (e) { switchErr = e.message; }
  check('switchMode：6 个模式全部可切换且无异常', !switchErr, switchErr || '');
  check('switchMode：元数据模式显示 metaApplyBtn、隐藏 startBtn',
    (() => { dom.window.switchMode('metadata');
      return $('metaApplyBtn').style.display !== 'none' && $('startBtn').style.display === 'none'; })());
  dom.window.switchMode('single');

  // ── 11. 控制台无错误 ──
  check('页面无 JS 错误', errors.length === 0, errors.slice(0, 3).join(' | '));

  // ── 输出 ──
  let failed = 0;
  console.log('══ 真实 DOM 验证（jsdom）══\n');
  for (const r of results) {
    if (!r.ok) failed++;
    console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${r.name}${r.detail ? '  → ' + r.detail : ''}`);
  }
  console.log(`\n合计 ${results.length} 项，通过 ${results.length - failed}，失败 ${failed}`);
  if (errors.length) { console.log('\n错误明细:'); errors.slice(0, 10).forEach(e => console.log('  ' + e.slice(0, 200))); }
  process.exit(failed ? 1 : 0);
})();

// v3.14.7 筛选按钮接线回归（用户实报：点「筛选」「添加条件」无任何反应）
// 根因：两按钮无 onclick、无 data-action、无本地 addEventListener——事件链断裂。
// 修复：data-action="meta-filter-toggle"/"meta-filter-add" + 00-core 中央委托注册。
// ★本套件的教训来源：v3.14.6 验收只断言"DOM 在位"并直接改 metaFilterList 驱动
//   渲染，从未真实 .click() 按钮——接线断裂完全测不出来。本套件强制走
//   dispatchEvent(真实 MouseEvent) → 中央委托 → 业务函数 的全链路。
const path = require('path');
const os = require('os');
const fs = require('fs');
const WS = path.join(os.homedir(), '.workbuddy', 'binaries', 'node', 'workspace', 'node_modules');
const { JSDOM, VirtualConsole } = require(path.join(WS, 'jsdom'));
const R = path.resolve(__dirname, '..', '..');
const results = [];
const check = (n, ok, d) => { results.push({ n, ok: !!ok, d: d === undefined ? '' : String(d) }); };

(async () => {
  // S 组：静态接线断言（源码级）
  const html = fs.readFileSync(path.join(R, 'static/index.html'), 'utf8');
  const core = fs.readFileSync(path.join(R, 'static/js/00-core.js'), 'utf8');
  const meta = fs.readFileSync(path.join(R, 'static/js/50-meta.js'), 'utf8');
  check('S1 筛选按钮带 data-action="meta-filter-toggle"',
    /id="metaFilterToggleBtn"[^>]*data-action="meta-filter-toggle"|data-action="meta-filter-toggle"[^>]*id="metaFilterToggleBtn"/.test(html));
  check('S2 添加条件按钮带 data-action="meta-filter-add"',
    /id="metaFilterAddBtn"[^>]*data-action="meta-filter-add"|data-action="meta-filter-add"[^>]*id="metaFilterAddBtn"/.test(html));
  check('S3 两 action 已在 00-core 中央委托注册',
    /'meta-filter-toggle':/.test(core) && /'meta-filter-add':/.test(core));
  check('S4 业务函数存在（toggleMetaFilterBar/metaFilterAddRow）',
    /function toggleMetaFilterBar\(/.test(meta) && /function metaFilterAddRow\(/.test(meta));

  // D 组：真实 DOM 全链路——dispatchEvent 点击（非直接调函数）
  const dom = await JSDOM.fromURL('http://127.0.0.1:8800/', {
    runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true,
    virtualConsole: new VirtualConsole(),
    beforeParse(w) {
      w.fetch = async (u, o) => {
        const p = String(u);
        if (p.includes('/api/codecs')) return { ok: true, status: 200, json: async () => ({ codecs: {}, video: [], audio: [] }) };
        if (p.includes('/api/codec_check')) return { ok: true, status: 200, json: async () => ({ available: {}, error_details: {}, ffmpeg_info: {}, runtime_dlls: {}, fix_hints: {} }) };
        if (p.includes('/api/settings')) return { ok: true, status: 200, json: async () => ({ amap_api_key: 'k', amap_security: 's', custom_ffmpeg_path: '' }) };
        if (p.includes('/api/presets')) return { ok: true, status: 200, json: async () => ({ presets: [] }) };
        if (p.includes('/api/version')) return { ok: true, status: 200, json: async () => ({ version: '3.14.7-test' }) };
        if (p.includes('/api/tasks/load')) return { ok: true, status: 200, json: async () => ({ tasks: [] }) };
        if (p.includes('/api/sysmon')) return { ok: true, status: 200, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => ({}) };
      };
      w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
      w.confirm = () => true;
    },
  });
  await new Promise(r => setTimeout(r, 3500));
  const win = dom.window;
  const d = win.document;
  const click = (el) => el.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
  const bar = () => d.getElementById('metaFilterBar');

  check('D0 前置：筛选栏初始 hidden', bar() && bar().classList.contains('hidden'));
  // D1 真实点击「筛选」按钮 → 栏展开
  click(d.getElementById('metaFilterToggleBtn'));
  check('D1 ★真实点击「筛选」→ 栏展开（用户实报路径）', bar() && !bar().classList.contains('hidden'));
  check('D1b 按钮获得激活态样式', d.getElementById('metaFilterToggleBtn').classList.contains('btn-accent'));
  // D2 真实点击「添加条件」→ metaFilterList 增一行 + 渲染出行控件
  click(d.getElementById('metaFilterAddBtn'));
  check('D2 ★真实点击「添加条件」→ 列表增行', win.eval('metaFilterList.length') === 1, 'len=' + win.eval('metaFilterList.length'));
  check('D2b 行控件已渲染（字段下拉出现）', !!d.querySelector('#metaFilterRows select.report-filter-field'));
  // D3 行内删除按钮（动态生成，data-action="meta-filter-remove"）→ 真实点击可删
  const rmBtn = d.querySelector('#metaFilterRows [data-action="meta-filter-remove"]');
  check('D3 删除按钮在位', !!rmBtn);
  if (rmBtn) {
    click(rmBtn);
    check('D3b ★真实点击删除 → 行移除', win.eval('metaFilterList.length') === 0);
  }
  // D4 再点「筛选」→ 栏收起（双向）
  click(d.getElementById('metaFilterToggleBtn'));
  check('D4 再点「筛选」→ 栏收起', bar() && bar().classList.contains('hidden'));
  // D5 SVG 子元素点击冒泡（用户实际点在图标上）→ closest 委托仍命中
  win.eval(`metaFilterList=[]; renderMetaFilterRows();`);
  const svg = d.querySelector('#metaFilterAddBtn svg');
  if (svg) {
    svg.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
    check('D5 ★点击按钮内 SVG 图标也能触发（冒泡 closest）', win.eval('metaFilterList.length') === 1);
  } else {
    check('D5 按钮内 SVG 存在', false, 'svg missing');
  }

  dom.window.close();
  const bad = results.filter(r => !r.ok);
  console.log('══ v3.14.7 筛选按钮接线回归 ══');
  results.forEach(r => console.log((r.ok ? 'OK   ' : 'FAIL ') + r.n + (r.d ? '  → ' + r.d : '')));
  console.log(`合计 ${results.length} 项，通过 ${results.length - bad.length}，失败 ${bad.length}`);
  process.exit(bad.length ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });

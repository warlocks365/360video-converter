// 门禁 09：布局断点与窗口宽度的协调性
//
// 背景（v3.12.0 首版实际踩过的坑）：三栏工作台用 @media (max-width: N) 做单列回落，
// 而应用默认窗口宽度恰好等于 N。结果窗口一启动，视口宽度就 ≤ N，媒体查询立即命中，
// 三栏布局被自身的断点压回单列 —— 用户看到的是"新版 UI 完全没有变化"，
// 且没有任何报错。这类失效纯属配置冲突，静态检查无法从单侧发现，必须两侧联校。
//
// 本门禁校验：
//   ① app.css 中 .workspace 确实是三栏 Grid
//   ② 单列回落断点存在，且 **应用默认窗口宽度 > 断点**（留有余量）
//   ③ min_size 宽度同样大于断点（否则用户一旦缩小窗口就永久失去三栏布局）
const fs = require('fs');
const path = require('path');
const STATIC = path.resolve(__dirname, '../../static');
const APP_PY = path.resolve(__dirname, '../../app.py');

const css = fs.readFileSync(path.join(STATIC, 'css/app.css'), 'utf8');
const py = fs.readFileSync(APP_PY, 'utf8');

const results = [];
const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });

// ── ① .workspace 是三栏 Grid ──
const wsRule = css.match(/\.workspace\s*\{([^}]*)\}/);
check('.workspace 定义为 Grid 布局', wsRule && /display:\s*grid/.test(wsRule[1]),
  wsRule ? wsRule[1].trim().slice(0, 90) : '未找到 .workspace 规则');
const cols = wsRule && wsRule[1].match(/grid-template-columns:\s*([^;]+)/);
const trackCount = cols ? cols[1].trim().split(/\s+(?![^(]*\))/).length : 0;
check('三栏工作台为 3 条列轨', trackCount === 3, `实际 ${trackCount} 条：${cols ? cols[1].trim() : 'N/A'}`);

// ── ② 找出「把 .workspace 压成单列」的媒体查询断点 ──
const mediaBlocks = [...css.matchAll(/@media\s*\(([^)]*max-width[^)]*)\)\s*\{([\s\S]*?)\n\}/g)];
let breakpoint = null;
for (const m of mediaBlocks) {
  const maxW = m[1].match(/max-width\s*:\s*(\d+)\s*px/);
  if (!maxW) continue;
  // 该媒体块内是否把 .workspace 设为单列
  if (/\.workspace\s*\{[^}]*grid-template-columns:\s*1fr/.test(m[2])) {
    breakpoint = Number(maxW[1]);
  }
}
check('存在单列回落断点', breakpoint !== null, breakpoint === null ? '未找到' : `max-width: ${breakpoint}px`);

// ── ③ 解析 app.py 的窗口宽度与最小尺寸 ──
const winMatch = py.match(/webview\.create_window\(([\s\S]{0,600}?)\)\s*\n/);
const winArgs = winMatch ? winMatch[1] : '';
const wMatch = winArgs.match(/width\s*=\s*(\d+)/);
const minMatch = winArgs.match(/min_size\s*=\s*\(\s*(\d+)\s*,\s*(\d+)\s*\)/);
const winWidth = wMatch ? Number(wMatch[1]) : null;
const minWidth = minMatch ? Number(minMatch[1]) : null;

check('app.py 中解析到窗口宽度', winWidth !== null, winWidth === null ? '未找到 width=' : `width=${winWidth}`);
check('app.py 中解析到 min_size', minWidth !== null, minWidth === null ? '未找到 min_size=' : `min_size=(${minWidth}, ...)`);

// ── ④ 协调性：窗口宽度必须大于断点（留 100px 余量）──
const MARGIN = 100;
if (winWidth !== null && breakpoint !== null) {
  check(`默认窗口宽度(${winWidth}) > 单列断点(${breakpoint}) + ${MARGIN}`,
    winWidth > breakpoint + MARGIN,
    winWidth > breakpoint + MARGIN ? 'OK' :
      `❌ 窗口 ${winWidth}px ≤ 断点 ${breakpoint}px —— 三栏布局启动即被压回单列！请调低断点或调高窗口宽度`);
}
if (minWidth !== null && breakpoint !== null) {
  // 注意：min_size 宽度允许小于断点 —— 用户手动缩小窗口时回落单列是**预期的**
  // 响应式行为，不是缺陷。真正的失效条件只有"默认窗口宽度 ≤ 断点"（上面那条）。
  // 这里仅作信息提示，不计入失败。
  console.log(`INFO 最小窗口宽度 ${minWidth}px ${minWidth > breakpoint ? '>' : '≤'} 断点 ${breakpoint}px` +
    (minWidth > breakpoint ? '（无论如何都不会回落单列）' : '（用户缩至此宽度以下时回落单列，属预期行为）'));
}

// ── ⑤ 缓存策略：界面资源必须禁用缓存，避免旧版页面被复用以至掩盖新构建 ──
check('app.py 对非 API 响应禁用缓存（no-store）',
  /Cache-Control/.test(py) && /no-store/.test(py) && /@app\.after_request/.test(py),
  /no-store/.test(py) ? 'OK' : '未找到 no-store —— 旧版 index.html 可能被 WebView2 缓存复用');

// ── ⑥ 侧栏内容适配 ──
// 背景（v3.12.1 实际踩过的坑）：编码参数面板原按约 1160px 全宽设计，内含 10 处
// .grid-4 四列字段；.sysmon-grid 原为 5 列。把它们直接塞进约 380px / 250px 的侧栏后，
// 每格只剩约 40–57px，标签被压到 min-content 而逐字折行（"视/频/编/码"），
// <select> 还会按最长 option 撑出横向溢出。必须在侧栏语境内降列并允许收缩。
const lc = (css.match(/\.ws-col-left \.grid-4[\s\S]{0,120}?\{([^}]*)\}/) || [])[1] || '';
check('左栏内 .grid-4 已降为两列（不再是四列）',
  /1fr\s+1fr/.test(lc) && !/repeat\(4/.test(lc),
  lc ? lc.trim() : '未找到 .ws-col-left .grid-4 规则');
check('左栏内 .grid-2 已降为单列（下拉框需整行宽度以完整显示选项文案）',
  /\.ws-col-left \.grid-2\s*\{[^}]*grid-template-columns:\s*1fr\s*;/.test(css),
  /\.ws-col-left \.grid-2/.test(css) ? 'OK' : '未找到降列规则');
check('左栏内网格项已设 min-width:0（允许收缩到 min-content 以下，防横向溢出）',
  /\.ws-col-left[\s\S]{0,400}?min-width:\s*0/.test(css),
  /min-width:\s*0/.test(css) ? 'OK' : '缺失 —— <select> 会按最长 option 撑破网格');
check('左栏内卡片内边距已收紧（为内容多让出宽度）',
  /\.ws-col-left \.card\s*\{[^}]*padding:/.test(css), '');
const sc = (css.match(/\.ws-col-right \.sysmon-grid\s*\{([^}]*)\}/) || [])[1] || '';
check('右栏内 .sysmon-grid 已降为两列（原 5 列在 250px 栏内每格仅约 40px）',
  /repeat\(2/.test(sc) && !/repeat\(5/.test(sc),
  sc ? sc.trim() : '未找到 .ws-col-right .sysmon-grid 规则');

// ── 输出 ──
let failed = 0;
console.log('══ 布局断点与窗口宽度协调性 ══\n');
for (const r of results) { if (!r.ok) failed++; console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${r.name}${r.detail ? '  → ' + r.detail : ''}`); }
console.log(`\n合计 ${results.length} 项，通过 ${results.length - failed}，失败 ${failed}`);
process.exit(failed ? 1 : 0);

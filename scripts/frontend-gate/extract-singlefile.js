// 单文件前端拆分工具：index.html → css/app.css + js/*.js
// 核心保证：按顶层语句块整块切分（函数绝不被截断），并内置"拼回原文逐字符比对"的无损校验
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const INDEX = path.join(ROOT, 'static/index.html');
const html = fs.readFileSync(INDEX, 'utf8');

// ── 1. 提取 <style> 与内联 <script> ──────────────────────────
const styleRe = /<style[^>]*>([\s\S]*?)<\/style>/;
const styleMatch = html.match(styleRe);
if (!styleMatch) throw new Error('style block not found');
const cssBody = styleMatch[1];

const scriptRe = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/;
const scriptMatch = html.match(scriptRe);
if (!scriptMatch) throw new Error('inline script not found');
const jsBody = scriptMatch[1];

const scriptStartLine = html.slice(0, scriptMatch.index).split('\n').length + 1;

// ── 2. 顶层语句块解析器 ─────────────────────────────────────
// 逐字符扫描，跟踪：字符串(' " `)、模板插值、注释、括号深度、正则/除法消歧
const KEYWORDS_BEFORE_REGEX = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'throw', 'case', 'do', 'else', 'yield', 'await', 'default',
]);
const VALUE_KEYWORDS = new Set(['this', 'true', 'false', 'null', 'super', 'undefined']);

function parseTopLevel(src) {
  const lines = src.split('\n');
  const depthBefore = new Array(lines.length).fill(0);
  const depthAfter = new Array(lines.length).fill(0);

  let depth = 0;
  let i = 0;
  let line = 0;
  let inLineComment = false;
  let inBlockComment = false;
  let inSingle = false, inDouble = false, inTemplate = false;
  const tmplStack = [];
  let canEndExpr = false;   // 上一个 token 能否结束一个表达式 → 决定 / 是正则还是除号
  let identBuf = '';

  const n = src.length;

  function flushIdent() {
    if (!identBuf) return;
    if (VALUE_KEYWORDS.has(identBuf)) canEndExpr = true;
    else if (KEYWORDS_BEFORE_REGEX.has(identBuf)) canEndExpr = false;
    else canEndExpr = true; // 普通标识符是值
    identBuf = '';
  }

  // 解析正则字面量：进入时 src[i] === '/'
  function scanRegex() {
    i++; // 跳过开启的 /
    let inClass = false;
    while (i < n) {
      const c = src[i];
      if (c === '\\') { i += 2; continue; }
      if (c === '\n') return;          // 未闭合，放弃（按普通字符处理）
      if (c === '[') { inClass = true; i++; continue; }
      if (c === ']') { inClass = false; i++; continue; }
      if (c === '/' && !inClass) { i++; break; }
      i++;
    }
    while (i < n && /[a-z]/i.test(src[i])) i++; // flags
  }

  while (i < n) {
    const ch = src[i];
    const next = src[i + 1];

    if (ch === '\n') {
      depthAfter[line] = depth;
      inLineComment = false;
      line++;
      if (line < lines.length) depthBefore[line] = depth;
      i++;
      continue;
    }

    if (inLineComment) { i++; continue; }

    if (inBlockComment) {
      if (ch === '*' && next === '/') { inBlockComment = false; i += 2; continue; }
      i++; continue;
    }

    if (inSingle) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === "'") { inSingle = false; canEndExpr = true; }
      i++; continue;
    }
    if (inDouble) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === '"') { inDouble = false; canEndExpr = true; }
      i++; continue;
    }
    if (inTemplate) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === '`') { inTemplate = false; canEndExpr = true; i++; continue; }
      // 进入 ${ 插值：必须退出模板态，让插值按普通代码解析（否则匹配的 } 会被吞掉）
      if (ch === '$' && next === '{') { tmplStack.push(depth); depth++; inTemplate = false; i += 2; continue; }
      i++; continue;
    }

    // ── 正常代码 ──
    if (ch === '/' && next === '/') { flushIdent(); inLineComment = true; i += 2; continue; }
    if (ch === '/' && next === '*') { flushIdent(); inBlockComment = true; i += 2; continue; }
    if (ch === '/') {
      flushIdent();
      if (canEndExpr) { canEndExpr = false; i++; continue; }  // 除号
      scanRegex(); canEndExpr = true; continue;                // 正则字面量
    }
    if (ch === "'") { flushIdent(); inSingle = true; i++; continue; }
    if (ch === '"') { flushIdent(); inDouble = true; i++; continue; }
    if (ch === '`') { flushIdent(); inTemplate = true; i++; continue; }
    if (ch === '{') { flushIdent(); depth++; canEndExpr = false; i++; continue; }
    if (ch === '}') {
      flushIdent();
      depth--;
      if (tmplStack.length && depth === tmplStack[tmplStack.length - 1]) {
        tmplStack.pop();
        inTemplate = true;
        canEndExpr = true;
      } else {
        canEndExpr = true;
      }
      i++; continue;
    }
    if (/[A-Za-z0-9_$]/.test(ch)) { identBuf += ch; i++; continue; }

    // 其余标点
    flushIdent();
    if (ch === ')' || ch === ']') canEndExpr = true;
    else if (ch === ' ' || ch === '\t' || ch === '\r') { /* 空白不影响 */ }
    else canEndExpr = false;   // ( [ , ; : ? . = + - * ~ ! & | 等
    i++;
  }
  flushIdent();
  depthAfter[line] = depth;

  // 切分：深度回到 0 时，下一个 depthBefore===0 的行开启新块
  const chunks = [];
  let start = 0;
  for (let ln = 1; ln < lines.length; ln++) {
    if (depthAfter[ln - 1] === 0 && depthBefore[ln] === 0) {
      chunks.push({ start, end: ln - 1 });
      start = ln;
    }
  }
  chunks.push({ start, end: lines.length - 1 });

  // 把"纯注释/空白"块并入下一块；最后一块若纯注释则并入上一块
  const text = c => lines.slice(c.start, c.end + 1).join('\n');
  const isNoise = c => {
    const t = text(c);
    return t.split('\n').every(l => {
      const s = l.trim();
      return s === '' || s.startsWith('//') || s.startsWith('/*') || s.startsWith('*') || s.endsWith('*/');
    });
  };
  const merged = [];
  let carry = null;
  for (const c of chunks) {
    if (isNoise(c)) {
      if (merged.length === 0) { carry = carry ? { start: carry.start, end: c.end } : c; }
      else { merged[merged.length - 1].end = c.end; }
    } else {
      if (carry) { c.start = carry.start; carry = null; }
      merged.push(c);
    }
  }
  if (carry) { merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, carry.end); }

  return { lines, chunks: merged, text };
}

const { lines, chunks, text } = parseTopLevel(jsBody);

// ── 3. 模块划分（按顶层语句块索引 → 模块文件）────────────────
const MODULES = [
  ['00-core.js',   '全局状态 / 常量 / 通用工具 / 格式化函数',      [0,1,2,3,4,5,6,7,18,49,72,73,107,133,155,174,175,176,180,181]],
  ['10-ui.js',     '模式切换 / 折叠开关 / 弹窗 / tooltip / 原生对话框', [19,20,21,22,23,30,31,56,57,58,59,60,61,62,63,74,75,76,77,83,84,85,103,140,141,166,187,188,189,190]],
  ['20-map.js',    '地图与坐标（Leaflet / GCJ-02 转换 / 地理编码）', [14,15,16,17,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,50,51,52,53,54,55,154,156,157]],
  ['30-params.js', '参数采集回填 / 预设管理 / 分辨率与码率联动',    [24,25,26,27,28,29,71,78,79,80,81,82,114]],
  ['40-files.js',  '目录扫描 / 批量任务表 / 合并表 / 任务持久化',   [66,67,68,69,70,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,101,102,104,105,106,108,109,110,111,112,113]],
  ['50-meta.js',   '元数据工具（批量列表 / 单行编辑 / 探测 / 源复用）', [134,135,136,137,138,139,142,143,144,145,146,147,148,149,150,151,152,153,158,159,160,161,182,183]],
  ['60-jobs.js',   '任务调度（JobRegistry / Poller / Renderers / 进度渲染）', [115,116,117,118,119,120,121,122,123,124,125,126,127,128,129,130,131,132,162,163,164,177,178,179]],
  ['70-report.js', '元数据报告模式',                               [165,167,168,169,170,171,172,173,184,185,186]],
  ['80-codec.js',  '编码器检测 / 诊断 / 日志导出',                  [8,9,10,11,12,13,64,65,192,193,194,195,196,197]],
  ['90-boot.js',   '启动初始化',                                    [191,198]],
];

const MODE = process.argv[2] || 'list';

if (MODE === 'list') {
  console.log(`内联脚本起始行: ${scriptStartLine}, 总行数: ${lines.length}`);
  console.log(`顶层语句块数: ${chunks.length}\n`);
  chunks.forEach((c, idx) => {
    const absStart = scriptStartLine + c.start;
    const absEnd = scriptStartLine + c.end;
    const first = text(c).split('\n').find(l => {
      const s = l.trim();
      return s && !s.startsWith('//') && !s.startsWith('/*') && !s.startsWith('*');
    }) || '';
    console.log(`#${String(idx).padStart(3)} L${String(absStart).padStart(4)}-${String(absEnd).padStart(4)} (${String(c.end - c.start + 1).padStart(3)}行)  ${first.trim().slice(0, 96)}`);
  });

} else if (MODE === 'verify') {
  const rebuilt = chunks.map(c => text(c)).join('\n');
  const norm = s => s.replace(/\s+$/gm, '').replace(/^\s+|\s+$/g, '');
  if (norm(rebuilt) === norm(jsBody)) {
    console.log('OK: 顶层块拼接结果与原脚本逐字符一致（无损）');
  } else {
    console.log('FAIL: 拼接结果与原文不一致');
    const a = norm(rebuilt).split('\n'), b = norm(jsBody).split('\n');
    console.log(`  rebuilt lines: ${a.length}, original lines: ${b.length}`);
    for (let k = 0; k < Math.max(a.length, b.length); k++) {
      if (a[k] !== b[k]) { console.log(`  首个差异 @ 行 ${k}:\n    rebuilt : ${JSON.stringify((a[k]||'').slice(0,120))}\n    original: ${JSON.stringify((b[k]||'').slice(0,120))}`); break; }
    }
  }

} else if (MODE === 'extract') {
  const norm = s => s.replace(/\s+$/gm, '').replace(/^\s+|\s+$/g, '');

  // 校验 1：块索引分区完整性（无遗漏、无重复）
  const assigned = MODULES.flatMap(m => m[2]);
  const all = [...Array(chunks.length).keys()];
  const missing = all.filter(k => !assigned.includes(k));
  const dup = assigned.filter((v, k) => assigned.indexOf(v) !== k);
  if (missing.length) { console.error('FAIL: 未分配的块索引:', missing); process.exit(1); }
  if (dup.length) { console.error('FAIL: 重复分配的块索引:', dup); process.exit(1); }

  // 校验 2：块区间必须是 [0, lines-1] 的连续无重叠覆盖
  let expect = 0;
  for (const c of chunks) {
    if (c.start !== expect) { console.error(`FAIL: 块区间不连续，期望 start=${expect}，实际 ${c.start}`); process.exit(1); }
    expect = c.end + 1;
  }
  if (expect !== lines.length) { console.error(`FAIL: 块覆盖不完整，覆盖 ${expect} 行 / 共 ${lines.length} 行`); process.exit(1); }

  // 校验 3：按块索引顺序拼回后与原脚本无损一致
  // 注意：模块按功能划分（core 含块 18 与 49，map 含块 14-17），故"按模块顺序拼接"≠原顺序，
  // 正确的不变式是"按块索引顺序拼接 = 原文"
  if (norm(chunks.map(c => text(c)).join('\n')) !== norm(jsBody)) {
    console.error('FAIL: 按块索引拼回结果与原脚本不一致');
    process.exit(1);
  }

  const outDir = path.join(ROOT, 'static/js');
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(path.join(ROOT, 'static/css'), { recursive: true });

  // 写 CSS
  const cssHeader = '/* ============================================================\n'
    + '   app.css — 360 Video Converter 全局样式\n'
    + '   由 static/index.html 的 <style> 块拆分而来\n'
    + '   ============================================================ */\n';
  fs.writeFileSync(path.join(ROOT, 'static/css/app.css'), cssHeader + cssBody.replace(/^\n+/, ''), 'utf8');

  // 写 JS 模块
  const scriptTags = [];
  const moduleChunkCount = {};
  for (const [file, desc, idxList] of MODULES) {
    const header = `// ============================================================\n`
      + `//   ${file} — ${desc}\n`
      + `//   由 static/index.html 内联脚本拆分而来（整块切分，零行为变更）\n`
      + `// ============================================================\n\n`;
    const body = idxList.slice().sort((a, b) => a - b).map(k => text(chunks[k])).join('\n\n');
    fs.writeFileSync(path.join(outDir, file), header + body + '\n', 'utf8');
    scriptTags.push(`<script src="/js/${file}"></script>`);
    moduleChunkCount[file] = idxList.length;
  }

  // 校验 4：写盘后逐模块重新解析，块的并集必须与原块集一致（端到端回环验证）
  let reparsedTotal = 0;
  const reparsedTexts = [];
  for (const [file] of MODULES) {
    const src = fs.readFileSync(path.join(outDir, file), 'utf8');
    const bodyOnly = src.split('\n').slice(5).join('\n');   // 去掉 5 行文件头注释
    const sub = parseTopLevel(bodyOnly);
    sub.chunks.forEach(c => reparsedTexts.push(norm(sub.text(c))));
    reparsedTotal += sub.chunks.length;
  }
  const originalSet = chunks.map(c => norm(text(c))).slice();
  const sortedA = reparsedTexts.slice().sort();
  const sortedB = originalSet.slice().sort();
  if (reparsedTotal !== chunks.length || JSON.stringify(sortedA) !== JSON.stringify(sortedB)) {
    console.error(`FAIL: 回环验证不通过（重解析块数 ${reparsedTotal} ≠ 原 ${chunks.length}）`);
    process.exit(1);
  }

  // 重写 index.html
  const newStyleTag = '<link rel="stylesheet" href="/css/app.css">';
  const newScriptTag = '<!-- 业务脚本（按依赖顺序加载，勿调整顺序） -->\n'
    + scriptTags.map(t => '  ' + t).join('\n');
  let out = html.replace(styleRe, newStyleTag).replace(scriptRe, newScriptTag);
  fs.writeFileSync(INDEX, out, 'utf8');

  console.log('EXTRACT OK — 4 项校验全部通过');
  console.log(`  css/app.css        ${cssBody.split('\n').length} 行`);
  for (const [file, , idxList] of MODULES) {
    const lc = fs.readFileSync(path.join(outDir, file), 'utf8').split('\n').length;
    console.log(`  js/${file.padEnd(14)} ${String(lc).padStart(5)} 行  (${idxList.length} 块)`);
  }
  console.log(`  index.html         ${out.split('\n').length} 行（原 ${html.split('\n').length} 行）`);
  console.log(`  回环验证: ${reparsedTotal} 块全部匹配`);
}

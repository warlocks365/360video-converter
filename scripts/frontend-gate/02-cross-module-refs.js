// 跨模块引用校验：静态检测"被调用但全项目未定义"的函数（捕捉提取遗漏/拼写错误）
// 附带：检测跨模块重复的顶层声明
const fs = require('fs');
const path = require('path');

const JS_DIR = path.resolve(__dirname, '../../static/js');
const files = fs.readdirSync(JS_DIR).filter(f => f.endsWith('.js')).sort();

// 已知宿主/语言全局，不计入"未定义"
const GLOBALS = new Set(`
document window fetch alert confirm prompt setTimeout setInterval clearTimeout clearInterval
console JSON Math Object Array String Number Boolean Date RegExp Error Promise Map Set WeakMap
WeakSet Symbol BigInt Proxy Reflect parseInt parseFloat isNaN isFinite encodeURIComponent
decodeURIComponent encodeURI decodeURI requestAnimationFrame cancelAnimationFrame localStorage
sessionStorage navigator location history screen performance crypto XMLHttpRequest WebSocket
EventSource indexedDB self top parent frames getComputedStyle matchMedia Image Audio FileReader
Blob File URL URLSearchParams FormData Headers Request Response AbortController AbortSignal
structuredClone queueMicrotask CustomEvent Event MutationObserver IntersectionObserver
Intl TextEncoder TextDecoder Uint8Array Int8Array Uint16Array Int16Array Uint32Array Int32Array
Float32Array Float64Array ArrayBuffer DataView atob btoa escape unescape Function eval
globalThis arguments require module exports process Buffer L
if for while switch catch return typeof function new delete void in of case do else
await async yield throw instanceof class extends super this
`.trim().split(/\s+/).filter(Boolean));

// 去字符串与注释，避免误匹配
function strip(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let st = null; // ' " `
  const tmpl = [];
  let depth = 0;
  let lastSig = '';
  const KW = new Set(['return','typeof','instanceof','in','of','new','delete','void','throw','case','do','else','yield','await','default']);
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (st === "'" || st === '"') {
      if (c === '\\') { i += 2; continue; }
      if (st === c) { st = null; out += ' '; }
      i++; continue;
    }
    if (st === '`') {
      if (c === '\\') { i += 2; continue; }
      if (c === '`') { st = null; out += ' '; i++; continue; }
      if (c === '$' && d === '{') { tmpl.push(depth); depth++; st = null; i += 2; continue; }
      i++; continue;
    }
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    if (c === '/') {
      // 正则 vs 除法
      if (!/[\w$)\]]/.test(lastSig)) {
        i++; let cls = false;
        while (i < n) { const x = src[i];
          if (x === '\\') { i += 2; continue; }
          if (x === '\n') break;
          if (x === '[') { cls = true; i++; continue; }
          if (x === ']') { cls = false; i++; continue; }
          if (x === '/' && !cls) { i++; break; }
          i++; }
        while (i < n && /[a-z]/i.test(src[i])) i++;
        out += ' '; lastSig = 'x'; continue;
      }
      out += '/'; lastSig = '/'; i++; continue;
    }
    if (c === "'" || c === '"' || c === '`') { st = c; i++; lastSig = 'x'; continue; }
    if (c === '{') { depth++; out += c; lastSig = c; i++; continue; }
    if (c === '}') { depth--; if (tmpl.length && depth === tmpl[tmpl.length - 1]) { tmpl.pop(); st = '`'; } out += c; lastSig = c; i++; continue; }
    out += c;
    if (!/\s/.test(c)) lastSig = c;
    i++;
  }
  return out;
}

const defined = new Map();   // name -> [{file, kind}]
const called = new Map();    // name -> [{file, line}]
const topDecls = [];

// 收集"所有层级的声明名"（顶层 + 嵌套函数 + const/let/var + 函数参数）
function collectLocalNames(code) {
  const names = new Set();
  let m;
  // 具名函数（任意层级）
  const reFn = /function\s+([A-Za-z_$][\w$]*)/g;
  while ((m = reFn.exec(code)) !== null) names.add(m[1]);
  // 变量声明（任意层级，含箭头函数赋值）
  const reVar = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g;
  while ((m = reVar.exec(code)) !== null) names.add(m[1]);
  // 函数参数（含解构前的标识符与默认值）
  const reParam = /(?:function\s*[A-Za-z_$]*\s*|\(|,\s*)([A-Za-z_$][\w$]*)\s*(?=[,)])/g;
  const reFnSig = /(?:async\s+)?function\s*[A-Za-z_$]*\s*\(([^)]*)\)/g;
  while ((m = reFnSig.exec(code)) !== null) {
    m[1].split(',').forEach(p => {
      const t = p.replace(/=.*$/, '').trim();
      if (/^[A-Za-z_$][\w$]*$/.test(t)) names.add(t);
    });
  }
  // 箭头函数单参数 / 多参数
  const reArrow = /(?:\(([^)]*)\)|([A-Za-z_$][\w$]*))\s*=>/g;
  while ((m = reArrow.exec(code)) !== null) {
    const ps = m[1] !== undefined ? m[1] : m[2];
    ps.split(',').forEach(p => {
      const t = p.replace(/=.*$/, '').trim();
      if (/^[A-Za-z_$][\w$]*$/.test(t)) names.add(t);
    });
  }
  // catch 参数
  const reCatch = /catch\s*\(\s*([A-Za-z_$][\w$]*)/g;
  while ((m = reCatch.exec(code)) !== null) names.add(m[1]);
  return names;
}

for (const f of files) {
  const raw = fs.readFileSync(path.join(JS_DIR, f), 'utf8');
  const lines = raw.split('\n');
  const code = strip(raw);

  // 顶层声明（用于跨模块重复检测）
  lines.forEach((ln, i) => {
    let m = ln.match(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/);
    if (m) { if (!defined.has(m[1])) defined.set(m[1], []); defined.get(m[1]).push({ file: f, kind: 'function' }); topDecls.push({ f, name: m[1], line: i + 1 }); return; }
    m = ln.match(/^(?:const|let|var)\s+([A-Za-z_$][\w$]*)/);
    if (m) { if (!defined.has(m[1])) defined.set(m[1], []); defined.get(m[1]).push({ file: f, kind: 'var' }); topDecls.push({ f, name: m[1], line: i + 1 }); }
  });

  // 本文件内所有层级的声明名 → 并入 defined（标记 local）
  collectLocalNames(code).forEach(n => {
    if (!defined.has(n)) defined.set(n, []);
    if (!defined.get(n).some(x => x.file === f && x.kind === 'local')) defined.get(n).push({ file: f, kind: 'local' });
  });

  // 调用点
  const src = code;
  const re = /(^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g;
  let mm;
  while ((mm = re.exec(src)) !== null) {
    const name = mm[2];
    const line = src.slice(0, mm.index).split('\n').length;
    if (!called.has(name)) called.set(name, []);
    called.get(name).push({ file: f, line: raw.split('\n')[line - 1] ? line : line });
  }
}

// 回调/形参白名单：引擎（45-filter.js renderFilterRowsHtml）以回调形参向消费方
// 注入渲染钩子，strip 后形参名形如"被调用"，属正当词法，不计未定义。
// （消费方调用处传的是具名函数/箭头函数，非全局引用。）
const CALLBACK_PARAMS = new Set(['kindOf', 'valueCtlFor', 'accessor', 'valueCollect']);

// 未定义的被调用者
const undef = [];
for (const [name, sites] of called) {
  if (defined.has(name) || GLOBALS.has(name) || CALLBACK_PARAMS.has(name)) continue;
  undef.push({ name, count: sites.length, files: [...new Set(sites.map(s => s.file))] });
}

// 跨模块重复的【顶层】声明（覆盖风险）—— 只看 function/var，忽略 local
const dupAcross = [...defined.entries()]
  .map(([n, arr]) => [n, arr.filter(a => a.kind !== 'local')])
  .filter(([, arr]) => new Set(arr.map(a => a.file)).size > 1);

// 模块内重复的【顶层】声明（同一文件内同名顶层声明两次 = 覆盖/重复定义）
const dupWithin = [...defined.entries()]
  .map(([n, arr]) => [n, arr.filter(a => a.kind !== 'local')])
  .filter(([, arr]) => arr.length > 1 && new Set(arr.map(a => a.file)).size === 1);

console.log(`模块数: ${files.length} | 顶层声明: ${topDecls.length} | 唯一名字: ${defined.size} | 调用点覆盖唯一名: ${called.size}\n`);

console.log(`【跨模块同名声明】${dupAcross.length ? dupAcross.length + ' 个（需人工确认是否覆盖）' : '无 OK'}`);
dupAcross.forEach(([n, arr]) => console.log(`  ${n}: ${arr.map(a => a.file + '(' + a.kind + ')').join(', ')}`));

const realDupWithin = dupWithin.filter(([n]) => !['_tries'].includes(n));
console.log(`\n【模块内重复声明】${realDupWithin.length ? realDupWithin.length + ' 个' : '无 OK'}`);
realDupWithin.forEach(([n, arr]) => console.log(`  ${n}: ${arr.map(a => a.file).join(', ')}`));

console.log(`\n【被调用但全项目未定义】${undef.length ? undef.length + ' 个  ← 需排查' : '无 OK'}`);
undef.sort((a, b) => b.count - a.count).forEach(u => console.log(`  ${u.name.padEnd(28)} ${String(u.count).padStart(3)} 次  @ ${u.files.join(', ')}`));

process.exit(undef.length ? 1 : 0);

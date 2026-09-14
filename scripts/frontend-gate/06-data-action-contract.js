// 门禁 06：data-action 契约校验
// 事件委托最大的失效模式是「action 名拼错」——语法检查不报错、点击无反应、静默失效。
// 本门禁双向校验：① 使用但未注册（=功能失效） ② 注册但未使用（=死代码）
const fs = require('fs');
const path = require('path');
const STATIC = path.resolve(__dirname, '../../static');

// ── 1. 从 00-core.js 提取已注册的 action 名 ──
const core = fs.readFileSync(path.join(STATIC, 'js/00-core.js'), 'utf8');
const tableMatch = core.match(/const DELEGATED_ACTIONS = \{([\s\S]*?)\n\};/);
if (!tableMatch) { console.error('FAIL: 未找到 DELEGATED_ACTIONS 定义'); process.exit(1); }
const registered = new Set(
  [...tableMatch[1].matchAll(/^\s*'([a-z0-9-]+)':/gm)].map(m => m[1])
);

// ── 2. 收集所有 data-action 使用点（HTML 静态 + JS 动态生成字符串）──
const used = new Map();   // action -> [{file, line}]
const scan = (file, label) => {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.forEach((ln, i) => {
    for (const m of ln.matchAll(/data-action="([^"]*)"/g)) {
      const a = m[1];
      if (!used.has(a)) used.set(a, []);
      used.get(a).push({ file: label, line: i + 1 });
    }
  });
};

scan(path.join(STATIC, 'index.html'), 'index.html');
const jsDir = path.join(STATIC, 'js');
fs.readdirSync(jsDir).filter(f => f.endsWith('.js')).sort()
  .forEach(f => { if (f !== '00-core.js') scan(path.join(jsDir, f), f); });

// ── 3. 双向校验 ──
const broken = [...used.entries()].filter(([a]) => !registered.has(a));
const unused = [...registered].filter(a => !used.has(a));

console.log(`已注册 action: ${registered.size} 个 | 实际使用: ${used.size} 个\n`);

console.log(`【使用但未注册】${broken.length ? broken.length + ' 个  ← 点击会静默失效！' : '无 OK'}`);
broken.forEach(([a, sites]) => {
  console.log(`  '${a}'  ${sites.length} 处`);
  sites.slice(0, 5).forEach(s => console.log(`      ${s.file}:${s.line}`));
});

console.log(`\n【注册但未使用】${unused.length ? unused.length + ' 个  ← 死动作，建议清理' : '无 OK'}`);
if (unused.length) console.log('  ' + unused.join(', '));

// ── 4. 残留内联事件统计（迁移进度指标，不作为失败条件）──
let inlineCount = 0;
const inlineByFile = {};
for (const [file, label] of [[path.join(STATIC, 'index.html'), 'index.html'],
  ...fs.readdirSync(jsDir).filter(f => f.endsWith('.js')).map(f => [path.join(jsDir, f), f])]) {
  const src = fs.readFileSync(file, 'utf8');
  const n = (src.match(/\son(click|change|keydown|input)=/g) || []).length;
  if (n) { inlineByFile[label] = n; inlineCount += n; }
}
console.log(`\n【残留内联事件】合计 ${inlineCount} 处（改造前 148 处）`);
Object.entries(inlineByFile).sort((a, b) => b[1] - a[1]).forEach(([f, n]) => console.log(`  ${f.padEnd(16)} ${n}`));

process.exit(broken.length ? 1 : 0);

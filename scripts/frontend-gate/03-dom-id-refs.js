// 校验：JS 中通过 getElementById 引用的 id 是否都存在于 HTML（含动态拼接的静态前缀）
const fs = require('fs');
const path = require('path');
const R = path.resolve(__dirname, '../../static');

const html = fs.readFileSync(R + '/index.html', 'utf8');
const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));

// 动态创建的 id（运行期生成，不在 HTML 中）
const RUNTIME_IDS = new Set(['toastNotification']);

const jsFiles = fs.readdirSync(R + '/js').filter(f => f.endsWith('.js')).sort();
const refs = new Map();   // id -> [{file, line}]
const dynamic = [];       // 模板字符串拼出来的引用

for (const f of jsFiles) {
  const lines = fs.readFileSync(path.join(R, 'js', f), 'utf8').split('\n');
  lines.forEach((ln, i) => {
    // 跳过注释行（注释中常出现 getElementById('x') 之类的示例文本，避免误报）
    const t = ln.trim();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
    // 静态字面量：getElementById('x')
    for (const m of ln.matchAll(/getElementById\(\s*'([^']+)'\s*\)/g)) {
      if (!refs.has(m[1])) refs.set(m[1], []);
      refs.get(m[1]).push({ file: f, line: i + 1 });
    }
    // 动态拼接：getElementById(prefix + 'X')
    for (const m of ln.matchAll(/getElementById\([^')]*\+\s*'([^']+)'\s*\)/g)) {
      dynamic.push({ file: f, line: i + 1, suffix: m[1], src: ln.trim().slice(0, 110) });
    }
  });
}

const missing = [...refs.entries()].filter(([id]) => !htmlIds.has(id) && !RUNTIME_IDS.has(id));

console.log(`HTML 中的 id: ${htmlIds.size} 个`);
console.log(`JS 静态引用的唯一 id: ${refs.size} 个`);
console.log('');
console.log(`【引用但 HTML 中不存在的 id】${missing.length ? missing.length + ' 个  ← 必须排查' : '无 OK'}`);
missing.sort((a, b) => b[1].length - a[1].length).forEach(([id, sites]) => {
  console.log(`  ${id.padEnd(30)} ${sites.length} 处  @ ${[...new Set(sites.map(s => s.file))].join(', ')}`);
  sites.slice(0, 4).forEach(s => console.log(`      ${s.file}:${s.line}`));
});

if (dynamic.length) {
  console.log(`\n【动态拼接引用（需人工确认前缀组合）】${dynamic.length} 处`);
  dynamic.forEach(d => console.log(`  ${d.file}:${d.line}  suffix='${d.suffix}'  ← ${d.src}`));
}

process.exit(missing.length ? 1 : 0);

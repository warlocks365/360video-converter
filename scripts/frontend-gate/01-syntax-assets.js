// 前端模块语法校验：用 Node vm 按"经典脚本"语义编译每个模块（等价浏览器解析）
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const R = path.resolve(__dirname, '../..');
const jsDir = path.join(R, 'static/js');
const files = fs.readdirSync(jsDir).filter(f => f.endsWith('.js')).sort();

let fail = 0;
for (const f of files) {
  const code = fs.readFileSync(path.join(jsDir, f), 'utf8');
  try {
    new vm.Script(code, { filename: f });
    console.log(`OK   ${f.padEnd(14)} ${String(code.split('\n').length).padStart(5)} 行`);
  } catch (e) {
    fail++;
    console.log(`FAIL ${f.padEnd(14)} ${e.message}`);
  }
}

// CSS 大括号配平检查
const css = fs.readFileSync(path.join(R, 'static/css/app.css'), 'utf8');
const open = (css.match(/\{/g) || []).length;
const close = (css.match(/\}/g) || []).length;
console.log(`\nCSS 大括号: { ${open} } ${close} → ${open === close ? 'OK 配平' : 'FAIL 不配平'}`);

// index.html 引用完整性
const html = fs.readFileSync(path.join(R, 'static/index.html'), 'utf8');
const refs = [...html.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map(m => m[1]);
console.log('\nindex.html 资源引用:');
for (const r of refs) {
  const p = path.join(R, 'static', r.replace(/^\//, ''));
  console.log(`  ${fs.existsSync(p) ? 'OK  ' : 'MISS'} ${r}`);
}
const inlineScript = /<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/.test(html);
const inlineStyle = /<style[^>]*>[\s\S]*?<\/style>/.test(html);
console.log(`\n残留内联 <script>: ${inlineScript ? 'YES (异常)' : 'NO (OK)'}`);
console.log(`残留内联 <style>:  ${inlineStyle ? 'YES (异常)' : 'NO (OK)'}`);

process.exit(fail ? 1 : 0);

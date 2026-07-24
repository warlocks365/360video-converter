#!/bin/bash
# 360video-converter 前端 JS/HTML 代码扫描
# 用法: bash scripts/scan_js.sh
set -e

HTML="static/index.html"
cd "$(dirname "$0")/.."

echo "=========================================="
echo "  前端 JS/HTML 代码扫描 — $HTML"
echo "=========================================="
echo ""

# [1] JS 语法检查
echo "--- [1] JS 语法检查 ---"
node -e "
const fs = require('fs');
const html = fs.readFileSync('$HTML', 'utf8');
const scripts = [];
const regex = /<script[^>]*>([\s\S]*?)<\/script>/gi;
let m;
while ((m = regex.exec(html)) !== null) scripts.push(m[1]);
let ok = true;
scripts.forEach((src, i) => {
  try { new Function(src); }
  catch(e) { console.log('  Script ' + i + ' ERROR: ' + e.message); ok = false; }
});
console.log(ok ? '  语法正确（' + scripts.length + ' 个 script 块）' : '  有语法错误！');
"
echo ""

# [2] innerHTML 赋值统计
echo "--- [2] innerHTML 赋值统计 ---"
COUNT=$(grep -c "innerHTML" "$HTML" || echo 0)
echo "  共 $COUNT 处 innerHTML 引用"
echo ""

# [3] 未转义的模板字符串（潜在 XSS）
echo "--- [3] 未转义的模板字符串 in innerHTML (潜在 XSS) ---"
echo "  （以下行含 innerHTML + \${} 但不含 escapeHtml/esc）"
grep -n "innerHTML.*\${" "$HTML" | grep -v "escapeHtml\|esc(" | head -20 || echo "  无（合格）"
echo ""

# [4] eval 使用
echo "--- [4] eval 使用 (禁止) ---"
grep -n "eval(" "$HTML" && echo "  >>> 发现 eval！" || echo "  无（合格）"
echo ""

# [5] CSS 变量一致性
echo "--- [5] CSS 变量一致性 ---"
echo "  JS 中引用的 CSS 变量:"
grep -oP "var\(--[a-z-]+" "$HTML" | sort -u | sed 's/^/    /'
echo "  CSS 中定义的变量:"
grep -oP "^\s*--[a-z-]+:" "$HTML" | sort -u | sed 's/^/    /' | head -20
echo ""

# [6] 重复函数定义
echo "--- [6] 重复函数定义 ---"
DUPS=$(grep -oP "function \w+" "$HTML" | sort | uniq -d)
if [ -z "$DUPS" ]; then
  echo "  无（合格）"
else
  echo "$DUPS" | sed 's/^/    /'
fi
echo ""

# [7] 重复的转义函数
echo "--- [7] 重复的转义函数检查 ---"
ESC_COUNT=$(grep -c "function esc\|function escapeHtml\|function escapeStr" "$HTML" || echo 0)
if [ "$ESC_COUNT" -gt 1 ]; then
  grep -n "function esc\|function escapeHtml\|function escapeStr" "$HTML"
  echo "  >>> 发现 $ESC_COUNT 个转义函数，应合并为一个"
else
  echo "  无重复（合格）"
fi
echo ""

# [8] 函数总数
echo "--- [8] 函数总数 ---"
FUNC_COUNT=$(grep -cP "(async\s+)?function\s+\w+\s*\(" "$HTML" || echo 0)
echo "  共 $FUNC_COUNT 个函数"
echo ""

# [9] TODO/FIXME
echo "--- [9] TODO/FIXME ---"
grep -n "TODO\|FIXME\|HACK\|XXX" "$HTML" || echo "  无"
echo ""

echo "=========================================="
echo "  扫描完成"
echo "=========================================="

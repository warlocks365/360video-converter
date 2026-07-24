#!/bin/bash
# 360video-converter Python 后端代码扫描
# 用法: bash scripts/scan_python.sh [文件名]
# 默认扫描 app.py
set -e

APP="${1:-app.py}"
cd "$(dirname "$0")/.."

echo "=========================================="
echo "  Python 代码扫描 — $APP"
echo "=========================================="
echo ""

# [1] 裸 except:
echo "--- [1] 裸 except: (禁止) ---"
COUNT=$(grep -c "except:" "$APP" 2>/dev/null || echo 0)
if [ "$COUNT" -gt 0 ]; then
  grep -n "except:" "$APP"
  echo "  >>> 发现 $COUNT 处，必须修复"
else
  echo "  无（合格）"
fi
echo ""

# [2] except Exception: pass
echo "--- [2] except Exception: pass (静默吞异常) ---"
COUNT=$(grep -c "except Exception: pass" "$APP" 2>/dev/null || echo 0)
if [ "$COUNT" -gt 0 ]; then
  grep -n "except Exception: pass" "$APP"
  echo "  >>> 共 $COUNT 处，需逐个确认是否为清理操作"
else
  echo "  无（合格）"
fi
echo ""

# [3] 锁嵌套检查
echo "--- [3] 锁嵌套检查 ---"
python -c "
import re
with open('$APP') as f:
    lines = f.readlines()
func_name = ''
lock_stack = []
issues = 0
for i, line in enumerate(lines, 1):
    m = re.match(r'^(def |async def )(\w+)', line)
    if m:
        func_name = m.group(2)
        lock_stack = []
    stripped = line.strip()
    if 'with job_lock' in stripped and not stripped.startswith('#'):
        lock_stack.append(i)
        if len(lock_stack) > 1:
            print(f'  L{i}: 嵌套 with job_lock (depth={len(lock_stack)}) in {func_name}()')
            issues += 1
    # 简化的作用域结束检测：连续2个空行或新函数定义
    if line.strip() == '' and i > 0 and lines[i-2].strip() == '' if i >= 2 else False:
        lock_stack = []
if issues == 0:
    print('  未检测到嵌套锁（合格）')
"
echo ""

# [4] global 变量
echo "--- [4] global 变量 ---"
grep -n "^\s*global " "$APP" || echo "  无"
echo ""

# [5] shell=True (注入风险)
echo "--- [5] shell=True (注入风险) ---"
grep -n "shell=True" "$APP" && echo "  >>> 发现注入风险！" || echo "  无（合格）"
echo ""

# [6] 语法检查
echo "--- [6] 语法检查 ---"
python -m py_compile "$APP" && echo "  语法正确" || echo "  语法错误！"
echo ""

# [7] 过期注释检查
echo "--- [7] 过期注释检查 ---"
COUNT=$(grep -c "non-reentrant" "$APP" 2>/dev/null || echo 0)
if [ "$COUNT" -gt 0 ]; then
  grep -n "non-reentrant" "$APP"
  echo "  >>> 注释称 'non-reentrant' 但实际使用 RLock，需更新注释"
else
  echo "  无（合格）"
fi
echo ""

# [8] TODO/FIXME
echo "--- [8] TODO/FIXME ---"
grep -n "TODO\|FIXME\|HACK\|XXX" "$APP" || echo "  无"
echo ""

echo "=========================================="
echo "  扫描完成"
echo "=========================================="

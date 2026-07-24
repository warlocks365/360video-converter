# 360video-converter 代码审查标准与流程

> 制定日期：2026-07-24
> 适用版本：v3.7.2+
> 审查专家：代码审查专家

---

## 一、项目代码概况

| 维度 | 数据 | 风险等级 |
|------|------|----------|
| 后端 `app.py` | 4474 行，单文件 Flask | 高（单文件过大） |
| 前端 `index.html` | 5445 行，142 个函数，无框架 | 高（维护困难） |
| `except Exception: pass` | 22 处静默吞异常 | 中高 |
| `innerHTML` 赋值 | 89 处 | 中（XSS + 性能） |
| `global` 变量 | 6 处 | 中（状态管理） |
| `subprocess` 调用 | 16 处（均为 list 形式，无 shell 注入） | 低 |
| HTML 转义函数 | 2 个重复（`esc()` + `escapeHtml()`） | 中（不一致） |
| 并发锁 | 1 个 `RLock`，注释仍称 "non-reentrant Lock" | 中（误导性注释） |

---

## 二、审查流程

### 2.1 何时需要审查

| 场景 | 审查级别 | 要求 |
|------|----------|------|
| 修复 BUG | L1 基础审查 | 提交前自查清单 |
| 新增功能 | L2 标准审查 | 自查 + 逐行审查变更文件 |
| 重构/架构调整 | L3 深度审查 | 标准审查 + 模式扫描 + 并发分析 |
| 发布前 | L4 发布审查 | 深度审查 + 全量模式扫描 + 构建验证 |

### 2.2 审查步骤

```
1. 理解变更意图 ──→ 读 PR/commit message，明确改了什么、为什么改
2. 语法验证     ──→ Python: python -m py_compile；JS: node 语法检查
3. 逐行审查     ──→ 按"三、审查清单"逐项检查
4. 模式扫描     ──→ 运行"四、自动化扫描脚本"
5. 构建验证     ──→ PyInstaller 打包 + EXE 内容校验
6. 记录结论     ──→ 填写"六、审查报告模板"
```

### 2.3 审查原则

- **拦截优于事后修复**：在提交前发现问题，成本最低
- **对事不对人**：审查的是代码，不是写代码的人
- **给可执行的建议**：不写"这里有问题"，写"L1430 的嵌套 `with job_lock:` 应删除内层锁，因为 RLock 虽不致命但逻辑冗余"
- **验证修复**：提出问题后，确认修复确实解决了问题，没有引入新问题

---

## 三、审查清单

### 3.1 严重级别（必须修复，阻塞发布）

#### C-01: 并发/线程安全

| 检查项 | 检查方法 | 本项目已知问题 |
|--------|----------|----------------|
| 锁嵌套获取 | 搜索 `with job_lock` 是否在另一个 `with job_lock` 内部 | L1430-1435 仍有嵌套（RLock 不致死但逻辑错误） |
| 锁内调用会获锁的函数 | 检查 `with job_lock:` 块内是否调用 `log_line()` 等内部获锁函数 | 注释 L3950/L4176 仍称 "non-reentrant Lock"，实际已改为 RLock |
| 全局可变状态竞态 | 检查 `global` 变量的读写是否都在锁保护下 | 6 处 global：`_HTTPS_SSL_CONTEXT`、`_encoder_ffmpeg_map` 等 |
| subprocess 管道死锁 | `stdin=PIPE` + `stderr=PIPE` 时是否在独立线程排空 stderr | L1197 Popen 只读 stderr，无 stdin 写入，当前安全 |

**审查要点**：
```python
# 危险模式：嵌套锁
with job_lock:           # 第一次获取
    with job_lock:       # 第二次获取 — 即使 RLock 不死锁，也说明逻辑有问题
        ...

# 正确模式：合并到一个锁作用域
with job_lock:
    j = jobs.get(jid)
    # 所有需要锁保护的操作放在一起
    ...

# 危险模式：锁内调用会获锁的函数
with job_lock:
    log_line(jid, "...")  # log_line 内部会 with job_lock → 嵌套

# 正确模式：锁外调用
with job_lock:
    j = jobs.get(jid)
    if j:
        j['status'] = 'done'
# 锁释放后再调用
log_line(jid, "完成")
```

#### C-02: 异常处理

| 检查项 | 检查方法 | 标准 |
|--------|----------|------|
| 裸 `except:` | `grep -n "except:" app.py` | 禁止，必须 `except Exception:` |
| 静默吞异常 `except Exception: pass` | 逐个审查 22 处 | 清理操作（proc.kill/wait/os.remove）可接受但需注释说明；业务逻辑异常禁止吞掉 |
| 过宽异常捕获 | 检查 `except Exception` 是否应改为具名异常 | 能确定具体异常类型的应使用具名类型（FileNotFoundError, ValueError 等） |
| 异常后状态不一致 | 检查 except 块后是否清理了中间状态 | 如：部分写入的文件、半初始化的对象 |

**`except Exception: pass` 分类标准**：
```
✅ 可接受（清理操作，失败无影响）：
   try: proc.kill()
   except Exception: pass

✅ 可接受（资源释放）：
   try: os.remove(temp_file)
   except Exception: pass

❌ 不可接受（吞掉业务错误）：
   try:
       data = json.loads(response)
       important_value = data['key']
   except Exception: pass    # ← 吞掉了 JSON 解析错误或 KeyError

❌ 不可接受（静默失败）：
   try:
       result = do_critical_operation()
   except Exception: pass    # ← 调用者不知道失败了
```

#### C-03: HTML 注入 / XSS

| 检查项 | 检查方法 | 本项目已知问题 |
|--------|----------|----------------|
| innerHTML 拼接用户输入 | 搜索所有 `innerHTML` 赋值，检查是否有未转义的用户数据 | L3415 `${f.name}` 未转义；L3931 正确使用 `escapeHtml()` |
| 转义函数一致性 | 检查使用 `esc()` 还是 `escapeHtml()`（两者功能完全相同） | 应统一为一个，删除重复 |
| 事件处理器注入 | 检查 onclick 等属性是否拼接用户数据 | 需逐个检查 |

**规则**：所有通过 `innerHTML` 插入的用户可控数据（文件名、路径、API 返回值）必须经过 `escapeHtml()` 转义。

### 3.2 警告级别（应当修复，可在下一版本解决）

#### W-01: 代码重复

| 检查项 | 说明 |
|--------|------|
| 重复的转义函数 | `esc()` (L3787) 和 `escapeHtml()` (L3795) 功能完全相同，应合并 |
| 重复的批量列表渲染逻辑 | 转换工具和元数据工具各有 `renderBatchTable()` / `renderMetaBatchTable()`，结构几乎相同 |
| 重复的文件浏览逻辑 | `openFileBrowser()` 被多处调用，但参数和回调方式不统一 |

#### W-02: 过期注释

| 检查项 | 本项目已知问题 |
|--------|----------------|
| 注释描述与代码不符 | L3950/L4176 注释称 `job_lock` 是 "non-reentrant threading.Lock"，实际已是 `RLock` |
| TODO/FIXME 未跟踪 | 搜索所有 TODO/FIXME 注释，确认是否需要处理 |

**规则**：修改代码时必须同步更新相关注释。注释中不应包含可能过期的实现细节（如锁的具体类型），应描述意图（如"此处不能在锁内调用 log_line，因为会引起重入"）。

#### W-03: 单文件过大

| 文件 | 行数 | 建议 |
|------|------|------|
| `app.py` | 4474 | 按功能拆分：`routes_convert.py`、`routes_metadata.py`、`routes_merge.py`、`ffmpeg_helpers.py`、`native_dialog.py` |
| `index.html` | 5445 | 将 JS 提取为独立 `.js` 文件，按功能分：`convert.js`、`metadata.js`、`merge.js`、`map.js`、`common.js` |

> 短期不强制拆分，但新功能不应继续往大文件里加。新增功能优先考虑独立文件。

#### W-04: DOM 操作性能

| 检查项 | 本项目已知问题 |
|--------|----------------|
| 全量 `innerHTML` 重建 | 89 处 innerHTML 赋值，部分在轮询循环中（500ms），应改为增量更新 |
| 日志全量重建 | pollStatus 中日志区域应使用 `DocumentFragment` + `lastLogCount` 增量追加 |

### 3.3 建议级别（优化项，不阻塞）

#### S-01: 命名一致性
- 函数命名：`selectAllMetaFiles` vs `selectAllFiles` — 统一前缀/后缀规则
- CSS 变量：确保 JS 引用的变量名与 CSS 定义一致（历史 BUG：`--error` vs `--danger`）

#### S-02: 魔法数字
- 超时值（30, 5, 60）、缓冲区大小、轮询间隔等应提取为命名常量

#### S-03: 类型提示
- `app.py` 函数缺少类型提示，建议逐步添加 `def func(x: str) -> dict:`

#### S-04: 测试覆盖
- 当前 5 个测试文件共 644 行，主要测编码器和 API 基础功能
- 缺少：并发场景测试、错误路径测试、元数据写入验证测试

---

## 四、自动化扫描脚本

### 4.1 Python 后端扫描

```bash
#!/bin/bash
# 保存为 scripts/code_scan.sh，每次提交前运行
# 用法: bash scripts/code_scan.sh

APP=app.py
echo "=== Python 代码扫描 ==="

echo "--- [1] 裸 except: ---"
grep -n "except:" $APP || echo "  无（合格）"

echo "--- [2] except Exception: pass (静默吞异常) ---"
grep -n "except Exception: pass" $APP | while read line; do
  echo "  $line"
done
echo "  共 $(grep -c "except Exception: pass" $APP) 处"

echo "--- [3] 锁嵌套检查 ---"
# 查找同一函数内多次 with job_lock
python -c "
import re, sys
with open('$APP') as f:
    lines = f.readlines()
in_func = ''
lock_depth = 0
for i, line in enumerate(lines, 1):
    if re.match(r'^def |^async def ', line):
        in_func = line.strip().split('(')[0]
        lock_depth = 0
    if 'with job_lock' in line and not line.strip().startswith('#'):
        lock_depth += 1
        if lock_depth > 1:
            print(f'  L{i}: 嵌套 with job_lock in {in_func}')
    # 简化：函数结束时不重置（保守估计）
"

echo "--- [4] global 变量 ---"
grep -n "^\s*global " $APP

echo "--- [5] shell=True (注入风险) ---"
grep -n "shell=True" $APP || echo "  无（合格）"

echo "--- [6] 语法检查 ---"
python -m py_compile $APP && echo "  语法正确" || echo "  语法错误！"

echo "--- [7] 过期注释检查 ---"
grep -n "non-reentrant" $APP || echo "  无（合格）"
```

### 4.2 前端 JS 扫描

```bash
#!/bin/bash
# 用法: bash scripts/js_scan.sh

HTML=static/index.html
echo "=== 前端 JS 扫描 ==="

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
console.log(ok ? '  语法正确' : '  有语法错误！');
"

echo "--- [2] innerHTML 赋值统计 ---"
grep -c "innerHTML" $HTML
echo "  处（需逐个检查是否拼接了未转义的用户数据）"

echo "--- [3] 未转义的模板字符串（潜在 XSS）---"
# 查找 ${...} 中不含 escapeHtml/esc 的 innerHTML 赋值行
grep -n "innerHTML.*\${" $HTML | grep -v "escapeHtml\|esc(" | head -20

echo "--- [4] eval 使用 ---"
grep -n "eval(" $HTML || echo "  无（合格）"

echo "--- [5] CSS 变量一致性 ---"
echo "  JS 引用的 CSS 变量:"
grep -oP "var\(--[a-z-]+" $HTML | sort -u
echo "  CSS 定义的变量:"
grep -oP "--[a-z-]+:" $HTML | sort -u | head -20

echo "--- [6] 重复函数定义 ---"
grep -oP "function \w+" $HTML | sort | uniq -d
```

### 4.3 EXE 内容验证

```python
# 用法: python scripts/verify_exe.py
# 确保打包后的 EXE 包含最新代码
import PyInstaller.archive.readers as readers
import sys

exe_path = 'dist/360VideoConverter.exe'
arch = readers.CArchiveReader(exe_path)
data = arch.extract('static\\index.html')

checks = [
    (b'NEW_FUNCTION_NAME', '新函数已包含'),
    (b'OLD_DEPRECATED_FUNC', None),  # None = 不应存在
]

for pattern, desc in checks:
    if desc is None:
        if pattern in data:
            print(f'FAIL: {pattern.decode()} 应已移除但仍在 EXE 中')
        else:
            print(f'OK: {pattern.decode()} 已移除')
    else:
        if pattern in data:
            print(f'OK: {desc}')
        else:
            print(f'FAIL: {desc} — EXE 中未找到')
```

---

## 五、本项目高频 BUG 模式（历史教训库）

以下模式均来自实际发生的 BUG，审查时必须重点检查。

| ID | 模式 | 历史案例 | 审查方法 |
|----|------|----------|----------|
| H-01 | 锁嵌套获取 | BUG-S01: `threading.Lock` 嵌套 → 死锁 | 搜索嵌套 `with job_lock` |
| H-02 | 裸 except 捕获 SystemExit | v3.6.2 审查发现 15+ 处 `except:` | `grep "except:" app.py` |
| H-03 | CSS 变量名不一致 | `--error` 定义但 JS 引用 `--danger` | 对比 CSS 定义与 JS 引用 |
| H-04 | COM 内存泄漏 | `SHGetKnownFolderPath` 未调 `CoTaskMemFree` | 检查所有 ctypes 调用 |
| H-05 | async 时序覆写共享状态 | `reverseGeocode()` 覆写 `mapSelectedLocation` | async 函数中检查共享状态的读写时序 |
| H-06 | click handler 直接调 async | `mapInstance.on('click')` → `reverseGeocode()` | UI 事件 handler 中 async 调用前必须同步设置状态 |
| H-07 | MP4 location 元数据层级错误 | `-metadata:s:v:0` → ffmpeg 静默丢弃 | 验证 ffmpeg 命令参数是否与目标格式兼容 |
| H-08 | CDN 依赖在 WebView2 静默失败 | Leaflet CDN 加载失败无错误日志 | 桌面应用不应依赖外部 CDN |
| H-09 | PyInstaller 临时文件提取失败 | certifi `where()` 在 frozen 模式失效 | 验证 frozen 模式下的资源定位 |
| H-10 | subprocess 管道死锁 | `stdin=PIPE` + `stderr=PIPE` 无排空 | 检查 PIPE 组合是否有独立排空线程 |
| H-11 | NVENC preset 映射缺失 | 崩溃回退 libx265 时 preset `p4` 无效 | 硬件编码回退时检查参数映射 |
| H-12 | SRI integrity hash 不匹配 | CDN script 的 hash 错误 → 静默拒绝加载 | 本地化资源则无此问题 |
| H-13 | 函数属性未初始化比较 | `func._tries` 首次为 `undefined`，比较跳过 | 检查 `func._xxx` 模式的初始化 |
| H-14 | jobs 字典内存泄漏 | 完成的任务不清理，800 条日志堆积 | 检查长时间运行服务的内存清理策略 |

---

## 六、审查报告模板

```markdown
# 代码审查报告 vX.X.X

> 审查日期：YYYY-MM-DD
> 审查范围：[文件列表]
> 审查人：[姓名/AI]

## 变更摘要
[1-2 句话描述本次变更的目的和内容]

## 审查结论
- [ ] 通过，可合并
- [ ] 需修改后重新审查
- [ ] 不通过

## 发现的问题

### [严重程度] [问题标题]
- **文件**: `文件名`
- **行号**: LXXX
- **类别**: 并发/异常/XSS/性能/...
- **描述**: [问题描述]
- **建议**: [具体修复建议]
- **状态**: [ ] 已修复  [ ] 待修复

## 模式扫描结果
[粘贴扫描脚本输出摘要]

## 构建验证
- [ ] PyInstaller 打包成功
- [ ] EXE 内容验证通过
- [ ] Inno Setup 安装包生成成功
```

---

## 七、审查频率与责任

| 角色 | 职责 |
|------|------|
| 开发者（自查） | 每次提交前运行 L1 基础审查（语法检查 + 自查清单） |
| AI 审查助手 | 每次功能开发完成后执行 L2 标准审查（逐行 + 模式扫描） |
| 发布前审查 | 每个版本发布前执行 L4 发布审查（全量扫描 + 构建验证） |

### 自查清单（L1 — 每次提交前）

```
[ ] Python 语法检查通过（python -m py_compile）
[ ] JS 语法检查通过（node -e "new Function(...)"）
[ ] 无裸 except:（grep "except:" app.py）
[ ] 无新增 except Exception: pass（除非是清理操作）
[ ] innerHTML 拼接的数据已转义
[ ] 无新增 global 变量（除非有充分理由）
[ ] 锁使用无嵌套
[ ] 注释与代码一致（修改代码时同步更新注释）
[ ] EXE 打包后验证包含最新代码
```

---

## 八、版本号与审查的关系

参照项目版本号规则：
- **BUG 修复**（末尾 +1，如 3.7.2 → 3.7.3）：至少 L1 审查
- **功能改进**（中间 +1，如 3.7.2 → 3.8.0）：至少 L2 审查
- **重大新功能**（大版本 +1，如 3.7.2 → 4.0.0）：L3 深度审查 + 全量回归测试

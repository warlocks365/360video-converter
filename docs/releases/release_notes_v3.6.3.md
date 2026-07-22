# v3.6.3 BUG 修复版本

## 概述

基于 v3.6.2 代码全面审查，修复 3 个严重级别、8 个中等级别和 6 个轻微级别共 17 个 BUG。

## 严重级别修复（3 个）

### BUG-S01: threading.Lock 嵌套死锁
- **文件**：`app.py` L540
- **根因**：`job_lock` 使用 `threading.Lock()`（不可重入锁），在嵌套获取时导致确定性死锁
- **修复**：改为 `threading.RLock()`（可重入锁），允许同一线程多次获取

### BUG-S02: COM 内存泄漏
- **文件**：`app.py` L2654
- **根因**：`SHGetKnownFolderPath` 返回的 COM 分配字符串未释放，每次调用都泄漏内存
- **修复**：在获取字符串拷贝后调用 `ctypes.windll.ole32.CoTaskMemFree(pp)` 释放 COM 内存

### BUG-S03: CSS 变量名不一致导致错误提示无背景色
- **文件**：`static/index.html` L3296/4432/4440
- **根因**：CSS 定义 `--error` 变量，但 JS 引用 `--danger`，导致所有错误提示 toast 透明无背景色
- **修复**：统一为 `var(--error)`

## 中等级别修复（8 个）

### BUG-M01: bare except 捕获 SystemExit/KeyboardInterrupt
- **文件**：`app.py`（15+ 处）、`sysmon.py`
- **修复**：所有 `except:` 统一改为 `except Exception:`

### BUG-M02: stabilize.py 子进程管道阻塞死锁
- **文件**：`stabilize.py` L430-496
- **根因**：`proc.communicate(timeout=120)` 在 stderr 管道缓冲区满时会阻塞
- **修复**：使用独立线程排空 stderr，主线程用 `proc.wait(timeout=120)` 等待

### BUG-M03: app.py 进程终止无超时
- **文件**：`app.py` L1204/1247
- **修复**：`proc.wait()` 添加 timeout 参数（5s/10s），超时后强制 kill

### BUG-M04: inject_spherical_metadata.py 大文件内存占用
- **文件**：`inject_spherical_metadata.py` L201-279
- **根因**：`bytearray(f.read())` 将整个文件读入内存
- **修复**：改用 `mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_COPY)` 写时复制映射

### BUG-M05: sysmon.py shutdown 竞态条件
- **文件**：`sysmon.py` L42-47
- **修复**：`shutdown_global_sysmon()` 添加 `_global_lock` 保护

### BUG-M06: esc() 函数引号转义不完整
- **文件**：`static/index.html` L3697
- **根因**：`esc()` 未转义双引号和单引号，可能导致属性注入
- **修复**：添加 `"` → `&quot;` 和 `'` → `&#39;` 转义

### BUG-M07: stabilize.py stdin 写入管道死锁
- **文件**：`stabilize.py`
- **根因**：向 `proc.stdin` 写入时 stderr 未排空，管道缓冲区满后阻塞
- **修复**：通过 BUG-M02 的 stderr 排空线程 + `proc.wait(timeout=120)` 保护

### BUG-M08: logBox 每 500ms 全量 DOM 重建
- **文件**：`static/index.html` L3569
- **根因**：每次轮询都用 `innerHTML` 重建最后 100 条日志，造成不必要的 DOM 操作
- **修复**：改为增量追加模式 — 使用 `lastLogCount` 跟踪已渲染条数，仅通过 `DocumentFragment` 追加新条目；超过 100 条时移除最旧的

## 轻微级别修复（6 个）

### BUG-L01/L02: sysmon.py bare except 已修复
- 随 BUG-M01 修复一并处理

### BUG-L03: wmic 命令在 Win11 弃用
- **文件**：`sysmon.py` L151
- **修复**：`wmic path win32_VideoController get Name` → PowerShell `Get-CimInstance Win32_VideoController`

### BUG-L07/L08: 页面卸载时定时器未清理
- **文件**：`static/index.html`
- **修复**：添加 `beforeunload` 事件监听器，清理 `pollTimer`、`sysmonTimer` 和 `toast._timer`

### BUG-L09: jobs 字典永不清理
- **文件**：`app.py`
- **修复**：新增 `cleanup_old_jobs()` 函数，在状态轮询时定期（每 60 秒）清理已完成超过 1 小时的任务数据

## 未修复项（3 个，极低风险）

| # | 说明 | 风险评估 |
|---|------|---------|
| L04 | inject_spherical_metadata.py 正则解析 XML | 格式固定，实际风险极低 |
| L05 | stabilize.py 两次 VideoCapture 打开同一文件 | 极端情况帧数不一致，概率极低 |
| L06 | build_exe.py 硬编码构建机器路径 | 仅影响构建环境，不影响运行时 |

## 测试验证

- 4 个 Python 模块语法检查全部通过
- 2 个 HTML script 块 JS 语法检查通过
- 25 项 BUG 修复验证测试全部通过
- Flask 应用启动冒烟测试通过

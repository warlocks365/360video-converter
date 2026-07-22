# 360video-converter v3.6.2 全面代码审查报告

> 审查日期：2026-07-22
> 审查范围：app.py (4437行), static/index.html (5176行), sysmon.py (378行), inject_spherical_metadata.py (380行), stabilize.py (496行), build_exe.py (366行)
> 审查方法：全代码逐行审查 + 模式扫描（shell注入、bare except、锁嵌套、CSS变量一致性）

---

## 一、严重级别 BUG（必须修复）

### BUG-S01：`threading.Lock` 嵌套获取导致确定性死锁

- **文件**: `app.py`
- **行号**: L540（定义）、L1407/L1412（嵌套触发）
- **类别**: 并发/线程安全
- **严重程度**: 严重
- **问题描述**:

  `job_lock = threading.Lock()` 是不可重入锁。在 `merge_files()` 函数中，L1407 先获取锁检查取消状态，若发现已取消，在 L1412 又在**同一锁作用域内**再次 `with job_lock:`，导致同一线程对同一 Lock 重复获取 → 确定性死锁。

  触发条件：**用户在合并阶段点击"停止"按钮**，100% 触发死锁。

  ```python
  # L1407-1416
  with job_lock:                    # ← 第一次获取 Lock（成功）
      _j = jobs.get(jid)
      if not _j or _j['status'] == 'cancelled':
          try: os.remove(merge_output)
          except: pass
          with job_lock:            # ← 第二次获取同一 Lock → 死锁！线程永远阻塞
              j = jobs.get(jid)
              if j:
                  j['merge_status'] = None
          return False, 'Cancelled by user'   # ← 永远无法到达
  ```

- **修复方案**（两种可选）:
  1. **方案A（推荐）**: 将 `job_lock` 改为 `threading.RLock()`，允许同一线程重复获取
     ```python
     job_lock = threading.RLock()   # L540
     ```
  2. **方案B**: 删除内层 `with job_lock:`，因为已经在锁作用域内
     ```python
     with job_lock:
         _j = jobs.get(jid)
         if not _j or _j['status'] == 'cancelled':
             try: os.remove(merge_output)
             except: pass
             # 内层代码已在锁内，无需再次获取
             j = jobs.get(jid)
             if j:
                 j['merge_status'] = None
             return False, 'Cancelled by user'
     ```

---

### BUG-S02：`SHGetKnownFolderPath` COM 内存泄漏

- **文件**: `app.py`
- **行号**: L2615-2639（`_get_known_folder_path` 函数）
- **类别**: 原生内存泄漏
- **严重程度**: 严重
- **问题描述**:

  `SHGetKnownFolderPath` 通过 `ctypes.byref(pp)` 返回一个 COM 分配的宽字符串指针。代码通过 `pp.value` 获取了 Python 字符串拷贝后直接返回，但**没有调用 `CoTaskMemFree` 释放原始 COM 内存**。

  每次调用此函数（每次打开文件对话框都会调用）都会泄漏一小块 COM 内存（约几KB）。在长期运行的会话中会累积。

  ```python
  # L2629-2631
  rc = SHGetKnownFolderPath(ctypes.byref(guid), 0, None, ctypes.byref(pp))
  if rc == 0 and pp:
      return pp.value         # ← 获取了 Python 字符串拷贝，但原始 COM 内存未释放
  ```

- **修复方案**:
  ```python
  rc = SHGetKnownFolderPath(ctypes.byref(guid), 0, None, ctypes.byref(pp))
  if rc == 0 and pp:
      result = pp.value
      # 释放 COM 分配的原始内存
      ctypes.windll.ole32.CoTaskMemFree(pp)
      return result
  ```

---

### BUG-S03：CSS 变量 `--danger` 未定义，错误提示 toast 背景透明

- **文件**: `static/index.html`
- **行号**: L3295, L4432, L4440
- **类别**: 前端显示/UI
- **严重程度**: 严重
- **问题描述**:

  CSS 中定义的错误色变量是 `--error`（L17/L19: `--error: #dc2626` light, `--error: #ef4444` dark），但 JavaScript 中 3 处使用了**不存在**的 `var(--danger)`：

  | 行号 | 代码 | 影响 |
  |------|------|------|
  | L3295 | `toast.style.background = type === 'error' ? 'var(--danger)' : ...` | 错误提示 toast 背景透明，用户**看不到任何错误反馈** |
  | L4432 | `const color = item.ok === false ? 'var(--danger)' : 'var(--success)'` | 批量任务失败项颜色不显示 |
  | L4440 | `<span style="color:var(--danger);">` | 失败任务耗时文字颜色不显示 |

  当 CSS 变量未定义时，浏览器回退到 `initial`（通常为透明/继承），导致所有错误视觉反馈消失。

- **修复方案**: 将所有 `var(--danger)` 改为 `var(--error)`（3处）
  ```javascript
  // L3295
  toast.style.background = type === 'success' ? 'var(--success)' : type === 'error' ? 'var(--error)' : 'var(--accent)';
  // L4432
  const color = item.ok === false ? 'var(--error)' : 'var(--success)';
  // L4440
  timeCell.innerHTML = `<span style="color:var(--error);">${fmtTime(elapsed)}</span>`;
  ```

---

## 二、中等级别 BUG（建议修复）

### BUG-M01：大量 bare `except:` 语句（15+处）

- **文件**: `app.py`
- **行号**: L654, L1411, L1420, L1447, L1518, L1538, L1546, L1550, L1602, L1625, L1670, L1700, L1704, L1826, L1856
- **类别**: 异常处理
- **严重程度**: 中等
- **问题描述**: `except:` 会捕获 `SystemExit` 和 `KeyboardInterrupt`，阻止正常进程终止。调试时也会吞掉所有异常信息。
- **修复方案**: 全部改为 `except Exception:` 或 `except (OSError, IOError):`（按场景选择具体异常类型）

### BUG-M02：ffmpeg Popen stdout/stderr 管道阻塞风险

- **文件**: `app.py` (L1177-1178), `stabilize.py` (L431-434)
- **类别**: 子进程管理
- **严重程度**: 中等
- **问题描述**:
  - `app.py`: `stdout=subprocess.DEVNULL, stderr=subprocess.PIPE` + `_read_ffmpeg_lines()` 逐行读取。如果 ffmpeg 输出量极大，理论上 stderr 管道缓冲区可能满导致 ffmpeg 阻塞。实际风险较低（因为持续读取）。
  - `stabilize.py`: `stdin=subprocess.PIPE, stderr=subprocess.PIPE` + 逐帧写入 stdin。ffmpeg 的 stderr 没有被持续 drain，如果 ffmpeg 产生大量 stderr 输出，stderr 管道可能满导致 ffmpeg 阻塞 → 进程死锁。
- **修复方案**:
  - `stabilize.py`: 在写帧循环中定期读取 stderr，或在 Popen 后启动独立线程 drain stderr

### BUG-M03：proc.wait() 无超时保护

- **文件**: `app.py`
- **行号**: L1204, L1208-1209, L1241
- **类别**: 子进程管理
- **严重程度**: 中等
- **问题描述**: `proc.kill()` 后 `proc.wait()` 在某些情况下可能阻塞较长时间（僵尸进程、信号未送达）。
- **修复方案**: 使用 `proc.wait(timeout=5)` 并处理 TimeoutExpired

### BUG-M04：`inject_spherical_metadata.py` 大文件全量读入内存

- **文件**: `inject_spherical_metadata.py`
- **行号**: L210-211
- **类别**: 内存管理
- **严重程度**: 中等
- **问题描述**: `bytearray(f.read())` 将整个 MP4 文件读入内存。360° 全景视频文件通常在 1-10 GB 范围，可能导致内存溢出。
- **修复方案**: 对于大文件使用文件映射（`mmap`）或分块读写策略

### BUG-M05：sysmon `shutdown_global_sysmon` 缺少锁保护

- **文件**: `sysmon.py`
- **行号**: L42-47
- **类别**: 并发安全
- **严重程度**: 中等
- **问题描述**: `shutdown_global_sysmon()` 设置 `_global_sysmon = None` 时没有 `with _global_lock:` 保护，与 `get_global_sysmon()` 的双检锁模式不一致，可能导致竞态。
- **修复方案**:
  ```python
  def shutdown_global_sysmon():
      global _global_sysmon
      with _global_lock:
          if _global_sysmon is not None:
              _global_sysmon.stop()
              _global_sysmon = None
  ```

### BUG-M06：前端 `esc()` 函数不完整（缺少 `"` `'` 转义）

- **文件**: `static/index.html`
- **行号**: L3697-3698
- **类别**: XSS 防护不一致
- **严重程度**: 中等
- **问题描述**: `esc()` 只转义 `&`, `<`, `>` 但不转义 `"` `'`。同时存在更完整的 `escapeHtml()` (L3705-3708) 转义了全部5个特殊字符。日志渲染 (L3571) 使用 `esc(l.msg)` 而非 `escapeHtml(l.msg)`，虽然 `<span>` 内容中 `"` `'` 不构成 XSS，但这是不一致的防护水平。
- **修复方案**: 在 `esc()` 中补全 `"` `'` 转义，或统一使用 `escapeHtml()`

### BUG-M07：`stabilize.py` Popen stdin 写帧无超时保护

- **文件**: `stabilize.py`
- **行号**: L473-474
- **类别**: 子进程管理
- **严重程度**: 中等
- **问题描述**: `proc.stdin.write(out_frame.tobytes())` 每帧写入 `w*h*3` bytes（如 3840×1920 = ~22MB）。如果 ffmpeg 消费速度慢于生产速度，stdin 缓冲区可能填满导致 Python 阻塞。
- **修复方案**: 使用 `proc.stdin.write()` + 检查 `BrokenPipeError`，或使用独立线程写帧

### BUG-M08：前端 logBox 每次轮询完全重建 DOM

- **文件**: `static/index.html`
- **行号**: L3569-3572
- **类别**: 性能/UI
- **严重程度**: 中等
- **问题描述**: 每 500ms 轮询一次，每次都通过 `innerHTML` 重新生成 100 条日志 HTML。即使日志内容完全未变化，也会重建 DOM，可能导致滚动位置丢失和性能浪费。
- **修复方案**: 增量更新——只追加新日志条目，或使用虚拟滚动策略

---

## 三、轻微级别问题（可选修复）

| # | 文件 | 行号 | 问题 | 说明 |
|---|------|------|------|------|
| L01 | sysmon.py | L140 | `_run()` bare `except: pass` 吞掉采样异常 | 不影响稳定性但妨碍调试 |
| L02 | sysmon.py | L285 | `_sample_gpu_pynvml()` bare `except: pass` | 同上 |
| L03 | sysmon.py | L151-153 | wmic 命令在 Win11 可能弃用 | 可改用 PowerShell `Get-CimInstance` |
| L04 | inject_spherical_metadata.py | L282-293 | `_parse_gsph_xml` 用正则解析 XML | 格式固定，实际风险低 |
| L05 | stabilize.py | L362/439 | 两次 VideoCapture 打开同一文件 | 极端情况帧数可能不一致 |
| L06 | build_exe.py | L31-33 | 硬编码构建机器路径 | 仅影响构建，不影响运行时 |
| L07 | app.py | L3295 | toast._timer 清理不完整 | 需在页面卸载时 clearTimeout |
| L08 | index.html | L3603-3609 | sysmonTimer 无页面卸载清理 | setInterval 可能泄漏 |
| L09 | app.py | 全局 | `jobs` dict 永不清理完成的任务 | 长时间运行可能累积大量任务数据 |

---

## 四、问题汇总统计

| 严重程度 | 后端(app.py/sysmon) | 前端(index.html) | 其他模块 | 合计 |
|---------|---------------------|-----------------|---------|------|
| 严重 | 2 | 1 | 0 | **3** |
| 中等 | 3 | 2 | 3 | **8** |
| 轻微 | 3 | 2 | 4 | **9** |
| **合计** | **8** | **5** | **7** | **20** |

---

## 五、修复优先级建议

1. **P0（立即修复）**: BUG-S01（死锁）、BUG-S03（--danger→--error）
   - 死锁影响生产稳定性（用户停止操作必然触发）
   - CSS 变量错误影响所有错误提示的用户可见性

2. **P1（尽快修复）**: BUG-S02（COM 内存泄漏）、BUG-M01（bare except）
   - 内存泄漏在长期运行中累积
   - bare except 阻碍调试和正常终止

3. **P2（计划修复）**: BUG-M02-M08
   - 管道阻塞风险在实际使用中概率较低
   - DOM 重建和 XSS 不一致性需要改进但不阻断功能

---

## 六、已确认的安全优势

- **无 shell=True**: 所有 subprocess 调用均使用列表形式参数，不存在命令注入风险
- **无路径遍历**: API 端点正确使用 `os.path.basename()` 和白名单模式
- **有 XSS 防护**: `esc()` / `escapeHtml()` 函数对日志输出进行 HTML 转义
- **子进程隔离**: ffmpeg 进程有 `CREATE_NO_WINDOW` 标志，防止窗口弹出

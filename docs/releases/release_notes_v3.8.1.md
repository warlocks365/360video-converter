# v3.8.1 发布说明

**发布日期：** 2026-07-27  
**版本类型：** BUG 修复  
**上一版本：** v3.8.0

## 问题背景

用户提交编码任务时，输入文件 `I:\20260726 常营马拉松体育公园游玩.mp4` 因录制中断/传输不完整导致 MP4 容器的 `moov` atom 缺失。ffmpeg 无法打开文件，返回错误码 `rc=3199971767`，但应用只显示了晦涩的 `ffmpeg failed (rc=3199971767)`，用户无法理解问题原因。

## 修复内容

### 1. 输入文件预校验 (validate_input_file)

在启动 ffmpeg 编码之前，用 ffprobe 快速检查输入文件是否为有效的媒体容器：
- 检查文件是否存在、是否过小（< 1KB）
- 运行 ffprobe 读取格式信息，捕获 `moov atom not found`、`Invalid data`、`end of file` 等错误
- 校验失败时直接返回用户友好的中文错误消息，不启动 ffmpeg

**覆盖路径：**
- `convert_one()` — 主编码流程
- `apply_metadata_one()` — 元数据写入流程

### 2. ffmpeg 错误信息解析器 (parse_ffmpeg_error)

在 `run_ffmpeg()` 中捕获最后 20 行非进度 stderr 输出，存储到 `jobs[jid]['_ffmpeg_last_err']`。当 ffmpeg 失败时，解析这些行匹配已知错误模式，翻译为用户友好的中文消息：

| ffmpeg 错误 | 用户看到的消息 |
|---|---|
| `moov atom not found` | 文件损坏或未完成写入（缺少 moov atom 索引）... |
| `Invalid data found when processing input` | 无法打开输入文件，文件数据无效或已损坏... |
| `No such file or directory` | 输入文件不存在，请检查文件路径 |
| `end of file` | 文件意外结束（可能被截断）... |
| `Permission denied` | 文件访问被拒绝，可能被其他程序锁定... |
| `No capable devices found` / `not find any gpu` | 未检测到可用的 GPU 硬件编码器... |
| `out of memory` / `cuda error` | GPU 显存不足或 CUDA 错误... |
| `no space left` / `disk full` | 磁盘空间不足... |

**覆盖路径：**
- 单遍编码失败（含 NVENC 崩溃回退后仍失败）
- 双遍编码 Pass 1 / Pass 2 失败
- 合并文件 (merge) 失败
- 流拷贝 (stream copy) 失败（2处）

### 3. 前端错误信息显示增强

转换工具批量表格中，失败项的状态列从仅显示"失败"改为显示截断的错误消息（前 20 字符 + "..."），鼠标悬停时通过 `title` 属性显示完整错误内容。

## 修改文件

| 文件 | 修改 |
|---|---|
| `app.py` | 新增 `validate_input_file()` 和 `parse_ffmpeg_error()` 函数；`run_ffmpeg()` 增加 stderr 行追踪；`convert_one()`、`apply_metadata_one()`、`merge_files()` 增加预校验和错误解析 |
| `static/index.html` | `renderItemStatus()` 失败状态显示错误消息而非仅"失败" |
| `VERSION` | 3.8.0 → 3.8.1 |

## 测试建议

1. **正常文件**：确认预校验通过，编码正常进行
2. **损坏文件**：使用截断的 MP4（删除末尾 moov atom），确认显示"文件损坏或未完成写入"而非晦涩的 rc 码
3. **不存在文件**：确认显示"输入文件不存在"
4. **空文件**：创建 0 字节文件，确认显示"文件大小为 0 字节"
5. **正常失败**：GPU 不可用时确认显示"未检测到可用的 GPU 硬件编码器"

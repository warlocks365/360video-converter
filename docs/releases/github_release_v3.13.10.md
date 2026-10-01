# v3.13.10 — 元数据工具流水线优化：全景视频临时全量文件 2 → 1（就地注入 + faststart 重排）

## 问题

元数据工具处理全景视频（需 GSpherical 注入）时，磁盘上先后出现**两个全量临时文件**：

1. `*.meta_tmp.mp4` / 输出文件本体 —— ffmpeg mux（`-c copy` + 日期/位置元数据，含 `+faststart`）；
2. `*.spherical_tmp.mp4` —— GSpherical 注入器（纯 Python 插盒必须产出新文件）。

根因：GSpherical UUID 盒是"向文件插入字节"的操作，且 ffmpeg 的 `+faststart` 把 moov 放到文件头部——插入点之后的全部数据（含 mdat）必须后移，注入器因此只能全量重写到第二个文件。磁盘全量 IO 3 遍（ffmpeg 内部 faststart 2 遍 + 注入 1 遍）。

## 修复：调整流水线顺序 + 注入器就地模式

1. **ffmpeg mux 不再带 `+faststart`** —— moov 留在文件尾部（一次全量写）；
2. **注入器新增就地模式 `inject_uuid_inplace()`**：moov 在尾部时，插入点之后的字节仅为 moov 剩余部分（几十 KB 级），全部媒体数据与 chunk 偏移位于插入点之前、不受影响 → **只重写 moov 尾区，不再产生第二个全量文件**；
3. **faststart 语义保留**：新增 `relocate_moov_front()`（64MB 分块流式写 + stco/co64 统一 +delta），需要时一次全量重排把 moov 移到头部，直达最终输出名；
4. **FS 时间语义保持**：重排产物继承 mux 产物的创建/修改时间（Windows `'wb'` 截断保留 ctime 的旧语义等价实现），未显式设置 FS 时间时表现与旧版一致；
5. **附加修复**：`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` 不再被整体覆盖（用户附加参数此前被静默丢弃），改为合并；新增诊断开关 `360VC_REMOTE_DEBUGGING_PORT`（开启 WebView2 CDP 远程调试，用于捕获前端未捕获异常）。

## 效果

| 指标 | 旧 | 新 |
|------|----|----|
| 全量临时文件 | 2 | **1**（faststart 开）/ 输出即唯一写入（关） |
| 磁盘全量 IO | 3 遍 | 2 遍（faststart 开）/ **1 遍**（关） |

## 验证

- 端到端三场景 7/7：faststart 开（GSpherical+moov 前置+时间/位置+无临时残留+日志确认就地/重排路径）、faststart 关（GSpherical+moov 留尾单遍 IO）、覆盖源文件模式；
- 元数据套件 21/21、门禁 01–09 全绿（07 36/36、08 12/12）。

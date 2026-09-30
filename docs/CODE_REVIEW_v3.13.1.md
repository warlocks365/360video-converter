# 360video-converter 全面代码审查报告（v3.13.1）

> 审查日期：2026-09-30 ｜ 审查基准：需求/设计基线（PROJECT.md、README.md、docs/ 全部文档、16 篇开发日记）
> 方法：3 路并行静态审查（需求基线 / 后端 / 前端）+ 主审查人对全部高危发现逐条源码复核与动态验证
> 严重程度定义（依 docs/CODE_REVIEW_STANDARD.md）：**P0** = 确定的功能性 BUG（功能失效/错误结果/崩溃）；**P1** = 潜在缺陷（边界条件错误/资源泄漏/状态错乱）；**P2** = 架构与可维护性问题
> 版本：VERSION=3.13.1，分支 v3.0.0-stabilization@9c66b62，工作树干净

---

## 一、需求与实现基线摘要

产品定位：桌面端 360° 全景视频转码工具（GoPro/Insta360/Okaa），Flask(8765) + pywebview，六大模式：单文件 / 合并 / 批量 / 元数据工具 / 元数据报告 / VR 3D 合成。当前 v3.13.1，累计约 40 个版本、200+ 提交。

各模块完成状态（基线核查结论）：

| 模块 | 状态 | 备注 |
|------|------|------|
| 单文件/批量转码 | ✅ 完整 | 编码器矩阵、回退、8K、copy 模式均到位 |
| 合并转换 | ⚠️ 有 P0 缺陷 | 无音轨文件必败（本报告 P0-1） |
| VR 3D 合成 | ❌ 两条 P0 | 布局选择不生效 + 非原分辨率必败（P0-2/P0-5） |
| 元数据工具 | ⚠️ 有 P0 | 输出到新目录+球面注入必败（P0-3） |
| 元数据报告 | ✅ 完整 | — |
| 地图选址（全球） | ✅ 基本完整 | 「仅查看坐标不选地址」为文档登记的未做项 |
| 前端三栏工作台 | ✅ 完整 | v3.12.2 后布局稳定 |
| 回归门禁/测试 | ⚠️ 部分失效 | test_bug_fixes.py 7/24 FAIL（P1-14） |

---

## 二、P0 —— 确定的功能性 BUG（5 项）

### P0-1 合并模式：无音轨视频合并必然失败
- **位置**：`app.py:2010-2011`（`merge_files`）
- **问题**：`-map 0:v:0` + `-map 0:a:0` 均未带 `?`。源文件无音频流时 ffmpeg 直接报错退出，合并 100% 失败。
- **动态验证**：用本仓库 `test_videos/20260715_360clip.mp4`（无音轨）实测复现：`Stream map '' matches no streams. To ignore this, add a trailing '?'`；改为 `-map 0:a:0?` 后同命令合并成功。
- **原因**：v3.5.0 重写合并命令时参考了 `build_cmd` 的 `-map 0:a?` 可选写法但漏掉 `?`；历史测试样本均带音轨。
- **修复**：`-map 0:v:0` 保留（无视频流本应失败），`-map 0:a:0` → `-map 0:a:0?`。

### P0-2 VR 3D 合成：输出分辨率非 original 时 filter_complex 非法，必然失败
- **位置**：`app.py:1222-1224`（`build_vr3d_cmd`）
- **问题**：`fc = "[0:v][1:v]vstack=inputs=2[v]"` 后追加 `";[v],scale=…[v]"` —— 链标签 `[v]` 被定义后又作为另一链的输入标签重复使用，且 scale 滤镜串带前导逗号（空滤镜名）。ffmpeg 报 `Invalid filterchain … Error parsing filterchain`。
- **触发条件**：`resolution != 'original'`。前端 `collectParams()` 默认提交 UI 分辨率（如 4096x2048），即默认路径即失败。
- **动态验证**：独立子代理用真实视频实测复现（libx264 与 hevc_nvenc 均报同一错误）。
- **修复**：中间标签改名并不复用：`[0:v][1:v]vstack=inputs=2[stk];[stk]scale=w:h:flags=lanczos,setsar=1[v]`。

### P0-3 元数据应用 + 球面注入 + 输出到新目录：同路径读写必然失败
- **位置**：`app.py:2863-2875` 与 `app.py:2913-2925`（`apply_metadata_one` 两个分支）
- **问题**：`final_out = temp_out if not replace_original else …` —— 输出目录与源不同时 `final_out is temp_out`（即 `out` 本身），随后 `inject_uuid(out, out)` 对同一文件 mmap 读取并以 `'wb'` 写入 → Windows `ERROR_USER_MAPPED_FILE`；异常 fallback 的 `shutil.copy2(temp_out, final_out)` 同路径再抛 `SameFileError`，最终以 `Internal error` 失败。
- **动态验证**：独立子代理实测复现（`OSError 22` / `SameFileError`）。
- **影响面**：元数据批量「输出到新目录」+ 启用球面注入 = 主流程全灭；原地覆盖模式（replace_original=True）路径不同所以正常，这解释了为何长期未被发现。
- **修复**：`final_out` 恒用独立临时名（`out + '.spherical_tmp.mp4'`），注入成功后 `os.replace(final_out, out)`。

### P0-4 批量编码状态渲染行错位（勾选过滤后状态/跳过按钮全部错行）
- **位置**：`static/js/60-jobs.js:462-471`（`renderEncodeJob`）配合 `60-jobs.js:134-138`（`startConversion` 只提交勾选任务）与 `40-files.js:359-390`（`renderBatchTable` 渲染全量任务）
- **问题**：后端 `data.items` 只含**勾选**的任务，而 `tbody.rows` 是**全量** batchTasks。`data.items.forEach((item, i) => row = tbody.rows[i])` 直接按下标对齐 —— 只要用户取消勾选任意一个任务，后续所有行的状态、进度、耗时、**跳过按钮**全部错行；点击「跳过」作用于 `skipItem(i)` 的后端索引，与用户看到的文件不符。
- **对照**：元数据批侧早就有 `_metaProcessingIndices` 映射解决同一问题（`60-jobs.js:477-498`），编码批侧遗漏了等价机制。
- **修复**：`startConversion` 记录勾选下标数组（如 `_encodeProcessingIndices`），`renderEncodeJob` 经其映射回行索引；或提交时给每个 item 附带前端行号。

### P0-5 VR 3D 布局选择不生效（`collectVR3DParams` 从未被调用）
- **位置**：`static/js/60-jobs.js:110-116`（`startConversion` 对 vr3d 模式传 `collectParams()`）；`static/js/30-params.js:427-441`（`collectVR3DParams` 定义但无启动路径调用）；`static/index.html:734`（`onchange="collectVR3DParams()"` 调用结果无接收者，纯空调用）
- **问题**：`vr3d_layout` / `vr3d_check_alignment` 从未随请求提交，后端只能取默认 `'top-bottom'` / `True`。用户选择 Side-by-Side 被**静默忽略**，且 stereo 元数据也跟着错。
- **叠加效应**：与 P0-2 叠加后，VR 3D 模式在默认参数下不可用。
- **修复**：`startConversion` 的 vr3d 分支改为 `return startVR3D(collectVR3DParams())`；删除 index.html:734 的无效 onchange。

---

## 三、P1 —— 潜在缺陷与边界错误（12 项）

### P1-1 pynvml 路径下 GPU 编码器/解码器利用率永不显示
- **位置**：`sysmon.py:288`、`sysmon.py:293`
- **问题**：`nvmlDeviceGetEncoderUtilization(handle, 0)` / `nvmlDeviceGetDecoderUtilization(handle, 0)` 多传第二参数；pynvml API 为单参数，抛 TypeError 被 `except Exception: pass` 静默吞掉 → pynvml 激活时 `gpu_enc_percent`/`gpu_dec_percent` 永远缺失。nvidia-smi 回退路径（`sysmon.py:390-393`）实现正确。
- **置信度**：高（API 签名静态可证），建议实机动态验证一次。
- **修复**：去掉第二个参数（返回值本就是 `(utilization, samplingPeriod)` 元组，`enc[0]` 用法正确）。

### P1-2 Okaa 右镜头 yaw 显示 0、实际按 180 执行
- **位置**：`static/js/30-params.js:234`
- **问题**：`okaa_yaw_r: parseInt(val('p_okaa_yaw_r')) || 180` —— UI 默认值就是 `0`（`index.html:481`），`parseInt("0")=0` 为 falsy → 实际提交 **180**。显示与执行不一致，右镜头被多转 180°。
- **同类**：`30-params.js:232` fov 兜底 `||185` 与 UI/后端默认 200 不一致（清空输入才触发）；`:239` blend 兜底 `'seam'` 与后端默认 `'replace'` 不一致。
- **修复**：`parseInt(val(...))` 后用 `Number.isNaN` 判断兜底，不要用 `||`。

### P1-3 `inject_uuid` 大文件内存翻倍（与 mmap 设计意图相悖）
- **位置**：`inject_spherical_metadata.py:287-289`
- **问题**：注释自称「分块写入避免全量内存拷贝」，实际 `out_f.write(data[:insert_pos])` / `data[insert_pos:]` 对 mmap 做全量切片，会物化成 bytes 副本 —— 多 GB 视频内存峰值 ≈ 2× 文件大小，正是 mmap 要避免的。
- **修复**：按 8~64MB 分块循环写入。

### P1-4 「导出编码日志」在任务结束后必然失败
- **位置**：`static/js/80-codec.js:280`
- **问题**：fetch 使用全局 `jobId`，而任务终态时 `endJob()` 已将其置 `null`（`60-jobs.js:291-298`）→ 请求 `/api/encode_log/null` → 404 → alert「Job not found」。
- **修复**：`renderJobCompletion` 时把 job id 缓存到专用变量（如 `lastCompletedJobId`），导出时优先使用。

### P1-5 保存自定义 ffmpeg 路径会清空用户全部未保存的编码参数
- **位置**：`static/js/10-ui.js:300-302` → `90-boot.js:9`
- **问题**：设置自定义路径后 `setTimeout(() => init(), 500)`，而 `init()` 内 `applyParams(DEFAULT_PARAMS)` 将编码面板重置为出厂默认。
- **修复**：自定义路径变更后只重跑 `checkCodecs()`，不要整页 `init()`。

### P1-6 取消请求超时/失败后取消按钮永久卡死
- **位置**：`static/js/60-jobs.js:172-196`
- **问题**：cancel 按钮被禁用并显示「停止中...」后，若 5s AbortController 触发或请求失败且后端未实际取消，后续轮询继续运行但**没有任何代码复位该按钮**（`renderCommonStatus` 不触碰 cancelBtn）→ 用户失去取消能力直到任务自然结束。
- **修复**：abort/失败分支恢复按钮可用态；或在轮询检测到 `status==='running'` 且本地无 pending cancel 时复位。

### P1-7 任务运行中可移除/重排批量任务行
- **位置**：`static/js/40-files.js:428-432`（`removeBatchItem`）、`:472-479`（`removeSelectedTasks`）
- **问题**：无运行态保护。运行中删行/重排使表格与后端 items 进一步错位（叠加 P0-4）。
- **修复**：`isJobRunning()` 时禁用这些操作并 toast 提示。

### P1-8 防抖/2-pass 临时文件在失败路径泄漏
- **位置**：`app.py:2259`（pass1 失败 return）、`app.py:2272`（pass2 失败）、`app.py:2322-2323`（编码失败）
- **问题**：`stab_tmp`、`_stab_trf` 仅成功路径（`app.py:2374-2381`）清理；passlog 文件（`.ffpass_*`）仅 `app.py:2263` 在 pass2 执行后清理，pass1 失败即残留。
- **修复**：`convert_one` 用 try/finally 统一清理三类临时文件。

### P1-9 主流程 fetch 无网络异常兜底
- **位置**：`static/js/60-jobs.js:158-168`（startConversion）、`:59-64`（startVR3D）、`:695-705`（startMetadataApply）
- **问题**：均无 try/catch。后端不可达时 Promise 静默拒绝，主按钮卡在禁用态无任何反馈。
- **修复**：统一包 try/catch，失败时 alert + `endJob()`/按钮复位。

### P1-10 球面防抖信任容器自报帧数，虚报时静默产出空/截断文件
- **位置**：`stabilize.py:317,374,454`
- **问题**：`n_frames = CAP_PROP_FRAME_COUNT`，部分容器该值不可靠（0/-1/虚高）。为 0 时 Phase1/3 循环体不执行 → 输出 0 帧文件，仅 ffmpeg 报错；虚高时 corrections 用尽后静默用单位阵。
- **修复**：改为 `while cap.read()` 计数推进，或读完后校验实际帧数与自报值偏差并告警。

### P1-11 批量表列索引硬编码，表结构一变即错位
- **位置**：`static/js/60-jobs.js:469-470`（`cells[7]`/`cells[9]`）、`:762-764`（`cells[8]`）
- **问题**：与 `40-files.js:359-390` 的 10 列结构硬耦合，加/减列即静默错位（注释自承「index 8 after the 参数 column was added」——已踩过一次）。
- **修复**：渲染时给目标 td 加 class（如 `.col-status`/`.col-time`/`.col-action`），按 class 定位。

### P1-12 稳定化阶段无进度条，进度长期停在 0%
- **位置**：`app.py:2155-2159`（`_stab_progress` 仅写日志）、`app.py:2131`
- **问题**：球面防抖耗时与编码相当，但 `file_progress` 全程不更新，仅在日志里 25% 步进；`progress_duration` 只覆盖编码段，导致进度条在防抖期间完全静止。
- **修复**：`_stab_progress` 内同步更新 `j['file_progress']`（按 防抖:编码 ≈ 50:50 加权），或前端展示阶段标签。

---

## 四、P2 —— 架构与可维护性（节选重要项）

### 架构
1. **app.py 5606 行单文件上帝对象**：~50 个 API 端点 + 命令构造 + 三个 worker + 系统对话框 + 地理代理全部同文件。建议拆 `routes/`（端点）、`workers/`（conversion/vr3d/metadata）、`ffmpeg/`（build_cmd/build_vr3d_cmd/build_okaa/merge）、`services/`（geocode/nominatim/native_dialog）。拆分时 DOM id 契约与 `build_cmd` 四分支互斥约束须写入模块头注释。
2. **requirements.txt 严重不全**：仅 `flask`/`pyinstaller` 两行，缺 pywebview、psutil、numpy、opencv-python、certifi、pynvml → `test_api.py`、`test_convert.py` 在标准 venv 直接 ImportError。即使不作为权威环境，也应标注或补齐。
3. **硬编码开发机路径**：`app.py:153-156`（`C:\ffmpeg-dev\…`、`C:\msys64\mingw64\bin`）、`app.py:163`（`C:\Users\warlocks\WorkBuddy\2026-07-14-13-37-44`）。仅影响非 frozen 开发分支，用户无感，但有迁移风险。
4. **NVENC 回退映射只覆盖 NVENC**：`app.py:2286` `fallback_map` 无 qsv/amf 条目，这两类硬编同样可能 0xC0000005，崩溃后无回退。
5. **`logger` 未定义**：`app.py:621` `logger.info(...)` → NameError。因 `del jobs[jid]` 在循环内已完成、调用方 `status()` 又有 try/except 吞掉，**清理功能实际正常**，仅日志行丢失 + 每次清理都抛一次异常。修正：定义 `logger = logging.getLogger(__name__)` 或直接删除该行。（注：子代理报告称「cleanup 完全失效」不准确，已复核。）
6. **Nominatim User-Agent 版本号硬编码 3.6.0**：`app.py:4465,4480`，与当前 3.13.1 不符；应读 `_read_app_version()`。
7. **合并 concat 不校验源参数一致性**：分辨率/编码不同的文件 stream copy 拼接会产出异常文件而无提示（concat demuxer 限制）。建议合并前 ffprobe 抽查首个与后续文件关键参数，不一致则 warn。
8. **`add_items` 运行中追加任务进度溢出**：`app.py:4896-4897` 追加后 `j['total']` 更新，但 `conversion_worker` 的 `total = len(items)`（`app.py:2396`）在启动时快照，`overall_progress = (idx+1)/total*100` 可超 100%。（注：子代理称「enumerate 遇 append 抛 RuntimeError」不准确 —— Python list 允许迭代中 append；真实问题是进度计算与完成判定语义。）

### 前端
9. **CSS 变量引用未定义变量（--error vs --danger 历史 BUG 同类复发）**：`--bg-secondary` 被 `app.css:424,517,567` 引用但从未定义；JS 内联样式引用 `--danger`（`60-jobs.js:21`）与 `--surface-2`（`60-jobs.js:25`）均未定义 → 回退透明/继承。建议把「CSS 变量定义↔引用一致性」加入门禁（现有 test_bug_fixes S03 只扫 index.html，扫不到 JS 模块）。
10. **HTML 转义遗漏**：`40-files.js:311`（`${c.name}` 未过 esc，文件名自 XSS）、`:306`（`date_in_name`）、`40-files.js` 批量表多处行内拼接未统一走 `esc()`。本地应用风险低，但违反项目硬约定。
11. **`detectInsvPair` 配对提示永不显示**：`60-jobs.js:96-97` 由 `singleInput` 推出 `singleInfo`，实际 DOM 只有 `sourceInfo`（`index.html:652`）→ `infoEl` 恒 null，死分支。
12. **smpte170m 选项产出自相矛盾的色彩元数据**：`index.html:257` 提供 SMPTE 170M 选项，但 `30-params.js:205-206` 的 primaries/trc 只看 bt2020nc，选 smpte170m 时 color_space=smpte170m + primaries=bt709 + trc=bt709。
13. **图标体系不一致**：`60-jobs.js` 混用 emoji 字符（⚠ ✅ 🔗 📦 ⏳，如 :21,:29,:99,:180,:383）与 HTML 实体（&#9989; 等）。建议统一到一种方案。
14. **新任务日志不清屏**：`beginJob` 重置 `lastLogCount` 但 `logBox` 旧内容保留（`60-jobs.js:424-457`），新日志混在旧任务尾部直至被裁剪。
15. **Python 3.14 兼容性**：`test_api.py:181` 存在 `datetime.utcnow()`（3.12+ DeprecationWarning，3.14 移除）；打包链若升级 Python 需处理。
16. **`_ff_path` 跨盘符回退 basename**：`stabilize.py:68-69`，工作目录与 TEMP 不同盘时 vidstab 找不到 .trf。

### 文档
17. **PROJECT.md 过期**：「最新发布：v3.6.2」（实际 v3.13.1）；目录结构未含 scripts/frontend-gate、scripts/release_github.js；「关键经验」一节未同步 v3.6.2 之后的沉淀。
18. **已注入 UUID 的文件无法修正 stereo_mode**：`inject_spherical_metadata.py:243-249` 检测到已有 UUID 即原样复制，用户想改 3D 模式时静默跳过。至少应 log 提示或提供 --force。

---

## 五、需求 / 设计 / 实现不一致事项（单列）

| # | 事项 | 需求/设计依据 | 实现现状 | 关联 |
|---|------|---------------|----------|------|
| D-1 | VR3D 布局可选（Top-Bottom / Side-by-Side） | v3.9.0 需求与 UI 选项 | 选择被静默忽略，恒 top-bottom | P0-5 |
| D-2 | VR3D 支持输出分辨率设置 | UI 提供分辨率选择 | 非 original 时 filter_complex 非法必败 | P0-2 |
| D-3 | 元数据工具「输出到新目录」 | 元数据批量主流程 | 叠加球面注入时同路径读写必败 | P0-3 |
| D-4 | 日期兜底链含「文件修改时间」一步 | 用户基线描述（手动→文件名→修改时间） | `app.py:2228-2229` 仅 warn，无 mtime 兜底；需求文档未见明确记载，**待用户确认是否为正式需求** | — |
| D-5 | 地图「仅查看坐标不选地址」 | 日记登记的 v3.6.5 待做项 | 未实现（选择即关闭 modal） | 待办 |
| D-6 | 批量编码逐行状态准确渲染 | 批量模式核心交互 | 勾选过滤后整列错位 | P0-4 |
| D-7 | 「分块写入避免全量内存拷贝」 | 代码注释自我声明 | 全量切片，2× 内存峰值 | P1-3 |
| D-8 | UI 显示 yaw_r=0 | 界面默认值 | 实际按 180 执行 | P1-2 |
| D-9 | UI 提供 SMPTE 170M 色彩空间 | 界面选项 | primaries/trc 仍写 bt709，元数据自相矛盾 | P2-12 |
| D-10 | 版本号一致性（Nominatim UA 含版本） | 版本号规则 | UA 硬编码 3.6.0 | P2-6 |
| D-11 | PROJECT.md 反映项目现状 | 文档义务 | 停留在 v3.6.2 | P2-17 |
| D-12 | 回归测试作为安全网 | 测试纪律 | test_bug_fixes.py 7/24 FAIL（断言模块化前 DOM）；requirements 不全致 test_api/test_convert 不可运行 | P1-14* |

---

## 六、测试与验证体系评估

- **test_bug_fixes.py 已失效（实测 17/24 PASS, 7 FAIL）**：M06/M08/L07/L08 全部在 `index.html` 里找内联 JS，而 v3.11.0 模块化后 esc/lastLogCount/beforeunload 已迁入 `00-core.js` 等模块（功能本身仍在，已人工确认）。该文件目前产生的是**恒失败的噪音**，建议按模块路径重写断言或删除，由 9 项 frontend-gate 门禁接替。
- **test_api.py / test_convert.py 不可运行**：requirements 缺依赖 + `import app` 即启动 Flask 占 8765 端口（端口被占即挂）。
- **frontend-gate 9 项门禁**是最新且有效的回归手段，但存在已知盲区（不做 CSS 布局验证、不验证视觉效果；门禁 08 有 Windows 僵尸进程陷阱，须 taskkill /F /T）。
- **编码器真机矩阵测试（test_all_encoders.py）无法在本机执行**：无物理 NVIDIA GPU，NVENC 路径（含 P1-1）只能静态推断 + 用户机验证。

---

## 七、审查过程记录：子代理发现的证伪清单

两个代码审查子代理共产生 **9 条假阳性/不准确结论**，均经主审查人逐条源码复核证伪（体现了「Explore 盘点 + 主审抽读二次核实」方法论的必要性）：

1. ~~后端参数白名单丢编码参数~~：`buildBatchFileSettings` 函数不存在；`t.params` 实为全量 `collectParams()` 快照（40-files.js:531），后端合并逻辑正确。
2. ~~_ps_escape 正则损坏~~：实现为简单 `replace("'", "''")`（app.py:3161-3163），正确。
3. ~~扫描陈旧闭包丢新文件~~：所述 `scanSelected/_pendingScanFiles` 等函数不存在；实际 scanDirectory→importCandidates 流程在点击时实时读取，无此问题。
4. ~~预设名 XSS~~：`refreshPresets` 用 `createElement`+`textContent`（30-params.js:371-373），安全。
5. ~~VR3D 暂停失效~~：`vr3d_merge_one` 走 `run_ffmpeg`→`check_pause`，暂停/取消均生效。
6. ~~脏合并行阻止扫描~~：scanDirectory 无此类检查，所述机制不存在。
7. ~~探测失败 alert 中断批量循环~~：`probeMetaFile` 对 `data.error` 静默标记 probed 并继续（50-meta.js:187）。
8. ~~地图转换无 out_of_china 保护~~：`gcj02ToWgs84`/`wgs84ToGcj02` 均有 `_outOfChina` 短路（20-map.js:100,115）。
9. 部分不准确：「enumerate 遇 append 抛 RuntimeError」（list 允许，真实问题是进度溢出）；「logger 未定义致 cleanup 完全失效」（cleanup 生效，仅日志行崩）。

---

## 八、修复优先级建议

| 批次 | 内容 | 预估 |
|------|------|------|
| 第一批（P0，建议合入 v3.13.2） | P0-1（一行）、P0-2（标签改名）、P0-3（临时文件名）、P0-5（一行调用切换） | ~2h |
| 第一批半 | P0-4（编码批索引映射，参照 _metaProcessingIndices 模式） | ~2h |
| 第二批（P1 高值） | P1-1、P1-2、P1-4、P1-5、P1-6、P1-7 | ~4h |
| 第三批 | P1-3、P1-8、P1-9、P1-12、测试体系修复（P1-14 相关） | ~6h |
| 架构批（另立项） | app.py 拆分、requirements 补齐、CSS 变量门禁、临时文件 try/finally 框架 | ~16h |

> P0 五项中四项为一行级修复，建议先出 v3.13.2 热修；P0-4 需要小规模前端改动，可同批或紧随其后。

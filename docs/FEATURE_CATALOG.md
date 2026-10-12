# 360° Video Converter · 功能目录与调用边界（能力真源）

> 生成日期：2026-10-12 ｜ 基线：v3.13.18（commit c177837）
> 用途：本文件是 AI Agent（page-agent）集成与一切自动化调用的**能力边界真源**。
> 修改任何端点/控件 id/data-action 时必须同步更新本目录（建议纳入 review checklist）。
> 行号引用基于 v3.13.18，代码演进后以符号名检索为准。

---

## 表A：HTTP API 全量清单（app.py，44 路径 / 46 注册）

Flask 固定监听 `127.0.0.1:8765`；除标注外均为本地闭环，无鉴权（桌面单用户应用，**任何网络侧暴露都是安全事故**）。

### A-1 长任务类（返回 job_id，经 `/api/status/<jid>` 轮询）

| 端点 | 功能 | 请求要点 | 副作用 |
|---|---|---|---|
| POST `/api/convert` | single/merge/batch 转码 | `mode` + `params`（深合并 DEFAULT_PARAMS）+ `items[]`；批量项可带 per-item `params`；合并 ≥2 文件 | **写输出视频**；merge 有 `.merged_tmp` 中间文件 |
| POST `/api/start_vr3d` | VR3D 双目合成 | `params` + `items[{left_input,right_input,output}]` 必填校验 | 写输出视频 |
| POST `/api/apply_metadata` | 元数据应用（不重编码） | `params`（顶层）+ `items[]`（含 per-item params）；功能门=顶层**或任一项**开 apply_date/location/spherical（v3.13.18） | **写/覆盖视频**（output==input 走临时文件替换）；写 FS 时间 |
| POST `/api/report` | 元数据报告 | `paths[]` 或 `directory`+`recursive` | 无（只读 ffprobe）；前端走独立轮询 pollReportJob，不占 ActiveJob |

任务控制：GET `/api/status/<jid>`（log 尾200条+sysmon）· POST `/api/cancel/<jid>`（杀进程树）· POST `/api/pause/<jid>` / `/api/resume/<jid>` · POST `/api/item/<jid>/<idx>/skip` · POST `/api/add_items/<jid>` · GET `/api/encode_log/<jid>`。
**已知残留**：add_items 后进度可超 100%（worker 按启动快照 total）；status 清理路径 634 行 logger NameError。

### A-2 探测/诊断类（只读或起子进程，无状态副作用）

GET `/api/probe` · `/api/probe-source`（GPS+creation_time+地名/地址）· `/api/probe_metadata`（spherical/date/GPS/size/文件名日期）· `/api/file_fs_time`（**本地 naive 无 Z**，时区契约）· `/api/drives` · `/api/browse` · POST `/api/scan` · `/api/extract_date` · `/api/vr3d/check_alignment` · `/api/insta360/detect_pair` · GET `/api/codec_check` · POST `/api/test_ffmpeg` · `/api/test_encoder_detail` · GET `/api/diagnostic_report` · GET `/api/debug` · GET `/api/sysmon` · GET `/api/codecs` · GET `/api/version`。

### A-3 配置/持久化类

| 端点 | 功能 | 副作用 |
|---|---|---|
| GET/POST `/api/settings` | 读写 `%APPDATA%\360VideoConverter\presets\_settings.json`；**POST 为浅合并、无字段白名单**（新增字段自动持久化）；现有字段 `amap_api_key`/`amap_security`/`auto_load_tasks`/`custom_ffmpeg_path` | 写用户配置 |
| GET/POST/DELETE `/api/presets[/<name>]` | 编码预设增删查 | 写/删 presets/*.json |
| POST `/api/tasks/save` · GET `/api/tasks/load` · POST `/api/tasks/load_file` | 任务列表存/载（可自定义路径） | 写 json |
| POST `/api/preview_formula` | 输出路径公式展开预览 | 无 |
| POST `/api/native_dialog` | 原生文件/目录/保存对话框 | 写 last_paths.json；抢占前台弹窗 |
| GET `/api/geocode` · `/api/nominatim` | 高德/OSM 外网代理（**前端从不直连外网 API**；SSL 失败自动降级重试；Nominatim 1req/s 节流） | 出网请求 |
| GET `/api/open_external` | 系统浏览器打开 URL（仅 http/https） | 起外部进程 |

### A-4 静态资源

`static_url_path=''` 全量服务 `static/`；非 `/api/` 响应一律 `Cache-Control: no-store`（after_request，新增资源自动继承）。**子目录天然可访问**（leaflet 即先例：`/leaflet/leaflet.js` → 同理 `/agent/*.js`）。

---

## 表B：六大模式 × 可操作面

模式切换：页签 `data-mode`（single/merge/batch/metadata/report/vr3d）→ `switchMode()`（10-ui.js）。

| 模式 | 输入面 | 操作按钮 | 产出通道 |
|---|---|---|---|
| single | `singleInput`（非 readonly，可直接赋值+触发 onchange 探测）、`singleOutput`、p_* 全参数面板 | `startBtn`、`addToBatchBtn`、`testEncode`/`testDuration` | /api/convert single |
| merge | `mergeTableBody`、`mergeOutput`、共享 p_* | `addMergeFiles()`/`clearMergeList()`/行内 move/remove、`startBtn` | /api/convert merge |
| batch | 导入区 `batchDir`/`batchOutDir`/`projectDir`/`batchFormula`+14 变量芯片、候选表 `importCandidatesBody`、任务表 `batchTableBody` | `scanDirectory()`、`addSelectedToTasks()`、`applySettingsToSelected()`、全选/删选中/删未选、保存/加载任务、`startBtn` | /api/convert batch（per-item params） |
| metadata | `metaInput`、`metaBatchOutDir`、m_* 默认设置（date/location/spherical 三组）、`me_*` 单行编辑弹窗（含 out_mode 三态 radio、复用条）、列队表 `metaBatchTableBody` | **四件套**：`metaAddQueueBtn`（入队=冻结 m_ 快照）· `metaApplyBtn`（只跑 metaInput 单文件）· `metaBatchRunBtn`（只跑列队，忽略界面）· `meta-force-form-run`（**设置同步器**：m_ 覆写勾选列队项 settings，不执行）；行内 勾选/编辑/删除/重置/输出模式 | /api/apply_metadata |
| report | `reportMode` radio、`reportInput`/`reportBatchDir`、结果区 `reportResult`、筛选 `reportFilterBar`、多选 `reportSelectBar` | `generateReport()`/`generateBatchReport()`/`saveReport()`/`clearReport()`/`exportReportLog()`、筛选行增删、**report-add-to-queue**（选中项注入 batch 或 meta 列队） | /api/report（独立轮询） |
| vr3d | `vr3dLeftInput`/`vr3dRightInput`（change 自动对齐检测）、`vr3dOutput`、`vr3dLayout` | `vr3dCheckAlignment`、`startBtn`（vr3d 分支） | /api/start_vr3d |

共享 p_ 参数面板 ≈45 控件（编码/音频/注入/稳定/okaa/insv/日期/位置全组），由 `collectParams()` 表驱动读取；折叠组必须保持 DOM 存在（display:none，禁惰性渲染）。

**全局共享反馈面**：`#mainActionBar` 进度区（progressLabel/overallProgress/fileProgress/encodeTimeInfo…）、`#logBox` 增量日志、`#toastNotification`、sysmon 卡 `sm*`；`ActiveJob`+`pollActiveJob(500ms)` 单轮询器；`PRIMARY_BTN_IDS=[startBtn, metaApplyBtn, metaBatchRunBtn]` 任务期互斥禁用。

---

## 表C：跨模式共享能力

| 能力 | 入口 |
|---|---|
| 设置弹窗 | `openSettings()`/`saveSettings()`（#settingsModal：amap key/安全码、自动加载、自定义 ffmpeg）；持久化 = A-3 settings |
| 预设 | `presetSelect` + 保存/删除（prompt/confirm 原生弹窗——自动化时注意） |
| 地图选点 | `openMapPicker(target)`，target='encode'|'meta'|'me'；GCJ02↔WGS84；逆地理失败用 `addrFailed` 标志拦截 |
| 剪贴板 | `writeClipboardText`/`readClipboardText`（clipboard API + execCommand 双路）；业务封装 copyGeoEntry/pasteGeoEntry（JSON schema `meta-geo/v1`） |
| 主题 | `toggleTheme()`（localStorage.theme，默认 dark） |
| 关于/帮助 | `openAbout('version'|'help')`；外链一律 `openExternalUrl`→/api/open_external |
| 中央委托 | `DELEGATED_ACTIONS`（00-core.js，33 个 action；表单只认 change、其余只认 click）；**注入按钮必须 data-action+注册，否则门禁 06 判死** |
| 单实例锁 | Global 内核 mutex；二次启动弹原生 MessageBox 后退出 |

---

## 表D：集成第三方 JS/网络资源的硬约束（既证事实）

| # | 约束 | 出处 |
|---|---|---|
| D1 | **公网 CDN 在 WebView2 静默失败**（Leaflet 先例）→ 第三方 JS 必须本地化随包 | memory/2026-07-23；release_notes_v3.6.4 |
| D2 | SRI hash 不匹配 = 静默拒载；本地 `<script>` 不写 integrity | release_notes_v3.6.1 |
| D3 | 非 /api/ 响应 no-store 由 after_request 统一注入，新静态资源自动继承 | app.py:222-240 |
| D4 | **外网 API 一律经 Flask 代理**（CORS + SSL 降级 + UA 合规三理由） | app.py geocode/nominatim 实现 |
| D5 | 验证工具链注意环境代理：本机 `http_proxy` 会把 127.0.0.1 请求劫持成 502，curl 必须 `--noproxy '*'`；node 原生 http 不受影响（2026-10-11 实测） | memory/2026-10-11 |
| D6 | **离线可用是分发前提**：功能默认关、失败优雅降级、纯工具用户零感知 | MEMORY.md |
| D7 | PyInstaller onefile：`static/` 整体进包（spec datas），frozen 下 `sys._MEIPASS` 为根；子目录文件自动随包 | 360VideoConverter.spec |
| D8 | 门禁体系：01 语法/资源存在（**新增第三方 bundle 需评估是否入扫描范围**）·05 id 契约（注入面板的 id 需登记/豁免）·06 data-action 双向 ·07 jsdom ·08 打包产物断言 ·10 凭据扫描（**默认配置严禁内置真实 key**） | scripts/frontend-gate/ |
| D9 | WebView2 默认 `--disable-gpu` CPU 合成（v3.13.0）：纯文本 DOM 方案与之一致 | app.py:5729 |
| D10 | DOM id 硬契约；P0 禁 emoji 图标（**第三方 bundle 内部 UI 属供应商实现，不改造、豁免登记**；自研注入按钮必须 ico() SVG） | 00-core.js:120 |
| D11 | XSS 红线：动态 HTML 属性禁拼 JS；`esc()` 在 JS-in-attribute 上下文不充分 | 00-core.js:253 |
| D12 | 时区契约：涉及日期一律本地 naive 无 Z | app.py:5106 |
| D13 | 编码校验事实（Agent 参数合法性判据）：h264 硬编≤4096×4096 超限自动切 HEVC；自定义分辨率须偶数；硬编无 2-pass；MP4>6.6h DTS 溢出走 mkv | 30-params.js:108 |
| D14 | 凭证纪律：key 只存 `_settings.json`（APPDATA，与 amap key 同级），不入 git/日志/记忆；GET /api/settings 对敏感字段回掩码、POST 收哨兵值保留旧值 | 用户 P0 规则 + 门禁 10 |

---

## 表E：Agent 调用边界分级（供权限控制设计）

| 级别 | 范围 | Agent 默认策略 |
|---|---|---|
| L0 只读 | A-2 探测类、GET settings/presets/codecs/version | 放行 |
| L1 界面导航 | 切模式、填参数、勾选项、入列队、报告生成（A-1 report 无文件副作用）、任务存载 | 放行 |
| L2 有副作用（新文件） | convert/vr3d/apply_metadata 且输出≠输入、save_report、presets 保存、open_external | **二次确认**（confirm_destructive） |
| L3 破坏性 | 原地覆盖（output==input）、删除预设、cancel 运行中任务、remove 批量行、settings 保存（改模型端点） | **默认禁止**，需 allow_overwrite_source / 显式确认 |
| 禁区 | 修改 `_settings.json` 中的模型端点与 key（Agent 自我改写配置=失控回路）；执行 execute_javascript（page-agent 内置该实验工具，本项目**必须关闭**） | 拦截 + 提示用户在设置面板手动操作 |

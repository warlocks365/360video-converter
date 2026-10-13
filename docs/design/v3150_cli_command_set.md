# Spec — v3.15.0 CLI 指令集（page-agent 原生调用通道）

> 生成日期：2026-10-13 ｜ 状态：待用户确认
> 产出说明：首席架构师两次 spawn 因模型配额（429）失败、零产出（过程留档），
> 本文档由项目总监亲自产出（沿用 v3.14.0 前端代写先例），全部技术论断附实证来源。
> 基于：docs/FEATURE_CATALOG.md（44 端点/表E）、v3.14.x page-agent 集成两轮对抗验收、
> scripts/_poc_custom_tool_webview.js（customTools 可行性 PoC，提交 cb3985c）。

---

## 1. 决策总览与三通道权衡

**问题**：page-agent 内置工具只有模拟鼠标/键盘（click_element_by_index / input_text /
scroll / select_dropdown / wait / done / ask_user），执行一次批量转换需要十几次模拟操作
并"读界面猜状态"，慢且易错。目标：把应用功能抽象为 CLI 指令集，agent 一步下发、
一步读结构化结果。

| 通道 | 可行性（实证） | 单任务 agent 操作数 | 状态获取准确性 | 权限收口位置 | 实现成本 | 外部依赖 | 定位 |
|---|---|---|---|---|---|---|---|
| **A 页内命令控制台桥**：GUI 内嵌命令输入框+结果面板，agent 用 input_text+click 两步操作，控制台经 `POST /api/cli` 单一入口执行 | **✅ 已证**：bundle `isTextAreaElement` 判定 TEXTAREA 可被 input_text 写入；结果以文本块渲染即进 agent 观察面 | 2–4 步/任务（输入命令→执行→读 JSON→轮询读增量） | 单 JSON 块完整返回，无猜测 | **后端**（/api/cli 强制表E） | 中 | 无 | **v3.15.0 主通道** |
| **B exe `--cli` 进程子命令**：同一内核，外部进程调用 | ✅ 技术可行；但浏览器内 agent **无本地进程能力**，对 page-agent 不可达 | N/A（服务对象=人/脚本/未来工具） | stdout JSON | 同一内核 | 低 | windowed exe 的 stdout 需显句柄重建（见 §10 风险 R3） | 辅助入口（与 A 共用内核，零额外语义分叉） |
| **C vendor 原生 customTools（function calling）**：工具直接进 LLM tools 数组 | **❌ 当前不可行**（PoC 实测）：构造器接受注入（bundle @150013 `tools.set` 循环），但序列化 `zodToOpenAITool→toJSONSchema` 要求 inputSchema 带 zod v4 内部 `_zod.def`；plain JSON Schema / `~standard` 手工对象 / 浅 shim 三形态 execute 全抛 `TypeError: reading 'def'`；bundle window 暴露面仅 PageAgent（内嵌 zod 不可达，项目无构建链） | 最优（1 步） | 最优 | 需后端桥 | 低 | vendor 版本行为变更 | **远期**；升级 vendor 时重跑 PoC 脚本判定 |

**推荐路线**：A 为主 + B 同内核辅 + C 远期。核心收益量化：批量转码任务从
"切模式→选目录→勾文件→填参数→点开始→盯进度"≈12–18 次模拟操作，降为
"vc file scan → vc job start-convert → 轮询 vc job status"≈4–6 步，
且每步返回结构化 JSON，**消除全部"读界面猜状态"的不确定环节**。

## 2. CLI 内核架构

### 2.1 单一真源命令注册表（Python 侧）

`app.py` 新增模块级 `CLI_REGISTRY`（或独立 `cli_kernel.py`，倾向独立文件控制
app.py 体积）：每条命令声明 `name / args_schema / permission（表E 等级）/ handler /
doc（agent 可读的一行说明+参数摘要）`。`POST /api/cli` 与 exe `--cli` 子命令共用
同一注册表——**任何一侧改命令，另一侧零成本同步**；GUI 旧端点原样保留（反向兼容）。

命令形态：`vc <group> <verb> [--flag value ...]`，kebab-case。

### 2.2 权限模型后端强制

| 判定输入 | 来源 |
|---|---|
| 命令自身权限级 | CLI_REGISTRY.permission（L0/L1/L2/L3/FORBIDDEN，对齐表E） |
| 会话权限档 | 现有 `agent_permission` 设置（readonly/standard/full） |
| 调用来源 | 请求体 `source:"agent-cli"`（控制台桥注入）；无标记=GUI，正常执行零影响 |

映射规则（后端强制，前端不可绕过）：

| 命令级 × 会话档 | readonly | standard | full |
|---|---|---|---|
| L0/L1 | 放行 | 放行 | 放行 |
| L2 | 拒绝 ERR_PERMISSION | **控制台确认条**（见 2.3）| 直接执行 |
| L3 | 拒绝 | 拒绝（引导用户手动） | 拒绝——L3 恒禁（见禁区矩阵） |
| FORBIDDEN | 拒绝 | 拒绝 | 拒绝 |

**禁区矩阵（恒禁，full 亦拒）**：`vc config set`（改模型端点=失控回路，继承 v3.14.x
既定红线）、`vc preset delete`、`vc job cancel`（杀运行中作业）、`vc file overwrite-inpath`
（output==input 的原地覆盖）、`vc task load-file`（改界面状态属 GUI 语义，不暴露）。
standard 档确认**次数从"每模拟步一次"降到"每 L2 任务一次"**——本设计的核心
交互收益，必须写死。

### 2.3 控制台桥 UI（页内组件）

- 位置：主操作栏下新增可折叠「命令控制台」组（复用 param-group 手风琴结构，不新建布局范式）；
- 输入：`<textarea>`（单行命令）+「执行」按钮（`data-action="cli-run"`，注册 DELEGATED_ACTIONS，零派发器改动）；
- 确认条：standard 档 L2 命令执行前，面板内渲染「确认执行 / 取消」两按钮（替代浏览器
  confirm 弹窗——agent 可读可点，用户可点，语义同权限门）；
- 结果区：`<pre class="cli-result">` 输出**单个 JSON 块**（信封全文）。超长按 §5.3
  截断策略，保证 agent 观察面收录；
- `help` 命令：`vc help` / `vc help <group>` 返回命令清单/详情（手册注入入口，见 §6.2）。

### 2.4 任务/幂等/轮询语义

- **单活动作业互斥**：沿用现有后端拒绝并发（ERR_JOB_ACTIVE + 冲突 job_id 回显）；
- **幂等**：`vc job *` 接受 `--request-id <agent 生成>`；内核保留最近 64 条映射，
  重复提交返回原 job_id（`{"ok":true,"code":"OK_IDEMPOTENT",...}`），防 agent 重试风暴；
- **状态紧凑对象**：`vc job status --id --since-seq <n>` 返回
  `{job_id, phase, progress_pct, current_index, current_file, speed_x, eta_sec,
  items_state:[{idx,state}], failed:[{idx,reason}], log:{from_seq,lines:[...]}}`；
  后端在作业对象加单调 `seq` 计数器（log 每条 +1），**增量游标防日志洪水**；
- **终态可取回**：作业结束后 status 仍返回终态快照 + `finished:true`（现在
  /api/status 终态后条目会被清理，CLI 需保留终态 10 分钟或提供 `vc job result --id`）。

## 3. 指令集全表（38 条）

权限列 = 命令级（表E 映射）。handler 列 = 复用的现有端点。

### vc job（任务生命周期，9 条）

| 命令 | 参数 | 级 | handler |
|---|---|---|---|
| `vc job start-convert` | `--mode single\|merge\|batch` `--items <json:[{input,output}或{inputs,output}]>` `--params <json:编码参数对象>` [--request-id] | L2（output==input 时 L3 拒） | POST /api/convert |
| `vc job start-vr3d` | `--left <path>` `--right <path>` `--output <path>` `--layout top-bottom\|left-right` [--check-alignment] | L2 | POST /api/start_vr3d |
| `vc job apply-metadata` | `--items <json:[{file,settings:{...}}]>` [--write-back] | L2（write-back 原地=L3 拒） | POST /api/apply_metadata |
| `vc job status` | `--id <jid>` [--since-seq <n>] | L0 | GET /api/status/<jid> |
| `vc job log` | `--id <jid>` [--since-seq] | L0 | GET /api/encode_log/<jid> |
| `vc job pause` / `vc job resume` | `--id <jid>` | L2 | POST /api/pause\|resume |
| `vc job skip-item` | `--id <jid>` `--index <n>` | L2 | POST /api/item/<jid>/<n>/skip |
| `vc job add-items` | `--id <jid>` `--items <json>` | L2 | POST /api/add_items/<jid> |

（`vc job cancel` 不暴露给 agent——L3 恒禁，错误 hint 引导用户手动。）

### vc probe（媒体探测，7 条，全 L0）

| 命令 | 参数 | handler |
|---|---|---|
| `vc probe file` | `--path` | GET /api/probe |
| `vc probe source` | `--path` | GET /api/probe-source |
| `vc probe metadata` | `--path` [--raw] | GET /api/probe_metadata |
| `vc probe date` | `--path` | POST /api/extract_date |
| `vc probe fs-time` | `--path` | GET /api/file_fs_time |
| `vc probe insv-pair` | `--dir` [--pattern] | POST /api/insta360/detect_pair |
| `vc probe vr3d-alignment` | `--left --right` | POST /api/vr3d/check_alignment |

### vc file（目录与文件，3 条）

| 命令 | 参数 | 级 | handler |
|---|---|---|---|
| `vc file scan` | `--dir` [--pattern] [--recursive] | L0 | POST /api/scan |
| `vc file browse` | `--dir` [--show-hidden] | L0 | GET /api/browse |
| `vc file drives` | — | L0 | GET /api/drives |

### vc config（应用配置，6 条）

| 命令 | 参数 | 级 | handler |
|---|---|---|---|
| `vc config show` | — | L0（密钥哨兵掩码，沿用 §7 协议） | GET /api/settings |
| `vc config set` | 任意设置字段 | **FORBIDDEN（恒禁）** | POST /api/settings |
| `vc config codecs` | — | L0 | GET /api/codecs |
| `vc config codec-check` | [--codec list] | L0 | POST /api/codec_check |
| `vc config test-ffmpeg` | [--path] | L0 | POST /api/test_ffmpeg |
| `vc config test-encoder` | `--codec --preset` | L0 | POST /api/test_encoder_detail |

### vc preset / task / geo / report / sys（13 条）

| 命令 | 参数 | 级 | handler |
|---|---|---|---|
| `vc preset list` | — | L0 | GET /api/presets |
| `vc preset save` | `--name --params <json>` [--overwrite] | L2（覆盖既有=L3 拒） | POST /api/presets |
| `vc preset delete` | `--name` | **FORBIDDEN** | DELETE /api/presets/<name> |
| `vc task save` | `--name` | L2 | POST /api/tasks/save |
| `vc task list` | — | L0 | GET（tasks 目录枚举） |
| `vc geo search` | `--q` [--key-source amap\|osm] | L0 | GET /api/geocode |
| `vc geo reverse` | `--lat --lon` | L0 | GET /api/nominatim |
| `vc report generate` | `--data <json>`（纯生成无文件副作用） | L1 | POST /api/report |
| `vc report save` | `--content <json> --out <path>` | L2 | POST /api/save_report |
| `vc report diagnostic` | — | L0 | GET /api/diagnostic_report |
| `vc sys version` | — | L0 | GET /api/version |
| `vc sys monitor` | — | L0 | GET /api/sysmon |
| `vc help` | [group\|command] | L0 | CLI_REGISTRY 自省 |

## 4. 统一 JSON 信封与状态码

### 4.1 信封（全命令一致，HTTP 与 --cli 同构）

```json
{
  "ok": true,
  "code": "OK",
  "data": { },
  "error": null,
  "meta": { "cmd": "vc job status", "job_id": "a1b2", "ts": "2026-10-13T10:55:06+08:00", "seq": 42 }
}
```
失败时 `ok:false`、`data:null`、`error:{kind, message, hint}`——**hint 是给 agent 的
处置指令**（下一步该做什么），一等公民字段。

### 4.2 状态码枚举 × HTTP × agent 处置

| code | HTTP(/api/cli) | exit(--cli) | 语义 | agent 处置 |
|---|---|---|---|---|
| OK / OK_IDEMPOTENT | 200 | 0 | 成功 | 继续编排 |
| ERR_USAGE | 400 | 1 | 命令不存在/参数缺失/拼写 | 按 hint 改参重试一次，仍败→上报用户 |
| ERR_VALIDATION | 422 | 2 | 参数值非法（路径不存在、越界、JSON 形态错） | 换参重试；路径类先 vc file browse |
| ERR_NOT_FOUND | 404 | 2 | 资源不存在（job_id 过期/预设无） | 重查列表，勿盲目重试 |
| ERR_JOB_ACTIVE | 409 | 4 | 已有活动作业 | 转 vc job status 跟踪既有作业（hint 带其 job_id） |
| ERR_JOB_FINISHED | 410 | 4 | 作业终态且快照过期 | 取 vc report diagnostic 汇总上报 |
| ERR_PERMISSION_READONLY | 403 | 3 | readonly 档被拒 | 停止该类动作，把步骤文字化上报用户 |
| ERR_PERMISSION_DECLINED | 406 | 3 | standard 档用户点了取消 | 尊重决定，中止该子任务 |
| ERR_FORBIDDEN | 403 | 3 | 禁区命令恒禁 | 立即中止该意图，hint 指明需用户手动 |
| ERR_PENDING_CONFIRM | 202 | — | L2 待确认条展示中 | 轮询 vc cli-confirm 直到用户决定 |
| ERR_BACKEND | 502 | 5 | 上游端点/内部异常（透传脱敏） | 重试一次；仍败上报 |
| ERR_FFMPEG | 500 | 6 | ffmpeg 执行失败（附 stderr 摘要+错误模式码） | 按 hint 改参数或上报 |
| ERR_TIMEOUT | 504 | 5 | 命令超时（探测/扫描） | 缩小范围重试（--dir 深度等） |

### 4.3 参数字符串安全（内核强制）

`--items/--params` 等 JSON 参数：后端 **schema 白名单校验**（未知键→拒 ERR_USAGE，
继承 v3.14.x relay「请求体 url 字段被忽略」的同款纪律）；路径参数只允许绝对路径字符串，
内核层禁 shell 拼接（subprocess 列表参数化——项目既有模式）。`/api/cli` 仅 POST、
仅同源、请求体总大小上限 256KB（防 DOM/日志洪水与内存攻击）。

## 5. 日志格式（三处同构，JSON-lines）

```json
{"ts":"2026-10-13T10:55:06+08:00","level":"info","event":"cli.exec","cmd":"vc job start-convert","source":"agent-cli","perm":"standard","decision":"confirm_shown","job_id":"a1b2","seq":38}
```

| 字段 | 说明 |
|---|---|
| ts/level | ISO8601+时区；debug/info/warn/error |
| event | cli.exec / cli.confirm / job.start / job.item_done / job.finish / probe.fail … |
| source | gui \| agent-cli \| cli-process |
| decision | allowed / blocked_readonly / blocked_forbidden / confirm_approved / confirm_declined |
| seq | 作业内单调游标（§2.4） |

落地面：① `--cli` 模式 → stdout 只打**最终信封单行**，日志行走 stderr（脚本可分离捕获）；
② 控制台桥 → 结果区渲染信封 + 页内既有 logBox 追加一行 `[CLI]`（复用 writeMetaScopeLog
同构函数，不动 lastLogCount 轮询游标——v3.14.0 已验证的隔离纪律）；
③ `/api/cli` 服务端：每命令一条 JSON-line 进应用日志（诊断报告可聚合）。

## 6. 编排逻辑（page-agent 侧）

### 6.1 任务分解模式（五拍）

```
探测(probe/file scan) → 校验(codec-check + 输出路径预检) → 提交(job start-*)
→ 轮询(job status --since-seq, 节律见 6.3) → 分支处置(成功→done；失败项→6.4 决策树)
```

### 6.2 命令手册注入（vendor prompt 不可改 → 走 DOM）

- 控制台组说明区（常显 DOM 文本）：列出 9 组×代表命令（≈300 字精简版）；
- `vc help` 输出全量清单、`vc help job` 输出组内每条命令的参数与示例——agent 需要细节时
  **自己发 help 命令读结果**，等价于动态 function schema 的 description 面；
- 实证依据：bundle PageController 收集元素 textContent（textarea/input 值收录已证），
  `<pre>` 结果块文本进观察面。升级 vendor 时该收录行为列入回归检查。

### 6.3 轮询节律（写死，防 LLM 即兴高频）

提交后 5s 首查 → 之后每 15s 一查（agent 用内置 wait 15）；连续 4 次 progress_pct
无变化 → 查 vc job log 找卡点；eta_sec>1800 → 建议转 done 上报"长任务已提交，
job_id=xxx，稍后用 vc job status 查询"。**增量游标保证每次只读新行，token 消耗恒定。**

### 6.4 失败恢复决策树

```
items_state 含 failed:
├─ 失败原因=ENCODER_UNAVAILABLE(表内映射 ERR_FFMPEG 细分) → vc config codec-check → 换编码器重提失败子集(--items 仅失败项)
├─ 失败原因=SOURCE_MISSING/PROBE_FAIL            → vc probe file 复核路径 → 修正重提
├─ 失败原因=DISK_FULL(诊断码)                    → vc sys monitor 取证 → 上报用户(不自动重试)
├─ 部分成功部分失败                              → 先 vc report generate 汇总 → 询问用户：跳过(fail 项 vc job skip-item)或重提
└─ 作业整体 ERR_BACKEND 中断                     → 最多重试整任务 1 次(--request-id 复用幂等) → 仍败上报
```

### 6.5 权限衔接

见 §2.2。关键差异：**standard 档一次 L2 任务只产生一次确认条**（旧：每个模拟动作
都可能触发前端门）。确认条本身是 DOM（agent 可观察状态：ERR_PENDING_CONFIRM），
agent 的正确行为是 wait+轮询确认结果，而非重复提交。

## 7. 示例调用流程

### 7.1 批量转码 + 打元数据（多任务编排）

```
用户指令：把 G:\264 目录里的视频批量转 H.265 快速档，输出到 G:\265out，完成后把拍摄时间写进元数据

agent 序列（每步=一次控制台交互）：
1. vc file scan --dir G:/264
   → {"ok":true,"data":{"files":[{"path":"G:/264/a.mp4","size":...},...],"count":5}}
2. vc config codec-check --codec libx265        → available:true
3. vc job start-convert --mode batch --items '[{"input":"G:/264/a.mp4","output":"G:/265out/a.mp4"},...]'
     --params '{"codec":"h265","preset":"fast","crf":23}' --request-id op-20261013-01
   → standard 档：{"code":"ERR_PENDING_CONFIRM"} → agent wait 5 → 重试读状态 → 用户点确认 →
     {"ok":true,"data":{"job_id":"j-7f3a"}}
4. vc job status --id j-7f3a --since-seq 0 → 每 15s 增量轮询至 finished
5. 5 个文件全 done → vc job apply-metadata --items '[{"file":"G:/265out/a.mp4","settings":{"date_source":"source"}}]'
   →（一次确认条）→ 轮询完成 → vc report generate --data 汇总 → done 上报
```

操作数对照：**6 次控制台交互 + 轮询**，替代旧路径估算 ≈25–40 次模拟点击/读屏。

### 7.2 长任务 + 部分失败恢复

```
轮询返回：{"phase":"running","failed":[{"idx":2,"reason":"ERR_FFMPEG:encoder not available"}],"..."}
1. vc job status 确认 2 号仍在跑 → 不干预
2. finished 后：vc config codec-check --codec hevc_nvenc → available:false（本机无 NVENC）
3. 决策树 SOURCE/ENCODER 分支：vc probe file --path G:/264/c.mp4 → 校验源文件完好
4. 重提失败子集：vc job start-convert --items '[失败2项]' --params '{"codec":"h265","preset":"fast"}'
5. 成功 → vc report generate 合并两轮结果 → done
```

### 7.3 禁区示例（配置变更被拒）

```
vc config set --custom_ffmpeg_path D:/ffmpeg/bin
→ {"ok":false,"code":"ERR_FORBIDDEN","error":{"message":"该命令对 AI 助手恒禁",
   "hint":"设置类修改请由用户在 设置 面板手动完成"}}
agent 行为：立即中止该意图，把"需要什么配置改动"文字化上报用户。不重试。
```

## 8. 迁移改造方案（三阶段）

### Phase 1 — CLI 内核 + 控制台桥（v3.15.0 本体）

| 改动 | 文件 | 说明 |
|---|---|---|
| CLI_REGISTRY + /api/cli + 参数校验 + 权限强制 | `cli_kernel.py`（新）/ `app.py`（挂路由，~30 行） | L0/L1 全量先通，L2 带确认条 |
| 作业 seq 游标 + 终态快照保留 | `app.py`（jobs 字典维护处） | 每作业 log 单调计数；终态快照 10 分钟 |
| 控制台 UI（textarea+按钮+结果 pre+说明区） | `static/index.html` | 新 id 全部登记门禁 05 EXPECTED_ADDED |
| 命令执行/确认条渲染/help | `static/js/86-cli.js`（新，数字前缀=90 之前） | 前端只解析与转发，**不裁决权限** |
| 门名单收口 | `static/js/85-agent.js` | 包装门保留为 UX 双保险，注释标注 Phase2 降级 |
| 门禁 12 | `scripts/frontend-gate/12-cli-kernel.js` | 断言：注册表权限字段全覆盖/信封键一致/控制台 DOM 齐备/agent-cli 源标不缺失 |
| 兼容承诺 | — | 旧端点/旧 DOM id/GUI 路径零改动；控制台组默认折叠 |

### Phase 2 — 权限门后端化 + ADV 消解（v3.15.x）

- `/api/cli` 成为**唯一 agent 可执行面**；85-agent.js 函数包装降级为"仅防 GUI 面板
  误触发"的 UX 层，安全语义以后端为准（双轨收敛，ADV-1 的链式继承洞随前端门退役消解，
  OPEN-DECISIONS 关闭并升格 ADR）；
- standard 确认条文案按命令语义定制（消解 ADV-2）；
- 运行时验收迁移：`_verify_agent_runtime_v3140_qa.js` 的拦截断言改打 /api/cli。

### Phase 3 — vendor 原生通道（远期，条件触发）

- 触发条件：升级 page-agent bundle 且 `scripts/_poc_custom_tool_webview.js` 重跑
  **tools 数组出现自定义工具**（vendor 导出工具工厂/改认 `~standard` 接口/提供 JSON
  Schema 直通）；
- 届时 CLI_REGISTRY 直接投影为 customTools（inputSchema 用 vendor 认可形态），
  控制台桥退居兜底；`--cli` 入口不变——**三通道同一内核是迁移不变式**。

## 9. 验收标准（EARS）

| 编号 | 标准 | 优先级 |
|---|---|---|
| AC-01 | When agent 经控制台提交批量转换，系统**必须**在单次 L2 任务上至多产生一次确认交互 | P0 |
| AC-02 | When 任何 CLI 命令执行（成功或失败），系统**必须**返回 §4.1 信封且键集一致（门禁 12 全命令断言） | P0 |
| AC-03 | If 会话为 readonly/full 且命令为 FORBIDDEN/L3，系统**必须**返回 ERR_FORBIDDEN/ERR_PERMISSION 且**零后端副作用** | P0 |
| AC-04 | When GUI 未启用 AI 助手，控制台组**必须**不可见且 /api/cli 拒绝无 source 标以外的一切 agent 语义（GUI 零回归，门禁 01–11 全绿） | P0 |
| AC-05 | When agent 以相同 `--request-id` 重复提交 start 类命令，系统**必须**返回既有 job_id 且**不**新建作业 | P0 |
| AC-06 | While 作业运行中，`vc job status --since-seq` 两次调用**必须**不重复返回同一日志行（seq 单调） | P1 |
| AC-07 | If 参数含未声明键/路径不存在/JSON 非法，系统**必须**拒绝（ERR_USAGE/ERR_VALIDATION）且 hint 指明修正动作 | P0 |
| AC-08 | When 作业完成，终态快照**必须**保留 ≥10 分钟供 `vc job status` 取回 | P1 |
| AC-09 | 「批量转 5 个文件并打元数据」任务，headless 实测 agent 控制台交互数 **≤10**（对照基线 ≈25） | P1 |
| AC-10 | If `--cli` 进程模式执行，stdout **必须**恰为一行信封 JSON，stderr 为 JSON-lines 日志 | P1 |
| AC-11 | When vendor bundle 升级，PoC 脚本**必须**重新执行且结果登记于本 Spec 变更记录 | P2 |
| AC-12 | 全部门禁（含新增 12）+ 既有回归套件（queue 185/geo 99/reuse 35/report 27/agent 59）**必须**全绿方可发布 | P0 |

## 10. 风险与开放问题

| # | 风险 | 缓解 |
|---|---|---|
| R1 | `/api/cli` 单入口扩大攻击面：任意 JSON 透传=内部端点被拼越权 | §4.3 白名单校验 + 仅 POST + 同源 + 256KB 上限；门禁 12 加"未知键拒绝"断言；比照 relay 归一化全等教训（v3.14.1 B1） |
| R2 | 控制台结果 DOM 陈旧误导 agent（读到上次 JSON 做决策） | 信封带 cmd 回显 + job_id + ts；每次执行清空结果区再渲染；轮询语义用 since-seq 而非读屏 |
| R3 | windowed exe 无 CRT std 句柄，`--cli` stdout 可能为 None | handler 用 `GetStdHandle(-11)` 重建 FileIO 输出，失败回退落盘 `cli_out.json` 并在 stderr 指明路径；Phase1 以 HTTP 主通道不阻塞 |
| R4 | 双轨权限（前端包装+后端强制）迁移期裁决不一致 | Phase1 后端为准、前端仅 UX 层；差异用例写入门禁 12；Phase2 前端门降级完成收敛 |
| R5 | 长 JSON 被 vendor 观察面截断 → agent 读半截 | 结果区默认输出紧凑信封（summary+failed 全量、items_state 仅异常项）；`--full` 显式求全量并分块 |
| R6 | 手册注入依赖 textContent 收录，vendor 改版可能改变 | AC-11 把 PoC 重跑变成版本门禁 |

**与 OPEN-DECISIONS 联动**：ADV-1 在 Phase2 关闭（本设计后端强制收口）；ADV-2 在
Phase2 定制文案关闭；通道 C 复活判定已资产化为 PoC 脚本 + AC-11。

---

## 11. 变更记录

| 日期 | 内容 | 原因 |
|---|---|---|
| 2026-10-13 | 初版（38 命令/12 AC/三通道权衡） | v3.15.0 设计立项；架构师两次 429 未产出，项目总监按 Spec-as-contract 亲自产出（留档），待配额恢复后独立复核 |
| 2026-10-13 | **Phase1 实施回写（提交 8bc451e）**：①实际注册 39 条（vc cli-confirm 为确认流补入）；②Spec §2.4 假设修正——实测后端 /api/convert 本无并发拒绝（互斥只在前端 ActiveJob），CLI 直连绕过它；内核补 _SUBMIT_CMDS 单活动互斥（pending/running 均视为活动），语义同设计、实现位置不同；③用户取消确认返回明确 ERR_PERMISSION_DECLINED+HTTP 406；④确认条 1.5s 人性化延迟防护（UX 层防助手秒批自家确认，安全边界仍在后端）；⑤apply-metadata 提交前可用性预检（对齐 v3.13.3 判据，非法提交不弹垃圾确认条）；⑥幂等检查先于互斥（重放返回原结果不被别的活动作业误拒）；⑦门禁 08 资源清单盲区修复（v3.14.0 遗漏 85-agent，现 16 项含 86-cli 与 vendor）；⑧顺带修复既有潜伏 bug：app.py 的 logger 从未定义，多处调用一直被 try 吞掉 | 实施验证发现（C 组 36 断言基线上的事实校准，AC-05 幂等语义经真 dev 进程复验） |

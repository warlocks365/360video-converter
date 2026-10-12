# Spec：page-agent 集成方案 v3.14.0

> 日期 2026-10-12 ｜ 状态：待实施
> 上游输入：docs/FEATURE_CATALOG.md（能力真源）、docs/AGENT_INTEGRATION_ASSESSMENT.md（选型）、page-agent 1.12.4 包体实测（类型定义逐文件核对）

## 1. 锁定决策

| 项 | 决策 | 依据（全部实测，非推测） |
|---|---|---|
| 引入产物 | `page-agent@1.12.4` 官方 IIFE bundle（228,364 B，sha1 `4817e4ee7699d538c97f3356eb6012ce2384f8c2`，tgz sha512 与 npm integrity `o+9lFDNF…9g==` **字节级匹配**）本地化到 `static/agent/page-agent.iife.js` | D1 CDN 静默失败先例；npm 完整性已验证 |
| 加载方式 | **惰性注入**：`enable_ai_agent` 开启且用户点「AI 助手」按钮时才 `<script src="/agent/page-agent.iife.js?autoInit=false">`；不进 index.html | 关键：bundle 检测 `currentScript.src` 的 `autoInit=false` 才不自动创建连阿里测试端点的 demo agent（实测源码 `autoInit=currentScriptURL?.searchParams.get('autoInit')!=='false'`，**无查询参数=自动初始化**，直接普通引入=隐私事故）；Flask `static_url_path=''` 支持 `/agent/…` 带查询（leaflet 先例） |
| 初始化 | `new window.PageAgent({ baseURL, apiKey, model, language:'zh-CN', maxSteps, stepDelay, temperature?, transformRequestBody, customFetch })`；纯 GUI 文本 DOM 路线，**不使用 customTools**（需 zod schema，bundle 未暴露 tool/zod → 无构建环境不可构造；能力走内置 10 工具：done/wait/ask_user/click_element_by_index/input_text/select_dropdown_option/scroll/scroll_horizontally/execute_javascript(关)） | IIFE 仅暴露 `window.PageAgent`（实测 grep） |
| 实验工具 | `experimentalScriptExecutionTool` **保持缺省 false**（不传）；`experimentalLlmsTxt` 不开 | bundle 源码默认关 |
| LLM 通道 | `customFetch` 改写请求到 **Flask 代理 `/api/agent_relay`**，服务端从 `_settings.json` 注入真实 Authorization 与 baseURL 拼接，且**仅允许转发到设置中已保存的 agent_base_url**（防开放代理） | D4 CORS 教训（dashscope/llama.cpp 跨域不可靠）+ 密钥集中管理 |
| 思考模式/推理深度 | 设置项 `agent_thinking`（默认/开启/关闭）与 `agent_reasoning_effort`（auto/low/medium/high/xhigh/max）；由 `transformRequestBody` 注入 `body.reasoning={effort}` + `body.reasoning_effort` +（thinking=开启时）`body.chat_template_kwargs={enable_thinking:true}`；端点不支持则被忽略 | WorkBuddy models.json 的 reasoning.effort 惯例 + llama.cpp chat_template_kwargs 惯例 |
| 权限控制 | `agent_permission`：`readonly`（只读浏览）/ `standard`（触发任务前 confirm）/ `full`（完全信任）。**实现=函数包装法（v1.1 修订，原"派发器插钩子"方案作废）**：实测关键动作按钮多为内联 onclick（startBtn 等，全项目内联事件残留 115 处），data-action 钩子覆盖不到；且函数包装完全收敛在 85-agent.js 内、零侵入既有模块。85-agent 载入时保存原函数并定义 window 同名代理（内联 onclick 运行期解析到 window 同名属性，必然经过包装）；包装名单=`startConversion` / `startMetadataApply` / `startMetadataBatchRun` / 取消任务函数 / `savePresetDialog` / `deletePreset` / 批量删除函数（以 60-jobs.js、40-files.js 实际导出名为准）。agent 活跃标志 `__vcAgentActive` 由 `onBeforeTask`/`onAfterTask` 置/清——**非 agent 期间直通，用户手动操作零影响**；`saveSettings` 与模型端点修改在 agent 期间一律拦截（Agent 自我改写配置=失控回路，FEATURE_CATALOG 表E 禁区） | 包装面=全部 L2/L3 入口实测清单；不依赖 zod |
| 功能开关 | `agent_enabled` 默认 **false**；关闭时零注入、零感知（D6） | 评估 D 节要求 |

## 2. 设置项清单（AI 助手组，参考 WorkBuddy 自定义模型接入）

现有字段：`amap_api_key` / `amap_security` / `auto_load_tasks` / `custom_ffmpeg_path`（浅合并、无白名单 → **后端零改动即可持久化新字段**）。

| id | 字段 | 控件 | 默认 | 说明 |
|---|---|---|---|---|
| settings_agent_enabled | agent_enabled | checkbox | false | 主开关 |
| settings_agent_base_url | agent_base_url | text | 空 | OpenAI 兼容根（如 `http://192.168.1.42:8888/v1`）；placeholder 给本机/局域网/云三示例 |
| settings_agent_api_key | agent_api_key | password | 空 | **GET 不回显明文**（后端对 key 字段返回掩码 `••••`+已设标志；POST 收到掩码哨兵 `__KEEP__` 时保留旧值——新约定，app.py GET/POST settings 两处小改） |
| settings_agent_model | agent_model | text | 空 | 模型名 |
| settings_agent_thinking | agent_thinking | select 默认/开启/关闭 | default | 思考模式 |
| settings_agent_effort | agent_reasoning_effort | select auto/low/medium/high/xhigh/max | auto | 推理深度 |
| settings_agent_temperature | agent_temperature | number 0–2 step0.1 | 空 | 留空不发送（bundle 注释：非标准参数，多数模型拒绝） |
| settings_agent_max_steps | agent_max_steps | number 1–100 | 40 | bundle 默认 40 |
| settings_agent_step_delay | agent_step_delay | number 0–5 step0.1 | 0.4 | bundle 默认 0.4s |
| settings_agent_permission | agent_permission | select readonly/standard/full | standard | 权限控制 |

数据流向警示文案（设置面板明示，P0-3 禁空洞文案）：「开启后页面文本（含视频文件路径、参数值）将发送到你配置的模型端点；默认模型/端点为空时 AI 助手不可用。」

## 3. 文件改动面

| 文件 | 改动 |
|---|---|
| `static/agent/page-agent.iife.js` | 新增（vendor，sha1 记录在旁）+ `static/agent/VENDOR_LICENSE.txt`（MIT + browser-use 致谢原文转录）+ sha1 自检串 |
| `static/js/85-agent.js` | 新增：懒加载、构造、vcAgentGate、panel 容器、agent-toggle 动作、失败降级 toast |
| `static/js/00-core.js` | `DELEGATED_ACTIONS` 注册 `agent-toggle`；派发器在调用 handler 前调 `window.vcAgentGate?.(action, el) !== false`（1 行） |
| `static/js/10-ui.js` | openSettings/saveSettings 扩展 agent 字段；header 「AI 助手」按钮显隐（仅 agent_enabled 时显示） |
| `static/index.html` | #settingsModal 内新增「AI 助手」分组控件 + header 按钮（ico() SVG，禁 emoji） |
| `app.py` | ① `POST /api/agent_relay`（仅转发到已存 agent_base_url+路径白名单 `/chat/completions`；`_https_urlopen`；错误结构化回传）② GET settings 对 `*_key`/`agent_api_key` 返回掩码；POST 遇 `__KEEP__` 保留旧值 ③ **不新增 DEFAULT 字段**（浅合并天然兼容，缺省即关） |
| 门禁 | 05 登记新增 id（约 11 个）；06 自动校验 `agent-toggle`；01 会把 `static/js/*.js` 全量 vm 语法检查——85-agent 通过；**vendor 不进 static/js 所以 01 不扫**（设计如此，不放宽门禁）；07 jsdom 不受影响（无同步 script 注入）；10 扫 bundle 已证 0 命中 sk-/ghp_ |

## 4. 验收标准（EARS）

| 编号 | 标准 |
|---|---|
| AC-01 | While `agent_enabled=false`，系统**必须**不加载任何 agent 代码、不出现任何 agent UI 入口 |
| AC-02 | When 用户勾选启用并保存且填了 baseURL/model，系统**必须**在 header 显示「AI 助手」按钮 |
| AC-03 | When 点击 AI 助手按钮，系统**必须**以 `?autoInit=false` 注入 vendor、以 `new window.PageAgent(...)` 构造（**不得**出现连 `page-ag-testing-*.fcapp.run` 的网络请求），并展示面板 |
| AC-04 | If LLM 端点不可达/密钥错误，系统**必须** toast 中文错误且六模式功能零影响 |
| AC-05 | While `agent_permission=readonly`，agent 活跃期间对 L2/L3 动作（startBtn/metaApplyBtn/metaBatchRunBtn/cancel/presets 删除/原地覆盖），系统**必须**拦截并 toast 提示权限级别 |
| AC-06 | While `agent_permission=standard`，agent 触发 L2/L3 动作时系统**必须**弹 confirm 二次确认；用户手动点击不受影响 |
| AC-07 | 所有 LLM 请求**必须**经由 `/api/agent_relay`，页面**不得**直连 baseURL |
| AC-08 | GET `/api/settings` 响应中 **`agent_api_key` 必须为掩码**（前端从不使用其明文，见 §7）；`amap_api_key` 维持既有明文行为（运行期地图请求需要，改造风险大且不在本次范围） |
| AC-09 | While agent 运行中，用户点「停止」或 `stop()`，agent **必须**在 2s 内终止（bundle 原生 stop） |
| AC-10 | reasoning 参数组合：effort≠auto 时 relay 请求体含 `reasoning.effort`；thinking=开启时含 `chat_template_kwargs.enable_thinking=true`；均缺省时请求体不出现这些字段 |
| AC-11 | 门禁 01–10 全绿 + 既有套件不劣化（基线：queue 185/185、geo_bulk 99/99、reuse 35/35[REAL_TAG]、report 27/27、phase 29/29、addrfail 18/18、mode_clicks 7/7、08 打包断言、meta python 21/21） |

## 5. 端到端验证步骤

```bash
# 1. 门禁全量
for g in 01 02 03 04 05 06 07 09 10; do node scripts/frontend-gate/${g}-*.js; done   # 07 先起 8800 桩
# 2. 代理与掩码（Flask dev，8767）
curl -s --noproxy '*' http://127.0.0.1:8767/api/settings          # 断言 agent_api_key 为掩码
curl -s --noproxy '*' -X POST http://127.0.0.1:8767/api/agent_relay -d '{"path":"/chat/completions","body":{"model":"m","messages":[]}}'  # 未配 baseURL → 400 结构化错误
# 3. CDP 真实 exe：注入设置 → 点 AI 助手 → 断言 window.PageAgent 实例存在、面板 DOM 出现、
#    断言 network 无 fcapp.run 请求、readonly 门拦截 startBtn 点击、standard 门出 confirm
# 4. 真实推理冒烟（可选，需 LAN 端点在线）：execute("切换到元数据工具页签") → 断言 modeTab 激活态变化
```

## 6. 已知坑提醒（从记忆召回）

- 折叠参数必须 display:none，禁惰性渲染（collectParams 读 DOM）——设置弹窗新组同理
- DOM id 硬契约；me_/p_ 的 `_opts`/`_options` 后缀不对称，新 select 用项目现行约定
- 事件 handler 调 async 须先同步设共享状态（agent-toggle 置 `__vcAgentActive` 的顺序）
- esc() 在 JS-in-attribute 上下文不充分——agent 文案一律 textContent 或 data-action
- exe 启动验证勿用 `| head`（断管杀进程）；测试 curl 一律 `--noproxy '*'`
- 凭证：本文件与代码**不得**出现任何真实 key；默认值留空

## 7. 为什么 agent key 可掩码而 amap key 不行（设计取舍）

实测 grep 结论：`amap_api_key` 在运行期被 `20-map.js:36` 取**明文**拼进 `/api/geocode` 的 query，且 `10-ui.js:185` 回填到输入框、`:331` 另存 localStorage 兜底——对它做掩码会直接破坏地图搜索，改造面超出本次范围，故**保持既有行为不动**。

`agent_api_key` 则设计成**前端永远不需要明文**：所有 LLM 请求经 `customFetch` → `/api/agent_relay`，由后端从 `_settings.json` 自行读取并注入 `Authorization`。因此：
- GET `/api/settings` 对 `agent_api_key` 返回掩码（已设则哨兵 `__KEEP__`，未设则空串；另有布尔 `agent_api_key_set` 供前端摆 placeholder）；
- 前端**不写 localStorage**（避免第二次持久化面）；
- POST 收到掩码哨兵 `__KEEP__` 时后端保留旧值，收到空串时清空；
- 输入框默认显示掩码占位，用户不重新输入就不会覆盖真实 key。

这样 key 的明文只存在于 `_settings.json`（APPDATA）与后端进程内，不经过前端 DOM、不进 localStorage、不进日志。

## 8. 变更记录

| 日期 | 变更内容 | 原因 | 影响范围 |
|---|---|---|---|
| 2026-10-12 | v3.14.1 修复轮（QA 对抗验收 B1/B2/A1/A2/A3）：① relay 转发改用归一化路径（`/chat//completions` 等松散变体不再以非规范形态到上游）；② 权限门加**同步链式继承**标记（startConversion→startVR3D 单次确认，链深>0 时内层继承外层决策不再弹）；③ 启动期按设置恢复 agentToggleBtn（90-boot 调 vcRestoreAgentUI）；④ 名单补 saveReport/exportReportLog/openExternalUrl 三个 L2 对齐表E（11→14 项）；⑤ API Key 非 ASCII 入口校验 400+错误脱敏（消除 latin-1 内部异常回显） | 独立对抗验收（_verify_agent_v3140_qa.js 85/89→修复后复验、runtime 43/43） | app.py / 85-agent.js / 90-boot.js |
| 2026-10-12 | 实测修正：vendor Panel 构造内部自行接线 `agent.onAskUser`（bundle @217760），**ask_user 实际启用**（经助手面板人工应答，无自动副作用，可接受）——派单时"未设置 onAskUser→自动禁用"表述有误，不显式关闭 | QA 证伪第 7 点上报的规格矛盾 | 文档 |

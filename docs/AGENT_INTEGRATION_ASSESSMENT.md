# 360video-converter · Agent 能力扩展选型评估报告

> 评估日期：2026-09-30 ｜ 评估对象：`alibaba/page-agent` vs `HKUDS/CLI-Anything`
> 评估目标：为本项目（Windows 桌面应用，Flask(8765) + pywebview/WebView2 本地网页 UI，六大转码模式，HTTP API ~50 端点）选择合适的开源项目集成，扩展"对接 AI Agent"的能力
> 结论先行：**推荐 alibaba/page-agent**；CLI-Anything 不作为集成对象，但其 CLI 规范值得借鉴（见第六节）

---

## 一、两个项目是什么（事实摘要）

### alibaba/page-agent
- **定位**："JavaScript in-page GUI agent. Control web interfaces with natural language." —— 一个 `<script>` 标签给**任意网页**装上自己的 AI Agent（页面内 GUI 智能体）
- **版本/维护**：v1.12.4（2026-09-06），Alibaba 官方仓库，CI 齐备，npm 持续发版，Chrome 商店扩展上架，Hacker News 讨论，Trendshift 榜单
- **原理**：**纯文本 DOM 操作**——无截图、无多模态模型、无浏览器扩展依赖；DOM 处理组件与 prompt 源自 browser-use（MIT，已在 LICENSE 致谢）
- **模型**：BYO LLM，OpenAI 兼容接口（`baseURL`/`apiKey`/`model`），官方支持主流云模型与**本地部署模型**
- **生态**：可选 Chrome 扩展（跨页面任务）+ **MCP Server（Beta）**（让外部 Agent 客户端控制浏览器）
- **许可证**：MIT
- **分发**：npm 包（`page-agent`）+ IIFE 产物可直接 `<script src>` 引入（含 `?autoInit=false` 手动实例化模式）；bundlejs 显示 minified+gzip 体积很小（zod 为 peer dep）

### HKUDS/CLI-Anything
- **定位**："Making ALL Software Agent-Native" —— 把**任意软件**变成 AI Agent 可直接操控的 CLI：输入源码/GitHub 仓库，7 阶段流水线（Analyze→Design→Implement→Test→Doc→Publish）自动生成生产级 Click CLI（REPL + `--json` + undo/redo），配套 CLI-Hub 包管理器（40+ 现成 harness：GIMP/Blender/LibreOffice/OBS 等）
- **版本/维护**：HKUDS（港大数据科学实验室，LightRAG 同门），GitHub Trending，arXiv 技术报告（2606.03854），飞书/微信社区，活跃
- **原理**：Python 3.10+/Click 8.0/pytest；"结构化接口 TO 软件，不替代软件"——生成的 CLI 委托真实后端渲染；SKILL.md 自动生成供 Agent 技能发现；MCP 仅作为部分 harness 的桥接（非一级协议）
- **限制（README 自述）**：依赖前沿大模型做生成（弱模型产物不完整）；目标软件只有二进制时质量大降；常需多轮 `/refine`；**Windows 需装 Git for Windows（bash/cygpath）或 WSL**
- **许可证**：Apache 2.0

## 二、七维度对比

| 维度 | alibaba/page-agent | HKUDS/CLI-Anything | 对本项目的意义 |
|------|--------------------|--------------------|----------------|
| **核心功能与定位** | 给**自己的网页 UI** 加页面内 Agent（SaaS Copilot） | 为**第三方软件**从源码生成外部 CLI | 本项目诉求是"让 Agent 操控本软件"——两者都有交集，但作用面不同（界内 vs 界外） |
| **架构与实现原理** | 纯前端 JS/TS，文本化 DOM 决策，无需截图/多模态/无头浏览器 | Python 生成器流水线，产出 Click CLI 包，委托真实后端 | 本项目前端是 WebView2 渲染的本地网页 → page-agent 的运行环境天然存在 |
| **与本项目契合度** | **高**：项目 README 的"SaaS AI Copilot——lines of code, no backend rewrite"用例与本项目完全对口；六大模式的全部 UI 能力即刻被 Agent 覆盖；现有 Flask API 无需改动 | **中低**：本项目**已有** ~50 个结构化 REST 端点，"从源码生成 CLI"的边际价值低；生成 CLI 反而要维护第二套接口随 API 演进同步 | page-agent 复用全部既有功能与门禁保障；CLI-Anything 需要额外维护层 |
| **集成难度与改造成本** | **低**：IIFE 产物 `<script>` 引入（支持 `autoInit=false` 手动实例化）+ 一个 LLM 配置项（baseURL/key/model）。半天级 | **中高**：跑生成器需把源码喂给前沿 LLM（多轮 refine）；产物为独立 Python 包，需测试与持续维护；Windows 需 Git bash/WSL | 两者都可行，但成本差一个量级 |
| **依赖体积** | IIFE minified+gzip 很小（zod 为 peer dep），无 Python 依赖 | 生成物本身轻（Click/pytest），但方法论要求真实后端 + 前沿 LLM 生成 | page-agent 对打包体积影响可忽略 |
| **许可证** | **MIT**（含 browser-use 源码致谢，合规清晰） | Apache 2.0 | 两者均无商用障碍 |
| **社区与维护** | Alibaba 官方 + npm/Chrome 商店分发 + HN 讨论 + 2026-09 仍在发版 | HKUDS 学术团队 + Trending + arXiv + 40+ harness 生态 + 中文社区 | 均健康；page-agent 更"产品级"，CLI-Anything 更"方法论+生态" |

## 三、推荐结论：alibaba/page-agent

**理由（按权重排序）**：

1. **运行环境天然匹配**：本项目 UI 就是 pywebview/WebView2 渲染的本地网页（Chromium 内核）。page-agent 的唯一硬前提"一个网页"已经存在，`dist/iife/page-agent.js` 的 `<script>` 引入方式与本项目**无构建器、13 文件按序加载**的前端架构完全兼容，不需要引入 npm/bundler 工具链。
2. **零后端改动即获全功能覆盖**：Agent 驱动的是现有 UI，六大模式的全部能力（含批量勾选、参数面板、进度/日志区）即刻可被自然语言操控，且这些 UI 已被 9 项门禁长期守护——不需要像 CLI-Anything 那样再生成并维护一套平行接口。
3. **离线可用**：BYO LLM 走 OpenAI 兼容协议，可指向本机 llama.cpp（qwen3.6-27b，OpenAI 兼容端点）实现**全离线 Agent**，符合桌面工具的用户预期；也兼容云端模型。
4. **文本 DOM 路线对资源友好**：无截图/多模态需求，与 `--disable-gpu` 的 CPU 渲染环境（v3.13.0 闪烁修复的既定形态）无冲突，token 消耗也远低于视觉方案。
5. **MIT + Alibaba 官方维护 + 产品级分发**：法律与持续演进风险低。

**CLI-Anything 不推荐为集成对象的原因**：本项目已有完整结构化 API，其"从源码生成 CLI"的核心价值在本项目上边际收益低；生成过程需将源码交给外部前沿 LLM（多轮 refine，源码外发面扩大，与本项目"源码/凭证最小暴露"的工程红线相悖）；生成物是**第二套需要长期同步维护的接口层**（API 每次演进都要重新生成/测试）；Windows 依赖 Git bash/WSL。**但其三项规范值得直接借鉴**（见第六节）。

## 四、page-agent 集成方案骨架（建议实施路径）

1. **加载**：`static/` 增加 `page-agent.iife.js`（**本地化随包分发，禁用公网 CDN**——参照 Leaflet 本地化的既有先例：WebView2 环境公网 CDN 会静默失败）；以 `autoInit=false` 引入，在 `90-boot.js` 之后按需初始化（保持"90-boot 最后"的加载顺序红线）。
2. **LLM 配置**：设置面板新增"AI 助手"组（baseURL/apiKey/model，复用现有设置持久化与 `esc()` 约定）；默认可指向本机 llama.cpp 端点。密钥不入 git/日志。
3. **功能开关**：设置项 `enable_ai_agent`（默认关），关闭时不注入任何 Agent 代码——保证纯工具用户的现有体验与体积零感知。
4. **语言**：`language: 'zh-CN'`，提示词与界面一致。

## 五、关键风险点（集成前必须处理）

1. **DOM 契约红线**：page-agent 会给页面注入自己的面板 DOM/样式。本项目 **DOM id 是硬契约**（门禁 03/05/06 强校验）——注入元素必须使用独立前缀命名空间，且门禁 05 的"意外新增 id"断言需登记豁免清单，避免门禁假阴性。
2. **CSP/no-store/缓存**：界面资源 `Cache-Control: no-store`（after_request）对 page-agent 的静态文件同样生效（本地化文件随包，无外链缓存问题）；需确认无 CSP 注入冲突。
3. **LLM 密钥安全**：key 存本地设置（与地图 key 同路径），**绝不入 git/日志/记忆**；对公网 LLM 端点，页面截图不存在（文本 DOM 方案天然低敏感），但 DOM 文本（含文件路径）会发送给所配置的 LLM 端点——需在设置面板明示数据流向。
4. **Agent 触发破坏性动作**：Agent 经 UI 可启动转码/覆盖文件。建议：Agent 驱动的"开始转换"保持现有确认逻辑；在 README/设置中说明风险；长期可加"Agent 操作二次确认"开关。
5. **版本锁定**：page-agent 处于 1.x 快速迭代（当前 1.12.4），IIFE 产物**锁版本随包分发**，升级走显式变更流程。
6. **pywebview 环境差异**：WebView2 与标准 Chrome 行为基本一致，但需在 `--disable-gpu`（默认 CPU 渲染）形态下实测 Agent 面板交互无回归；纳入人工验收清单。
7. **失败降级**：LLM 端点不可达时 Agent 面板须优雅提示，不影响六模式正常使用（try/catch + 功能开关兜底）。

## 六、从 CLI-Anything 借鉴的三项规范（零集成成本）

1. **`--json` 输出约定**：本项目 HTTP API 已 JSON 化，但批量/错误响应可进一步统一"机器可读 + 人类可读"双形态（对 Agent 与脚本调用都友好）。
2. **SKILL.md 技能自描述**：为本项目编写一份 SKILL.md（能力清单 + 端点 + 示例命令 + 约束），使外部 Agent（Claude Code/Cursor/WorkBuddy 等）无需专门集成即可发现并正确使用本软件的 HTTP API——这是"对接 Agent"性价比最高的一步，与 page-agent 界内方案互补。
3. **确定性输出校验**：CLI-Anything 的"输出验证层"（产物存在性/完整性断言）思路与本项目门禁一致，可在 API 响应中增加 `output_path`/`output_sha256` 等校验字段，便于 Agent 闭环确认任务成功。

## 七、一句话结论

**集成 alibaba/page-agent（MIT，IIFE 本地化 + 功能开关 + 本地 LLM 兼容）为本软件界面注入自然语言 Agent；同时抄 CLI-Anything 的"SKILL.md 自描述 + JSON 输出"作业作为界外 Agent 的低成本补充——两条路都不引入重依赖，且不动现有后端。**

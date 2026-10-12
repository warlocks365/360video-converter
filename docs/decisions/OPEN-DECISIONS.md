# OPEN-DECISIONS 登记册

> 规则：只追加 + 就地关闭（OPEN → RESOLVED 补 Resolution）。未决项在每次 Phase 开始时复现到工作上下文最前面。

| Date | Source | Open Item | Related Constraints | Current Leaning | Blocked By | Resolves When | Status |
|------|--------|-----------|---------------------|-----------------|------------|---------------|--------|
| 2026-10-12 | v3.14.1 QA ADV-1 | `_wrapAgentAction` 链式继承（`_gatedChainDepth>0`）内层无条件继承外层决策、跳过自身 FORBIDDEN 检查。当前调用图安全（brace-matching 重建 14 函数链：唯一边 startConversion→startVR3D 同为 L2；saveSettings 零体内调用者），但属**隐性契约**——未来若有被包装的 L2 函数在同步体内调用 saveSettings/更高权限函数，链式继承会静默放行=失控回路 | design-decision-to-evaluate | 加「内层 FORBIDDEN 不继承、强制拦截」守卫（约 2 行），纳入下一个小版本 | 无（非阻断，当前无洞） | 下次动 85-agent.js 或新增包装函数时 | OPEN |
| 2026-10-12 | v3.14.1 QA ADV-2 | standard 档 confirm 文案对 openExternalUrl 显示「可能创建或覆盖文件」——打开外部链接不创建文件，通用文案与行为不符 | existing-design-boundary | `_wrapAgentAction` 文案按 level/动作定制或泛化措辞 | 无 | 下个 UI 文案轮 | OPEN |
| 2026-10-12 | v3.14.0 QA 第七点 | vendor Panel 构造内部自行接线 `agent.onAskUser`（bundle @217760），ask_user 实际**启用**（经面板人工应答，无自动副作用）。Spec §1 原表述「未设置 onAskUser→自动禁用」有误，已在 §8 订正为可接受 | existing-design-boundary | 保持启用（人工应答属可接受交互）；如需关闭可显式 `customTools:{ask_user:null}`（但 IIFE 不暴露 tool/zod，需评估可行性） | 无 | 用户提出关闭需求时 | OPEN |

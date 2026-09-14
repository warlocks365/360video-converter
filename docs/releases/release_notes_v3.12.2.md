# v3.12.2 — 修复侧栏内容挤压

本版是 **v3.12.1 的延续**，两者一起解决「三栏工作台」上线后暴露的布局问题。若你此前安装的是 v3.12.0，本版一次性包含以下全部修复。

---

## 问题现象（v3.12.0）

三栏工作台已呈现（左：参数配置｜中：工作区｜右：监控），但**左栏内容挤成一团**：

- 字段标签被逐字折行 —— 「视/频/编/码」「编/码/器/状/态」
- 编码器下拉框与状态列表被压扁，长选项文案严重折行
- 右栏系统资源（CPU/内存/磁盘/网络）数值被压断，「N/A」也换行
- 左栏右缘出现溢出的控件残留（下拉箭头等）

---

## 根因

**把「为全宽设计的面板」直接塞进了窄侧栏，且没有同步降级其内部的列布局。**

| 元素 | 原始设计语境 | 塞进侧栏后 | 后果 |
|------|------------|-----------|------|
| `#encodePanel` 内的 `.grid-4`（10 处） | 约 1160px 全宽 → 每列约 280px | 约 300px 侧栏 → 每列约 **57px** | 标签被压到 min-content，逐字折行 |
| `#encodePanel` 内的 `.grid-2`（2 处） | 每列约 570px | 每列约 **110px** | `#p_codec` 的 option 文本达 30 字符，严重折行 |
| `.sysmon-grid`（5 列） | 全宽卡片 → 每格约 230px | 约 250px 侧栏 → 每格约 **40px** | 数值与单位被压断 |

两个放大问题：

1. **`.field` 未设 `min-width: 0`** —— 网格项默认 `min-width: auto`，无法收缩到内容以下
2. **`.input, .select { width: 100% }` 但同样没有 `min-width: 0`** —— `<select>` 会按**最长 option** 撑出 min-content 宽度，直接撑破网格并产生横向溢出（即左栏右缘那些残留控件）

另外 `.field-label` 是不换行的 flex 行，文本项被压到 min-content 后只能逐字折行。

---

## 修复内容

### 1. 左右栏宽度重新分配（`app.css`）

```diff
-.app { max-width: 1680px; ... }
+.app { max-width: 1920px; ... }          /* 充分利用宽屏 */

-.workspace { grid-template-columns: minmax(260px, 300px) minmax(0, 1fr) minmax(240px, 290px); }
+.workspace { grid-template-columns: minmax(360px, 400px) minmax(0, 1fr) minmax(240px, 270px); }
```

左栏由约 300px 提升到约 400px —— 这是**参数配置面板能正常显示的前提**。

### 2. 左栏侧栏适配（新增规则块）

```css
.ws-col-left .grid-4,
.ws-col-left .grid-3 { grid-template-columns: 1fr 1fr; }   /* 四列 → 两列 */
.ws-col-left .grid-2 { grid-template-columns: 1fr; }        /* 两列 → 单列 */
.ws-col-left .field,
.ws-col-left .grid-2 > *, .ws-col-left .grid-3 > *,
.ws-col-left .grid-4 > * { min-width: 0; }                  /* 允许收缩到 min-content 以下 */
.ws-col-left .select, .ws-col-left .input { min-width: 0; max-width: 100%; }
.ws-col-left .field-label { flex-wrap: wrap; row-gap: 2px; }
.ws-col-left .card { padding: 14px; }                       /* 多让出 12px 内容宽度 */
.ws-col-left .field { margin-bottom: 10px; }
```

效果：字段宽度由约 57px 提升到约 **181px**，标签不再逐字折行；编码器下拉框独占整行，完整显示选项文案。

### 3. 右栏监控适配

```css
.ws-col-right .sysmon-grid { grid-template-columns: repeat(2, 1fr); }
```

每格由约 40px 提升到约 **110px**，数值与单位不再被压断。

### 4. 单列回落时撤销适配

回落断点由 1100px 调整为 **1180px**（再窄时中间工作区不足 420px，三栏的表格已无法阅读），并在该断点内把左右栏恢复为全宽语境：

```css
@media (max-width: 1180px) {
  .workspace { grid-template-columns: 1fr; }
  .ws-col-sticky { position: static; max-height: none; }
  .ws-col-left .grid-4, .ws-col-left .grid-3 { grid-template-columns: 1fr 1fr; }
  .ws-col-left .grid-2 { grid-template-columns: 1fr 1fr; }
  .ws-col-left .card { padding: 20px; }
  .ws-col-right .sysmon-grid { grid-template-columns: repeat(5, 1fr); }
}
```

### 5. 门禁 09 扩充（防止复发）

把「侧栏内容适配」也固化为强制检查，共 12 项。新增的 5 项：

- 左栏内 `.grid-4` 已降为两列（不再是四列）
- 左栏内 `.grid-2` 已降为单列
- 左栏内网格项已设 `min-width: 0`（防横向溢出）
- 左栏内卡片内边距已收紧
- 右栏内 `.sysmon-grid` 已降为两列（原 5 列在 250px 栏内每格仅约 40px）

**为什么必须写成门禁**：这类问题（全宽设计的面板 ↔ 侧栏语境）本质是**跨文件、跨语境的配置耦合**，与 v3.12.1 的「断点 × 窗口宽度」是同一类盲区 —— 单看任何一侧都正确，组合才出问题。CSS 的视觉效果在本环境无法自动化验证（jsdom 不做布局，无头浏览器无输出），只能靠门禁把约束显式固化。

---

## 各断点下的实际列宽（计算值）

| 视口宽度 | 左栏 | 中间工作区 | 右栏 |
|---------|------|-----------|------|
| 1900（1080p 最大化） | 400px | 约 1158px | 270px |
| 1440（默认窗口） | 400px | 约 698px | 270px |
| 1280 | 360px | 约 593px | 240px |
| ≤1180 | 单列（左右栏恢复全宽语境） | — | — |

左栏内容宽度约 372px（400 − 28 内边距），两列字段各约 181px。

---

## 验证

9 项门禁全部通过：

| 门禁 | 内容 | 结果 |
|------|------|------|
| 01 | 语法 + 资源引用 + CSS 配平 | 通过 |
| 02 | 跨模块引用完整性 | 通过 |
| 03 | DOM id 引用一致性 | 通过 |
| 04 | 运行时冒烟（Node vm） | 10/10 |
| 05 | id 契约 | 通过 |
| 06 | `data-action` 契约 | 20/20 |
| 07 | 真实 DOM 验证（jsdom） | 23/23 |
| 08 | 打包产物端到端 | 12/12 |
| **09** | **布局断点 + 侧栏适配（本次扩充）** | **12/12** |

---

## 已知限制

**CSS 视觉效果无法自动化验证。** 本环境无可用无头浏览器（静默无输出），jsdom 不实现布局引擎。上述列宽均为**按 CSS 规则推算**的结果，**真实渲染效果仍需人工确认**。若左栏仍显拥挤，可继续调宽左栏（`.workspace` 第一条列轨）或再折叠若干参数分组。

# 排查报告：为什么新版 UI 没有生效

**结论先行**：新版 UI 的代码与打包产物**都是正确的**，问题出在**三栏工作台被自身的响应式断点压回了单列，且是启动瞬间就发生的**。两侧配置数值冲突：

| 位置 | 配置 |
|------|------|
| `static/css/app.css` | `@media (max-width: 1280px) { .workspace { grid-template-columns: 1fr; } }` |
| `app.py` | `webview.create_window(..., width=1280, height=860)` |

应用窗口宽度恰为 **1280px**，减去滚动条后视口 ≤1280px → **媒体查询条件立即命中** → `.workspace` 被改成单列。而单列下的元素顺序（标题栏 → 模式标签 → 编码面板 → 业务面板 → 操作栏 → 系统资源 → 日志）与旧版布局几乎完全一致，因此观感上「毫无变化」。

**本质上是我在设计断点时没有核对应用窗口宽度**——三栏布局写好了、也打包进去了，却在第一帧就被自己的断点关掉。

---

## 一、排查过程（先证明「不是代码问题」）

按「先排除自己的产物、再怀疑运行环境」的顺序逐项验证：

### 1. 源码层面：CSS 规则齐全 ✓

`static/css/app.css` 中确认存在：
- `.app { max-width: 1680px }`
- `.workspace { display: grid; grid-template-columns: ... }`
- `.ws-col` / `.ws-col-sticky`
- `.param-group*` 手风琴折叠规则
- `.btn-lg`

### 2. 源码层面：DOM 结构正确 ✓

门禁 07（jsdom 真实 DOM）确认：`.workspace` × 1、`.ws-col` × 3、`param-group` × 9、`mainActionBar` × 1、事件委托可用。

### 3. 构建层面：EXE 里装的是新版 ✓

从**已安装的** `C:\Program Files\360video-converter\360VideoConverter.exe` 归档中提取 `static/index.html`，逐项校验：

```
归档条目总数: 1407
   static/index.html      ✓
   static/css/app.css     ✓
   static/js/00-core.js … static/js/90-boot.js  (10 个模块) ✓

static/index.html 内容校验（69833 字节）
   YES  ★ 三栏工作台容器        (class="workspace")
   YES  ★ 左/中/右栏包装        (ws-col-left / -center / -right)
   YES  ★ 手风琴分组            (param-group)
   YES  ★ 单一操作栏            (id="mainActionBar")
   YES  ★ 外部 CSS 引用         (/css/app.css)
   YES  ★ 模块化脚本引用        (/js/00-core.js)
   内联 <style> 块 : NO(OK)
   内联 <script> 块: NO(OK)
   归档内 VERSION : '3.12.0'
结论: 归档内是【新版】前端
```

同时确认安装时间线：已安装 EXE 的 mtime = `2026-09-14T05:38`（正是构建时间），`unins000.exe` = 15:37 —— **用户确实成功安装了新版**。

### 4. 环境层面：排除实例冲突与缓存 ✓

- 无 `360VideoConverter.exe` 残留进程，8765 端口空闲 → 排除「旧实例占用端口导致新版被单实例检查拦下」
- 定位 WebView2 用户数据目录，未见与本应用关联的持久化缓存

**至此，代码、构建、安装、运行时环境全部正常，问题只能出在 CSS 与窗口宽度的配合上——于是发现了两侧的数值冲突。**

---

## 二、根因详解

### 为什么症状是「完全没有变化」

单列回落后的元素顺序与旧版完全一致：

```
标题栏 → 模式标签 → [批量导入(仅批量模式)] → 编码参数面板
      → 业务面板 → 操作栏 → 系统资源 → 实时日志
```

三栏布局虽然把元素分到了三列，但**单列残留时就是这条竖线**，与旧版逐项对应。

唯一残留的可见差异是手风琴（箭头 + 2 个默认折叠的分组）。而我在设计手风琴时**刻意沿用了原 `.section-divider` 的字号/字重/大小写/颜色**以保持视觉一致，只把 `border-top` 换成 `border-bottom` 并加了个小三角 —— 差异非常不显眼，需要滚动到编码面板中部的 Okaa / Insta360 才能看到折叠效果。**这个「刻意保持一致性」的设计判断，反而掩盖了改动是否生效的信号。**

### 为什么此前的验证没发现

| 验证手段 | 覆盖 | 为何漏掉 |
|---------|------|---------|
| 门禁 01/02/03 | 语法、引用、id 契约 | 不涉及 CSS 媒体查询 |
| 门禁 05/06 | id 契约、`data-action` 契约 | 同上 |
| 门禁 04 | Node vm 冒烟 | 无 DOM、无 CSS |
| 门禁 07 | jsdom 真实 DOM | **jsdom 不实现 CSS 布局与媒体查询**，只能验证「DOM 里有没有 `.ws-col`」，无法验证「它们是否被排成三列」 |
| 门禁 08 | 打包产物 HTTP 校验 | 只能验证「资源被正确提供」，无法验证渲染 |

**核心教训：响应式断点与应用窗口宽度是一组必须联校的配置。单看任何一侧都是完全正确的——CSS 写对了、窗口尺寸也合理，组合起来才致命。这种「跨文件的数值耦合」正是静态检查的盲区。**

---

## 三、修复方案（已实施）

### 修复 1：降低单列回落断点，并给中间工作区让出宽度

`static/css/app.css`：

```diff
-.workspace { display: grid; grid-template-columns: minmax(280px, 320px) minmax(0, 1fr) minmax(260px, 320px); ... }
+.workspace { display: grid; grid-template-columns: minmax(260px, 300px) minmax(0, 1fr) minmax(240px, 290px); ... }

-@media (max-width: 1280px) {
+@media (max-width: 1100px) {
   .workspace { grid-template-columns: 1fr; }
   .ws-col-sticky { position: static; max-height: none; }
 }
```

两侧栏收窄后，中间工作区在 1280px 视口下仍可拿到约 730px（原先三列全开时约 650px）。

### 修复 2：加宽默认窗口，使三栏布局有足够展示空间

`app.py`：

```diff
 webview.create_window(
     '360° Video Converter',
     f'http://127.0.0.1:{PORT}',
-    width=1280, height=860,
-    min_size=(900, 600),
+    width=1440, height=900,
+    min_size=(1024, 640),
 )
```

在 1440px 窗口下，中间工作区约 810px，批量任务表（11 列）不再拥挤。

### 修复 3：界面资源禁用缓存（消除另一类「看不见的失效」）

`app.py` 新增 `after_request`：对非 `/api/` 路径统一下发 `Cache-Control: no-store`。

**为什么必须加**：应用通过 `http://127.0.0.1:<port>/` 提供界面，**各版本共用同一 URL**；而 Flask 对静态文件只发 `Last-Modified`/`ETag`、不发 `Cache-Control`，浏览器会套用启发式新鲜度，**可能直接复用上一版本缓存的 `index.html`**。这同样会表现为「装了新版但界面不变」，且无任何报错。本地单机应用资源极小（本次界面资源合计不足 300 KB），禁用缓存代价可忽略，换来「安装即生效」的确定性。

### 修复 4：新增回归门禁 09，把该约束固化为强制检查

`scripts/frontend-gate/09-layout-breakpoint.js` 自动校验：

- `.workspace` 确实是三栏 Grid
- 存在单列回落断点
- **默认窗口宽度 > 断点 + 100px 余量**（核心断言）
- 最小窗口宽度与断点的关系（提示，不判失败——用户手动缩小窗口时回落单列属预期行为）
- `app.py` 对界面资源下发了 `no-store`

同时扩充门禁 08：验证**打包页面**里含三栏结构（`.workspace` × 1、`.ws-col-*` × 3）、9 个手风琴分组，以及实际下发的 `no-store` 响应头。

---

## 四、验证结果

| 门禁 | 内容 | 结果 |
|------|------|------|
| 01 | 语法 + 资源引用 + CSS 配平 | 通过 |
| 02 | 跨模块引用完整性 | 通过 |
| 03 | DOM id 引用一致性 | 通过 |
| 04 | 运行时冒烟（Node vm） | 10/10 |
| 05 | id 契约 | 通过 |
| 06 | `data-action` 契约 | 20/20 |
| 07 | 真实 DOM 验证（jsdom） | 23/23 |
| 08 | **打包产物端到端（已扩充）** | **12/12** |
| **09** | **布局断点与窗口宽度协调性（新增）** | **7/7，窗口 1440 > 断点 1100** |

门禁 08 的关键输出：

```
OK   打包页面含三栏工作台结构            → .workspace=1, .ws-col-*=3
OK   打包页面含 9 个手风琴分组与单一操作栏  → param-group=9, mainActionBar=YES
OK   版本接口返回 3.12.1                → version = "3.12.1"
OK   首页下发 no-store（防止旧版页面被缓存复用） → Cache-Control: no-store, no-cache, must-revalidate, max-age=0
OK   CSS 资源下发 no-store              → Cache-Control: no-store, ...
```

---

## 五、验收步骤

安装 `installer_output/360VideoConverter_Setup_v3.12.1.exe` 后：

1. **打开程序，确认窗口标题栏右侧版本号为 v3.12.1**
2. **确认界面呈现三栏**：左侧「参数配置」｜中间「工作区」｜右侧「实时监控」，且右侧栏随滚动固定
3. **确认操作栏吸底**：向下滚动时操作栏始终停在窗口底部
4. **确认左侧编码参数面板出现 9 个可折叠分组**，其中「Okaa 双鱼眼校正」与「Insta360 原生文件处理」默认为折叠态（标题左侧三角向右）
5. 点击任一分组标题，应能展开/折叠

### 若仍未呈现三栏

按顺序排查：

1. **窗口宽度是否 ≥1100px** —— 三栏需要足够宽度，若窗口较窄请拉宽或最大化
2. 确认启动的是 `C:\Program Files\360video-converter\360VideoConverter.exe`（安装会原地升级旧版）
3. 若版本号显示的不是 v3.12.1，说明运行的仍是旧程序 —— 请先完全退出程序再重新安装
4. 兜底：删除 WebView2 用户数据目录后重启 —— `%LOCALAPPDATA%\Temp\tmp*\EBWebView`

---

## 六、本次排查的方法论收获

1. **「功能看起来没生效」要先分清是「没做」还是「做了但被关掉」**。本次通过直接解包已安装的 EXE 归档、逐项校验前端标记，把「代码/构建/安装」三个环节一次性排除，才把注意力集中到运行时。
2. **跨文件的数值耦合是静态检查的盲区**。CSS 断点与窗口尺寸各自都正确，组合才出问题。这类耦合必须显式固化为门禁（本次新增门禁 09）。
3. **为了视觉一致而刻意保留旧样式，会削弱「改动是否生效」的可观测性**。手风琴沿用了原分组标题的样式，导致改动虽在却不显眼。后续做同类改造时，应考虑给用户一个明确的「版本已更新」信号（如版本号 + 首屏可见的新结构）。
4. **本地 Web 应用应默认禁用界面缓存**。多版本共用同一 URL 时，缓存会让「是否生效」变得不可判定，且不产生任何报错。

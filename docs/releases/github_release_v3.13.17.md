# v3.13.17 — 修复「关于」按钮打不开

## 问题

点击「关于」按钮，下拉虽然展开，但**菜单位于窗口之外**，鼠标点不到任何菜单项——「版本号」「使用说明」均无响应。

## 根因

「关于」下拉 `.dropdown-menu` 使用 `position: absolute; top: calc(100% + 6px)`，其定位基准是外层 `.dropdown`（`position: relative`）。实测运行态 DOM 中**该包裹层不存在**（`document.querySelectorAll('.dropdown').length === 0`，`#aboutMenu` 的父元素直接是 `.header-actions`），导致绝对定位包含块退到 `BODY`——`top` 的`100%` 于是按**视口高度**计算，下拉被推到 `top: 867`，而视口高度仅 `861`，菜单项落在屏幕外，`openAbout` 从未执行（弹窗 `display:none`、内容长度 0、无任何报错）。

`.dropdown` 为何缺失尚未定论：源码与 exe 提供的 HTML 都含该元素，最小复现证明浏览器解析器不丢弃它，且非缓存问题（`Page.reload` + `ignoreCache` 后依旧缺失）。已确证**并非打包资源不同步**——v3.13.14/15/16 新增的元素在运行态均正常存在。

## 修复

不依赖可能缺失的包裹层，把定位基准上移到必然存在的容器，并加两层兜底：

1. `.header-actions { position: relative; }` —— `#aboutMenu` 的包含块由此固定为 header-actions，下拉贴在按钮下方；
2. `.dropdown-menu` 增加 `max-height: calc(100vh - 96px); overflow-y: auto;` —— 极端小窗口或长内容时不溢出屏幕；
3. `toggleAboutMenu()` 增加溢出兜底：若展开后整体落在视口下缘之外，自动改为向上弹出。

## 验证

- 门禁 01–09 全绿（07 37/37、08 12/12、09 12/12）
- 真实 exe 验收 **9/9**：下拉完全在视口内（修复前 `bottom=958 > winH=861`，修复后 `top=64bottom=155`）、定位基准为 `.header-actions`、菜单项可点、弹窗正常打开且内容填充正确（版本号 / 作者 / 项目主页）、关闭后再次打开正常、运行期零未捕获异常
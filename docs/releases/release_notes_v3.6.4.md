# Release Notes v3.6.4

## 修复问题

### BUG-H01: 地图无法显示、搜索结果无法选中

**严重程度：** 高（High）  
**影响范围：** 地图/位置选择功能

#### 现象
- 打开"选取拍摄位置"地图弹窗后，地图区域空白，不显示任何地图瓦片。
- 搜索地点后，点击搜索结果没有任何反应，无法选中位置。

#### 根因
地图引擎 Leaflet 通过外部 CDN (`https://unpkg.com/leaflet@1.9.4/dist/leaflet.js`) 加载。在桌面应用（pywebview + Edge WebView2）环境中，尤其是虚拟机或受限网络下，外部 CDN 加载存在以下风险：
- 首次打开地图时 `L` 对象未定义；
- `createMapInstance()` 调用 `L.map()` 抛出 `ReferenceError`，导致 `mapInstance` 始终为 `null`；
- 搜索结果点击后，`selectSearchResult()` 与 `reverseGeocode()` 在未做 `mapInstance` 空值保护的情况下调用 Leaflet API，直接抛出异常，表现为"无法选中"。

#### 修复内容
1. **Leaflet 本地化**：将 Leaflet 1.9.4 的 CSS、JS 及标记图标、图层图标等资源下载到 `static/leaflet/`，HTML 改为引用本地路径 `/leaflet/leaflet.css` 和 `/leaflet/leaflet.js`，彻底消除对外部 CDN 的依赖。
2. **修复 `createMapInstance._tries` 比较 BUG**：原代码 `createMapInstance._tries < 8` 在首次调用时 `_tries` 为 `undefined`，JS 中 `undefined < 8` 等价于 `NaN < 8`，结果为 `false`，导致容器尚未布局完成时无法进入重试逻辑。现改为先初始化 `_tries = (createMapInstance._tries || 0)` 再比较。
3. **Leaflet 加载检测**：在 `createMapInstance()` 开头检查 `typeof L === 'undefined'`，若 Leaflet 未加载则在地图容器内显示可见错误提示，而不是静默失败。
4. **地图操作空值保护**：在 `selectSearchResult()`、`reverseGeocode()`、`clearMapSelection()` 中加入 `if (!mapInstance)` 守卫，防止地图初始化失败时后续操作崩溃。
5. **标记图标路径修复**：通过 `L.Icon.Default.mergeOptions()` 显式配置本地标记图标路径，避免 WebView2 中默认图标路径解析错误导致标记不可见。
6. **全局错误捕获**：在脚本顶部添加 `window.addEventListener('error', ...)`，将未捕获的 JS 错误以 toast 形式展示，便于排查 WebView2 中的静默失败。

#### 新增文件
- `static/leaflet/leaflet.css`
- `static/leaflet/leaflet.js`
- `static/leaflet/images/marker-icon.png`
- `static/leaflet/images/marker-icon-2x.png`
- `static/leaflet/images/marker-shadow.png`
- `static/leaflet/images/layers.png`
- `static/leaflet/images/layers-2x.png`

#### 修改文件
- `static/index.html`
- `VERSION`

## 版本号

3.6.4

# v3.6.1 地图功能修复

## 修复问题

### 1. 地图不能正确显示（真正根因）
- **根因**：`index.html` 中 Leaflet CDN 引用的 `integrity`（SRI hash）与实际 CDN 文件不匹配，浏览器静默拒绝加载 Leaflet 库，导致 `L` 未定义，地图永远不初始化。
- **修复**：去掉错误的 `integrity` / `crossorigin` 属性，改用普通 CDN 引用。
- 同时保留以下防御性优化：
  - `openMapPicker` 使用双层 `requestAnimationFrame` 延迟初始化，避免 modal 布局未完成时创建 0×0 地图。
  - `#mapContainer` 添加 `flex-shrink: 0; min-height: 400px;`，防止 modal flex 布局压缩地图容器。
  - `createMapInstance` 增加容器尺寸守卫，0 尺寸时最多重试 8 次，之后强制创建。
  - 多次 `invalidateSize(false)` 确保 WebView 懒渲染时也能正确加载瓦片。

### 2. 国外地址搜索"失败"无反馈
- **根因**：`searchMap` / `reverseGeocode` 静默 `catch(e){}` 吞掉错误，且默认 `fetch` 无超时，慢速网络下用户永远看到"搜索中..."。
- **修复**：
  - 新增 `fetchWithTimeout(url, ms)`（基于 `AbortController`）。
  - 搜索/反向编码分别设置 12s / 15s 超时。
  - 失败时把高德/OSM 的具体错误（超时、SSL、网络）显示到结果区。

## 验证
- Nominatim / OpenStreetMap 可达（HTTP 200，2–3s）。
- Edge headless 自动化截图验证：主应用地图 modal 已正常显示 OSM 瓦片。

## 安装包
- 文件：`360VideoConverter_Setup_v3.6.1.exe`

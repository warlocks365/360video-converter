# v3.6.2 搜索结果显示修复

## 修复问题

### 搜索结果区域高度太窄无法看到结果
- **根因**：`.search-results` 的 `max-height` 仅 180px，且在 modal flex 布局中没有 `flex-shrink` 保护，被 `#mapContainer`（400px 固定高度）和其他兄弟元素挤压到几乎不可见。
- **修复**：
  - `.search-results` 高度从 180px → 280px，使用 `flex: 0 1 280px`（可弹性收缩但最小 120px）
  - 地图 modal `max-height` 从 80vh → 92vh，给搜索结果更多空间
  - `#mapContainer` 高度从 400px → 380px，为搜索结果让出空间
  - modal 内所有固定高度元素（header、search-bar、location-info、footer）添加 `flex-shrink: 0`，只有 `.search-results` 是唯一可弹性收缩的元素

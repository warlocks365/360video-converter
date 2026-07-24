# v3.7.0 发布说明

发布日期：2026-07-24

## 新功能

### 元数据工具批量执行列表（F-01）

元数据工具的批量模式从简单文件列表升级为完整的任务列表，与批量转换功能风格一致但独立实现：

- **表格化展示**：每行显示序号、源文件、大小、文件名日期、处理状态、操作按钮
- **勾选机制**：支持全选/全不选/单独勾选，仅处理勾选的文件
- **文件管理**：支持手动添加单个文件、移除选中、移除单个、清空列表
- **追加扫描**：多次扫描目录的结果会追加到列表，自动跳过重复文件
- **实时状态**：处理过程中实时显示每个文件的状态（等待中/处理中/完成/失败），完成后显示耗时
- **Toast 提示**：添加/移除文件时显示操作反馈

### 技术实现
- 新增 `metaBatchItems` 数据结构替代 `metaScannedFiles`，增加 `selected`、`status`、`statusMsg`、`duration` 字段
- 新增 `_metaProcessingIndices` 映射数组，将后端 item 索引映射回前端表格行
- `pollStatus` 中新增增量状态更新逻辑，仅在有状态变化时重新渲染表格
- 任务完成时进行最终状态渲染，确保所有文件状态被正确更新

## BUG 修复

### BUG-M10: 地图点击选点后"拍摄地点"输入框空白（中）

**现象**：通过地图点击选点（非搜索），点击"确认位置"后，"拍摄地点"输入框仍然空白。

**根因**：`mapInstance.on('click', ...)` 直接调用异步函数 `reverseGeocode(lat, lng)`，`mapSelectedLocation` 只在 `reverseGeocode` 完成后（API 响应返回后）才被设置。如果用户在 API 响应之前点击"确认位置"，`mapSelectedLocation` 为 null，`confirmMapSelection()` 弹出 alert "请先在地图上选择一个位置" 并返回，输入框保持空白。

**对比**：搜索选点（`selectSearchResult`）在调用 `reverseGeocode` 之前就立即设置了 `mapSelectedLocation`，所以不存在此问题。

**修复**：在地图点击事件中，立即设置 `mapSelectedLocation`（使用坐标作为临时名称），并更新 UI 显示（位置名称、坐标、地址占位符），然后调用 `reverseGeocode` 异步更新名称和地址。

### "拍摄地点"输入框说明

**用途**：存储地点名称（POI名称如"故宫博物院"，或坐标格式如"39.9092, 116.3974"），写入视频元数据的 `location.name` 标签，在照片管理软件中显示为拍摄地点名称。

**数据流**：`m_location_name` → `startMetadataApply()` → `location_name` 参数 → `/api/apply_metadata` → `apply_metadata_one()` → ffmpeg `-metadata location.name=xxx`

**地图选点后的填充逻辑**：
- 搜索选点：POI名称（如"故宫博物院"）
- 地图点击选点：坐标格式（如"39.9092, 116.3974"），API 返回后更新为地点名称
- 手动输入：用户可直接在输入框中输入地点名称

## 修改文件

- `static/index.html` — 地图点击选点修复 + 元数据批量执行列表
- `VERSION` — 3.6.5 → 3.7.0

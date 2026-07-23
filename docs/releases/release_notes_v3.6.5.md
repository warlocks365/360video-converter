# Release Notes v3.6.5

## 修复问题

### BUG-H02: 拍摄位置 GPS 坐标未写入媒体文件（国内外均受影响）

**严重程度：** 高（High）
**影响范围：** 元数据写入功能 — 位置标签

#### 现象
- 通过地图选取位置后应用元数据，元数据报告检查显示"拍摄位置：未设置"。
- 详细地址（comment 字段）能正确写入，但 GPS 坐标（location 字段）丢失。

#### 根因
MP4/MOV muxer 中 `location` 元数据映射到 QuickTime `©xyz` atom，该 atom 只能存储在
**格式级别**（moov/udta/©xyz），不能存储在流级别。代码使用 `-metadata:s:v:0`
（流级别）写入 `location`，ffmpeg 静默丢弃了该标签，导致 ffprobe 读取时找不到。

经实际测试验证：
- `-metadata:s:v:0 location=+39.9092+116.3974/` → `location` 标签**完全丢失**
- `-metadata location=+39.9092+116.3974/` → `location` 标签**正确写入** format.tags

#### 修复
将编码流程（`build_ffmpeg_cmd`）和元数据-only流程（`apply_metadata_one`）中的
`location` 和 `location.name` 元数据写入从 `-metadata:s:v:0`（流级别）改为
`-metadata`（格式级别）。`comment` 字段不受影响（原本就是格式级别）。

#### 修改文件
- `app.py` — 2 处 `-metadata:s:v:0` → `-metadata`（L1035, L1986）

---

### BUG-M09: 国外地址选取后详细地址未自动填入

**严重程度：** 中（Medium）
**影响范围：** 地图位置选取 — 国外地址

#### 现象
- 选取国外地址后，详细地址字段为空，需要手动填入。
- 选取国内地址则可正常自动填入。

#### 根因
`selectSearchResult()` 调用 `reverseGeocode()` 时未传入搜索结果中已有的地址。
`reverseGeocode()` 中 `address` 初始化为空字符串，当 Nominatim 反向地理编码失败
（如限流、超时）时，`mapSelectedLocation.address` 被覆写为空，丢失了搜索结果中
原始的 `display_name` 地址。国内地址因高德 API 通常成功返回而不受影响。

#### 修复
1. `selectSearchResult()` 调用 `reverseGeocode()` 时传入原始 `address` 作为回退
2. `reverseGeocode()` 新增 `fallbackAddress` 参数，当反向地理编码失败时使用该回退值

#### 修改文件
- `static/index.html` — `selectSearchResult()` 传参 + `reverseGeocode()` 签名和回退逻辑

## 版本号

3.6.5

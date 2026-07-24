# v3.8.0 — 元数据批量列表增强：任务内容显示 + 逐行编辑 + 自动探测

## 新增功能

### F-02: 批量列表任务内容显示
- 每行显示彩色标签（badge）概括该文件将执行的元数据操作
- 🌐 全景标签：显示投影模式（360°/180° + 单目/左右/上下）
- 📅 日期标签：显示将写入的日期值
- 📍 GPS 标签：显示经纬度坐标
- 无任务时显示"无任务（点击编辑设置）"提示
- 文件加入时显示"探测中..."加载状态

### F-03: 逐行编辑功能
- 每行增加 ✏️ 编辑按钮
- 点击打开模态对话框，显示该文件的元数据设置
- 可独立修改全景/日期/GPS 三项开关及其参数
- 保存后立即更新任务内容标签显示

### F-04: 自动探测已有元数据
- 文件加入批量列表时，后端自动调用 ffprobe + read_gspherical 探测
- 若文件已有全景元数据 → 全景开关自动打开，填入已有 pano_type/stereo_mode
- 若文件已有日期元数据 → 日期开关自动打开，填入已有 creation_time
- 若文件已有 GPS 元数据 → GPS 开关自动打开，填入已有经纬度/地址
- 全局功能开关卡片改为"默认设置"角色：仅对新加入且无对应元数据的文件生效

### F-05: 后端新增 `/api/probe_metadata` 端点
- 一次性返回文件的所有现有元数据（全景+日期+GPS+文件大小+文件名日期）
- 合并 ffprobe 和 read_gspherical 两步探测为单次 API 调用
- 用于批量列表添加文件时的自动探测

## 变更文件

| 文件 | 变更 |
|------|------|
| `app.py` | 新增 `/api/probe_metadata` 端点（~90 行） |
| `static/index.html` | 重构批量表格（任务内容列+编辑按钮）、新增编辑模态框、新增 `probeMetaFile()`/`editMetaFileSettings()`/`saveMetaFileSettings()`/`getDefaultMetaSettings()` 函数、新增 `.meta-badge` CSS、更新 `startMetadataApply()` 发送 per-item params |
| `VERSION` | 3.7.2 → 3.8.0 |

## 技术细节

- 后端 `metadata_worker()` 第 2153 行已支持 per-item params（`item.get('params') or job_params`），本次前端终于利用了这一能力
- `getDefaultMetaSettings()` 从全局开关卡片读取当前状态作为新文件的默认值
- `probeMetaFile()` 异步探测不阻塞 UI，探测完成后自动更新 `f.settings` 并刷新表格
- 任务标签用不同颜色区分：蓝色=全景、绿色=日期、橙色=GPS

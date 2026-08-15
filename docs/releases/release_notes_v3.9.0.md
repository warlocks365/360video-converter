# v3.9.0 发布说明 — VR 3D 合成 & Insta360 原生支持

## 新功能

### 1. VR 3D 360° 合成 (VR 3D Synthesis)

新增「VR 3D合成」标签页，支持将左右眼两个 360° 全景视频合成为一个带 3D 视差的 VR 360° 视频。

**功能特性：**
- 选择左眼和右眼视频文件
- 支持 Top-Bottom（上下排列，VR头显标准）和 Side-by-Side（左右排列）两种输出格式
- **视角一致性检测与修正**：自动检测左右眼视频的分辨率和时长是否一致，不一致时自动缩放对齐
- 合成后自动注入 GSpherical 立体元数据（StereoMode=top-bottom 或 left-right）
- 支持 8 种编码器（H.264/H.265 软件编码 + NVENC/QSV/AMF 硬件编码）
- 完整的进度显示和错误处理

**技术实现：**
- 后端：`build_vr3d_cmd()` 构建 ffmpeg vstack/hstack 命令
- 后端：`vr3d_merge_one()` worker 处理合成+元数据注入
- 后端：`check_vr3d_alignment()` 对齐检测函数
- 后端：`/api/start_vr3d` 和 `/api/vr3d/check_alignment` API 端点
- 前端：独立 VR 3D 模式面板，含左右眼文件选择器和对齐检测结果展示

### 2. Insta360 原生文件支持

转码器现在可以直接处理 Insta360 相机拍摄的原生文件格式。

**支持的文件格式：**
- `.insv` — Insta360 视频文件（MP4 + 双鱼眼画面 + 尾部元数据）
- `.lrv` — Insta360 低分辨率预览视频
- `.insp` — Insta360 照片文件（已加入文件类型）

**Insta360 专用处理选项（编码面板新增）：**
- **双鱼眼→全景拼接**（默认开启）：使用 ffmpeg `v360=dfisheye:equirect` 滤镜将双鱼眼画面转换为等距柱状 360° 全景
- **防抖 (FlowState 替代)**：使用 vidstab 滤镜实现画面防抖，作为 Insta360 FlowState 的开源替代
- **方向锁定**：通过 vidstab 防抖 + 地平线校正实现方向锁定效果
- **降噪**：使用 hqdn3d 滤镜减少暗光噪点
- **高级参数**：镜头 FOV（默认 200°）、Yaw/Pitch/Roll 微调

**自动配对检测：**
- 检测到 `.insv` 文件时，自动查找配对文件（`_00_` 前镜头 / `_10_` 后镜头）
- 在单文件模式下提示用户使用合并模式处理配对文件
- `/api/insta360/detect_pair` API 端点支持前端查询

**集成范围：**
- 单文件转换：自动检测 .insv 并应用 v360 滤镜
- 合并转换：支持 .insv 文件合并
- 批量转换：目录扫描包含 .insv/.lrv
- 文件选择器：新增 Insta360 视频过滤器
- 元数据处理：.insv 文件经过 v360 转换后自动注入 GSpherical 元数据

## 修改文件

- `app.py` — 新增 Insta360 辅助函数、VR 3D 合成命令构建器、worker、API 端点
- `static/index.html` — 新增 VR 3D 模式面板、Insta360 设置区域、前端函数
- `VERSION` — 升级到 3.9.0

## 技术参考

- [insv-to-yt](https://github.com/peterbraden/insv-to-yt) — Insta360 .insv 转 YouTube 360
- [insta360-cli-utils](https://github.com/syncom/insta360-cli-utils) — 命令行 Insta360 处理
- [InstaTrailer.jl](https://github.com/EvertSchippers/InstaTrailer.jl) — .insv/.insp 尾部元数据解析
- [Create Stereoscopic 360 Video with FFmpeg](https://salivity.github.io/ffmpeg/article/create-stereoscopic-360-video-with-ffmpeg) — vstack 立体视频合成

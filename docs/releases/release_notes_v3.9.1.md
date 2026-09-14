# v3.9.1 — Bug Fix Release

## Bug 修复

### Insta360 .insv 配对文件自动拼接修复

**问题**：转码器处理 `.insv` 配对文件时（如 Insta360 ONE X 等前代相机产生的前/后镜头双文件），虽然检测到配对文件但只打印警告提示用户"请使用合并模式"，没有自动将两个文件拼接。v360 的 `dfisheye` 格式期望两个鱼眼画面在同一帧中，但每个配对文件只含一个镜头，导致输出视频只有一半画面。

**修复**：
- `convert_one()` 检测到配对文件后，自动将配对路径存入 `params['_insv_pair']`
- `build_cmd()` 有配对时自动添加第二输入，使用 `filter_complex` 将前/后镜头 `hstack` 后再 `v360` 拼接
- 镜头顺序：前镜头 `_00_` 在左、后镜头 `_10_` 在右（匹配 dfisheye 格式）
- 无配对文件时（X4+ 单文件机型）保持现有逻辑不变

**filter_complex 链**：
```
[0:v][1:v]hstack=inputs=2[s0];
[s0]v360=dfisheye:equirect:ih_fov=200:...[s1];
[s1]null[vout]
```

## 受影响文件
- `app.py` — `convert_one()` + `build_cmd()` Insta360 分支
- `VERSION` — 3.9.0 → 3.9.1

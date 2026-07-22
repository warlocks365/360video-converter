# v3.3.3 — NVENC 编码崩溃三层容错修正

## 完成内容

修复用户在另一台电脑用 v3.3.2 批量编码 GoPro 合并视频时出现的 NVENC 编码器崩溃问题（rc=3221225477 = 0xC0000005 访问违规）。

## 根因

GoPro 源文件部分 NAL unit 损坏 → `merge_files()` 用 stream copy 模式（`-c copy`）合并时容忍错误继续（rc=0），但产生的临时文件包含损坏 NAL → NVENC 硬件编码器处理损坏帧时触发访问违规崩溃。软件解码器（native h264）通常能容忍损坏 NAL，但 NVENC 硬件解码器对损坏数据极敏感。

## 三层修正方案

| 层 | 位置 | 修改 | 作用 |
|---|---|---|---|
| 1. 合并容错 | `merge_files()` app.py:1247 | 添加 `-err_detect ignore_err -fflags +discardcorrupt -max_errors -1` | 合并时主动跳过损坏 NAL unit |
| 2. 编码容错 | `build_cmd()` app.py:823 | 在 `-i` 前添加 `-err_detect ignore_err -fflags +discardcorrupt` | 编码解码阶段容忍损坏数据 |
| 3. 自动回退 | `convert_one()` app.py:1440 | 检测 `rc=3221225477/-1073741819` → 回退 `libx265`/`libx264` 软件编码 | NVENC 崩溃后自动用软件编码重试 |

## 关键技术要点

- **0xC0000005 双形式**：Windows `subprocess.returncode` 可能返回 unsigned（3221225477）或 signed（-1073741819），两种都要检测
- **2-pass 不受影响**：`if mode == '2pass' and cp['group'] == 'cpu'` 限定 2-pass 只在 CPU 软件编码下使用，NVENC 走 else 分支，所以回退逻辑只需加在 else 中
- **清理 temp_out**：NVENC 崩溃后 temp_out 可能是半成品文件，回退前必须删除
- **映射关系**：`hevc_nvenc → libx265`、`h264_nvenc → libx264`

## 构建发布

- **版本号**：3.3.2 → 3.3.3（BUG 修复）
- **PyInstaller 构建**：成功（含静态 ffmpeg + NVENC/AMF/libVPL 硬件编码支持）
- **Inno Setup 编译**：成功（146.7 MB，143 秒编译）
- **Git**：commit `5d3b066` + tag `v3.3.3` + push 到 `v3.0.0-stabilization` 分支
- **GitHub Release**：https://github.com/warlocks365/360video-converter/releases/tag/v3.3.3
- **安装包**：`360VideoConverter_Setup_v3.3.3.exe` (146.7 MB)
  - 下载：https://github.com/warlocks365/360video-converter/releases/download/v3.3.3/360VideoConverter_Setup_v3.3.3.exe
  - SHA256: `697f689b43ca75df8dbe3d23b5a33a7d006c1461d4debde26c48fb5bca531073`

## 修改的文件

- `app.py` — 三处函数修改（merge_files, build_cmd, convert_one）
- `VERSION` — 3.3.2 → 3.3.3

## 升级说明

直接安装新版覆盖即可，用户数据（预设、任务列表、设置）保留。如遇到 NVENC 崩溃，v3.3.3 会自动回退到软件编码，虽然速度较慢但能完成编码。

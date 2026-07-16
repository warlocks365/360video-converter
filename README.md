# 360° 全景视频转换器 (360 Video Converter)

一个 Windows 下的 360° 全景视频批量转换工具，基于 **Flask + ffmpeg** 构建，内置 pywebview 容器（无需浏览器即可运行）。

## 功能特性

### 视频转码（单文件 / 批量 / 合并）
- 360° 全景视频批量转码：H.264 / H.265 软件编码，以及 NVIDIA NVENC、Intel QSV、AMD AMF 硬件编码
- GSpherical 全景元数据注入（群晖 Photos 等可识别）
- 从文件名提取拍摄日期并写入视频元数据
- 高德地图选取拍摄位置并写入 GPS 经纬度标签
- 编码测试输出：仅编码指定秒数片段用于快速验证参数
- 参数悬浮提示：每个参数旁的 `?` 图标悬停查看详细解释

### 元数据工具（无需重编码，流复制 `-c copy`）
- 独立使用日期写入、GPS 位置写入、GSpherical 注入
- 支持单文件和批量目录操作，可原地修改或输出到新目录

### 元数据报告
- 读取视频文件元数据和编码信息（基于 ffprobe）
- 生成格式化报告，可保存为文本文件
- 检测全景元数据、拍摄日期、GPS 位置等标签状态

### 任务管理
- 批量任务列表可保存 / 加载
- 可选自动加载上次任务列表

### 硬件编码支持与显卡驱动兼容性
内置的 ffmpeg 包含 **NVENC (NVIDIA) + AMF (AMD) + libVPL (Intel QSV)** 硬件编码支持。针对低版本 / 缺失的显卡驱动，软件采用「**检测 → 优雅降级**」策略：

1. **软件编码永远可用**：`libx264` / `libx265` 不依赖任何 GPU 或显卡驱动，在任何机器上都能转码，是硬件编码不可用时的可靠回退。
2. **硬件编码器真实探测**：对 NVENC / QSV / AMF，程序会真正执行一次 0.1s 测试编码来判断当前驱动是否支持，而非凭版本号猜测。
3. **运行时 DLL 检测**：检测 `nvcuda.dll` / `nvEncodeApi64.dll`（N 卡）、`libmfxhw64.dll` / `libvpl.dll`（Intel）、`amfrt64.dll`（A 卡）是否存在，缺失时提示"需要安装显卡驱动"。
4. **诊断与修复建议**：不可用的硬件编码器会显示 `[详情]`，给出具体报错与升级驱动的建议，避免用户选到会失败的编码器。

> 说明：当前为「检测 → 禁用 → 提示」模型。若希望进一步增强，可在任务开始时对失败的硬件编码器自动降级到 `libx264`。

## 目录结构

```
app.py                       # Flask 后端：API、转码、元数据注入、编码器检测
static/index.html            # 前端单页应用（原生 JS + CSS）
inject_spherical_metadata.py # GSpherical 元数据注入模块
build_exe.py                 # PyInstaller 打包脚本（生成单文件 EXE）
installer.iss                # Inno Setup 安装包脚本
folder_picker.cs             # 文件夹选择对话框（C# 源码）
start.bat                    # 开发模式启动脚本
requirements.txt             # Python 依赖
VERSION                      # 版本号（构建与安装包自动读取）
languages/                   # Inno Setup 多语言文件
test_*.py                    # 端到端 / API 测试脚本
```

## 开发环境运行

```bash
pip install -r requirements.txt
python app.py
# 浏览器打开 http://localhost:8765
```

## 构建 Windows 安装包

1. 准备 ffmpeg 静态构建，放到 `ffmpeg-static/`（需同时含 `ffmpeg.exe` 与 `ffprobe.exe`，建议带硬件编码器支持）。
2. 执行打包：

```bash
python build_exe.py
```

3. 使用 Inno Setup 6 编译安装包：

```bash
"路径\ISCC.exe" installer.iss
```

安装包文件名与内部版本号自动从 `VERSION` 文件读取。

## 高德地图 API Key

点击右上角「API Key」按钮设置高德地图 Web 服务 Key，用于 GPS 位置选取。
免费申请：<https://lbs.amap.com/>

## 许可证

详见 `LICENSE` 文件（待补充）。

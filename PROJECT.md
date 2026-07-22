# 360video-converter 项目说明

360° 全景视频转换工具：Flask 后端 + pywebview 前端，支持拼接合并、球面防抖、
GSpherical 元数据注入、全球地图选址（Leaflet + OSM）。

## 云资产策略（Cloud Assets）

本项目使用 **GitHub** 作为唯一云资产通道（`gh` CLI 走 git 凭证，独立于已断开的 MCP 连接器）。

| 资产类别 | 存放位置 | 同步方式 |
|---------|---------|---------|
| 源码（app.py / sysmon.py / stabilize.py 等） | GitHub 仓库 | `git push` |
| 前端（static/，含地图诊断页） | GitHub 仓库 | `git push` |
| 文档（docs/：分析、发布说明、测试报告、Bug 报告） | GitHub 仓库 | `git push` |
| 调试诊断（assets/diagnostics/：截图、DOM dump） | GitHub 仓库 | `git push` |
| 安装包（360VideoConverter_Setup_vX.Y.Z.exe） | GitHub Releases | `gh release create --notes-file docs/releases/release_notes_vX.Y.Z.md installer_output/360VideoConverter_Setup_vX.Y.Z.exe` |
| 构建产物（dist/ build/ ffmpeg 等二进制） | 不入库（gitignore） | 本地 + Releases 仅安装包 |

> 安装包与二进制被 `.gitignore` 排除（GitHub 单文件 100MB 限制），仅在 GitHub Releases 以云资产形式存档。

## 目录结构

```
360video-converter/
├── README.md              # 项目使用说明
├── PROJECT.md             # 本文件：项目与云资产组织
├── app.py                 # Flask 后端 + 所有 API 端点 + ffmpeg 调用
├── sysmon.py              # 全局系统资源监控（CPU/GPU/内存/磁盘/网络）
├── stabilize.py           # 视频防抖（vidstab + OpenCV 球面防抖）
├── inject_spherical_metadata.py  # GSpherical 元数据注入
├── static/                # 前端（原生 HTML/JS，无框架）
│   └── map-diagnostic.html # 地图调试诊断页（不带 SRI，用于对比排查）
├── docs/                  # 文档（入库云资产）
│   ├── BUG_REPORT.md
│   ├── overview.md
│   ├── test_report_v1.9.6.md / v2.0.md
│   ├── analysis/          # 性能/优化分析报告
│   │   ├── 360video-analysis.md
│   │   └── 360video-optimization-analysis.md
│   └── releases/          # 各版本发布说明
│       ├── release_notes_v3.6.1.md
│       └── release_notes_v3.6.2.md
├── assets/diagnostics/    # 调试诊断素材（入库云资产）
│   ├── diag_dom.html / diag_screenshot.png / main_dom.html
│   └── map_test_*.png     # 地图 modal 截图验证
├── installer_output/      # 安装包（gitignore，仅本地 + GitHub Releases）
├── installer.iss / build_installer.ps1 / build_exe.py / 360VideoConverter.spec  # 构建链
└── languages/             # i18n 语言文件
```

## 版本与发布

- 版本号规则：BUG 修复末尾 +1；功能改进中间 +1；重大功能大版本 +1
- 发布流程：PyInstaller onefile EXE → Inno Setup LZMA 安装包 → GitHub Release 上传
- 最新发布：v3.6.2（修复地图搜索结果区域高度过窄）

## 关键经验（详见 .workbuddy/memory/MEMORY.md）

- **SRI hash 静默失败**：CDN `<script integrity>` 与实际文件不匹配时浏览器静默拒绝加载，无任何错误提示
- **flex column 中需明确弹性元素**：只有搜索结果区 `flex: 0 1 280px` 可收缩，其余 `flex-shrink: 0`
- **地图 modal 初始化时机**：display:none→flex 切换后需双层 rAF 延迟 + 容器尺寸守卫

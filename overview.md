# v3.7.1 — 元数据批量列表 UI 修复

## 问题

用户反馈 v3.7.0 实现的元数据批量执行列表在元数据工具页面不可见，也看不到"加入批量列表"按钮。

## 根因

v3.7.0 使用单选按钮（"单个文件" / "批量（递归扫描）"）切换模式，批量列表隐藏在 "批量" 模式后。用户无法发现这个隐藏入口。而批量转换工具使用的是始终可见的"加入批量队列"按钮 + 任务列表表格的模式，两者风格不一致。

## 修复方案

移除单选按钮，改为与转换工具一致的模式：

1. **"📋 加入批量列表"按钮** — 与文件输入框并排，点击后将当前文件加入下方列表
2. **批量执行列表始终可见** — 不再隐藏在模式切换后
3. **扫描目录保留** — 作为批量导入的替代方式
4. **统一输出目录** — 留空 = 原地修改，同时适用于单文件和批量
5. **智能处理逻辑** — 有选中批量项→处理批量；列表为空→处理输入框单个文件

## 变更文件

| 文件 | 变更 |
|------|------|
| `static/index.html` | 重构元数据工具文件输入区域，移除 radio buttons，添加 `addToMetaBatchList()` |
| `VERSION` | 3.7.0 → 3.7.1 |
| `docs/releases/release_notes_v3.7.1.md` | 新增发布说明 |

## 构建产物

- `dist/360VideoConverter.exe` — 重新构建的 EXE
- `installer_output/360VideoConverter_Setup_v3.7.1.exe` — 安装包

## GitHub

- Commit: `a2ddaf1` on `v3.0.0-stabilization`
- Release: https://github.com/warlocks365/360video-converter/releases/tag/v3.7.1

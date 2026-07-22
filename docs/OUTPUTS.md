# 360video-converter — 本任务输出物清单（云资产归档）

> 任务：分析并修复合并编码失败 / 地图不显示 / 搜索结果区域过窄；并将整个任务整理进 360video-converter WorkBuddy 项目。
> 生成日期：2026-07-22
> 归档方式：本地产物（结果区可见）+ 待上传「我的云端网盘」（需连接云账户）

## 一、版本发布说明（docs/releases/）
| 文件 | 说明 |
|---|---|
| `docs/releases/release_notes_v3.6.1.md` | v3.6.1 发布说明：修复地图不显示（SRI hash 错误为真正根因）+ 防御性优化 |
| `docs/releases/release_notes_v3.6.2.md` | v3.6.2 发布说明：修复地图弹窗搜索结果区域高度过窄 |

## 二、诊断素材（assets/diagnostics/）
| 文件 | 说明 |
|---|---|
| `assets/diagnostics/map_test_small.png` | 地图 modal 小屏截图（初始诊断） |
| `assets/diagnostics/map_test_large.png` | 地图 modal 大屏截图 |
| `assets/diagnostics/map_test_small_v2.png` | 二次验证截图 |
| `assets/diagnostics/map_test_small_v3.png` | 三次验证截图 |
| `assets/diagnostics/diag_screenshot.png` | Edge headless 诊断截图 |
| `assets/diagnostics/diag_dom.html` | 诊断页 DOM dump（含 Leaflet 加载状态/容器尺寸） |
| `assets/diagnostics/main_dom.html` | 主应用 DOM dump（对比用） |

## 三、分析与概览（docs/analysis/、docs/）
| 文件 | 说明 |
|---|---|
| `docs/analysis/360video-analysis.md` | 性能/功能分析报告 |
| `docs/analysis/360video-optimization-analysis.md` | 优化分析报告 |
| `docs/analysis/overview.md` | 项目总体概览 |
| `docs/overview.md` | 工作区概览 |
| `docs/BUG_REPORT.md` | Bug 报告 |
| `docs/test_report_v1.9.6.md` | 测试报告 v1.9.6 |
| `docs/test_report_v2.0.md` | 测试报告 v2.0 |

## 四、项目定义与源码产出
| 文件 | 说明 |
|---|---|
| `PROJECT.md` | 项目结构与云资产映射清单 |
| `static/index.html` | 修复后的前端（地图 SRI 修复 + 搜索结果布局修复） |
| `VERSION` | 当前版本号（3.6.2） |

## 五、云端上传说明
WorkBuddy「上传到云端」支持：我的云端网盘、腾讯文档、ima 知识库、乐享知识库。
当前所有云连接器均处于 **disconnected** 状态，需在 WorkBuddy 内登录/连接对应账户后，
于结果区对以上产物点击「上传到云端」完成云资产同步。

GitHub Releases（v3.6.1 / v3.6.2 安装包）作为独立二进制通道留存，不计入云端网盘资产。

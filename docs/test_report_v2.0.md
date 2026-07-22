# 360° 全景视频转换器 — v2.0 修复验证报告

> 生成时间：2026-07-16
> 范围：修复上一轮发现的两个问题 + 升级到 v2.0 + 重新打包 + 全面验证

## 一、本轮修复的两个问题

### 问题 1：「关于」里版本号显示不正常（根因已定位并修复）
- **根本原因**：`build_exe.py` 的 PyInstaller 命令只打包了 `inject_spherical_metadata.py` 和 `static` 目录，**没有把 `VERSION` 文件打包进 EXE**。
  - 程序运行时（`_read_app_version()`）优先从 `__file__` 所在目录读 `VERSION`，但 onefile 打包后 `__file__` 在 `sys._MEIPASS` 临时目录，那里没有 `VERSION`。
  - 最后兜底 `os.getcwd()/VERSION` 只在「从源码目录启动 EXE」时碰巧命中——之前冒烟测试就是从项目目录启动，所以蒙混过关显示正确。
  - **安装后**（Inno Setup 装到 `C:\Program Files\...`）cwd 里没有 `VERSION` → 读不到 → 版本号显示异常（甚至 `unknown`）。这正是用户看到的现象。
- **修复（两处）**：
  1. `build_exe.py` 增加 `--add-data '{SCRIPT_DIR}/VERSION;.'`，将版本文件打包进 EXE 数据目录（`sys._MEIPASS`）。
  2. `app.py` 的 `_read_app_version()` 改为：当 `sys.frozen` 为真时，优先从 `sys._MEIPASS/VERSION` 读取，再回退到 `__file__` 目录 / 父目录 / cwd。

### 问题 2：默认 `x264_params` 含非法参数（日志报错）
- **问题**：`app.py` 中 `DEFAULT_PARAMS['x264_params'] = 'hrd=1:pic_init_qp=26'`，这两个选项对 x264 **均不合法**，ffmpeg 实际报 `Error parsing option 'hrd = 1'` / `'pic_init_qp = 26'`，随后被忽略（不影响转码成功，但日志报错、参数与 UI 不一致）。
- **修复**：将该值清空为 `''`（与原本实际被忽略的编码行为完全一致，最稳妥，不改变输出结果）。

---

## 二、验证测试与结果

### 验证 1：版本号读取（关键场景复现）
- **测试**：从 `C:\Users\warlocks`（**不含 VERSION 文件**的目录）启动 v2.0 EXE，模拟安装后环境。
- **结果**：`GET /api/version` → `{"version":"2.0"}` ✅
- **结论**：之前会显示 `unknown` 的场景现已正确返回真实版本，问题 1 修复确认有效。

### 验证 2：真实浏览器「关于 → 版本号」交互
- 页头版本标签：`v2.0` ✅
- 「关于」菜单展开 ✅ → 点击「版本号」✅ → 弹窗打开 ✅
- 弹窗正文：`当前版本：v2.0` ✅（原始报障点）
- 「使用说明」正常加载（592 字）✅
- 控制台错误：仅 1 条 `/favicon.ico` 404（浏览器自动请求，无 favicon 路由，无害）
- 失败的网络请求：0 ✅
- 截图证据：`_tmpchk/about_v2.png`

### 验证 3：x264 默认参数转换
- **测试**：用默认 `libx264` 参数提交单文件转码任务。
- **结果**：任务 `status=completed`，进度 100%，输出文件正常生成；编码日志中**已无** `Error parsing option` 报错 ✅
- **结论**：问题 2 修复确认有效。

### 验证 4：构建产物与打包
- `py_compile app.py`：通过 ✅
- PyInstaller 构建 v2.0 EXE：成功（`dist/360VideoConverter.exe`，15.7 MB，内置 ffmpeg/ffprobe）✅
- Inno Setup 安装包：成功（`360VideoConverter_Setup_v2.0.exe`，**95.4 MB**，与旧版体积一致，确认 ffmpeg/ffprobe 已正确打包）✅

---

## 三、交付物
- 独立 EXE：`dist/360VideoConverter.exe`（v2.0）
- 安装包：`installer_output/360VideoConverter_Setup_v2.0.exe`（v2.0，95.4 MB）
- 本报告：`test_report_v2.0.md`
- 截图证据：`_tmpchk/about_v2.png`

## 四、说明 / 非问题项
- `/favicon.ico` 404 属无害现象（浏览器自动请求，应用无 favicon 路由），非功能缺陷，未处理。
- 上一轮报告中 `/api/tasks/load` 405、`/api/convert` 400 为测试命令方法/参数使用不当所致，非应用缺陷，前端调用均正常（已通过端到端转换验证）。

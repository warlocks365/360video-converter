# v3.13.3 — 全面代码审查修复：5×P0 + 6×P1 + 元数据模块 2×BUG（覆盖自 v3.13.1 起的完整变更集）

本版本基于对 v3.13.1 的**全面代码审查**（3 路并行静态审查 + 主审逐条动态验证，报告见 `docs/CODE_REVIEW_v3.13.1.md`），并以 `G:\264` 真实全景素材完成**端到端验收测试**（24/24 + 元数据专项 21/21，报告见 `docs/ACCEPTANCE_v3.13.2.md` 与 `docs/ACCEPTANCE_metadata_v3.13.2.md`）。包含 v3.13.2 与 v3.13.3 两个内部版本的完整修复集。

## 一、P0 功能性 BUG 修复（5 项，均经真实运行复现后修复）

1. **合并转换：无音轨视频合并必败** —— `-map 0:a:0` 缺可选标记，任何无音轨源 100% 失败。已修复并实测通过。
2. **VR 3D 合成：非 original 分辨率必败** —— filter_complex 复用 `[v]` 标签 + 前导逗号导致图非法。改用中间标签 `[stk]` + `setsar=1`，双布局实测通过。
3. **元数据工具：球面注入 + 输出到新目录必败** —— 注入目标与 mux 输出同路径，Windows 下 `ERROR_USER_MAPPED_FILE`。改为独立临时文件注入后原子回写，零残留。
4. **批量编码：勾选过滤后状态整列错位** —— 新增 `_encodeProcessingIndices` 行映射，状态/耗时/跳过按钮不再作用于错误文件。
5. **VR 3D：布局选择被静默忽略** —— 提交链路改用 `collectVR3DParams()`，Side-by-Side 真实生效（输出 StereoMode=left-right 实测验证）。

## 二、P1 潜在缺陷修复（6 项）

1. **GPU 编解码利用率永缺失**（pynvml 多传参）——RTX 3090 真机实测：NVENC 编码期间 `gpu_enc_percent` 峰值 51%。
2. **Okaa 参数兜底吞 0** —— yaw_r=0 被吞成 180 等三处 `||` 兜底改为 `Number.isNaN` 判断，fov/blend 对齐后端默认。
3. **导出编码日志必 404** —— 任务完成后 jobId 已置空，新增终态 job id 缓存。
4. **保存自定义 ffmpeg 路径清空参数** —— 改为仅重跑编码器探测，不再整页重置。
5. **取消请求失败后取消按钮永久卡死** —— 失败/超时分支恢复按钮与暂停按钮。
6. **任务运行中可移除批量行** —— 三类移除操作增加运行态守卫。

## 三、元数据工具专项修复（v3.13.3，验收实测发现 2 BUG + 3 设计缺陷）

1. **地名（location_name）此前永远不写入 MP4** —— `location.name` 键被 mov muxer 白名单机制静默丢弃（对照实验证实）。改写 `description` tag（实测保留，ffprobe 可读）。
2. **文件创建时间（set_file_created）此前实际不生效** —— ctypes 句柄截断导致 SetFileTime 必败且错误被静默吞掉。重写 Win32 调用（显式 argtypes/restype + use_last_error），错误现在写入任务日志。同卷 .NET SetCreationTime 对照实验排除环境因素。
3. **批量 per-item 参数由"整体替换"改为"逐键合并"**（item 优先），部分参数不再丢失全局键。
4. **skip 端点拒绝已开始的项**（400），杜绝 skipped 与成功并存的矛盾状态。
5. **错误消息区分**"未启用任何功能"与"已启用但无实际效果（检查日期值/坐标）"。

## 四、工程与测试基建

- 全新验收脚本入库：`scripts/_verify_p0_v3132.py`（11 项）、`scripts/_acceptance_v3132.py`（24 项）、`scripts/_meta_tool_tests.py`（21 项），全部基于真实产物断言。
- 门禁升级：07 新增 4 项 P0 回归断言（36/36）；08 版本断言随版本演进；`_diag-flicker`/门禁/release 脚本移除硬编码用户路径（改 homedir 推导，跨机器可用）。
- 已知问题：`dist_bak/`/`build_bak/` 为构建备份目录（已加入 .gitignore）。

## 五、升级说明

- 安装包自动覆盖升级，配置与预设保留（`%APPDATA%\360VideoConverter\presets`）。
- 如遇 GPU 利用率不显示，请确认 NVIDIA 驱动已安装（安装包已内含 pynvml）。

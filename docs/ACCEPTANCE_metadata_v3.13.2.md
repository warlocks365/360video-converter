# 元数据工具模块 · 全功能实测报告（v3.13.2）

> 测试日期：2026-09-30 ｜ 方法：HTTP API 驱动打包 exe（127.0.0.1:8765），全部用例真实运行
> 被测端点：`/api/apply_metadata`（含批量、暂停/恢复、跳过）、`/api/status`、`/api/probe-source`
> 素材：`G:\264\` 真实全景视频派生的 5s 干净基线片段（`-map_metadata -1` 剥离全部源 tag，保证断言无歧义）；原素材只读
> 验证手段：ffprobe(format_tags/duration) + os.stat(FS 创建/修改时间) + 全文件字节扫描(UUID box/XMP/box 顺序) + 任务日志
> **结果汇总：21 条用例，16 PASS / 5 FAIL。5 条失败全部溯源至 2 个确认的真实 BUG（见第四节）。**

---

## 一、功能面清单（源码级依据）

| 功能项 | 代码语义（app.py / inject_spherical_metadata.py） |
|--------|--------------------------------------------------|
| 手动日期 | `manual_date`：`YYYY-MM-DD` 自动补 `T12:00:00`；完整 ISO 原样 |
| 文件名日期 | `date_from_filename`：5 种 DATE_PATTERNS（分隔 datetime / 紧凑带分隔 / 全紧凑 14 位 / 分隔 date / 紧凑 8 位），年份 2000–2099 校验，date-only 补 12:00 |
| 日期优先级 | `manual_date` **优先于** 文件名日期（仅当前者为空才走文件名） |
| creation_time tag | `set_creation_time=true` 时写 `-metadata creation_time=...`；MP4 muxer 将本地时间规范化为 UTC 秒（ffprobe 读回 `...Z`） |
| FS 创建时间 | `set_file_created` → ctypes CreateFileW+SetFileTime（仅 Windows） |
| FS 修改时间 | `set_file_modified` → os.utime |
| 位置 | `location_lat`+`location_lon` 同时存在才生效 → ISO 6709 `±dd.dddd±ddd.dddd/`（4 位小数，带符号）；`location_name` → `-metadata location.name=...`；`location_address` → `comment` |
| 球面 | UUID box + XMP：`<GSpherical:StereoMode>{mono\|top-bottom\|left-right}>`（**mono 也写入**）、`SourceCount`（mono=1，3D=2）、`ProjectionType=equirectangular` |
| faststart | moov 前置；false 时 mdat 在前 |
| test 模式 | `test_duration>0` → 输出加 `_test` 后缀 + `-t` 截短 |
| 输出目标 | 输入==输出（原地覆盖，meta_tmp 中转）或新目录（自动建目录） |
| 批量 | **per-item params 整体替换 global**（`item.get('params') or job_params`，非合并）；skip；pause/resume（项间生效） |

## 二、用例矩阵与逐项结果

> 每条含五要素；子断言逐项列出（✓=通过 ✗=不通过）。原始逐条证据见 `G:\264\_acceptance_v3132\meta_results.json`。

### 单项功能（8 条）

| # | 测试意图 | 参数预设 | 预期输出 | 实际输出 | 结论 |
|---|----------|----------|----------|----------|------|
| M01 | 手动日期 date-only 补 12:00 | manual=`2026-05-26`，tag 开，FS 关 | tag=本地 05-26 12:00（UTC 04:00）；FS 不变 | tag=`2026-05-26T04:00:00.000000Z` ✓；FS ctime/mtime 不变 ✓；无球面 ✓ | **PASS** |
| M02 | 手动日期完整 ISO 保真 | manual=`2026-05-26T15:30:00` | tag=UTC 07:30 | tag=`2026-05-26T07:30:00.000000Z` ✓ | **PASS** |
| M03 | 文件名日期（紧凑格式） | 输入名 `VID_20260526_103000.mp4`，date_from_filename 开 | tag=本地 10:30（UTC 02:30） | tag=`2026-05-26T02:30:00.000000Z` ✓ | **PASS** |
| M04 | 优先级 manual＞文件名 | manual=`2026-03-15T09:00` + 文件名 `20260101_080000` 同开 | tag=03-15 09:00，文件名日期不生效 | tag=`2026-03-15T01:00:00Z` ✓；≠01-01 08:00 ✓ | **PASS** |
| M05 | 仅 FS 创建时间 | set_creation_time=false, set_file_created=true, manual=`2026-04-18T06:00` | tag 无；**FS ctime=2026-04-18 06:00**；mtime 不变 | tag 无 ✓；mtime 不变 ✓；**ctime=当前时间未变 ✗** | **FAIL → BUG-2** |
| M06 | 仅 FS 修改时间 | set_file_modified=true，其余关 | tag 无；FS mtime=2026-09-01 22:10；ctime 不变 | mtime=`1788271800`（与期望完全一致）✓；ctime 不变 ✓ | **PASS** |
| M07 | GPS 三字段 | lat36.0671/lon120.3826+地名+地址 | location=+36.0671+120.3826/；地名 tag；地址 tag | location ✓；地址(comment=青岛市市南区东海西路) ✓；**地名 tag 缺失 ✗** | **FAIL → BUG-1** |
| M08 | 球面 mono | stereo=mono | GSpherical+StereoMode=mono+SourceCount=1+ProjectionType | 五项 XMP 断言全部命中（gs@3131/mono@3438/1@3489/equirect@3368/true@3187） | **PASS** |

### 组合场景（6 条）

| # | 测试意图 | 参数预设 | 预期输出 | 实际输出 | 结论 |
|---|----------|----------|----------|----------|------|
| M09 | 日期+位置组合 | manual=`2026-02-14T19:45`+lat22.54/lon114.05+地名地址 | 全 tag 齐全 | creation_time ✓；location=+22.5400+114.0500/ ✓；地址(南山区) ✓；**地名 ✗** | **FAIL → BUG-1** |
| M10 | 全功能组合（新目录） | 三类全开+输出到不存在目录 | 目录创建；tag+UUID 全齐 | 目录创建 ✓；creation_time ✓；location ✓；GSpherical+top-bottom ✓；地址 ✓；**地名 ✗** | **FAIL → BUG-1** |
| M11 | 球面单独（elif 分支） | 仅 apply_spherical, stereo=left-right | GSpherical+lr+SourceCount=2；干净基线其余 tag 不出现 | 全部命中 ✓；creation_time/location 无 ✓ | **PASS** |
| M12 | faststart=false | 全功能+faststart 关 | mdat 在 moov 前；元数据完整 | mdat@44 < moov@34537991 ✓；creation_time/location/GSpherical 全 ✓ | **PASS** |
| M13 | test 模式 | test_duration=3+全功能 | `out_m13_test.mp4`、时长≈3s、元数据齐全 | 后缀 ✓；dur=3.033s ✓；三组元数据全 ✓ | **PASS** |
| M14 | 负坐标符号 | lat=-33.86, lon=-151.21 | location=`-33.8600-151.2100/` | 完全一致 ✓ | **PASS** |

### 批量与多选排列组合（3 条）

| # | 测试意图 | 参数预设 | 预期输出 | 实际输出 | 结论 |
|---|----------|----------|----------|----------|------|
| M15 | **per-item 参数完全隔离** | 3 项各带完整独立参数（日期/坐标/球面各归一项），全局参数设为**干扰值**（2020-01-01、lat1/lon2、mono） | 每项输出=各自预设；干扰值零串入 | out1 日期=06-01✓ 且无位置/球面✓；out2 坐标=上海✓ 且无日期/球面✓；out3 球面=top-bottom✓（非 mono）且无日期/位置✓ | **PASS** |
| M16 | **同参数全功能 ×3 逐参数核验** | 3 项共用全功能参数 | 每项 5 项子断言全过（共 15 项） | 每项：creation_time ✓、location ✓、地址 ✓、球面+mono+SourceCount1 ✓、faststart ✓；**每项地名 ✗（3 项同因）** | **FAIL → BUG-1** |
| M17 | 批量暂停→跳过→恢复 | 6 项；启动即 pause，1s 后 skip idx=3，resume | item4 无输出+error=Skipped by user；其余 5 项正常 | pause/skip/resume 全 200 ✓；item4 skipped=True 无文件 ✓ err=Skipped by user ✓；其余 5 项 ok ✓ 日期正确 ✓ | **PASS** |

### 边界与异常（4 条）

| # | 测试意图 | 参数预设 | 预期输出 | 实际输出 | 结论 |
|---|----------|----------|----------|----------|------|
| M18a | 非法日期+FS 全关（无可执行动作） | manual=`not-a-date`, FS 均关 | failed，error=No metadata features enabled；warn 日志；无产物 | 三项全命中 ✓ | **PASS** |
| M18b | 非法日期+set_file_created=true（宽容路径） | manual=`not-a-date`, set_file_created=true | completed 但无 tag、FS 不动、warn 日志 | 全命中 ✓ | **PASS** |
| M19 | 仅纬度无经度 | apply_location, lat 无 lon | failed，error 含 No metadata features enabled；无产物 | 全命中 ✓ | **PASS** |
| M20 | 文件名无日期 | date_from_filename 开+文件名无日期+FS 开 | completed；warn "No date found"；无 tag；FS 不动 | 全命中 ✓ | **PASS** |

## 三、确认的 BUG（含复现条件与影响范围）

### BUG-1：地名（location_name）永远不写入 MP4 输出 —— 静默丢失
- **复现条件**：元数据工具任意场景（单项/组合/批量）启用位置功能并填写地名 → 输出 MP4。
- **实测证据**：M07/M09/M10/M16 的地名子断言全部失败；同一条 ffmpeg 命令中 `location`（坐标）与 `comment`（地址）都正常写入，唯独 `location.name` 键消失。独立对照实验：直接对干净片段执行 `-metadata location.name=TESTNAMETAG`，产物 ffprobe 无任何对应 tag（`comment`/`location` 均在）；`location_name`（下划线候选键）同样被丢弃。
- **根因**：MP4 mov muxer 对 udta 键名有白名单，带点号的 `location.name` 与下划线变体都不映射到任何 atom，**被静默丢弃**。后端 `app.py:2831-2833` 将地名拼成该键，且不校验写入结果。
- **影响范围**：元数据工具全部"位置写入"场景中的**地名**输入项（坐标与地址不受影响）；UI 提供该输入框但结果永远为空，用户无任何提示。
- **修复方向**（三选一）：① 地名并入 `comment`（与地址组合写入）；② 走项目已有的 UUID/XMP 注入机制（同球面元数据路径，任意键名可靠落盘）；③ MP4 输出下隐藏/禁用该输入框并在文档声明限制。**不建议**尝试其它下划线键名（已实测同样被丢弃）。

### BUG-2：FS 创建时间（set_file_created）实际不生效 —— 失败被静默吞掉
- **复现条件**：启用日期功能 + 勾选"设置文件创建时间"（set_file_created=true）→ 任务显示完成。
- **实测证据**：M05 应用内执行后 `os.stat` ctime 保持当前时间（期望 2026-04-18 06:00，diff≈1.6×10⁷ 秒）；任务日志只有 `Setting file dates to ...`，**无** `File creation date: updated` 成功行（`date_results['created']` 为 False）。同一函数的 mtime 分支（os.utime，M06）正常生效，排除整体函数未调用。
- **根因定位**：`app.py:509-558` 的创建时间分支依赖 `ctypes CreateFileW + SetFileTime`。按同代码独立复现：`CreateFileW` 返回 `INVALID_HANDLE_VALUE(-1)`（GetLastError=6）。**已排除环境因素**：同一卷同一文件用 .NET `[IO.File]::SetCreationTime` 立即生效（CreationTime=2026-04-18 06:00:00）。缺陷定位于该 ctypes 调用实现本身（未设 restype/argtypes 的返回句柄处理可疑），且 `created_error` 被**静默丢弃**（调用方只打印成功分支），导致失败不可见。
- **影响范围**：所有勾选"设置文件创建时间"的场景（这是 UI 默认勾选项）——文件系统创建时间永远保持原值，界面显示任务成功，用户无从察觉。
- **修复方向**：① 修正 ctypes 调用（显式 `argtypes`/`restype=HANDLE`，或直接改用 pywin32/pywin32-ctypes 的 `win32api.SetFileTime`）；② `created_error` 必须写入任务日志，失败时向用户暴露。

## 四、设计层面缺陷评估（非崩溃类，均有实测依据）

1. **per-item params 为"整体替换"而非"合并"**（`app.py:3032`）。API 直调时若 item params 只写变更键，会丢失 global 的其余键。前端始终下发完整快照（`f.settings || globalParams`）故当前用户不受影响，但该语义对二次开发/脚本调用是隐坑。建议改为逐键合并（item 优先）或在 API 文档显式标注。
2. **对"运行中"项的 skip 会产生自相矛盾状态**：实测（第一轮 M17，1s 时序竞态）skip 命中已开始的项时，该项仍跑完并产出文件，但状态被标记 `skipped=true, error=None`——"已跳过"与"已成功/已产出"并存。建议 skip 端点对已开始项返回 400 或忽略。（本轮已改用"暂停→跳过→恢复"确定性时序验证，跳过语义对未开始项正确。）
3. **"No metadata features enabled" 报错语义误导**（M18a）：用户明确启用了日期功能，仅因日期解析失败且 FS 开关关闭，得到"未启用任何元数据功能"。建议区分"功能未启用"与"参数无效导致无可执行动作"。
4. **set_file_dates 的失败静默**：`created_error`/`modified_error` 不进任务日志（BUG-2 长期不可见的直接原因）。属可观测性设计缺口。

## 五、未覆盖范围（如实说明）

- 地图选点 UI（`/api/geocode`/nominatim 外网依赖）与元数据**报告**模式（`/api/report`）不在本轮——本轮聚焦元数据**工具**的写入链路；
- Okaa/insv 专有格式源（素材库无此类文件）；UI 交互层（筛选/多选/入队已由门禁 07 jsdom 断言覆盖 36/36）。

## 六、结论

元数据工具的**核心写入链路真实可用**：日期三来源与优先级、UTC 规范化、FS 修改时间、GPS 坐标（含负坐标符号）、地址、球面元数据全取值（含 XMP 细节 SourceCount）、faststart 开关、test 模式、输出目标双路径、批量参数隔离与逐项完整性、暂停/恢复/跳过、全部 4 类边界场景——共 16/21 用例以真实运行证据通过。

**存在 2 个确认 BUG**：① 地名在 MP4 输出中静默丢失（影响所有位置写入场景的地名项）；② FS 创建时间设置实际不生效且失败被静默吞掉（影响默认勾选场景）。两者均给出复现条件、根因与修复方向，均为**中等级别**（数据静默缺失/不可见，不崩溃、不损坏文件）。**另有 4 项设计层面缺陷**（见第四节），建议随修复一并处理。修复地名建议优先采用方案②（复用已有 XMP 注入机制）。

---

## 七、修复验证（v3.13.3，2026-09-30 追加）

针对第四节两个 BUG 与设计缺陷实施修复后全量复测（被测对象：重新打包的 v3.13.3 exe）：

### 修复内容
1. **BUG-2（FS 创建时间）**：重写 `set_file_dates` 创建时间分支——显式 `argtypes`/`restype`（HANDLE 必须 c_void_p，旧代码默认 c_int 截断句柄导致 SetFileTime 必败）+ `use_last_error`；`created_error`/`modified_error` 现在写入任务日志（此前静默吞掉）。
2. **BUG-1（地名丢失）**：`location_name` 的写入键由 `location.name`（mov muxer 白名单外，实测静默丢弃）改为 `description`（白名单内，实测保留）。地名语义通过自由文本 tag 承载。
3. **设计缺陷 ①**：per-item params 由"整体替换 global"改为逐键合并（item 优先），两个 worker（conversion/metadata）同步修复。
4. **设计缺陷 ②**：skip 端点对已开始（有 start_time）的项返回 400 `Item already started, cannot skip`，杜绝 skipped+ok 并存的矛盾状态。
5. **设计缺陷 ③**：区分"未启用任何功能"（原消息保留）与"已启用但无可执行动作（检查日期值/坐标）"两种错误。

### 复测结果（同一 21 用例套件，v3.13.3 exe）
**21/21 全部 PASS**（首轮 16/21）：
- M05 恢复通过：FS 创建时间实际写入（ctime=2026-04-18 06:00 本地）
- M07/M09/M10/M16 恢复通过：地名以 `description` tag 落盘（ffprobe 实测值与输入完全一致）
- M15 新增 3 条隔离断言（description=Shanghai / 全局 BAD 不串入）通过
- M17 暂停/恢复/跳过语义不变，仍通过
- 门禁回归：01–06、09 全过；07 36/36；08 12/12（版本断言升至 3.13.3）

// id 契约基线固化与对拍
// ① 从改造前备份固化基线；② 从当前 index.html 提取；③ 逐值 diff
const fs = require('fs');
const path = require('path');
const R = path.resolve(__dirname, '../../static');
const BASE = R + '/index.html.v3910.bak';
const CUR = R + '/index.html';
const CONTRACT = path.resolve(__dirname, 'id-contract.json');

const extractIds = f => {
  const html = fs.readFileSync(f, 'utf8');
  return [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
};

const MODE = process.argv[2] || 'check';

// ── 有意变更登记（v3.11.0 统一性改造）──────────────────────────
// 元数据专属操作栏与共享操作栏结构完全相同、仅 id 前缀不同（meta* vs 无前缀），
// 造成 10 个进度 DOM 元素重复。按报告 P0-#4 合并为单一操作栏后，下列 meta* 进度
// 与按钮 id 被有意移除；#metaApplyBtn 保留并迁入共享操作栏。
// 已通过 _domcheck.js 确认：无任何 JS 仍在引用这些 id。
const EXPECTED_REMOVED = new Set([
  'metaProgressLabel', 'metaProgressPercent', 'metaOverallProgress',
  'metaCurrentFileLabel', 'metaFileProgressPercent', 'metaFileProgress',
  'metaTimeInfo', 'metaElapsed', 'metaRemaining', 'metaTotal',
  'metaPauseBtn', 'metaCancelBtn',
  // v3.13.9 报告筛选重构：单条件三控件 → 多条件行容器（reportFilterRows）
  'reportFilterField', 'reportFilterKeyword', 'reportFilterBool',
]);
const EXPECTED_ADDED = new Set([
  'mainActionBar', 'testEncodeLabel',
  // v3.12.0 参数手风琴：9 个分组容器（每个 .section-divider 分组被包成独立可折叠组）
  'pg-codec', 'pg-video', 'pg-audio', 'pg-container', 'pg-stabilize',
  'pg-okaa', 'pg-insta360', 'pg-date', 'pg-location',
  // v3.13.0 编码 copy 模式（流复制）开关与提示框
  'p_copy_mode', 'copyModeHint',
  // v3.x 元数据报告：批量结果筛选 / 多选工具栏 / 加入批量转换队列
  'reportFilterBar', 'reportFilterField', 'reportFilterKeyword', 'reportFilterBool',
  'reportFilterCount', 'reportSelectBar', 'reportSelectCount', 'reportAddToQueueBtn',
  // v3.13.4 元数据工具复用修复：弹窗内复用按钮容器 + 弹窗信息框（GPS/时间）
  'metaEditReuse', 'me_location_info', 'me_date_info',
  // v3.13.9 报告筛选重构：单条件行（旧三控件）→ 多条件行容器 + 添加按钮 + 队列目标
  'reportFilterRows', 'reportFilterAddBtn', 'reportQueueTarget',
  // v3.13.14 元数据队列：加入列队按钮 / 执行范围说明条 / 编辑弹窗输出目录 /
  //   三处「读创建时间」按钮 / m_ 侧日期溯源条。
  // 其余新增 DOM 一律不加 id：p_ 与 me_ 的溯源条用 [data-date-source-for] 定位，
  // 输出位置分段用原生 radio[name=me_out_mode]，快照路径行/提示用 class 定位 ——
  // 纯展示或可由结构推导的元素不扩大 id 契约面。
  'metaAddQueueBtn', 'metaScopeNotice', 'me_out_dir',
  'p_manual_date_browse', 'm_manual_date_browse', 'me_manual_date_browse',
  'm_manual_date_source',
  // v3.13.18 列队执行独立按钮「开始批量列队执行」（与 #metaApplyBtn 并存）。
  // 拍摄位置复制/粘贴按钮刻意不给 id：三前缀共 6 枚，其唯一身份由
  // data-action + data-geo-prefix 表达（与 v3.13.14「读创建时间」按钮同理），
  // 给 id 只会把契约面从 1 项扩到 7 项而零收益。定位用
  // [data-action="geo-copy"][data-geo-prefix="m"] 即可。
  'metaBatchRunBtn',
  // v3.14.0 AI 助手（page-agent 集成）：header 入口按钮 + 设置弹窗 AI 助手组
  // 10 控件。AI 助手组的「执行参数」三输入框各持独立 id（值语义不同，
  // class 定位会歧义）；vendor Panel 的 DOM 由 page-agent 运行时挂 body，
  // 不属于本静态契约面（静态门禁只扫 index.html）。
  'agentToggleBtn',
  'settings_agent_enabled', 'settings_agent_base_url', 'settings_agent_api_key',
  'settings_agent_model', 'settings_agent_thinking', 'settings_agent_effort',
  'settings_agent_permission', 'settings_agent_temperature',
  'settings_agent_max_steps', 'settings_agent_step_delay',
]);

if (MODE === 'baseline') {
  const ids = extractIds(BASE);
  const dup = ids.filter((v, i) => ids.indexOf(v) !== i);
  fs.writeFileSync(CONTRACT, JSON.stringify({
    source: 'index.html.v3910.bak (v3.10.0)',
    total: ids.length,
    duplicates: [...new Set(dup)],
    ids: [...ids].sort(),
  }, null, 2), 'utf8');
  console.log(`基线已固化: ${ids.length} 个 id，重复 ${new Set(dup).size} 个`);
  console.log(`  → ${CONTRACT}`);
} else {
  const base = JSON.parse(fs.readFileSync(CONTRACT, 'utf8'));
  const cur = extractIds(CUR);
  const curSet = new Set(cur);
  const baseSet = new Set(base.ids);

  const missing = base.ids.filter(id => !curSet.has(id));   // 丢失（=功能破坏）
  const added = cur.filter(id => !baseSet.has(id));         // 新增（允许，但需说明）
  const dup = cur.filter((v, i) => cur.indexOf(v) !== i);

  const unexpectedMissing = missing.filter(id => !EXPECTED_REMOVED.has(id));
  const unexpectedAdded = added.filter(id => !EXPECTED_ADDED.has(id));
  const registeredMissing = missing.filter(id => EXPECTED_REMOVED.has(id));

  console.log(`契约基线: ${base.total} 个 id | 当前: ${cur.length} 个（唯一 ${curSet.size}）`);
  console.log(`已登记移除: ${registeredMissing.length} / 计划 ${EXPECTED_REMOVED.size} 个`);
  console.log(`意外丢失 id: ${unexpectedMissing.length}${unexpectedMissing.length ? '  ← 功能破坏！' : '  OK'}`);
  if (unexpectedMissing.length) console.log('   ' + unexpectedMissing.join(', '));
  console.log(`已登记新增: ${added.length - unexpectedAdded.length} | 意外新增: ${unexpectedAdded.length}${unexpectedAdded.length ? '  ← 需确认' : '  OK'}`);
  if (unexpectedAdded.length) console.log('   ' + unexpectedAdded.join(', '));
  console.log(`重复 id: ${dup.length}${dup.length ? '  ← 非法！' : '  OK'}`);
  if (dup.length) console.log('   ' + [...new Set(dup)].join(', '));

  process.exit(unexpectedMissing.length || unexpectedAdded.length || dup.length ? 1 : 0);
}

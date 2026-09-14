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
]);
const EXPECTED_ADDED = new Set([
  'mainActionBar', 'testEncodeLabel',
  // v3.12.0 参数手风琴：9 个分组容器（每个 .section-divider 分组被包成独立可折叠组）
  'pg-codec', 'pg-video', 'pg-audio', 'pg-container', 'pg-stabilize',
  'pg-okaa', 'pg-insta360', 'pg-date', 'pg-location',
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

// ============================================================
// 45-filter.js — 统一多条件叠加筛选引擎（v3.14.6）
// 消费者：元数据批量列队（50-meta.js）与元数据报告（70-report.js）。
// 设计契约：
//   · 条件行 = {field, op, value}；行间 AND 叠加；未生效行不参与过滤
//   · 字段三形态（由 FIELD_GROUPS 第三元 meta 声明）：
//       bool   → op 锁 equals，值控件=是/否下拉
//       collect→ op 可选 equals/contains/not_contains/empty/non_empty，
//                值控件=「从当前数据去重收集」的下拉（含 空值 哨兵）
//       text   → op 可选 contains/not_contains/empty/non_empty，值控件=文本输入
//   · 引擎不感知业务字段：groups/accessor/valueCollect 全由消费方注入
//   · 空值/非空判断统一走 empty/non_empty op（旧报告「（空值）」下拉哨兵
//     迁移为该形态 —— 数据兼容见 normalizeLegacy）
// ============================================================

const FILTER_EMPTY_SENTINEL = '__EMPTY__';   // collect 值下拉里的「空值」选项
const FILTER_OPS = {
  bool: [['equals', '是/否 精确']],
  collect: [['equals', '等于'], ['contains', '包含'], ['not_contains', '不包含'], ['empty', '为空'], ['non_empty', '非空']],
  text: [['contains', '包含'], ['not_contains', '不包含'], ['empty', '为空'], ['non_empty', '非空']],
};

function filterNormValue(v) {
  if (v == null) return '';
  if (typeof v === 'boolean') return v ? '是' : '否';
  return String(v).trim();
}

function filterMatch(val, cond) {
  const s = filterNormValue(val).toLowerCase();
  switch (cond.op) {
    case 'empty': return s === '';
    case 'non_empty': return s !== '';
    case 'equals': return cond.value === FILTER_EMPTY_SENTINEL ? s === '' : s === String(cond.value || '').toLowerCase();
    case 'not_contains': return cond.value && cond.value !== FILTER_EMPTY_SENTINEL ? !s.includes(String(cond.value).toLowerCase()) : true;
    case 'contains': return String(cond.value || '').toLowerCase() ? s.includes(String(cond.value).toLowerCase()) : false;
    default: return true; // 未知 op = 不参与过滤（坏数据不炸列表）
  }
}

// 一行是否生效（生效行才参与 AND 过滤）。
function filterRowActive(f) {
  if (!f || !f.field || !f.op) return false;
  if (f.op === 'empty' || f.op === 'non_empty' || f.op === 'equals') return true;
  return f.value !== '' && f.value != null; // contains/not_contains 需有值
}

// 通用过滤：返回生效下标集合（Set），无生效条件返回 null（=不过滤）。
// 区分「null 全量」与「空集 0 命中」——调用方徽标文案依赖该区分。
function filterVisibleIndexSet(items, conds, accessor) {
  const active = (conds || []).filter(filterRowActive);
  if (!active.length) return null;
  const keep = new Set();
  items.forEach((it, i) => {
    if (active.every(c => filterMatch(accessor(it, c.field), c))) keep.add(i);
  });
  return keep;
}

// 旧报告条件 {field, value}（value='__EMPTY__' 或精确值）→ 新三元形态。
// 迁移语义：旧版只有精确匹配 → op=equals；（空值）→ op=empty。
function filterNormalizeLegacy(list) {
  return (list || []).map(f => {
    if (f.op) return f;
    if (f.value === FILTER_EMPTY_SENTINEL) return { field: f.field, op: 'empty', value: '' };
    return { field: f.field, op: f.value ? 'equals' : '', value: f.value || '' };
  });
}

// ── 渲染 ────────────────────────────────────────────────────
// opts: {list, groups, changeAction, removeAction, kindOf(field), valueCtlFor, rowHint}
// ⚠ action 名必须是字面量（'meta-filter-row-change' 等由消费方传入后原样输出），
//   不可运行时拼接 —— 门禁 06 的静态扫描才能识别，防止漏注册的点击静默失效。
function renderFilterRowsHtml(opts) {
  const { list, groups, changeAction, removeAction, kindOf, valueCtlFor, rowHint } = opts;
  if (!list.length) return rowHint || '';
  return list.map((f, i) => {
    // action 字面量映射（门禁 06 静态扫描 data-action 字面量；引擎只服务两个消费方）
    const act = (changeAction === 'meta-filter-row-change')
      ? { field: 'meta-filter-row-change', remove: 'meta-filter-remove' }
      : { field: 'report-filter-row-change', remove: 'report-filter-remove' };
    const fieldSel = '<select class="input report-filter-field" data-action="' + act.field +
      '" data-row="' + i + '" data-part="field">' +
      '<option value="">— 选择筛选字段 —</option>' +
      groups.map(g => '<optgroup label="' + esc(g.label) + '">' +
        g.fields.map(([v, l]) => '<option value="' + esc(v) + '"' + (f.field === v ? ' selected' : '') + '>' + esc(l) + '</option>').join('') +
        '</optgroup>').join('') +
      '</select>';
    if (!f.field) {
      return '<div class="report-filter-row" style="display:flex;gap:8px;align-items:center;margin-bottom:6px;">' +
        fieldSel +
        '<span style="color:var(--text-muted);font-size:0.75rem;">先选字段</span>' +
        (changeAction === 'meta-filter-row-change'
          ? '<button class="btn btn-sm" type="button" data-action="meta-filter-remove" data-row="' + i + '" title="删除此条件" aria-label="删除此条件">' + ico('trash', 14) + '</button></div>'
          : '<button class="btn btn-sm" type="button" data-action="report-filter-remove" data-row="' + i + '" title="删除此条件" aria-label="删除此条件">' + ico('trash', 14) + '</button></div>');
    }
    const kind = kindOf(f.field);
    const ops = FILTER_OPS[kind] || FILTER_OPS.text;
    // op 合法性收敛：状态里 op 不在该字段可选集 → 按首项渲染并回写状态
    let op = f.op;
    if (!ops.some(([v]) => v === op)) op = ops[0][0];
    if (op !== f.op) f.op = op;
    const opSel = '<select class="input report-filter-op" data-action="' + act.field +
      '" data-row="' + i + '" data-part="op"' + (kind === 'bool' ? ' disabled' : '') + '>' +
      ops.map(([v, l]) => '<option value="' + v + '"' + (op === v ? ' selected' : '') + '>' + l + '</option>').join('') +
      '</select>';
    const showValue = op === 'equals' || op === 'contains' || op === 'not_contains';
    const valueCtl = '<span class="report-filter-value-wrap"' + (showValue ? '' : ' style="display:none;"') + '>' +
      valueCtlFor(f, i, kind, act.field) + '</span>';
    return '<div class="report-filter-row" style="display:flex;gap:8px;align-items:center;margin-bottom:6px;">' +
      fieldSel + opSel + valueCtl +
      (changeAction === 'meta-filter-row-change'
        ? '<button class="btn btn-sm" type="button" data-action="meta-filter-remove" data-row="' + i + '" title="删除此条件" aria-label="删除此条件">' + ico('trash', 14) + '</button></div>'
        : '<button class="btn btn-sm" type="button" data-action="report-filter-remove" data-row="' + i + '" title="删除此条件" aria-label="删除此条件">' + ico('trash', 14) + '</button></div>');
  }).join('');
}

// 中央委托 change handler 的通用逻辑；返回 true=需重渲染。
function filterRowChange(list, el) {
  const f = list[parseInt(el.dataset.row, 10)];
  if (!f) return false;
  if (el.dataset.part === 'field') {
    if (f.field === el.value) return false;
    f.field = el.value;
    f.value = '';
    f.op = '';   // 交给渲染层按 kind 收敛默认 op
    return true;
  }
  if (el.dataset.part === 'op') { f.op = el.value; return true; }
  if (el.dataset.part === 'value') { f.value = el.value; return true; }
  return false;
}

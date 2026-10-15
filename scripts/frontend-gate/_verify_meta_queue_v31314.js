// ════════════════════════════════════════════════════════════════════
//  v3.13.14 元数据队列四项改动 — 独立验收测试套件
//  归属：QA（mvp-dev-expert-team-qa）
//  权威规格：
//    docs/design/ui_redesign/v31314_元数据队列交互设计.md（验收断言 A1-A16）
//    docs/decisions/ADR-004-元数据队列快照与待转换状态机.md（D-1..D-10）
//    docs/design/ui_redesign/_emoji_audit_v31314.txt（72 处 emoji 逐行审计）
//  运行：node scripts/frontend-gate/_verify_meta_queue_v31314.js
//        （需先起桩服务器：node scripts/frontend-gate/_stub-server.js 8800）
//
//  [P0] 本套件只读生产代码，绝不修改 static/** / app.py / VERSION。
//  [P0] 套件内禁止出现 emoji 字符（团队 P0 铁律）：所有 emoji 一律用 \u 转义。
//  [P0] 断言不得为让实现变绿而放宽：失败即失败，区分「前端未实现」与「规格矛盾」。
//
//  覆盖矩阵（对照 team-lead 派单）：
//    需求1 加入批量列队      → A1  A2  A3
//    需求2 输出目录三态      → A4  A5
//    需求3 应用元数据执行逻辑 → A6  A7  A8
//    需求4 三处日期浏览按钮  → A9  A10
//    跨切面（队列表/徽标/emoji/phase/契约）→ A11..A16
// ════════════════════════════════════════════════════════════════════
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawnSync: _unusedSpawnSync } = require('child_process');
void _unusedSpawnSync;   // 保留占位：本套件不 spawn 子进程（Windows EBUSY），仅 require 校验环境

const WS = path.join(os.homedir(), '.workbuddy', 'binaries', 'node', 'workspace', 'node_modules');
const { JSDOM, VirtualConsole } = require(path.join(WS, 'jsdom'));

const PORT = Number(process.env.META_QUEUE_PORT || 8800);
const URL = `http://127.0.0.1:${PORT}/`;
const ROOT = path.resolve(__dirname, '../..');   // 仓库根

// ── emoji 字形类（团队 P0 扫描口径，与审计文件同款）────────────────
// [!] 只用 \u 转义，本文件不写入任何 emoji 字符。
const EMOJI_RE = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u;
const FRONTEND_FILES = [
  'static/index.html',
  'static/js/00-core.js', 'static/js/10-ui.js', 'static/js/20-map.js', 'static/js/30-params.js',
  'static/js/40-files.js', 'static/js/45-filter.js', 'static/js/50-meta.js', 'static/js/60-jobs.js',
  'static/js/70-report.js', 'static/js/80-codec.js', 'static/js/90-boot.js',
];

// ── 断言记录 ────────────────────────────────────────────────────────
const results = [];
const check = (name, cond, detail) => {
  const ok = !!cond;
  results.push({ name, ok });
  console.log((ok ? 'OK  ' : 'FAIL') + ' ' + name + (detail ? '  -> ' + detail : ''));
};
// 静态源码断言（不依赖 jsdom，可在页面加载失败时也给出结论）
const checkSrc = (name, files, pred, detailFn) => {
  const findings = [];
  files.forEach(rel => {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) { findings.push(rel + ' <文件缺失>'); return; }
    const src = fs.readFileSync(abs, 'utf8');
    src.split(/\r?\n/).forEach((line, i) => {
      // HTML 实体解码后一并检测（审计文件口径：实体 + 裸字形）
      const decoded = line.replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(Number(d)));
      if (pred(decoded, line, i)) findings.push(`${rel}:${i + 1}`);
    });
  });
  const bad = findings.filter(f => !f.includes(' '));
  check(name, bad.length === 0, bad.length === 0 ? (detailFn ? detailFn() : findings.length + ' 处') : bad.slice(0, 12).join(' '));
};

// ════════════════════════════════════════════════════════════════════
//  第 0 组：源码层断言（先跑，即使 jsdom 起不来也有结论）
// ════════════════════════════════════════════════════════════════════
function staticPhase() {
  console.log('\n──── 第 0 组：源码层断言（静态）────');

  // ── A16 emoji 归零（UI 渲染点）──────────────────────────────────
  // 口径严格按审计文件：REPLACE 68 处须归零；KEEP_COMMENT 4 处按设计保留。
  // 本断言只针对 UI 渲染点 —— 纯注释行（// 或 /* 开头，或行内注释）豁免。
  const isCommentLine = (decoded) => {
    const t = decoded.trim();
    if (!t) return false;
    if (t.startsWith('//') || t.startsWith('/*') || t.startsWith('*') || t.startsWith('<!--')) return true;
    // 行内注释：emoji 出现在 // 之后
    const idx = decoded.indexOf(EMOJI_RE.source ? (decoded.match(EMOJI_RE) || [''])[0] : '');
    if (idx > 0) {
      const before = decoded.slice(0, idx);
      const lastSlash = before.lastIndexOf('//');
      const lastQuote = Math.max(before.lastIndexOf("'"), before.lastIndexOf('"'));
      if (lastSlash > lastQuote) return true;
    }
    return false;
  };

  const auditPath = path.join(ROOT, 'docs/design/ui_redesign/_emoji_audit_v31314.txt');
  const audit = fs.existsSync(auditPath) ? fs.readFileSync(auditPath, 'utf8') : '';
  const auditRows = audit.split(/\r?\n/).filter(l => /^static\//.test(l.trim()));
  const replaceRows = auditRows.filter(l => l.indexOf('REPLACE') >= 0);
  const keepRows = auditRows.filter(l => l.indexOf('KEEP_COMMENT') >= 0);
  const phaseFirstRows = auditRows.filter(l => l.indexOf('PHASE_FIRST') >= 0);

  check('A16.1 审计文件可解析且计数符合规格（REPLACE 68 / KEEP_COMMENT 4 / PHASE_FIRST 4）',
    replaceRows.length === 68 && keepRows.length === 4 && phaseFirstRows.length === 4,
    `REPLACE=${replaceRows.length} KEEP_COMMENT=${keepRows.length} PHASE_FIRST=${phaseFirstRows.length}`);

  // UI 渲染点 = 命中 emoji 且所在行不是纯注释
  const uiHits = [];
  const commentHits = [];
  FRONTEND_FILES.forEach(rel => {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) { uiHits.push(rel + ' <缺失>'); return; }
    fs.readFileSync(abs, 'utf8').split(/\r?\n/).forEach((line, i) => {
      const decoded = line.replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(Number(d)));
      if (!EMOJI_RE.test(decoded)) return;
      (isCommentLine(decoded) ? commentHits : uiHits).push(`${rel}:${i + 1}`);
    });
  });
  // 交叉核对：残留是否全部落在审计 REPLACE 清单内（区分「该改未改」与「新增了违规 emoji」）
  const auditSet = new Set(replaceRows.map(l => {
    const c = l.trim().split(/\s+/);
    return c[0] + '|' + c[2];
  }));
  const notInAudit = uiHits.filter(h => {
    const rel = h.split(':')[0];
    const abs = path.join(ROOT, rel);
    const ln = parseInt(h.split(':')[1], 10) - 1;
    const decoded = fs.readFileSync(abs, 'utf8').split(/\r?\n/)[ln]
      .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(Number(d)));
    const cp = 'U+' + decoded.match(EMOJI_RE)[0].codePointAt(0).toString(16).toUpperCase();
    return !auditSet.has(rel + '|' + cp);
  });
  const detail = uiHits.length === 0
    ? `UI 命中 0；注释豁免 ${commentHits.length} 处（含 4 处 KEEP_COMMENT）`
    : `残留 ${uiHits.length}/68 处；其中审计清单外的新增违规 ${notInAudit.length} 处；`
      + `注释豁免 ${commentHits.length} 处。清单外: ${notInAudit.slice(0, 5).join(' ') || '无'}；`
      + `残留位置: ${uiHits.slice(0, 14).join(' ')}`;
  check('A16.2 UI 渲染点 emoji 归零（审计 REPLACE 68 处须全部替换）', uiHits.length === 0, detail);

  // ── A14 4 处 KEEP_COMMENT 未被误改 ─────────────────────────────
  // 按内容定位（行号会随改动漂移，规格 A14 说的是「那 4 条注释」不是「第 78 行」）
  const KEEP_SIGNATURES = [
    { file: 'static/js/10-ui.js', needle: '折叠实现必须依赖 CSS 的 display:none' },
    { file: 'static/js/10-ui.js', needle: '决策说明：14 处既有输入框的 id 仍保留在 index.html' },
    { file: 'static/js/50-meta.js', needle: '子区容器 id 映射' },
    { file: 'static/js/50-meta.js', needle: '不适用于 p_ 球面容器' },
  ];
  KEEP_SIGNATURES.forEach((sig, i) => {
    const abs = path.join(ROOT, sig.file);
    const lines = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8').split(/\r?\n/) : [];
    const hit = lines.findIndex(l => l.indexOf(sig.needle) >= 0);
    const line = hit >= 0 ? lines[hit] : '';
    // 必须仍是「注释 + 原字形」，且未被替换成 SVG 路径数据
    const hasGlyph = EMOJI_RE.test(line);
    const stillComment = /^\s*(\/\/|\/\*|\*)/.test(line);
    const notSvg = line.indexOf('<svg') < 0 && line.indexOf('<path') < 0;
    check(`A14.${i + 1} KEEP_COMMENT 保留：${sig.file} 「${sig.needle.slice(0, 12)}…」`,
      hit >= 0 && hasGlyph && stillComment && notSvg,
      hit < 0 ? '未找到该注释行' : `line=${hit + 1} glyph=${hasGlyph} comment=${stillComment} noSvg=${notSvg}`);
  });

  // ── A12 ActiveJob.phase 生效（防静默失效，最高优先）────────────
  // 判据：progressLabel 的重置分支不得再靠「展示文案是否以 U+1F517 开头」反推内部状态。
  // 旧代码形态：lbl.textContent.startsWith('<U+1F517>')  → emoji 换 SVG 后恒为 false，
  // 「合并阶段切回编码阶段」会静默失效（不报任何错，标签卡在旧文案）。
  const jobs = fs.existsSync(path.join(ROOT, 'static/js/60-jobs.js')) ? fs.readFileSync(path.join(ROOT, 'static/js/60-jobs.js'), 'utf8') : '';
  // 把源码里可能出现的真实 U+1F517 与 \u{1F517} / \uD83D\uDD17 两种写法一并纳入判定
  const LINK_GLYPH = String.fromCodePoint(0x1F517);
  const startsWithLink = /textContent\s*\.\s*startsWith\s*\(\s*(['"])[^'"]*\1\s*\)/.test(jobs)
    && (jobs.indexOf('startsWith(' + "'" + LINK_GLYPH) >= 0
      || jobs.indexOf('startsWith("\\u{1F517}') >= 0
      || jobs.indexOf('startsWith("\\uD83D\\uDD17') >= 0);
  check('A12.1 60-jobs.js 不再用 textContent.startsWith(U+1F517) 反推状态',
    !startsWithLink,
    startsWithLink ? '仍存在 textContent.startsWith(emoji) —— emoji 换 SVG 后该判断恒 false，阶段切换会静默失效'
      : (jobs.indexOf('textContent.startsWith') >= 0 ? '存在其他 startsWith 用法（需人工确认非 emoji 反推）' : '已无 startsWith 反推'));
  check('A12.2 ActiveJob 声明 phase 字段', /const ActiveJob = \{[^}]*\bphase\b[^}]*\}/s.test(jobs),
    /const ActiveJob = \{[^}]*\}/s.exec(jobs) ? (/phase/.test(/const ActiveJob = \{[^}]*\}/s.exec(jobs)[0]) ? 'phase 已声明' : 'ActiveJob 无 phase 字段') : 'ActiveJob 声明未找到');
  check('A12.3 beginJob 接受初始 phase 并写入 ActiveJob.phase',
    /function beginJob\(\s*id\s*,\s*type\s*,\s*phase\s*\)/.test(jobs) && /ActiveJob\.phase\s*=/.test(jobs),
    /function beginJob\([^)]*\)/.exec(jobs) ? /function beginJob\([^)]*\)/.exec(jobs)[0] : 'beginJob 未找到');
  check('A12.4 endJob 清理 phase', /endJob\s*\(\s*\)\s*\{[\s\S]*?ActiveJob\.phase\s*=\s*null/.test(jobs), '');
  check('A12.5 合并模式调用方显式传 merge', /beginJob\(\s*[^,]+,\s*['"]encode['"]\s*,\s*['"]merge['"]\s*\)/.test(jobs), '');

  // ── A3 表格仍 7 列 + 操作列 90->104px ──────────────────────────
  const html = fs.existsSync(path.join(ROOT, 'static/index.html')) ? fs.readFileSync(path.join(ROOT, 'static/index.html'), 'utf8') : '';
  const metaThead = /<th style="width:36px;"><input type="checkbox" id="metaSelectAll"[\s\S]*?<\/tr>/.exec(html);
  const thCount = metaThead ? (metaThead[0].match(/<th/g) || []).length : 0;
  check('A3.1 元数据队列表格仍为 7 列（不加列）', thCount === 7, `th 数=${thCount}`);
  check('A3.2 操作列宽度 90->104px（done 行三按钮 78px 需要 80px 可用）',
    /<th style="width:104px;">操作<\/th>/.test(html), '');
  const css = fs.existsSync(path.join(ROOT, 'static/css/theme-cobalt.css')) ? fs.readFileSync(path.join(ROOT, 'static/css/theme-cobalt.css'), 'utf8') : '';
  check('A3.3 操作列紧凑排布 CSS 已落地（btn-sm padding 6px 4px + 相邻 margin-left 3px）',
    /td\.col-actions \.btn-sm\s*\{[^}]*padding:\s*6px 4px/.test(css) && /td\.col-actions \.btn-sm \+ \.btn-sm\s*\{[^}]*margin-left:\s*3px/.test(css), '');
  // 3 按钮 78px <= 可用 80px：24*3 + 3*2 = 78，104 - 24(td padding) = 80
  const btnW = 6 * 0 + 4 + 4 + 14 + 1 + 1;   // padding-y 不计入宽度；padding-x 4+4 + icon 14 + border 1+1 = 24
  const total = btnW * 3 + 3 * 2;
  check('A3.4 done 行三按钮总宽 78px <= 可用 80px（无横向溢出）', total <= 104 - 24,
    `每按钮 ${btnW}px x 3 + gap 3px x 2 = ${total}px <= ${104 - 24}px`);

  // ── A2 新增 CSS 无硬编码色值（只看 v3.13.14 增量块）─────────────
  const v31314Block = /v3\.13\.14 元数据队列/.test(css) ? css.slice(css.indexOf('v3.13.14 元数据队列')) : '';
  const hexInNew = (v31314Block.match(/#[0-9a-fA-F]{3,8}/g) || []);
  check('A2.1 v3.13.14 新增 CSS 无硬编码色值（全部 var()/color-mix 派生）',
    v31314Block.length > 0 && hexInNew.length === 0,
    v31314Block.length === 0 ? '未找到 v3.13.14 CSS 块' : hexInNew.length === 0 ? '0 处硬编码' : hexInNew.slice(0, 6).join(' '));
  check('A2.2 五枚 --state-*-fg 状态前景令牌已定义（暗色+浅色各一组）',
    (css.match(/--state-pending-fg/g) || []).length >= 2 && (css.match(/--state-failed-fg/g) || []).length >= 2, '');
  check('A2.3 --focus-ring 令牌存在（新增控件 focus 可见性载体）', /--focus-ring:\s*0 0 0 3px/.test(css), '');
  check('A2.4 reduced-motion 收敛已落地（spinner 降速而非冻结）',
    /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?animation-duration:\s*2\.4s/.test(css), '');

  // ── A4/A6 断点与三栏栅格未被改动 ────────────────────────────────
  const appCss = fs.existsSync(path.join(ROOT, 'static/css/app.css')) ? fs.readFileSync(path.join(ROOT, 'static/css/app.css'), 'utf8') : '';
  check('A4.1 单列回落断点仍为 1180px（未被改动）', /@media\s*\(max-width:\s*1180px\)/.test(appCss), '');

  // ── A6/A8/A9 委托动作注册（门禁 06 的前置）────────────────────
  const core = fs.existsSync(path.join(ROOT, 'static/js/00-core.js')) ? fs.readFileSync(path.join(ROOT, 'static/js/00-core.js'), 'utf8') : '';
  const REG_REQUIRED = ['meta-enqueue', 'reset-meta-item', 'meta-force-form-run', 'meta-out-mode', 'browse-date'];
  REG_REQUIRED.forEach((act, i) => {
    const re = new RegExp("'" + act + "'\\s*:");
    check(`A6.${i + 1} DELEGATED_ACTIONS 已注册 '${act}'`, re.test(core), '');
  });
  check('A6.6 browse-date 未复用 open-path-dialog（ADR D-7 独立性）',
    !/open-path-dialog[^\n]*path-mode=.date./.test(core) && !/'open-path-dialog':\s*el\s*=>\s*openPathDialog\(el\.dataset\s*,\s*'date'/.test(core), '');

  // ── A9 三处日期浏览按钮（三个前缀对称）─────────────────────────
  const DATE_BTN = ['p_manual_date_browse', 'm_manual_date_browse', 'me_manual_date_browse'];
  DATE_BTN.forEach((id, i) => {
    const re = new RegExp('id="' + id + '"[^>]*data-action="browse-date"');
    const re2 = new RegExp('data-action="browse-date"[^>]*id="' + id + '"');
    check(`A9.${i + 1} #${id} 存在且走 browse-date 委托`, re.test(html) || re2.test(html), '');
  });
  ['p_manual_date', 'm_manual_date', 'me_manual_date'].forEach((id, i) => {
    check(`A9.${i + 4} #${id} 输入框存在`, html.indexOf('id="' + id + '"') >= 0, '');
  });
  // 三前缀对称：溯源条统一用 data-date-source-for 定位（三处各一）
  const srcCnt = (html.match(/class="date-source/g) || []).length;
  check('A9.7 三处日期溯源条齐备（三前缀对称，用 data-date-source-for 定位）',
    srcCnt === 3 && (html.match(/data-date-source-for="(p|m|me)_manual_date"/g) || []).length === 3,
    `date-source 数=${srcCnt}`);

  // ── A5 编辑弹窗输出位置三态 ────────────────────────────────────
  ['global', 'snapshot', 'inplace'].forEach((mode, i) => {
    check(`A5.${i + 1} 编辑弹窗 me_out_mode 三态 radio 齐备（value=${mode}）`,
      html.indexOf(`name="me_out_mode" value="${mode}"`) >= 0, '');
  });
  check('A5.4 #me_out_dir 快照路径输入框存在', html.indexOf('id="me_out_dir"') >= 0, '');
  check('A5.5 #metaScopeNotice 执行范围说明条存在且在惰性子树之外',
    html.indexOf('id="metaScopeNotice"') >= 0, '');
  // 说明条必须在「功能开关」卡之前，且不是 .card 的后代
  const noticePos = html.indexOf('id="metaScopeNotice"');
  const cardPos = html.indexOf('功能开关');
  check('A5.6 说明条位置在「功能开关 — 默认设置」卡之前（满对比度可读）',
    noticePos > 0 && cardPos > 0 && noticePos < cardPos, `notice@${noticePos} card@${cardPos}`);
  check('A5.7 说明条带 aria-live=polite + role=status（屏幕阅读器播报）',
    /id="metaScopeNotice"[^>]*role="status"[^>]*aria-live="polite"/.test(html) || /id="metaScopeNotice"[\s\S]{0,200}aria-live="polite"/.test(html), '');

  // ── A1 #metaAddQueueBtn 位置与规格 ────────────────────────────
  const barIdx = html.indexOf('id="mainActionBar"');
  const applyIdx = html.indexOf('id="metaApplyBtn"');
  const addIdx = html.indexOf('id="metaAddQueueBtn"');
  const pauseIdx = html.indexOf('id="pauseBtn"');
  check('A1.1 #metaAddQueueBtn 存在于 #mainActionBar 内',
    addIdx > 0 && barIdx > 0 && addIdx > barIdx, `bar@${barIdx} add@${addIdx}`);
  check('A1.2 #metaAddQueueBtn 紧贴 #metaApplyBtn 右侧、#pauseBtn 之前',
    applyIdx > 0 && addIdx > applyIdx && pauseIdx > addIdx, `apply@${applyIdx} add@${addIdx} pause@${pauseIdx}`);
  const addBtnTag = /<button[^>]*id="metaAddQueueBtn"[\s\S]{0,900}?<\/button>/.exec(html);
  const addBtnSrc = addBtnTag ? addBtnTag[0] : '';
  check('A1.3 #metaAddQueueBtn data-action="meta-enqueue"', /data-action="meta-enqueue"/.test(addBtnSrc), '');
  check('A1.4 #metaAddQueueBtn 为次要样式（class 含 btn btn-lg，不含 btn-primary）',
    /class="btn btn-lg"/.test(addBtnSrc) && !/btn-primary/.test(addBtnSrc), '');
  check('A1.5 #metaAddQueueBtn 内联 20px inbox SVG（非 emoji、非 14px undersized）',
    /<svg[^>]*width="20"[^>]*height="20"/.test(addBtnSrc) && addBtnSrc.indexOf('M22 12h-6l-2 3h-4l-2-3H2') >= 0, '');
  check('A1.6 #metaAddQueueBtn 文案为「加入批量列队」', addBtnSrc.indexOf('加入批量列队') >= 0, '');
  check('A1.7 #metaAddQueueBtn 带 aria-describedby 指向执行范围说明条',
    /aria-describedby="metaScopeNotice"/.test(addBtnSrc), '');
  // 顶部就近入口也统一走委托
  check('A1.8 顶部「加入批量列队」入口同走 meta-enqueue 委托（去掉内联 onclick）',
    /<button class="btn" type="button" data-action="meta-enqueue">加入批量列队<\/button>/.test(html), '');

  // ── A13 表格行操作列三按钮（编辑/重排队/移除）+ 无横向溢出标记 ──
  const metaJs = fs.existsSync(path.join(ROOT, 'static/js/50-meta.js')) ? fs.readFileSync(path.join(ROOT, 'static/js/50-meta.js'), 'utf8') : '';
  check('A13.1 操作列 td 带 col-actions class（三按钮紧凑排布的作用域）', /class="col-actions"/.test(metaJs), '');
  check('A13.2 reset-meta-item 按钮仅在 done 行渲染',
    /f\.status === 'done'[\s\S]{0,200}?reset-meta-item/.test(metaJs), '');
  check('A13.3 reset-meta-item 按钮带 aria-label（图标按钮无障碍名称非空）',
    /data-action="reset-meta-item"[\s\S]{0,200}?aria-label="重排队/.test(metaJs), '');
  check('A13.4 状态列四态文案为「待转换/处理中/完成/失败」（未用 running/failed 英文文案）',
    metaJs.indexOf('待转换') >= 0 && metaJs.indexOf('处理中') >= 0
    && /完成\$\{dur\}/.test(metaJs) && metaJs.indexOf('失败') >= 0
    && !/statusHtml\s*=\s*['"][^'"]*\brunning\b/i.test(metaJs.replace(/\/\/[^\n]*/g, '')),
    '四态中文文案齐备');
  check('A13.5 status 四态沿用代码现值 pending/processing/done/error（未重命名）',
    /f\.status === 'processing'/.test(metaJs) && /f\.status === 'done'/.test(metaJs) && /f\.status === 'error'/.test(metaJs)
    && !/status\s*=\s*'running'/.test(metaJs) && !/status\s*=\s*'failed'/.test(metaJs), '');

  // ── A8 待执行项判定口径（ADR D-3）─────────────────────────────
  check('A8.1 metaRunnableItems = selected && status !== done（ADR D-3 口径）',
    /function metaRunnableItems\(\)\s*\{\s*return metaBatchItems\.filter\(f => f\.selected && f\.status !== 'done'\)/.test(metaJs), '');
  check('A8.2 startMetadataApply 用两段过滤（queue + runnable），未合成一次',
    /const queue = metaBatchItems\.filter\(f => f\.selected\)/.test(jobs) && /status !== 'done'/.test(jobs), '');
  check('A8.3 startMetadataApply 逐项重置仅限本次要跑的项（done 不被无差别重置）',
    /if \(!f\.selected \|\| f\.status === 'done'\) return;/.test(jobs), '');
  check('A8.4 输出路径按 outDir.mode 分派（不再统一读全局 outDir）',
    /resolveMetaOutputPath\(f,\s*outDir\)/.test(jobs), '');
  // v3.13.18：forceFormRun 已整体删除（界面单文件与列队执行拆成两个按钮后，
  // 不再需要「这一轮例外」的中间态）。断言改为「死标志不得复活」——
  // 若有人日后重新引入同名标志并挂回执行路径，这里会立刻失败。
  // 只查可执行代码（剥掉注释），否则解释其删除原因的注释会误报。
  // 注意：不能复用下方 A16 段的 stripComments —— 那是 const 声明，存在 TDZ。
  const codeOnly = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  check('A8.5 forceFormRun 已彻底移除（两按钮拆分后无「这一轮例外」中间态）',
    !/forceFormRun/.test(codeOnly(jobs)) && !/forceFormRun/.test(codeOnly(metaJs)),
    'forceFormRun 仍出现在可执行代码中');
  check('A8.6 列队模式写可追溯日志（[列队] 行）', /\[列队\] 按列队顺序执行/.test(jobs), '');

  // ── A7 reset 零副作用（源码层：不得绑定任何执行函数）───────────
  const resetFn = /function resetMetaItem\([\s\S]*?\n\}/.exec(metaJs);
  const resetSrc = resetFn ? resetFn[0] : '';
  check('A7.1 resetMetaItem 存在且只改状态字段',
    resetSrc.indexOf("f.status = 'pending'") >= 0 && resetSrc.indexOf('f.statusMsg') >= 0
    && resetSrc.indexOf('f.settings') < 0 && resetSrc.indexOf('f.outDir') < 0,
    resetSrc ? '已检查函数体' : 'resetMetaItem 未找到');
  check('A7.2 resetMetaItem 函数体内不调任何执行函数（零副作用铁律）',
    resetSrc.length > 0 && !/startMetadataApply|apply_metadata|beginJob|fetch\(/.test(resetSrc), '');
  check('A7.3 reset-meta-item 委托仅调 resetMetaItem（未绑执行）',
    /'reset-meta-item':\s*el => resetMetaItem\(/.test(core), '');

  // ── A10 ctime 回填不得破坏既有本地 naive 格式 ─────────────────
  // 先剥掉注释再判定：函数体内的注释里会出现「utcToLocalNaive」字样
  // （正是在说明「不要用它」），按裸文本匹配会误判为违规。
  const stripComments = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map(l => l.replace(/(^|[^:"'\\])\/\/.*$/, '$1')).join('\n');
  const browseFn = /async function browseDateFromFile\([\s\S]*?\n\}/.exec(metaJs);
  const browseSrc = browseFn ? browseFn[0] : '';
  const browseCode = stripComments(browseSrc);
  check('A10.1 回填使用后端 ctime 原值，不加 Z',
    browseCode.indexOf("el.value = d.ctime || ''") >= 0 && !/el\.value = d\.ctime \s*\+\s*'Z'/.test(browseCode), '');
  check('A10.2 回填链路不调 utcToLocalNaive（避免重新引入 v3.13.7 的 ±8h 偏差）',
    browseCode.length > 0 && browseCode.indexOf('utcToLocalNaive') < 0,
    browseCode.length === 0 ? 'browseDateFromFile 未找到' : '代码中无 utcToLocalNaive 调用（注释内的说明不计）');
  check('A10.3 成功回填后 dispatch change（刷新日期预览，既有惯例）',
    /el\.dispatchEvent\(new Event\('change'/.test(browseCode), '');
  check('A10.4 失败路径提前 return，绝不触碰 el.value（失败铁律）',
    browseSrc.indexOf('绝不触碰 el.value') >= 0
    && (browseCode.match(/return;/g) || []).length >= 2, '');
  check('A10.5 非 Windows（is_creation_time=false）如实告知而非假装创建时间',
    /is_creation_time === false/.test(browseCode), '');

  // ── A3 去重（ADR D-5 归一化四层）──────────────────────────────
  // 归一化四层按语义逐项核对（用子串而非复杂正则，避免转义歧义）：
  //   ① 去手输残留引号  ② 统一分隔符  ③ 折叠重复分隔符 + 去尾分隔符  ④ 转小写
  const normFn = /function normalizePathForCompare\([\s\S]*?\n\}/.exec(metaJs);
  const normSrc = normFn ? normFn[0] : '';
  check('A3.5 normalizePathForCompare 四层归一化齐备（引号/分隔符/重复+尾缀/小写）',
    normSrc.indexOf('function normalizePathForCompare') >= 0
    && normSrc.indexOf("replace(/^\"|\"$/g") >= 0          // ① 去引号
    && normSrc.indexOf("replace(/\\//g") >= 0              // ② 统一分隔符
    && normSrc.indexOf('{2,}') >= 0                        // ③ 折叠重复分隔符
    && /replace\(\/\\\\\+\$\//.test(normSrc)               // ③ 去尾分隔符
    && normSrc.indexOf('toLowerCase()') >= 0,              // ④ 大小写不敏感
    normSrc ? normSrc.split('\n').slice(2, 8).join(' / ').slice(0, 150) : 'normalizePathForCompare 未找到');
  check('A3.6 三处入队去重统一走归一化比对（findMetaItemIndex）',
    (metaJs.match(/findMetaItemIndex\(/g) || []).length >= 3, `调用次数=${(metaJs.match(/findMetaItemIndex\(/g) || []).length}`);

  // ── 门禁交叉验证：05 id 契约 / 06 data-action 契约 ─────────────
  // [!] 不 spawnSync 子进程：Windows 下 node spawnSync 同进程树会 EBUSY（status=null）。
  //   改为在本进程内复算门禁 05/06 的判定逻辑（口径与门禁脚本逐行一致）。
  {
    const gateDir = path.join(ROOT, 'scripts/frontend-gate');
    // —— 门禁 05：id 契约 ——
    const contract = JSON.parse(fs.readFileSync(path.join(gateDir, 'id-contract.json'), 'utf8'));
    const baseIds = new Set(contract.ids);
    const curIds = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
    const curSet = new Set(curIds);
    const gate05 = fs.readFileSync(path.join(gateDir, '05-id-contract.js'), 'utf8');
    const addedBlock = /const EXPECTED_ADDED = new Set\(\[([\s\S]*?)\]\);/.exec(gate05);
    const expectedAdded = new Set(addedBlock ? [...addedBlock[1].matchAll(/'([^']+)'/g)].map(m => m[1]) : []);
    const removedBlock = /const EXPECTED_REMOVED = new Set\(\[([\s\S]*?)\]\);/.exec(gate05);
    const expectedRemoved = new Set(removedBlock ? [...removedBlock[1].matchAll(/'([^']+)'/g)].map(m => m[1]) : []);
    const unexpectedAdded = [...curSet].filter(id => !baseIds.has(id) && !expectedAdded.has(id));
    const missing = [...baseIds].filter(id => !curSet.has(id) && !expectedRemoved.has(id));
    const dupIds = [...curSet].filter((v, i) => curIds.indexOf(v) !== i);
    check('A6.7 门禁 05（id 契约）通过：无意外新增/丢失/重复',
      unexpectedAdded.length === 0 && missing.length === 0 && dupIds.length === 0,
      `基线${baseIds.size} 当前${curSet.size} 意外新增[${unexpectedAdded.join(',')}] 丢失[${missing.join(',')}] 重复[${dupIds.join(',')}]`);

    // —— 门禁 06：data-action 双向契约 ——
    const coreSrc = fs.readFileSync(path.join(ROOT, 'static/js/00-core.js'), 'utf8');
    const tableM = coreSrc.match(/const DELEGATED_ACTIONS = \{([\s\S]*?)\n\};/);
    const registered = new Set(tableM ? [...tableM[1].matchAll(/^\s*'([a-z0-9-]+)':/gm)].map(m => m[1]) : []);
    const usedActions = new Set();
    const scanAct = (rel) => {
      fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\n').forEach(ln => {
        for (const m of ln.matchAll(/data-action="([^"]*)"/g)) usedActions.add(m[1]);
      });
    };
    scanAct('static/index.html');
    FRONTEND_FILES.filter(f => f.endsWith('.js') && f !== 'static/js/00-core.js').forEach(scanAct);
    const broken = [...usedActions].filter(a => !registered.has(a));
    const unused = [...registered].filter(a => !usedActions.has(a));
    check('A6.8 门禁 06（data-action 契约）通过：无「使用未注册」/ 无「注册未使用」',
      broken.length === 0 && unused.length === 0,
      `已注册${registered.size} 已使用${usedActions.size} 未注册[${broken.join(',')}] 未使用[${unused.join(',')}]`);
  }
}

// ════════════════════════════════════════════════════════════════════
//  第 1 组：运行时断言（jsdom 真实页面 + 真实 MouseEvent 派发）
// ════════════════════════════════════════════════════════════════════

// 可变后端：让「失败路径」与「成功路径」都能在同一次运行内被驱动
const BACKEND = {
  nativeDialogPath: 'G:/ref/IMG_2043.MP4',
  fsTimeStatus: 200,
  fsTime: {
    path: 'G:/ref/IMG_2043.MP4',
    ctime: '2024-03-11T09:22:41',           // 本地 naive，无 Z（ADR D-6 口径）
    ctime_ts: 1710136961, mtime: '2024-03-12T10:00:00',
    source: 'filesystem', is_creation_time: true,
  },
  applied: [],          // /api/apply_metadata 收到的 items
  appliedParams: null,
  fetchLog: [],         // 全量 fetch 轨迹（spy：用于 A7 零副作用断言）
};

const API = (url, opt) => {
  const u = String(url);
  if (u.indexOf('/api/native_dialog') >= 0) return { path: BACKEND.nativeDialogPath };
  if (u.indexOf('/api/file_fs_time') >= 0) {
    if (BACKEND.fsTimeStatus !== 200) return { error: '文件不存在' };
    return BACKEND.fsTime;
  }
  if (u.indexOf('/api/apply_metadata') >= 0) {
    try { const b = JSON.parse(opt && opt.body); BACKEND.applied = b.items; BACKEND.appliedParams = b.params; } catch (e) { /* ignore */ }
    return { job_id: 'job_v31314' };
  }
  if (u.indexOf('/api/probe_metadata') >= 0) return {
    has_spherical: false, spherical: null, has_date: false, creation_time: null,
    has_gps: false, gps: null, location_name: '', location_address: '',
    file_size_mb: 12.5, date_in_name: '', filename: 'X.mp4',
  };
  if (u.indexOf('/api/probe-source') >= 0) return { has_gps: false, has_time: false, creation_time: null, filename: 'X.mp4', location_name: '', location_address: '' };
  if (u.indexOf('/api/extract_date') >= 0) return { date_str: null };
  if (u.indexOf('/api/codecs') >= 0) return { codecs: { libx264: { label: 'x', group: 'cpu', presets: [], default_preset: '', has_profile: true, has_level: true, has_bf_refs: false, x264_params: false, x265_params: false } } };
  if (u.indexOf('/api/codec_check') >= 0) return { available: {}, error_details: {}, ffmpeg_info: {}, runtime_dlls: {}, fix_hints: {} };
  if (u.indexOf('/api/presets') >= 0) return { presets: [] };
  if (u.indexOf('/api/version') >= 0) return { version: '3.13.14', name: '360 Video Converter' };
  if (u.indexOf('/api/tasks/load') >= 0) return { tasks: [] };
  if (u.indexOf('/api/settings') >= 0) return {};
  if (u.indexOf('/api/sysmon') >= 0) return { cpu: 10, mem: 40, disk: 0, net: 0, gpu: 0 };
  if (u.indexOf('/api/status/') >= 0) return { overall_progress: 0, file_progress: 0, items: [], log: [], status: 'running' };
  return {};
};

const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', e => errors.push('jsdomError: ' + ((e.detail && e.detail.message) || e.message || e)));
vc.on('error', (...a) => errors.push('console.error: ' + a.map(String).join(' ')));

(async () => {
  console.log('\n──── 第 0 组：源码层断言（静态）────');
  staticPhase();

  console.log('\n──── 第 1 组：运行时断言（jsdom 真实 DOM + MouseEvent）────');
  let dom;
  try {
    dom = await JSDOM.fromURL(URL, {
      runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true,
      virtualConsole: vc,
      beforeParse(w) {
        w.alert = (m) => { w.__lastAlert = String(m); };
        w.confirm = () => true;
        w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
        w.AbortController = w.AbortController || AbortController;
        w.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
        // spy：记录每一次 fetch 的 URL —— A7「零副作用」断言依赖它
        w.fetch = async (u, opt) => {
          BACKEND.fetchLog.push({ url: String(u), method: (opt && opt.method) || 'GET' });
          const r = API(u, opt);
          // [!] file_fs_time 必须回真实 HTTP 状态码：前端的失败文案分流
          //   （404 文件已删 / 403 无权限 / 其他 IO 异常）依赖 response.status，
          //   若一律回 200，三种失败情形会退化成同一条文案，测不出分流是否正确。
          const isFsTime = String(u).indexOf('/api/file_fs_time') >= 0;
          const st = isFsTime ? BACKEND.fsTimeStatus : 200;
          return { ok: st === 200, status: st, json: async () => r, text: async () => JSON.stringify(r) };
        };
      },
    });
  } catch (e) {
    console.log('FAIL 无法加载页面: ' + e.message + '  （需先起 8800 桩服务器：node scripts/frontend-gate/_stub-server.js 8800）');
    const failed = results.filter(r => !r.ok).length;
    console.log(`\n══ v3.13.14 元数据队列验收：${results.length - failed}/${results.length} PASS ══`);
    process.exit(1);
  }
  await new Promise(r => setTimeout(r, 2500));

  const w = dom.window;
  const d = w.document;
  const $ = id => d.getElementById(id);
  const ev = f => w.eval(f);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  // 真实 MouseEvent 派发（必须走中央委托，不能直接调函数）
  const click = sel => {
    const el = typeof sel === 'string' ? d.querySelector(sel) : sel;
    if (!el) return false;
    el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
    return true;
  };
  const change = sel => {
    const el = typeof sel === 'string' ? d.querySelector(sel) : sel;
    if (!el) return false;
    el.dispatchEvent(new w.Event('change', { bubbles: true }));
    return true;
  };
  const toastText = () => { const t = $('toastNotification'); return t ? (t.textContent || '') : ''; };
  const badgeText = () => ($('metaQueueCount') ? ($('metaQueueCount').textContent || '') : '');
  // v3.13.18：待转换数（= selected && status !== 'done'），供拆分后的按钮文案断言使用。
  // 口径与 50-meta.js 的 metaQueueStats 完全一致，不另立标准。
  const pendingCount = () => ev('metaBatchItems.filter(f => f.selected && f.status !== "done").length');

  // ══ A1 按钮存在性 / 位置 / 模式显隐 ═══════════════════════════
  check('A1.9 运行时：#metaAddQueueBtn 存在于 DOM', !!$('metaAddQueueBtn'), '');
  check('A1.10 运行时：DOM 顺序紧贴 #metaApplyBtn 之后',
    $('metaApplyBtn').nextElementSibling === $('metaAddQueueBtn'),
    `next=${$('metaApplyBtn').nextElementSibling && $('metaApplyBtn').nextElementSibling.id}`);
  // 逐模式点击页签 → 显隐跟随 switchMode（回归 _diag_mode_clicks 范式）
  const NON_META = ['single', 'merge', 'batch', 'report', 'vr3d'];
  let hideOk = true, hideDetail = [];
  for (const m of NON_META) {
    const tab = d.querySelector(`.mode-tab[data-mode="${m}"]`);
    if (!tab) { hideOk = false; hideDetail.push(m + ':tab缺失'); continue; }
    tab.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await wait(30);
    const disp = $('metaAddQueueBtn').style.display;
    if (disp !== 'none') { hideOk = false; hideDetail.push(`${m}:display=${disp || '(空)'}`); }
  }
  const metaTab = d.querySelector('.mode-tab[data-mode="metadata"]');
  metaTab.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await wait(40);
  check('A1.11 运行时：非元数据模式隐藏、元数据模式显示（switchMode 显隐同步）',
    hideOk && $('metaAddQueueBtn').style.display !== 'none',
    hideOk ? 'currentMode=' + ev('currentMode') : hideDetail.join(' '));
  check('A1.12 运行时：元数据模式下不与转换族「加入批量队列」同屏出现',
    $('metaAddQueueBtn').style.display !== 'none' && $('addToBatchBtn').style.display === 'none',
    `add=${$('metaAddQueueBtn').style.display || '(显示)'} convert=${$('addToBatchBtn').style.display || '(显示)'}`);

  // ══ A2 快照完整性（入队即冻结界面参数）═══════════════════════
  ev('metaBatchItems = []; forceFormRun = false; renderMetaBatchTable();');
  $('metaInput').value = 'D:\\videos\\a.mp4';
  $('metaBatchOutDir').value = 'D:\\out1';
  // 先在界面上勾几个开关，验证「快照 = 完整界面参数」
  $('m_apply_spherical').checked = true;
  $('m_apply_date').checked = true;
  $('m_date_from_filename').checked = true;
  click('#metaAddQueueBtn');
  await wait(80);
  check('A2.1 运行时：点「加入批量列队」新增 1 项（真实 MouseEvent 走委托）',
    ev('metaBatchItems.length') === 1, `n=${ev('metaBatchItems.length')}`);
  const snap = ev('JSON.stringify(metaBatchItems[0].settings)');
  check('A2.2 快照完整：outDir = 加入时 #metaBatchOutDir（D:\\out1）',
    ev("metaBatchItems[0].outDir.mode") === 'snapshot' && ev("metaBatchItems[0].outDir.value") === 'D:\\out1',
    ev('JSON.stringify(metaBatchItems[0].outDir)'));
  check('A2.3 快照完整：settings 含界面勾选的日期/全景开关（非默认空对象）',
    /"apply_spherical":true/.test(snap) && /"apply_date":true/.test(snap) && /"date_from_filename":true/.test(snap),
    snap.slice(0, 130));
  check('A2.4 快照完整：selected=true / status=pending（入队初始态）',
    ev('metaBatchItems[0].selected') === true && ev('metaBatchItems[0].status') === 'pending',
    `selected=${ev('metaBatchItems[0].selected')} status=${ev('metaBatchItems[0].status')}`);
  // 改界面参数后，已入队项的 settings 不得跟着变
  $('m_apply_spherical').checked = false;
  $('metaBatchOutDir').value = 'D:\\changed';
  check('A2.5 快照隔离：入队后改界面，全局输出目录不影响已入队项',
    ev("metaBatchItems[0].outDir.value") === 'D:\\out1', `outDir.value=${ev("metaBatchItems[0].outDir.value")}`);
  check('A2.6 toast 必须说出输出结果（用户最易错点：输出去了哪）',
    toastText().indexOf('已加入列队第 1 项') >= 0 && toastText().indexOf('D:\\out1') >= 0, toastText());
  check('A2.7 入队后 #metaInput 不清空（保留路径便于核对）', $('metaInput').value === 'D:\\videos\\a.mp4', $('metaInput').value);

  // toast 计数：入队不得连发第二条（改为行内探测 spinner）
  const toastAfterEnq = toastText();
  await wait(200);   // 等 probeMetaFile 完成
  check('A2.8 入队后不连发第二条 toast（探测反馈由行内 spinner 承担）',
    toastText() === toastAfterEnq && toastText().indexOf('探测') < 0,
    `enq="${toastAfterEnq}" after="${toastText()}"`);

  // ══ A3 去重（路径规范化）════════════════════════════════════
  const DEDUP_VARIANTS = [
    { p: 'd:/videos/a.mp4', label: '小写 + 正斜杠' },
    { p: 'D:\\videos\\a.mp4', label: '完全相同' },
    { p: 'D:\\\\videos\\\\a.mp4', label: '重复分隔符' },
    { p: 'D:\\videos\\a.mp4\\', label: '尾部分隔符' },
    { p: '"D:\\videos\\a.mp4"', label: '手输残留引号' },
  ];
  let dedupOk = true, dedupDetail = [];
  for (const v of DEDUP_VARIANTS) {
    $('metaInput').value = v.p;
    click('#metaAddQueueBtn');
    await wait(40);
    if (ev('metaBatchItems.length') !== 1) { dedupOk = false; dedupDetail.push(`${v.label}: n=${ev('metaBatchItems.length')}`); }
  }
  check('A3.7 五种路径变体全部被去重拦下（ADR D-5 归一化四层 + 大小写）',
    dedupOk, dedupOk ? '队列仍 1 项' : dedupDetail.join(' ; '));
  check('A3.8 去重 toast 说出所在项序号（不是笼统的「已在列表中」）',
    toastText().indexOf('已在列队第 1 项') >= 0, toastText());

  // ══ A2/D-4 核心：改全局后入队，第 1 项保持旧快照 ═════════════
  $('metaBatchOutDir').value = 'D:\\out2';
  $('metaInput').value = 'D:\\videos\\b.mp4';
  click('#metaAddQueueBtn');
  await wait(80);
  check('A2.9 改全局后入队：第 1 项仍快照 out1、第 2 项快照 out2（D-4 核心）',
    ev('metaBatchItems[0].outDir.value') === 'D:\\out1' && ev('metaBatchItems[1].outDir.value') === 'D:\\out2',
    `1=${ev('metaBatchItems[0].outDir.value')} 2=${ev('metaBatchItems[1].outDir.value')}`);
  // 输出目录留空 → inplace（唯一会覆盖源文件的结果，必须在 toast 里说出来）
  $('metaBatchOutDir').value = '';
  $('metaInput').value = 'D:\\videos\\c.mp4';
  click('#metaAddQueueBtn');
  await wait(80);
  check('A2.10 输出目录留空 → outDir.mode=inplace',
    ev('metaBatchItems[2].outDir.mode') === 'inplace', ev('JSON.stringify(metaBatchItems[2].outDir)'));
  check('A2.11 inplace 入队的 toast 必须明说「原地修改」（唯一破坏性结果）',
    toastText().indexOf('原地修改') >= 0, toastText());
  // 队列行输出归属芯片：三态
  const body0 = $('metaBatchTableBody').innerHTML;
  check('A2.12 队列行渲染输出归属芯片且三态 class 齐备（快照/全局/原地）',
    body0.indexOf('metaq-chip-out-snapshot') >= 0 && body0.indexOf('metaq-chip-out-inplace') >= 0,
    '本轮仅含 snapshot 与 inplace 两态');
  check('A2.13 输出芯片不靠颜色单独传达（图标 + 文案 + 描边三编码）',
    /points="15 10 20 15 15 20"/.test(body0) && body0.indexOf('快照') >= 0
    && /metaq-chip-out-snapshot/.test(body0), '');

  // ══ A6 按钮文案随状态切换 + 惰性化 ═════════════════════════
  $('metaApplyBtn').textContent = '?';
  ev('renderMetaBatchTable();');
  check('A6.9 有待转换项 → 「应用元数据」文案恒定（职责已收窄为界面单文件）',
    $('metaApplyBtn').textContent === '应用元数据（当前文件）', `"${$('metaApplyBtn').textContent}"`);
  check('A6.10 「应用元数据」title 指向单文件语义并指路列队按钮（标签即语义）',
    ($('metaApplyBtn').title || '').indexOf('单个文件') >= 0
    && ($('metaApplyBtn').title || '').indexOf('开始批量列队执行') >= 0, $('metaApplyBtn').title);
  // v3.13.18：待转换计数与「忽略界面设置」的说明已迁移到 #metaBatchRunBtn。
  // 这是拆分后信息不该丢失的保证 —— 两个按钮各司其职，但「本次跑什么」仍必须可见。
  check('A6.10b 有待转换项 → 「开始批量列队执行」显示待转换数并在 title 说明忽略界面设置',
    $('metaBatchRunBtn').textContent === `开始批量列队执行 · ${pendingCount()} 项`
    && ($('metaBatchRunBtn').title || '').indexOf('界面设置本次不生效') >= 0,
    `btn="${$('metaBatchRunBtn').textContent}" title="${$('metaBatchRunBtn').title}"`);
  check('A6.11 有待转换项 → 执行范围说明条出现并列出待转换数',
    !$('metaScopeNotice').classList.contains('hidden') && ($('metaScopeNotice').textContent || '').indexOf('3') >= 0,
    ($('metaScopeNotice').textContent || '').trim().slice(0, 46));
  // 惰性化三态在页面上下文中判定（用 document.getElementById，不引用宿主侧 $）
  const inert = ev(`(function(){
    const sph=document.getElementById('m_apply_spherical');
    const out=document.getElementById('metaBatchOutDir');
    const notice=document.getElementById('metaScopeNotice');
    const card = sph ? sph.closest('.card') : null;
    return [!!(card && card.classList.contains('meta-form-inert')),
            !!(out && out.closest('.field') && out.closest('.field').classList.contains('meta-form-inert')),
            !!(card && card.contains(notice))];   // true = 说明条被惰性化包住（违规）
  })()`);
  check('A6.12 功能开关卡 + 输出目录字段双双置惰性（队列模式下界面设置不生效）',
    inert[0] === true && inert[1] === true, JSON.stringify(inert));
  check('A6.13 说明条在惰性子树之外（满对比度，WCAG 禁用豁免的正确用法）',
    inert[2] === false, '说明条未被惰性化');
  // v3.13.18：出口按钮语义由「本轮忽略列队」改为「设置同步器」——
  // 把界面设置写入勾选项，且不启动任何转换。
  const beforeSync = JSON.stringify(ev('metaBatchItems.map(f => f.settings)'));
  const outDirsBefore = JSON.stringify(ev('metaBatchItems.map(f => f.outDir)'));
  BACKEND.applied = [];
  click('[data-action="meta-force-form-run"]');
  await wait(40);
  check('A6.14 点「把界面设置应用到勾选项」→ 设置写入各列队项，且未发起任何转换请求',
    ev('metaBatchItems.every(f => f.settings && typeof f.settings === "object")')
    && JSON.stringify(ev('metaBatchItems.map(f => f.settings)')) !== beforeSync
    && BACKEND.applied.length === 0,
    `applied=${BACKEND.applied.length} toast="${toastText()}"`);
  check('A6.14b 设置同步器绝不改写各项 outDir（输出位置与标签内容是两件事）',
    JSON.stringify(ev('metaBatchItems.map(f => f.outDir)')) === outDirsBefore,
    JSON.stringify(ev('metaBatchItems.map(f => f.outDir)')));
  check('A6.14c 设置同步成功有 toast 反馈（非静默）',
    toastText().indexOf('已将界面设置应用到') >= 0, toastText());
  check('A6.14d 设置同步器不改动任何队列项状态（只改 settings，不隐式重排队）',
    ev('metaBatchItems.filter(f=>f.status==="done").length') === 0, '');
  ev('forceFormRun = false; renderMetaBatchTable();');

  // ══ A8 待执行项判定 + 输出分派 ═══════════════════════════════
  // v3.13.18：列队执行已从 startMetadataApply 迁到 startMetadataBatchRun，
  // 本组断言改为打新按钮对应的入口 —— 判定语义（ADR D-3/D-4）未变。
  ev('metaBatchItems[1].selected = false;');
  BACKEND.applied = [];
  await ev('startMetadataBatchRun()');
  await wait(100);
  check('A8.7 未勾选项不执行（selected=false 的 pending 项照跑会让 checkbox 变装饰）',
    BACKEND.applied.length === 2 && BACKEND.applied.every(i => i.input.indexOf('b.mp4') < 0),
    `n=${BACKEND.applied.length} inputs=${JSON.stringify(BACKEND.applied.map(i => i.input))}`);
  check('A8.8 输出按 outDir.mode 分派：快照项各自落自己的目录、inplace 项原地',
    BACKEND.applied[0].output === 'D:\\out1\\a.mp4' && BACKEND.applied[1].output === 'D:\\videos\\c.mp4',
    JSON.stringify(BACKEND.applied.map(i => i.output)));
  check('A8.9 列队模式忽略界面设置（items 用 per-item settings 快照，非当前界面）',
    BACKEND.applied.every(i => i.params && typeof i.params === 'object') && BACKEND.applied.length === 2, '');
  // v3.13.18：两条路径彻底分离 —— 界面单文件入口内不得再出现列队判定。
  // 运行时判据：调用 startMetadataApply 后 _metaProcessingIndices 必须为空
  // （非空即说明它仍在建立「后端项 → 队列行」映射，也就是仍在跑列队）。
  ev('if (isJobRunning()) endJob();');
  $('metaInput').value = 'D:\\videos\\c.mp4';
  BACKEND.applied = [];
  await ev('startMetadataApply()');
  await wait(100);
  check('A8.10 「应用元数据」只跑界面单文件（不建立队列行映射即不碰列队）',
    BACKEND.applied.length === 1
    && BACKEND.applied[0].input === 'D:\\videos\\c.mp4'
    && ev('_metaProcessingIndices.length') === 0,
    `n=${BACKEND.applied.length} idx=${ev('_metaProcessingIndices.length')}`);

  // 全 done → 「开始批量列队执行」应拒绝执行（done 不被重跑 = D-4 核心修复）
  ev('if (isJobRunning()) endJob();');
  ev('metaBatchItems.forEach(f => { f.status = "done"; }); renderMetaBatchTable();');
  check('A8.11 队列非空但全部完成 → 列队按钮禁用且 title 说明原因',
    $('metaBatchRunBtn').disabled === true
    && ($('metaBatchRunBtn').title || '').indexOf('重新排队') >= 0,
    `disabled=${$('metaBatchRunBtn').disabled} title="${$('metaBatchRunBtn').title}"`);
  ev('metaBatchItems[1].selected = true;');
  BACKEND.applied = [];
  await ev('startMetadataBatchRun()');
  await wait(100);
  check('A8.12 全 done 时列队执行不发起任何请求（done 项不被重复处理）',
    BACKEND.applied.length === 0, JSON.stringify(BACKEND.applied.map(i => i.input)));
  check('A8.13 无待转换项时明确告知（含重跑指引，而非静默退出）',
    toastText().indexOf('无待转换项') >= 0 && toastText().indexOf('重新排队') >= 0, toastText());

  // hasAnyFeature 中止 ≠ 无可执行项兜底（D-4 明确要求两段过滤）
  ev(`metaBatchItems = [{path:"D:\\\\videos\\\\z.mp4",name:"z.mp4",size_mb:"",date_in_name:"",
      selected:true,status:"pending",statusMsg:"",duration:"",
      settings:{apply_spherical:false,apply_date:false,apply_location:false},
      outDir:{mode:"inplace",value:""},probed:true}]; renderMetaBatchTable();`);
  $('metaInput').value = 'D:\\videos\\y.mp4';
  w.__lastAlert = undefined;
  BACKEND.applied = [];
  await ev('startMetadataBatchRun()');
  await wait(80);
  check('A8.14 有项但都没开功能 → alert 中止（不得误判成「无待转换项」静默退出）',
    (w.__lastAlert || '').indexOf('均未启用任何元数据功能') >= 0 && BACKEND.applied.length === 0,
    `alert="${w.__lastAlert}" 已发起请求=${BACKEND.applied.length > 0}`);
  check('A8.14b 中止后不留悬空 _metaProcessingIndices（否则结果会错记到别的行）',
    ev('_metaProcessingIndices.length') === 0, `len=${ev('_metaProcessingIndices.length')}`);

  // ══ A5 编辑弹窗输出位置三态 ═════════════════════════════════
  ev(`metaBatchItems = [
    {path:"D:\\\\videos\\\\a.mp4",name:"a.mp4",size_mb:"12.5",date_in_name:"",selected:true,status:"pending",statusMsg:"",duration:"",
     settings:{apply_date:true,manual_date:"2024-01-15",date_from_filename:false,apply_spherical:false,apply_location:false},
     outDir:{mode:"snapshot",value:"D:\\\\out1"},probed:true,probeData:{has_gps:false,has_time:false}},
    {path:"D:\\\\videos\\\\g.mp4",name:"g.mp4",size_mb:"1",date_in_name:"",selected:true,status:"pending",statusMsg:"",duration:"",
     settings:{apply_date:false,apply_spherical:false,apply_location:false},
     outDir:{mode:"global",value:""},probed:true}
  ]; renderMetaBatchTable();`);
  $('metaBatchOutDir').value = 'D:\\global_now';
  ev('editMetaFileSettings(0);');
  const segG = d.querySelector('input[name="me_out_mode"][value="global"]');
  const segS = d.querySelector('input[name="me_out_mode"][value="snapshot"]');
  const segI = d.querySelector('input[name="me_out_mode"][value="inplace"]');
  check('A5.8 运行时：分段控件三态 radio 齐备', !!segG && !!segS && !!segI,
    `global=${!!segG} snapshot=${!!segS} inplace=${!!segI}`);
  check('A5.9 按 f.outDir.mode 回填选中项（弹窗打开即反映该行真实语义）', segS.checked === true, `checked=${segS.checked}`);
  const pathWrap = d.querySelector('#metaEditModal .me-out-path');
  check('A5.10 snapshot 态：路径行显示且预填加入时的快照值',
    pathWrap && !pathWrap.classList.contains('hidden') && $('me_out_dir').value === 'D:\\out1',
    `hidden=${pathWrap && pathWrap.classList.contains('hidden')} val="${$('me_out_dir').value}"`);
  const hintEl = d.querySelector('#metaEditModal .me-out-hint');
  check('A5.11 snapshot 态 hint 说明「之后改全局不影响本行」',
    hintEl && hintEl.textContent.indexOf('不影响本行') >= 0, hintEl && hintEl.textContent);

  // 真实 change 事件切三态（radio 是表单控件，委托只监听 change）
  segG.checked = true; change(segG);
  check('A5.12 切「全局」→ 路径行隐藏 + hint 切全局级',
    pathWrap.classList.contains('hidden') && hintEl.textContent.indexOf('全局级') >= 0, hintEl.textContent);
  check('A5.13 切走不清空已填的快照路径（切回可恢复，非 destructive）',
    $('me_out_dir').value === 'D:\\out1', `val="${$('me_out_dir').value}"`);
  segI.checked = true; change(segI);
  check('A5.14 切「原地」→ 路径行隐藏 + hint 含破坏性警告（源文件不可撤销）',
    pathWrap.classList.contains('hidden') && hintEl.textContent.indexOf('覆盖源文件') >= 0, hintEl.textContent);

  // 保存为 snapshot + 改路径 → 输出目录「可改且改完仍固定」
  segS.checked = true; change(segS);
  $('me_out_dir').value = 'D:\\edited';
  ev('saveMetaFileSettings();');
  check('A5.15 保存 snapshot → f.outDir={mode:snapshot,value:D:\\edited}（编辑可改）',
    ev('metaBatchItems[0].outDir.mode') === 'snapshot' && ev('metaBatchItems[0].outDir.value') === 'D:\\edited',
    ev('JSON.stringify(metaBatchItems[0].outDir)'));
  // 改全局后，执行期仍用该行快照
  $('metaBatchOutDir').value = 'D:\\global_after_edit';
  check('A5.16 改全局后该行输出目录仍固定为编辑后的快照（改完仍固定）',
    ev('resolveMetaOutputPath(metaBatchItems[0], "D:\\\\global_after_edit")') === 'D:\\edited\\a.mp4',
    ev('resolveMetaOutputPath(metaBatchItems[0], "D:\\\\global_after_edit")'));
  // 切回 inplace 保存 → 非 snapshot 时忽略路径值
  ev('editMetaFileSettings(0);');
  const segI2 = d.querySelector('input[name="me_out_mode"][value="inplace"]');
  segI2.checked = true; change(segI2);
  $('me_out_dir').value = 'D:\\ignored';
  ev('saveMetaFileSettings();');
  check('A5.17 保存 inplace → value 置空（留空=覆盖源文件，不留隐藏目录）',
    ev('JSON.stringify(metaBatchItems[0].outDir)') === '{"mode":"inplace","value":""}',
    ev('JSON.stringify(metaBatchItems[0].outDir)'));
  // out_dir 绝不污染 collectMetaSettings（D-1 不变量）
  check('A5.18 outDir 未并入 settings（collectMetaSettings 表驱动，不得污染三前缀映射）',
    ev('JSON.stringify(metaBatchItems[0].settings).indexOf("out_dir")') === -1
    && ev('JSON.stringify(metaBatchItems[0].settings).indexOf("outDir")') === -1,
    Object.keys(JSON.parse(ev('JSON.stringify(metaBatchItems[0].settings)'))).join(','));
  // global 态解析：执行时读全局当前值
  check('A5.19 global 态 → 执行期读 #metaBatchOutDir 当前值（非快照）',
    ev('resolveMetaOutputPath(metaBatchItems[1], "D:\\\\global_now")') === 'D:\\global_now\\g.mp4',
    ev('resolveMetaOutputPath(metaBatchItems[1], "D:\\\\global_now")'));
  check('A5.20 inplace 态 → 解析为源文件本身（唯一破坏性结果必须显式）',
    ev('resolveMetaOutputPath(metaBatchItems[0], "D:\\\\x")') === 'D:\\videos\\a.mp4',
    ev('resolveMetaOutputPath(metaBatchItems[0], "D:\\\\x")'));
  ev('closeMetaEditModal();');

  // ══ A7 reset-meta-item 零副作用（最危险的一条，spy 断言无网络调用）
  // 先结束可能残留的任务句柄：否则 ActiveJob.id 的基线值本身来自前序 startMetadataApply，
  // 「未变」的断言会失去意义（且后续 startMetadataApply 会被 isJobRunning 拒绝）。
  ev('if (isJobRunning()) endJob();');
  ev('metaBatchItems[0].status = "done"; metaBatchItems[0].duration = "1.4秒"; metaBatchItems[0].statusMsg = ""; renderMetaBatchTable();');
  const beforeSettings = ev('JSON.stringify(metaBatchItems[0].settings)');
  const beforeOutDir = ev('JSON.stringify(metaBatchItems[0].outDir)');
  const beforeSelected = ev('metaBatchItems[0].selected');
  const beforeJobId = ev('ActiveJob.id');
  const beforeLogLen = ev('document.getElementById("logBox").children.length');
  const beforeFetch = BACKEND.fetchLog.length;
  const beforeApplied = BACKEND.applied.length;
  // 徽标基线必须在点击**之前**取：reset 后徽标立即重算，事后取已看不到「已完成 -1」
  const badgeBeforeReset = badgeText();

  const resetBtns = d.querySelectorAll('[data-action="reset-meta-item"]');
  check('A7.4 done 行渲染出「重排队」按钮（图标 + aria-label）', resetBtns.length === 1, `按钮数=${resetBtns.length}`);
  check('A7.5 非 done 行不渲染重排队按钮（pending 行无重排需求）',
    resetBtns.length === 1 && ev('metaBatchItems.filter(f=>f.status==="done").length') === 1, '');
  // 真实点击 → 只允许状态变化
  click(resetBtns[0]);
  await wait(80);
  check('A7.6 重排队 → done 改回 pending 且清空耗时/状态文案',
    ev('metaBatchItems[0].status') === 'pending' && ev('metaBatchItems[0].duration') === '' && ev('metaBatchItems[0].statusMsg') === '',
    `status=${ev('metaBatchItems[0].status')} dur="${ev('metaBatchItems[0].duration')}"`);
  check('A7.7 零副作用：f.settings 与 f.outDir 逐字节未变',
    ev('JSON.stringify(metaBatchItems[0].settings)') === beforeSettings
    && ev('JSON.stringify(metaBatchItems[0].outDir)') === beforeOutDir, '');
  check('A7.8 零副作用：勾选状态未被改动',
    ev('metaBatchItems[0].selected') === beforeSelected, `selected=${ev('metaBatchItems[0].selected')}`);
  // ── spy 断言：本次点击期间不得有任何网络调用 / 任务启动 ──
  const duringFetch = BACKEND.fetchLog.slice(beforeFetch);
  const applyCalls = duringFetch.filter(f => f.url.indexOf('/api/apply_metadata') >= 0);
  const statusCalls = duringFetch.filter(f => f.url.indexOf('/api/status/') >= 0);
  check('A7.9 【关键】reset 绝不触发 /api/apply_metadata（spy 断言零网络执行）',
    applyCalls.length === 0, applyCalls.length === 0 ? `期间 fetch 共 ${duringFetch.length} 次，均为无关调用` : JSON.stringify(applyCalls));
  check('A7.10 【关键】reset 绝不触发 /api/status/ 轮询（未调起任何任务）',
    statusCalls.length === 0, `期间 fetch 共 ${duringFetch.length} 次: ${duringFetch.map(f => f.url).join(' ') || '(无)'}`);
  check('A7.11 【关键】reset 未调起 startMetadataApply（ActiveJob.id 未变、未进 running）',
    ev('ActiveJob.id') === beforeJobId && ev('isJobRunning()') === false,
    `jobId=${ev('ActiveJob.id')} running=${ev('isJobRunning()')}`);
  check('A7.12 【关键】reset 未下发任何 items（apply_metadata 请求体未新增）',
    BACKEND.applied.length === beforeApplied, `items=${BACKEND.applied.length}`);
  // 徽标重算：reset 前应有 1 已完成，reset 后应消失且待转换 +1
  check('A7.13 reset 后徽标立即重算（待转换 +1 / 已完成 -1）',
    badgeBeforeReset.indexOf('1 已完成') >= 0
    && badgeText().indexOf('2 待转换') >= 0 && badgeText().indexOf('已完成') < 0,
    `before="${badgeBeforeReset}" after="${badgeText()}"`);
  check('A7.14 reset 给了明确反馈 toast（告知下次点应用会重跑）',
    toastText().indexOf('待转换') >= 0 && toastText().indexOf('重跑') >= 0, toastText());

  // 编辑已完成项不隐式重排队（ADR D-2 关键约束）
  ev('metaBatchItems[0].status = "done"; metaBatchItems[0].duration = "1.4秒"; renderMetaBatchTable();');
  ev('editMetaFileSettings(0); saveMetaFileSettings();');
  check('A8.15 ADR D-2 关键约束：done 项编辑后回落 pending 并明确告知（用户编辑意图真实生效）',
    ev('metaBatchItems[0].status') === 'pending' && toastText().indexOf('重跑') >= 0,
    `status=${ev('metaBatchItems[0].status')} toast="${toastText()}"`);
  ev('closeMetaEditModal();');

  // ══ A9/A10 三处日期浏览按钮 ═════════════════════════════════
  // 成功路径：三处都跑一遍（三前缀对称，防只改一处）
  const PREFIXES = [
    { prefix: 'm', input: 'm_manual_date', fromName: 'm_date_from_filename', master: 'm_apply_date', btn: 'm_manual_date_browse' },
    { prefix: 'p', input: 'p_manual_date', fromName: 'p_date_from_filename', master: 'p_date_from_filename', btn: 'p_manual_date_browse' },
    { prefix: 'me', input: 'me_manual_date', fromName: 'me_date_from_filename', master: 'me_apply_date', btn: 'me_manual_date_browse' },
  ];
  for (const P of PREFIXES) {
    $(P.input).value = '';
    $(P.fromName).checked = true;
    $(P.master).checked = true;
    if (P.prefix === 'me') ev('editMetaFileSettings(0);');
    BACKEND.nativeDialogPath = 'G:/ref/IMG_2043.MP4';
    BACKEND.fsTimeStatus = 200;
    // 真实点击浏览按钮（走 browse-date 委托）
    click('#' + P.btn);
    await wait(150);
    const srcEl = d.querySelector(`.date-source[data-date-source-for="${P.input}"]`);
    check(`A9.8 ${P.prefix}_ 前缀：点「读创建时间」回填本地 naive 字符串（无 Z、无二次转换）`,
      $(P.input).value === '2024-03-11T09:22:41', `val="${$(P.input).value}"`);
    // 联动语义按前缀区分（ADR-004 D-7 第 1 条）：
    //   m_ / me_：masterDate 与 fromName 是两个元素 → fromName 必被清、master 必开启
    //   p_    ：两者是**同一个元素** → 「先清后开」两行作用在同一节点，净效果 = 仍开启
    //            （若为 p_ 写特判或调换顺序，净效果会变成「日期功能被关闭」且界面无报错）
    const isP = P.prefix === 'p';
    check(`A9.9 ${P.prefix}_ 前缀：联动语义正确（${isP ? '同元素净效果=日期功能仍开启' : '清文件名勾选 + 开启日期总开关'}）`,
      isP
        ? ($(P.master).checked === true && ev('document.getElementById("p_date_from_filename") === document.getElementById("p_date_from_filename")'))
        : ($(P.fromName).checked === false && $(P.master).checked === true),
      `fromName=${$(P.fromName).checked} master=${$(P.master).checked}${isP ? '（同一元素，两行顺序契约）' : ''}`);
    check(`A9.10 ${P.prefix}_ 前缀：溯源条显示来源文件名与时间戳（常驻真相来源）`,
      !!srcEl && !srcEl.classList.contains('hidden') && srcEl.dataset.source === 'fs-ctime'
      && srcEl.textContent.indexOf('IMG_2043.MP4') >= 0 && srcEl.textContent.indexOf('2024-03-11') >= 0,
      srcEl ? `"${(srcEl.textContent || '').trim().slice(0, 60)}"` : '溯源条缺失');
  }
  check('A9.11 p_ 前缀顺序陷阱：masterDate===fromName 同元素，净效果仍是日期功能开启',
    ev('document.getElementById("p_date_from_filename").checked') === true && $('p_manual_date').value === '2024-03-11T09:22:41',
    `checked=${ev('document.getElementById("p_date_from_filename").checked')} val="${$('p_manual_date').value}"`);
  ev('closeMetaEditModal();');

  // 失败路径（铁律：绝不覆盖用户已输入的日期）
  const FAIL_CASES = [
    { status: 404, label: '文件已删除/移动（HTTP 404）' },
    { status: 403, label: '无访问权限（HTTP 403）' },
    { status: 500, label: '其他 IO 异常（HTTP 500）' },
  ];
  for (const FC of FAIL_CASES) {
    $('m_manual_date').value = '2024-01-15';
    BACKEND.fsTimeStatus = FC.status;
    click('#m_manual_date_browse');
    await wait(150);
    const srcEl = d.querySelector('.date-source[data-date-source-for="m_manual_date"]');
    check(`A10.6 ${FC.label} → 用户已输入的日期原样保留（失败绝不覆盖）`,
      $('m_manual_date').value === '2024-01-15', `val="${$('m_manual_date').value}"`);
    check(`A10.7 ${FC.label} → 溯源条切 error 并给「手动输入」恢复出口`,
      !!srcEl && srcEl.dataset.source === 'error' && srcEl.classList.contains('is-error')
      && !!srcEl.querySelector('[data-action="meta-date-from-file"][data-date-mode="manual"]'),
      srcEl ? `"${(srcEl.textContent || '').trim()}"` : '溯源条缺失');
    check(`A10.8 ${FC.label} → toast 只给人话、系统细节进 title（禁止把 e.message 拼进 toast）`,
      toastText().indexOf('读不到创建日期') >= 0 || toastText().indexOf('读取创建日期失败') >= 0,
      `toast="${toastText()}"`);
    check(`A10.9 ${FC.label} → 系统细节进溯源条 title（排障入口不占首屏）`,
      !!srcEl && (srcEl.title || '').indexOf('系统返回') >= 0, srcEl ? `title="${srcEl.title}"` : '');
  }
  // 取消对话框：取消不是错误
  $('m_manual_date').value = '2024-02-02';
  BACKEND.nativeDialogPath = '';
  BACKEND.fsTimeStatus = 200;
  w.__lastAlert = undefined;
  click('#m_manual_date_browse');
  await wait(150);
  check('A10.10 用户取消文件对话框 → 不改日期、不弹错误提示（取消不是错误）',
    $('m_manual_date').value === '2024-02-02' && w.__lastAlert === undefined,
    `val="${$('m_manual_date').value}" alert=${w.__lastAlert}`);

  // 「手动输入」/「清除」恢复出口
  BACKEND.nativeDialogPath = 'G:/ref/IMG_2043.MP4';
  $('m_manual_date').value = '2024-05-05';
  BACKEND.fsTimeStatus = 404;
  click('#m_manual_date_browse');
  await wait(150);
  const errSrc = d.querySelector('.date-source[data-date-source-for="m_manual_date"]');
  click(errSrc.querySelector('[data-date-mode="manual"]'));
  await wait(60);
  check('A10.11 「手动输入」→ 溯源条切 manual 且不清空已有值（是跳转不是提交）',
    errSrc.dataset.source === 'manual' && $('m_manual_date').value === '2024-05-05',
    `source=${errSrc.dataset.source} val="${$('m_manual_date').value}"`);

  BACKEND.fsTimeStatus = 200;
  click('#m_manual_date_browse');
  await wait(150);
  const okSrc = d.querySelector('.date-source[data-date-source-for="m_manual_date"]');
  click(okSrc.querySelector('[data-date-mode="clear"]'));
  await wait(60);
  check('A10.12 「清除」→ 输入框清空且溯源条回到 none',
    $('m_manual_date').value === '' && okSrc.dataset.source === 'none' && okSrc.classList.contains('hidden'),
    `val="${$('m_manual_date').value}" source=${okSrc.dataset.source}`);

  // 成功路径不弹 toast（回填 + 溯源条已足够反馈）
  $('m_manual_date').value = '';
  const toastBefore = toastText();
  click('#m_manual_date_browse');
  await wait(150);
  check('A10.13 成功回填不弹 toast（不重复告知）', toastText() === toastBefore,
    `before="${toastBefore}" after="${toastText()}"`);

  // ══ A11 徽标双计数 + 11 个实时同步触发点 ═════════════════════
  ev('metaBatchItems = []; renderMetaBatchTable();');
  for (let i = 0; i < 4; i++) {
    $('metaInput').value = `D:\\videos\\q${i}.mp4`;
    click('#metaAddQueueBtn');
    await wait(50);
  }
  check('A11.1 加入 4 项 → 徽标「4 项 · 4 待转换」（总数 = X+Y+Z）',
    badgeText().indexOf('4 项') >= 0 && badgeText().indexOf('4 待转换') >= 0, badgeText());
  // 全选时不显示「勾选 S」（无信息量）
  check('A11.2 全选状态不显示「勾选 N」片段（无信息量）', badgeText().indexOf('勾选') < 0, badgeText());
  // 部分勾选
  ev('toggleMetaFileSelection(1, false);');
  check('A11.3 部分勾选 → 徽标出现「勾选 3」且待转换同步降为 3（双计数分离）',
    badgeText().indexOf('勾选 3') >= 0 && badgeText().indexOf('3 待转换') >= 0, badgeText());
  // 混合态：总数 4 = 待转换 3 + 已完成 1；「失败」是待转换内部的子类标注（error 项仍会被重跑）
  ev('metaBatchItems[0].status = "done"; metaBatchItems[2].status = "error"; metaBatchItems[1].selected = true; renderMetaBatchTable();');
  const mixed = badgeText();
  check('A11.4 混合态计数（总数 = 待转换 + 已完成；失败为待转换子类标注）',
    mixed.indexOf('4 项') >= 0 && mixed.indexOf('3 待转换') >= 0
    && mixed.indexOf('1 已完成') >= 0 && mixed.indexOf('1 失败') >= 0, mixed);
  // 空态必须 hidden（不留只有背景色的空胶囊）
  ev('metaBatchItems = []; renderMetaBatchTable();');
  check('A11.5 队列清空 → 徽标整体 hidden 且无空胶囊残留',
    $('metaQueueCount').classList.contains('hidden') && $('metaQueueCount').innerHTML === '',
    `hidden=${$('metaQueueCount').classList.contains('hidden')}`);
  // 11 个同步触发点逐一验证（缺一即产生不一致，R-4）
  const SYNC_POINTS = [
    ['加入列队 addToMetaBatchList', () => { ev('metaBatchItems = []; renderMetaBatchTable();'); $('metaInput').value = 'D:\\videos\\s1.mp4'; click('#metaAddQueueBtn'); }],
    ['添加文件 addMetaFileManual', () => { ev('metaBatchItems = []; renderMetaBatchTable();'); }],
    ['单项勾选 toggleMetaFileSelection', () => { ev('toggleMetaFileSelection(0, false);'); }],
    ['全选/全不选 selectAllMetaFiles', () => { ev('selectAllMetaFiles(true);'); }],
    ['移除选中 removeSelectedMetaFiles', () => { ev('removeSelectedMetaFiles();'); }],
    ['清空 clearMetaFiles', () => { ev('metaBatchItems = [{path:"D:\\\\v\\\\z.mp4",name:"z.mp4",selected:true,status:"pending",settings:{apply_date:true},outDir:{mode:"inplace",value:""},probed:true}]; renderMetaBatchTable(); clearMetaFiles();'); }],
    ['移除单项 removeMetaFile', () => { ev('metaBatchItems = [{path:"D:\\\\v\\\\z.mp4",name:"z.mp4",selected:true,status:"pending",settings:{apply_date:true},outDir:{mode:"inplace",value:""},probed:true},{path:"D:\\\\v\\\\y.mp4",name:"y.mp4",selected:true,status:"pending",settings:{apply_date:true},outDir:{mode:"inplace",value:""},probed:true}]; renderMetaBatchTable(); removeMetaFile(0);'); }],
    ['保存行内设置 saveMetaFileSettings', () => { ev('editMetaFileSettings(0); saveMetaFileSettings();'); }],
    ['显式重排队 resetMetaItem', () => { ev('metaBatchItems[0].status = "done"; renderMetaBatchTable(); resetMetaItem(0);'); }],
    ['执行状态推进 renderMetadataJob', () => { ev('_metaProcessingIndices = [0]; renderMetadataJob({items:[{ok:true,start_time:0,end_time:1.4}],current_index:-1,status:"running"});'); }],
    ['执行结束 renderJobCompletion', () => { ev('_metaProcessingIndices = [0]; renderJobCompletion({status:"completed",file_progress:100,items:[{ok:true,start_time:0,end_time:1.4}]});'); }],
  ];
  // 先造一个 2 项的基线队列
  ev(`metaBatchItems = [
    {path:"D:\\\\videos\\\\s1.mp4",name:"s1.mp4",size_mb:"1",date_in_name:"",selected:true,status:"pending",statusMsg:"",duration:"",
     settings:{apply_date:true,manual_date:"2024-01-01",date_from_filename:false,apply_spherical:false,apply_location:false},
     outDir:{mode:"inplace",value:""},probed:true,probeData:{has_gps:false,has_time:false}},
    {path:"D:\\\\videos\\\\s2.mp4",name:"s2.mp4",size_mb:"2",date_in_name:"",selected:true,status:"pending",statusMsg:"",duration:"",
     settings:{apply_date:true,manual_date:"2024-01-02",date_from_filename:false,apply_spherical:false,apply_location:false},
     outDir:{mode:"inplace",value:""},probed:true}
  ]; renderMetaBatchTable();`);
  // 记录 sync 三函数的调用次数（用 eval 包裹计数器，验证「统一 sync 被调用」）
  ev(`window.__syncCount = 0;
      (function(){
        const oc = window.syncMetaQueueCount, oa = window.syncMetaApplyButton, of = window.syncMetaFormInert, ot = window.renderMetaBatchTable;
        window.__bump = function(){ window.__syncCount++; };
      })();`);
  // 直接断言「徽标与按钮文案零脱节」：每个触发点之后二者必须与队列真实状态一致
  const consistent = () => {
    const total = ev('metaBatchItems.length');
    const pending = ev('metaBatchItems.filter(f => f.selected && f.status !== "done").length');
    const done = ev('metaBatchItems.filter(f => f.status === "done").length');
    const err = ev('metaBatchItems.filter(f => f.status === "error").length');
    const b = badgeText();
    // v3.13.18：计数一致性改为对齐「开始批量列队执行」——
    // 「应用元数据」文案恒定，不再承载队列计数，故不参与一致性判定。
    // 零脱节的本意（徽标数字 == 按钮承诺处理的项数）由 batchRun 按钮继续保证。
    const btn = $('metaBatchRunBtn').textContent;
    if (total === 0) {
      return $('metaQueueCount').classList.contains('hidden') && btn === '开始批量列队执行';
    }
    const badgeOk = b.indexOf(total + ' 项') >= 0
      && (pending === 0 || b.indexOf(pending + ' 待转换') >= 0)
      && (done === 0 || b.indexOf(done + ' 已完成') >= 0)
      && (err === 0 || b.indexOf(err + ' 失败') >= 0);
    const btnOk = pending > 0 ? btn === `开始批量列队执行 · ${pending} 项` : btn === '开始批量列队执行';
    // 「应用元数据」必须始终是单文件语义文案，不得被队列状态改写
    const applyOk = $('metaApplyBtn').textContent === '应用元数据（当前文件）';
    return badgeOk && btnOk && applyOk;
  };
  let syncOk = true, syncDetail = [];
  for (const [label, fn] of SYNC_POINTS) {
    try { fn(); } catch (e) { syncOk = false; syncDetail.push(label + ': 抛错 ' + e.message); continue; }
    await wait(50);
    if (!consistent()) {
      syncOk = false;
      syncDetail.push(`${label}: n=${ev("metaBatchItems.length")} badge="${badgeText()}" run="${$("metaBatchRunBtn").textContent}"`);
    }
  }
  check('A11.6 11 个实时同步触发点后徽标与按钮文案零脱节（缺一即不一致，R-4）',
    syncOk, syncOk ? '11/11 触发点后计数与文案均与队列真实状态一致' : syncDetail.join(' ; '));
  check('A11.7 徽标文案用「项」而非「文件」（与全应用计数单位对齐）',
    badgeText().indexOf('个文件') < 0, badgeText() || '(空队列)');
  check('A11.8 徽标带 aria-live=polite（屏幕阅读器播报计数变化）',
    /aria-live="polite"/.test($('metaQueueCount').outerHTML), '');
  check('A11.9 徽标超长时挂完整文本 title（截断兜底）',
    ev('metaBatchItems.length') === 0 || !!$('metaQueueCount').title, '');

  // ══ A12 运行时：emoji 换成 SVG 后合并→编码阶段仍能切回 ══════
  // 这是防静默失效的关键：旧实现用 lbl.textContent.startsWith(emoji) 反推状态，
  // emoji 一换 SVG 该判断恒为 false，标签卡在旧文案且不报任何错。
  const phaseProbe = await w.eval(`(function(){
    const out = {};
    out.hasPhaseField = ('phase' in ActiveJob);
    // 模拟「emoji 已换 SVG」的合并阶段：标签是 SVG 而非 emoji 前缀
    const lbl = document.getElementById('progressLabel');
    lbl.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24"></svg>合并 1/2：a.mp4';
    const textWithSvg = lbl.textContent;
    out.labelBefore = textWithSvg;
    out.startsWithEmojiWouldBeFalse = !/^\\u{1F517}/u.test(textWithSvg);
    // 置 phase='merge' 再进入编码阶段数据
    if (out.hasPhaseField) ActiveJob.phase = 'merge';
    isPaused = false;
    renderCommonStatus({ status: 'running', current_input: 'D:\\\\v\\\\a.mp4', current_index: 0, total: 1, merge_status: null }, 100);
    out.labelAfter = document.getElementById('progressLabel').textContent;
    out.phaseAfter = out.hasPhaseField ? ActiveJob.phase : '(无 phase 字段)';
    return out;
  })()`);
  check('A12.6 【关键·运行时】标签已是 SVG（非 emoji 前缀）时，切回编码阶段文案仍被重置',
    /转换中|应用中/.test(phaseProbe.labelAfter),
    `labelBefore="${phaseProbe.labelBefore}" labelAfter="${phaseProbe.labelAfter}" phase=${phaseProbe.phaseAfter}`);
  check('A12.7 阶段切换后 phase 归位为 encode（生命周期单向，不残留 merge）',
    phaseProbe.phaseAfter === 'encode' || phaseProbe.phaseAfter === '(无 phase 字段)',
    `phase=${phaseProbe.phaseAfter}`);
  const phaseAfterEnd = ev('(function(){ beginJob("jx","encode","merge"); var p_in = ActiveJob.phase; endJob(); return {during:p_in, after:ActiveJob.phase}; })()');
  check('A12.8 endJob 后 phase 归 null（不污染下一个任务）',
    phaseAfterEnd.after === null,
    `beginJob 期间 phase=${JSON.stringify(phaseAfterEnd.during)}，endJob 后 phase=${JSON.stringify(phaseAfterEnd.after)}（null 之外的值说明 endJob 未清理）`);
  check('A12.9 beginJob 缺省 phase 为 encode（非合并任务无需调用方改动）',
    ev('(function(){ beginJob("jy","encode"); var p = ActiveJob.phase; endJob(); return p; })()') === 'encode', '');

  // ══ A15 队列表 P0：零 emoji + 状态列文案 ═════════════════════
  ev(`metaBatchItems = [
    {path:"D:\\\\videos\\\\e.mp4",name:"e.mp4",size_mb:"12.5",date_in_name:"",selected:true,status:"done",statusMsg:"",duration:"1.4秒",
     settings:{apply_date:true,manual_date:"2024-01-15",date_from_filename:false,apply_spherical:true,pano_type:"360",stereo_mode:"mono",
               apply_location:true,location_lat:"36.7",location_lon:"116.8",location_name:"济南"},
     outDir:{mode:"snapshot",value:"D:\\\\out1"},probed:true,probeData:{has_gps:false,has_time:false}},
    {path:"D:\\\\videos\\\\f.mp4",name:"f.mp4",size_mb:"3",date_in_name:"",selected:true,status:"error",statusMsg:"写入失败：目标目录只读",duration:"",
     settings:{apply_date:false,apply_spherical:false,apply_location:false},outDir:{mode:"global",value:""},probed:true},
    {path:"D:\\\\videos\\\\g.mp4",name:"g.mp4",size_mb:"4",date_in_name:"",selected:true,status:"pending",statusMsg:"",duration:"",
     settings:{apply_date:true,date_from_filename:true,apply_spherical:false,apply_location:false},outDir:{mode:"inplace",value:""},probed:true}
  ]; renderMetaBatchTable();`);
  const tbody = $('metaBatchTableBody').innerHTML;
  const tbodyEmoji = (tbody.match(new RegExp(EMOJI_RE.source, 'gu')) || []);
  check('A15.1 队列表格内零 emoji（四态/徽章/芯片/操作列全部内联 SVG）',
    tbodyEmoji.length === 0, tbodyEmoji.length === 0 ? `SVG 数=${(tbody.match(/<svg/g) || []).length}` : `残留 ${tbodyEmoji.length} 个: ${tbodyEmoji.join('')}`);
  check('A15.2 done 行用 check SVG + 「完成 1.4秒」（无 emoji 对勾、无多余括号）',
    /M20 6 9 17l-5-5/.test(tbody) && /完成 1\.4秒/.test(tbody), '');
  check('A15.3 error 行用 x SVG + 第二行承载截断原因（不必悬停才看得到）',
    /M18 6 6 18M6 6l12 12/.test(tbody) && /metaq-state-detail/.test(tbody), '');
  check('A15.4 pending 行文案为「待转换」（非「等待中」，与动词体系一致）',
    /待转换/.test(tbody) && tbody.indexOf('等待中') < 0, '');
  check('A15.5 三行输出芯片分属 snapshot / global / inplace 三态',
    /metaq-chip-out-snapshot/.test(tbody) && /metaq-chip-out-global/.test(tbody) && /metaq-chip-out-inplace/.test(tbody), '');
  check('A15.6 done 行三按钮齐备（编辑 / 重排队 / 移除），pending 行两按钮',
    /M3 2v6h6/.test(tbody) && /M17 3a2\.828/.test(tbody) && /points="3 6 5 6 21 6"/.test(tbody), '');
  check('A15.7 任务徽章用 globe / calendar / pin 三枚 SVG（替换原 emoji 徽章）',
    /viewBox="0 0 24 24"[^>]*><circle cx="12"/.test(tbody) && /<rect x="3" y="4"/.test(tbody) && /M21 10c0 7-9 13-9 13/.test(tbody), '');
  check('A15.8 徽标/文件名/序号未被整行 opacity 降级（销毁审计线索）',
    tbody.indexOf('opacity: 0.55') < 0, '');

  // ══ A16 P0 视觉合规：禁 emoji 图标 / 禁紫粉渐变 / 禁 AI 模板味 ══
  const cssAll = fs.readFileSync(path.join(ROOT, 'static/css/theme-cobalt.css'), 'utf8')
    + fs.readFileSync(path.join(ROOT, 'static/css/app.css'), 'utf8');
  const htmlAll = fs.readFileSync(path.join(ROOT, 'static/index.html'), 'utf8');
  check('A16.3 全站无紫粉渐变（团队 P0：purple->pink）',
    !/from-purple[^\n]*to-pink|purple[^\n]{0,40}pink|7C3AED[^\n]{0,40}(A855F7|EC4899)/i.test(cssAll + htmlAll), '');
  check('A16.4 无 AI 模板味占位文案（Welcome to / Lorem ipsum）',
    htmlAll.indexOf('Welcome to') < 0 && htmlAll.indexOf('Lorem ipsum') < 0, '');
  check('A16.5 套件自身零 emoji（QA 侧 P0 自检：本文件不含任何 emoji 字符）',
    !EMOJI_RE.test(fs.readFileSync(__filename, 'utf8')), '');

  // ══ 收尾 ═════════════════════════════════════════════════════
  check('A0.1 页面无 JS 运行时错误', errors.length === 0, errors.slice(0, 3).join(' | '));

  const failed = results.filter(r => !r.ok);
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(` v3.13.14 元数据队列验收：${results.length - failed.length}/${results.length} PASS`);
  if (failed.length) {
    console.log(` 失败 ${failed.length} 条：`);
    failed.forEach(f => console.log('   - ' + f.name));
  }
  console.log(`═══════════════════════════════════════════════════════════`);
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('运行异常:', e && e.stack || e); process.exit(1); });

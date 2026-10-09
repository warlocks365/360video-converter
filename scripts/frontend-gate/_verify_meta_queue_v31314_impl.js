// v3.13.14 元数据队列四项改动 — 实现侧功能验证（jsdom 真实页面加载）
// 与 QA 的 _verify_meta_queue_v31314.js 互补：那份是规格断言（读源码 + 运行时），
// 这份专打**行为与铁律**：快照隔离、去重归一化、输出三态分派、失败不覆盖已有值、
// p_ 前缀顺序依赖、重排队零副作用、徽标/按钮零脱节。
// 运行：node scripts/frontend-gate/_stub-server.js 8800   （先起桩）
//       node scripts/frontend-gate/_verify_meta_queue_v31314_impl.js
const path = require('path');
const os = require('os');
const WS = path.join(os.homedir(), '.workbuddy', 'binaries', 'node', 'workspace', 'node_modules');
const { JSDOM, VirtualConsole } = require(path.join(WS, 'jsdom'));

const PORT = Number(process.env.META_QUEUE_PORT || 8800);
const URL = `http://127.0.0.1:${PORT}/`;

// 可被测试改写的可变后端状态
const BACKEND = {
  nativeDialogPath: 'G:/ref/IMG_2043.MP4',
  fsTime: { path: 'G:/ref/IMG_2043.MP4', ctime: '2024-03-11T09:22:41', ctime_ts: 1710136961, mtime: '2024-03-12T10:00:00', source: 'filesystem', is_creation_time: true },
  fsTimeStatus: 200,
  appliedItems: null,
  appliedParams: null,
};
const API = (url, opt) => {
  const u = String(url);
  if (u.includes('/api/native_dialog')) return { path: BACKEND.nativeDialogPath };
  if (u.includes('/api/file_fs_time')) {
    if (BACKEND.fsTimeStatus !== 200) return { error: '文件不存在' };
 return BACKEND.fsTime;
  }
  if (u.includes('/api/apply_metadata')) {
    try { const b = JSON.parse(opt && opt.body); BACKEND.appliedItems = b.items; BACKEND.appliedParams = b.params; } catch (e) {}
    return { job_id: 'job_test_1' };
  }
  if (u.includes('/api/probe_metadata')) return {
    has_spherical: false, spherical: null, has_date: false, creation_time: null,
    has_gps: false, gps: null, location_name: '', location_address: '',
    file_size_mb: 12.5, date_in_name: '', filename: 'X.mp4',
  };
  if (u.includes('/api/probe-source')) return { has_gps: false, has_time: false, creation_time: null, filename: 'X.mp4', location_name: '', location_address: '' };
  if (u.includes('/api/codecs')) return { codecs: { libx264: { label: 'x', group: 'cpu', presets: [], default_preset: '', has_profile: true, has_level: true, has_bf_refs: true, has_x264_params: false, x265_params: false } } };
  if (u.includes('/api/codec_check')) return { available: {}, error_details: {}, ffmpeg_info: {}, runtime_dlls: {}, fix_hints: {} };
  if (u.includes('/api/presets')) return { presets: [] };
  if (u.includes('/api/version')) return { version: '3.13.14', name: '360 Video Converter' };
  if (u.includes('/api/tasks/load')) return { tasks: [] };
  if (u.includes('/api/settings')) return {};
  if (u.includes('/api/sysmon')) return { cpu: 10, mem: 40, disk: 0, net: 0, gpu: 0 };
  if (u.includes('/api/status/')) return { overall_progress: 0, file_progress: 0, items: [], log: [], status: 'running' };
  return {};
};

const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', e => errors.push('jsdomError: ' + (e.detail || e.message || e)));
vc.on('error', (...a) => errors.push('console.error: ' + a.map(String).join(' ')));

const results = [];
const check = (name, cond, detail) => {
  results.push({ name, ok: !!cond });
  console.log((cond ? 'OK  ' : 'FAIL') + ' ' + name + (detail ? '  → ' + detail : ''));
};

(async () => {
  const dom = await JSDOM.fromURL(URL, {
    runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) {
      w.alert = (m) => { w.__lastAlert = String(m); };
      w.confirm = () => true;
      w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
      w.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
      w.fetch = async (u, opt) => {
        const r = API(u, opt);
        return { ok: true, status: BACKEND.fsTimeStatus, json: async () => r, text: async () => JSON.stringify(r) };
 };
    },
  });
  await new Promise(r => setTimeout(r, 1200));
  const d = dom.window.document;
  const $ = id => d.getElementById(id);
  // showToast 复用同一个常驻节点（id=toastNotification），直接读其 textContent
  const toast = () => { const t = d.getElementById('toastNotification'); return t ? t.textContent : ''; };
  const ev = f => dom.window.eval(f);
  const click = sel => { const el = d.querySelector(sel); if (!el) return false; el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); return true; };
  const change = sel => { const el = d.querySelector(sel); if (!el) return false; el.dispatchEvent(new dom.window.Event('change', { bubbles: true })); return true; };

  ev('metaBatchItems = []; forceFormRun = false; renderMetaBatchTable();');

  // ══ ①加入批量列队 ══════════════════════════════════════
  $('metaInput').value = 'D:\\videos\\a.mp4';
  $('metaBatchOutDir').value = 'D:\\out1';
  click('#metaAddQueueBtn');
  await new Promise(r => setTimeout(r, 60));
  check('①点「加入批量列队」新增 1 项', ev('metaBatchItems.length') === 1, `n=${ev('metaBatchItems.length')}`);
  check('①入队即冻结 out_dir 快照（D:\\out1）',
    ev("JSON.stringify(metaBatchItems[0].outDir)") === '{"mode":"snapshot","value":"D:\\\\out1"}',
    ev("JSON.stringify(metaBatchItems[0].outDir)"));
  check('①入队 toast 说出输出结果',
    (toast() || '').includes('已加入列队第 1 项') && (toast() || '').includes('D:\\out1'), toast());

  // 去重：同路径变体（小写 + 正斜杠）应被拦下
  $('metaInput').value = 'd:/videos/a.mp4';
  click('#metaAddQueueBtn');
  await new Promise(r => setTimeout(r, 40));
  check('①去重拦下路径变体 d:/videos/a.mp4（归一化后比对）',
    ev('metaBatchItems.length') === 1 && (toast() || '').includes('已在列队第 1 项'),
    `n=${ev('metaBatchItems.length')} toast="${toast()}"`);

  // 改全局输出目录后，第 2 项应快照新值，第 1 项保持旧值（D4 核心）
  $('metaBatchOutDir').value = 'D:\\out2';
  $('metaInput').value = 'D:\\videos\\b.mp4';
  click('#metaAddQueueBtn');
  await new Promise(r => setTimeout(r, 60));
  check('①改全局后入队：第 1 项仍快照 out1、第 2 项快照 out2',
    ev("metaBatchItems[0].outDir.value") === 'D:\\out1' && ev("metaBatchItems[1].outDir.value") === 'D:\\out2',
    `1=${ev("metaBatchItems[0].outDir.value")} 2=${ev("metaBatchItems[1].outDir.value")}`);

  // 输出目录留空 → inplace
  $('metaBatchOutDir').value = '';
  $('metaInput').value = 'D:\\videos\\c.mp4';
  click('#metaAddQueueBtn');
  await new Promise(r => setTimeout(r, 60));
  check('①输出目录留空 → mode=inplace',
    ev("metaBatchItems[2].outDir.mode") === 'inplace', ev("JSON.stringify(metaBatchItems[2].outDir)"));

  // ══ ③应用语义 + 惰性化 ════════════════════════════════════
  $('metaApplyBtn').textContent = '?';
  ev('renderMetaBatchTable();');
  check('③有待转换项 → 按钮文案「应用元数据 · 3 项」',
    $('metaApplyBtn').textContent === '应用元数据 · 3 项', `"${$('metaApplyBtn').textContent}"`);
  check('③说明条出现且列出待转换数',
    !$('metaScopeNotice').classList.contains('hidden')
    && ($('metaScopeNotice').textContent || '').includes('3'),
    $('metaScopeNotice').textContent.trim().slice(0, 50));
  // 惰性化目标：功能开关卡 + 输出目录字段
  const inertTargets = ev(`(function(){
    const sph=document.getElementById('m_apply_spherical'); const out=document.getElementById('metaBatchOutDir');
    return [sph.closest('.card').classList.contains('meta-form-inert'), out.closest('.field').classList.contains('meta-form-inert')];
  })()`);
  check('③功能开关卡 + 输出目录字段双双置惰性', inertTargets[0] === true && inertTargets[1] === true, JSON.stringify(inertTargets));

  // 徽标计数
  const badge = $('metaQueueCount').textContent;
  check('③徽标显示「3 项 · 3 待转换」', badge.includes('3 项') && badge.includes('3 待转换'), `"${badge}"`);

  // 一次性覆盖出口
  click('[data-action="meta-force-form-run"]');
  await new Promise(r => setTimeout(r, 40));
  check('③点「仍按界面设置执行这一轮」→ 惰性解除 + 说明条收起 + 文案切界面模式',
    ev('forceFormRun') === true
    && $('metaScopeNotice').classList.contains('hidden')
    && ev("!document.getElementById('m_apply_spherical').closest('.card').classList.contains('meta-form-inert')")
    && $('metaApplyBtn').textContent === '按界面设置应用',
    `force=${ev('forceFormRun')} noticeHidden=${$('metaScopeNotice').classList.contains('hidden')} btn="${$('metaApplyBtn').textContent}"`);
  ev('forceFormRun = false; renderMetaBatchTable();');

  // 待执行项判定 + 输出解析（startMetadataApply 的核心）
  ev('metaBatchItems[1].selected = false;');
  BACKEND.appliedItems = null;
  await ev('startMetadataApply()');
  await new Promise(r => setTimeout(r, 80));
  const applied = BACKEND.appliedItems || [];
  check('③未勾选项不执行（selected 正交于 done，ADR D-3）',
    applied.length === 2 && applied.every(it => !it.input.endsWith('b.mp4')),
    `n=${applied.length} inputs=${JSON.stringify(applied.map(i => i.input))}`);
  check('③按 outDir.mode 分派输出：快照项各自落到自己的目录',
    applied[0].output === 'D:\\out1\\a.mp4' && applied[1].output === 'D:\\videos\\c.mp4',
    JSON.stringify(applied.map(i => i.output)));
  check('③forceFormRun 在 startMetadataApply 内被消费复位',
    ev('forceFormRun') === false, `forceFormRun=${ev('forceFormRun')}`);

  // 全部 done → 兜底到界面单文件
  ev('metaBatchItems.forEach(f => { f.status = "done"; }); renderMetaBatchTable();');
  check('③全部完成 → 按钮文案「按界面设置应用」',
    $('metaApplyBtn').textContent === '按界面设置应用', `"${$('metaApplyBtn').textContent}"`);
  ev('metaBatchItems[1].selected = true;');
  BACKEND.appliedItems = null;
  await ev('startMetadataApply()');
  await new Promise(r => setTimeout(r, 80));
  check('③全 done 时兜底只处理界面单文件（不重复跑队列）',
    (BACKEND.appliedItems || []).length === 1 && BACKEND.appliedItems[0].input === 'D:\\videos\\c.mp4',
    JSON.stringify(BACKEND.appliedItems));

  // ══ ②输出位置三态（编辑弹窗）═════════════════════════════
  ev('metaBatchItems[0].selected = true; metaBatchItems[1].selected = false; metaBatchItems[0].status = "pending"; renderMetaBatchTable();');
  ev('editMetaFileSettings(0);');
  const segGlobal = d.querySelector('input[name="me_out_mode"][value="global"]');
  const segSnap = d.querySelector('input[name="me_out_mode"][value="snapshot"]');
  const segInplace = d.querySelector('input[name="me_out_mode"][value="inplace"]');
  check('②分段控件三态齐备', !!segGlobal && !!segSnap && !!segInplace, `global=${!!segGlobal} snapshot=${!!segSnap} inplace=${!!segInplace}`);
  check('②按 outDir.mode 回填选中项', segSnap.checked === true, `snapshot.checked=${segSnap.checked}`);
  check('②快照模式显示路径行并预填快照值',
    !d.querySelector('#metaEditModal .me-out-path').classList.contains('hidden') && $('me_out_dir').value === 'D:\\out1',
    `hidden=${d.querySelector('#metaEditModal .me-out-path').classList.contains('hidden')} val="${$('me_out_dir').value}"`);

  // 切到 global → 路径行隐藏、提示文案切换；已填值不被清空
  segGlobal.checked = true;
  change('input[name="me_out_mode"][value="global"]');
  check('②切「全局」→ 路径行隐藏且提示切换',
    d.querySelector('#metaEditModal .me-out-path').classList.contains('hidden')
    && d.querySelector('#metaEditModal .me-out-hint').textContent.includes('全局级'),
    d.querySelector('#metaEditModal .me-out-hint').textContent);
  check('②切走不清空已填的快照路径（可恢复）', $('me_out_dir').value === 'D:\\out1', `val="${$('me_out_dir').value}"`);

  // 保存为 inplace → outDir 落库，且不影响 settings
  ev('document.getElementById("me_out_dir").value = "D:\\edited";');
  segInplace.checked = true;
  change('input[name="me_out_mode"][value="inplace"]');
  ev('saveMetaFileSettings();');
  check('②保存后 outDir={mode:inplace,value:""}（非 snapshot 时忽略路径）',
    ev('JSON.stringify(metaBatchItems[0].outDir)') === '{"mode":"inplace","value":""}',
    ev('JSON.stringify(metaBatchItems[0].outDir)'));
  check('②out_dir 未污染 collectMetaSettings 的 settings（无 out_dir 键）',
    ev('JSON.stringify(metaBatchItems[0].settings).indexOf("out_dir")') === -1,
    ev('Object.keys(metaBatchItems[0].settings).join(",")'));

  // ══ 编辑已完成项 → 回落 pending ════════════════════════════
  ev('metaBatchItems[0].status = "done"; metaBatchItems[0].duration = "1.4秒"; renderMetaBatchTable();');
  ev('editMetaFileSettings(0); saveMetaFileSettings();');
  check('③编辑已完成项并保存 → 状态回落 pending',
    ev('metaBatchItems[0].status') === 'pending' && ev('metaBatchItems[0].duration') === '',
    `status=${ev('metaBatchItems[0].status')} dur="${ev('metaBatchItems[0].duration')}"`);
  check('③回落时 toast 说明会重跑', (toast() || '').includes('会重跑'), toast());

  // ══ 重排队零副作用 ════════════════════════════════════════
  // 先把整队重置为「仅第 1 项 done」，否则前面用例遗留的 done 项会干扰按钮计数
  ev('metaBatchItems.forEach((f,i) => { f.status = i === 0 ? "done" : "pending"; f.duration = i === 0 ? "1.4秒" : ""; f.statusMsg = ""; }); renderMetaBatchTable();');
  const beforeSettings = ev('JSON.stringify(metaBatchItems[0].settings)');
  const beforeOutDir = ev('JSON.stringify(metaBatchItems[0].outDir)');
  const beforeJob = dom.window.ActiveJob ? dom.window.ActiveJob.id : null;
  check('③done 行渲染出「重排队」按钮', !!d.querySelector('[data-action="reset-meta-item"]'), '');
  const resetBtns = d.querySelectorAll('[data-action="reset-meta-item"]').length;
  check('③非 done 行不渲染重排队按钮', resetBtns === 1, `按钮数=${resetBtns}（应仅 done 行）`);
  click('[data-action="reset-meta-item"]');
  await new Promise(r => setTimeout(r, 40));
  check('③重排队 → done→pending 且清空耗时',
    ev('metaBatchItems[0].status') === 'pending' && ev('metaBatchItems[0].duration') === '',
    `status=${ev('metaBatchItems[0].status')}`);
  check('③重排队零副作用：settings/outDir 未变',
    ev('JSON.stringify(metaBatchItems[0].settings)') === beforeSettings
    && ev('JSON.stringify(metaBatchItems[0].outDir)') === beforeOutDir, '');
  check('③重排队未触发任何执行（无新任务）',
    (dom.window.ActiveJob ? dom.window.ActiveJob.id : null) === beforeJob,
    `jobId=${dom.window.ActiveJob ? dom.window.ActiveJob.id : null}`);

  // ══ ④读创建时间 ══════════════════════════════════════════
  // 成功路径（m_ 前缀）
  $('m_apply_date').checked = true;
  $('m_date_from_filename').checked = true;
  $('m_manual_date').value = '';
  $('metaInput').value = 'D:\\videos\\x.mp4';
  ev('renderMetaBatchTable();');
  await ev('browseDateFromFile("m_manual_date", "m")');
  await new Promise(r => setTimeout(r, 80));
  check('④成功：回填本地 naive 字符串（无 Z）',
    $('m_manual_date').value === '2024-03-11T09:22:41', `val="${$('m_manual_date').value}"`);
  check('④成功：清「从文件名提取」勾选', $('m_date_from_filename').checked === false, `checked=${$('m_date_from_filename').checked}`);
  check('④成功：日期总开关保持开启', $('m_apply_date').checked === true, `checked=${$('m_apply_date').checked}`);
  const ds = d.querySelector('.date-source[data-date-source-for="m_manual_date"]');
  check('④成功：溯源条显示来源与时间戳',
    !ds.classList.contains('hidden') && ds.dataset.source === 'fs-ctime' && ds.textContent.includes('IMG_2043.MP4'),
    `"${ds.textContent.trim()}"`);

  // ⚠ p_ 前缀顺序依赖：masterDate === fromName 同元素，净效果必须仍是「开启」
  ev('document.getElementById("p_date_from_filename").checked = true;');
  await ev('browseDateFromFile("p_manual_date", "p")');
  await new Promise(r => setTimeout(r, 80));
  check('④p_ 前缀：填了日期后日期功能仍开启（同元素两行顺序未破坏 ADR D-7）',
    $('p_manual_date').value === '2024-03-11T09:22:41' && $('p_date_from_filename').checked === true,
    `val="${$('p_manual_date').value}" checked=${$('p_date_from_filename').checked}`);

  // 失败路径（404）—— 铁律：绝不覆盖用户已输入的日期
  $('m_manual_date').value = '2024-01-15';
  BACKEND.fsTimeStatus = 404;
  await ev('browseDateFromFile("m_manual_date", "m")');
  await new Promise(r => setTimeout(r, 80));
  check('④失败铁律：404 后用户已输入的日期原样保留',
    $('m_manual_date').value === '2024-01-15', `val="${$('m_manual_date').value}"`);
  const ds2 = d.querySelector('.date-source[data-date-source-for="m_manual_date"]');
  check('④失败：溯源条切 error 并给「手动输入」恢复按钮',
    ds2.dataset.source === 'error' && ds2.classList.contains('is-error')
    && !!ds2.querySelector('[data-action="meta-date-from-file"][data-date-mode="manual"]'),
    `"${ds2.textContent.trim()}"`);
  check('④失败：toast 只给人话、系统细节进 title',
    (toast() || '').includes('读不到创建日期')
    && !(toast() || '').includes('WinError')
    && (ds2.title || '').includes('系统返回'),
    `toast="${toast()}" title="${ds2.title}"`);

  // 取消对话框 → 什么都不改
  $('m_manual_date').value = '2024-02-02';
  BACKEND.nativeDialogPath = '';
  await ev('browseDateFromFile("m_manual_date", "m")');
  await new Promise(r => setTimeout(r, 60));
  check('④取消对话框：不改日期、不弹错误提示',
    $('m_manual_date').value === '2024-02-02' && dom.window.__lastAlert === undefined,
    `val="${$('m_manual_date').value}"`);

  // 「手动输入」恢复按钮
  BACKEND.nativeDialogPath = 'G:/ref/IMG_2043.MP4';
  BACKEND.fsTimeStatus = 200;
  $('m_manual_date').value = '2024-05-05';
  click('.date-source[data-date-source-for="m_manual_date"] [data-action="meta-date-from-file"]');
  await new Promise(r => setTimeout(r, 40));
  check('④「手动输入」→ 溯源条切 manual 且不清空已有值',
    ds2.dataset.source === 'manual' && $('m_manual_date').value === '2024-05-05',
    `source=${ds2.dataset.source} val="${$('m_manual_date').value}"`);

  // 「清除」按钮
  click('.date-source[data-date-source-for="m_manual_date"] [data-action="meta-date-from-file"]');
  await new Promise(r => setTimeout(r, 20));
  ev(`document.querySelector('.date-source[data-date-source-for="m_manual_date"]').innerHTML =
     '<button type="button" data-action="meta-date-from-file" data-date-target="m_manual_date" data-date-mode="clear">清除</button>';`);
  click('.date-source[data-date-source-for="m_manual_date"] [data-date-mode="clear"]');
  await new Promise(r => setTimeout(r, 40));
  check('④「清除」→ 输入框清空且溯源条隐藏',
    $('m_manual_date').value === '' && ds2.classList.contains('hidden'),
    `val="${$('m_manual_date').value}" hidden=${ds2.classList.contains('hidden')}`);

  // ══ hasAnyFeature 中止 vs 无可执行项兜底（不得混淆）════════
  ev('metaBatchItems = [{path:"D:\\\\videos\\\\z.mp4",name:"z.mp4",size_mb:"",date_in_name:"",selected:true,status:"pending",statusMsg:"",duration:"",settings:{apply_spherical:false,apply_date:false,apply_location:false,spherical_mode:"360-mono"},outDir:{mode:"inplace",value:""},probed:true}]; renderMetaBatchTable();');
  $('metaInput').value = 'D:\\videos\\y.mp4';
  dom.window.__lastAlert = undefined;
  BACKEND.appliedItems = null;   // 清掉上一轮残留，否则「未发起请求」判据失效
  await ev('startMetadataApply()');
  await new Promise(r => setTimeout(r, 60));
  check('③有项但都没开功能 → alert 中止（不是兜底到界面）',
    (dom.window.__lastAlert || '').includes('均未启用任何元数据功能') && BACKEND.appliedItems === null,
    `alert="${dom.window.__lastAlert}" 未发起请求=${BACKEND.appliedItems === null}`);

  // ══ 徽标 / 按钮零脱节（勾选变化即同步）══════════════════════
  ev('metaBatchItems = [];');
  for (let i = 0; i < 3; i++) {
    $('metaInput').value = `D:\\videos\\q${i}.mp4`;
    click('#metaAddQueueBtn');
    await new Promise(r => setTimeout(r, 30));
  }
  ev('metaBatchItems[0].status = "done"; metaBatchItems[1].status = "error"; renderMetaBatchTable();');
  const badge2 = $('metaQueueCount').textContent;
  // 计数口径（50-meta.js metaQueueStats 为唯一权威）：
  //   待转换 = selected && status !== 'done'（含 error，ADR D-2「失败可重试」）
  //   不变式：总数 = 待转换 + 已完成；「失败」是待转换内部的子类标注
  // 此处 3 项：item0=done, item1=error, item2=pending → 待转换 2（error+pending）/ 完成 1 / 失败 1
  check('③徽标混合计数：总数 = 待转换 + 已完成，失败单列',
    badge2.includes('3 项') && badge2.includes('2 待转换') && badge2.includes('1 已完成') && badge2.includes('1 失败'),
    `"${badge2}"`);
  check('③徽标「待转换」数 = 按钮实际执行项数（零脱节）',
    badge2.includes('2 待转换') && $('metaApplyBtn').textContent === '应用元数据 · 2 项',
    `badge="${badge2}" btn="${$('metaApplyBtn').textContent}"`);

  // 取消勾选唯一纯 pending 项 → 剩 1 个待转换（error 项仍可执行）
  ev('toggleMetaFileSelection(2, false);');
  check('③取消勾选 pending 项 → 徽标与按钮同步减 1（error 项仍待重试）',
    $('metaQueueCount').textContent.includes('1 待转换')
    && $('metaApplyBtn').textContent === '应用元数据 · 1 项',
    `badge="${$('metaQueueCount').textContent}" btn="${$('metaApplyBtn').textContent}"`);

  // 全部 done → 切界面模式
  ev('metaBatchItems[0].status="done"; metaBatchItems[1].status="done"; renderMetaBatchTable();');
  check('③无任何待转换项 → 按钮切「按界面设置应用」',
    $('metaApplyBtn').textContent === '按界面设置应用'
 && $('metaQueueCount').textContent.includes('3 项') && !$('metaQueueCount').textContent.includes('待转换'),
    `btn="${$('metaApplyBtn').textContent}" badge="${$('metaQueueCount').textContent}"`);

  // 清空 → 徽标整体隐藏（不留空胶囊）
  ev('metaBatchItems = []; renderMetaBatchTable();');
  check('③队列清空 → 徽标 hidden（不留空胶囊）',
    $('metaQueueCount').classList.contains('hidden') && $('metaQueueCount').innerHTML === '',
    `hidden=${$('metaQueueCount').classList.contains('hidden')}`);

  // ══ P0：队列内零 emoji ═════════════════════════════════════
  ev('metaBatchItems = [];');
  $('metaInput').value = 'D:\\videos\\e.mp4';
  click('#metaAddQueueBtn');
  await new Promise(r => setTimeout(r, 60));
  ev('metaBatchItems[0].status = "done"; metaBatchItems[0].duration = "1.4秒"; metaBatchItems[0].settings = {apply_date:true,manual_date:"2024-01-15",apply_spherical:true,pano_type:"360",stereo_mode:"mono",apply_location:true,location_lat:"36.7",location_lon:"116.8",location_name:"济南"}; renderMetaBatchTable();');
  const tbodyHtml = $('metaBatchTableBody').innerHTML;
  const emojiRe = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u;
  check('P0 队列表格内零 emoji（全部内联 SVG）', !emojiRe.test(tbodyHtml),
    emojiRe.test(tbodyHtml) ? '仍有 emoji' : 'SVG 图标数=' + (tbodyHtml.match(/<svg/g) || []).length);

  // 输出归属芯片三态：同一张表内必须三态并存且各有冗余编码（图标+文案+描边样式）
  $('metaBatchOutDir').value = 'D:\\outX';
  ev('metaBatchItems = [];');
  const three = [
    { p: 'D:\\videos\\s1.mp4', od: { mode: 'snapshot', value: 'D:\\snap\\2024' } },
    { p: 'D:\\videos\\s2.mp4', od: { mode: 'global', value: '' } },
    { p: 'D:\\videos\\s3.mp4', od: { mode: 'inplace', value: '' } },
  ];
  for (const t of three) {
    $('metaInput').value = t.p;
    click('#metaAddQueueBtn');
    await new Promise(r => setTimeout(r, 40));
  }
  ev('metaBatchItems[0].outDir={mode:"snapshot",value:"D:\\\\snap\\\\2024"}; metaBatchItems[1].outDir={mode:"global",value:""}; metaBatchItems[2].outDir={mode:"inplace",value:""}; metaBatchItems[0].settings={apply_date:true,manual_date:"2024-01-15"}; renderMetaBatchTable();');
  const chipsHtml = $('metaBatchTableBody').innerHTML;
  check('P0 输出归属芯片三态在同一表内并存',
    chipsHtml.includes('metaq-chip-out-snapshot')
    && chipsHtml.includes('metaq-chip-out-global')
    && chipsHtml.includes('metaq-chip-out-inplace'), '');
  check('输出芯片靠「图标+文案」冗余编码，不靠颜色单独传达',
    /快照 D:\\snap/.test(chipsHtml) && chipsHtml.includes('跟随全局') && chipsHtml.includes('原地修改'),
    chipsHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').match(/快照[^ ]*|跟随全局|原地修改/g).join(' | '));
  check('输出芯片的行内 title 说明语义（三态各异）',
    chipsHtml.includes('加入时快照') && chipsHtml.includes('执行时读取上方') && chipsHtml.includes('覆盖源文件本身'), '');
  check('P0 芯片区仍零 emoji', !emojiRe.test(chipsHtml), '');

  check('页面无 JS 错误', errors.length === 0, errors.slice(0, 3).join(' | '));

  const failed = results.filter(r => !r.ok).length;
  console.log(`\n══ v3.13.14 实现侧功能验证：${results.length - failed}/${results.length} PASS ══`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('运行异常:', e); process.exit(1); });
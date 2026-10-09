// v3.13.14 裁决2 验证：ActiveJob.phase 显式阶段 + 合并 emoji 替换
// 回归目标：原 60-jobs.js:433 用 progressLabel 文案是否以合并链图标开头反推合并阶段。
// 该判据在文案被替换/截断/暂停时静默失效 → 标签永久卡在「合并 N/M」且不报错。
// 本套件证明：①阶段由显式字段驱动，文案怎么改都不影响；②切回编码阶段必复位；
//  ③phase 在 beginJob/endJob 的生命周期正确；④合并区 UI 零 emoji。
const path = require('path');
const os = require('os');
const WS = path.join(os.homedir(), '.workbuddy', 'binaries', 'node', 'workspace', 'node_modules');
const { JSDOM, VirtualConsole } = require(path.join(WS, 'jsdom'));

const PORT = Number(process.env.META_QUEUE_PORT || 8800);
const URL = `http://127.0.0.1:${PORT}/`;

// 可变后端：让测试驱动 merge_status 的进出
const BACKEND = { poll: null };
const API = (url) => {
  const u = String(url);
  if (u.includes('/api/convert')) return { job_id: 'job_p1' };
  if (u.includes('/api/status/')) return BACKEND.poll;
  if (u.includes('/api/probe_metadata')) return {
    has_spherical: false, has_date: false, has_gps: false,
    creation_time: null, spherical: null, gps: null,
    location_name: '', location_address: '', file_size_mb: 1, date_in_name: '', filename: 'X.mp4',
  };
  if (u.includes('/api/probe-source')) return { has_gps: false, has_time: false, creation_time: null, filename: 'X.mp4' };
  if (u.includes('/api/codecs')) return { codecs: { libx264: { label: 'x', group: 'cpu', presets: [], default_preset: '', has_profile: true, has_level: true, has_bf_refs: true, has_x264_params: false, x265_params: false } } };
  if (u.includes('/api/codec_check')) return { available: {}, error_details: {}, ffmpeg_info: {}, runtime_dlls: {}, fix_hints: {} };
  if (u.includes('/api/presets')) return { presets: [] };
  if (u.includes('/api/version')) return { version: '3.13.14', name: '360 Video Converter' };
  if (u.includes('/api/tasks/load')) return { tasks: [] };
  if (u.includes('/api/settings')) return {};
  if (u.includes('/api/sysmon')) return { cpu: 1, mem: 1, disk: 0, net: 0, gpu: 0 };
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

const emojiRe = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u;

(async () => {
  const dom = await JSDOM.fromURL(URL, {
    runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) {
      w.alert = () => {};
      w.confirm = () => true;
      w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
      w.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
      w.fetch = async (u) => {
        const r = API(u);
        return { ok: true, status: 200, json: async () => r, text: async () => JSON.stringify(r) };
      };
    },
  });
  await new Promise(r => setTimeout(r, 1200));
  const d = dom.window.document;
  const $ = id => d.getElementById(id);
  const ev = f => dom.window.eval(f);
  const lbl = () => $('progressLabel').textContent.trim();
  const curLbl = () => $('currentFileLabel').textContent.trim();
  const phase = () => ev('ActiveJob.phase');
  // 只驱动渲染器，不经过轮询定时器（避免测试与 pollActiveJob 抢状态）
  const render = payload => ev(`renderCommonStatus(${JSON.stringify(payload)}, 10)`);
  // beginJob 在已有任务进行中会拒绝并 return false（这是并发保护，不是缺陷），
  // 故每个用例前必须复位，否则 isJobRunning() 会让后续 beginJob 静默失败、
  // 上一用例的 isPaused/type/phase 泄漏到下一个用例。
  // ⚠ 注意：eval 字符串内没有宿主作用域的 $ / document 简写，必须用全限定名。
  const reset = () => ev('endJob(); isPaused = false; document.getElementById("progressLabel").textContent=""; document.getElementById("currentFileLabel").textContent="";');

  // ══ ① ActiveJob 声明 phase 字段 ════════════════════════════
  check('①ActiveJob 有 phase 字段', ev('"phase" in ActiveJob') === true, `phase=${phase()}`);
  check('①初始 phase 为 null（未开始任何任务）', phase() === null, `phase=${phase()}`);

  // ══ ② beginJob 第三参：缺省兜底为 'encode' ═════════════════
  check('②beginJob 签名接受第三参 phase', /function beginJob\(id, type, phase\)/.test(
    require('fs').readFileSync(path.resolve(__dirname, '../../static/js/60-jobs.js'), 'utf8')), '');
  reset();
  ev("beginJob('j1','encode')");
  check('②beginJob 缺省 phase → 兜底为 encode（调用方漏传也不失效）',
    phase() === 'encode', `phase=${phase()}`);
  check('②beginJob 设置了 id/type',
    ev('ActiveJob.id') === 'j1' && ev('ActiveJob.type') === 'encode', '');
  reset();
  ev("beginJob('j2','encode','merge')");
  check('②beginJob 显式传 merge → phase=merge', phase() === 'merge', `phase=${phase()}`);
  reset();
  check('②endJob 清理 phase 为 null', phase() === null && ev('ActiveJob.id') === null, `phase=${phase()}`);

  // ══ ③ 渲染器：合并阶段 → phase 置 merge + 文案正确 ═════════
  ev("beginJob('j3','encode','merge')");
  render({
    status: 'running', paused: false, merge_status: {
      phase: 'merging', current_file_index: 1, current_file_name: 'b.mp4',
      total_files: 3, elapsed_time: 10, total_duration: 60, total_gb: 0,
    },
    current_index: 0, total: 3, items: [], log: [],
  });
  check('③合并阶段 → ActiveJob.phase 变为 merge', phase() === 'merge', `phase=${phase()}`);
  check('③合并文案正确（含进度与预计）',
    lbl().includes('合并预处理中') && lbl().includes('(2/3)') && lbl().includes('b.mp4')
    && lbl().includes('预计还需'), `"${lbl()}"`);
  check('③currentFileLabel 合并文案正确',
    curLbl().includes('合并 2/3') && curLbl().includes('b.mp4'), `"${curLbl()}"`);
  check('③合并区 UI 零 emoji（合并链图标已换内联 SVG）',
    !emojiRe.test(lbl()) && !emojiRe.test(curLbl())
    && $('progressLabel').innerHTML.includes('<svg') && $('currentFileLabel').innerHTML.includes('<svg'),
    `progressLabel svg=${$('progressLabel').innerHTML.includes('<svg')} currentFileLabel svg=${$('currentFileLabel').innerHTML.includes('<svg')}`);

  // ══ ④ 切回编码阶段 → 标签必复位（这是本次修复的核心）════════
  render({ status: 'running', paused: false, merge_status: null, current_input: 'D:\\v\\a.mp4', current_index: 0, total: 3, items: [], log: [] });
  check('④切回编码阶段 → 标签复位为「转换中...」', lbl() === '转换中...', `"${lbl()}"`);
  check('④phase 立即翻转为 encode（下一轮不误判）', phase() === 'encode', `phase=${phase()}`);
  check('④currentFileLabel 回到编码格式 [1/3] a.mp4',
    curLbl() === '[1/3] a.mp4', `"${curLbl()}"`);

  // ══ ⑤ 关键回归：文案被改成任意值也不影响复位 ═══════════════
  // 旧判据是「文案是否以合并链图标开头」，这里标签被换成完全无关的文案后必然失效
  reset();
  ev("beginJob('j4','encode','merge')");
  render({ status: 'running', paused: false, merge_status: { phase: 'merging', total_files: 2, current_file_name: 'x.mp4', elapsed_time: 5, total_duration: 30, total_gb: 0 }, items: [], log: [] });
  $('progressLabel').textContent = '完全无关的文案（模拟文案被改/被外部覆盖）';
  render({ status: 'running', paused: false, merge_status: null, current_input: 'D:\\v\\a.mp4', current_index: 0, total: 3, items: [], log: [] });
  check('⑤标签文案被任意改写后，切回编码阶段仍复位（旧 startsWith 判据在此必失效）',
    lbl() === '转换中...', `"${lbl()}"`);

  // ══ ⑥ 暂停态下标签不被合并/编码文案污染 ═══════════════════
  // ⚠ 执行顺序事实：暂停态更新在 renderCommonStatus **末尾**，故分支判读 !isPaused
  //   时用的还是上一轮的值。这一点改动前后完全一致（a195db6 的旧实现同样如此），
  //   不是本次引入的行为。故此处断言「用户可见的最终标签」这一真实不变量，
  //   而不规定不可见的中间态 phase 是否翻转。
  reset();
  ev("beginJob('j5','encode','merge')");
  render({ status: 'running', paused: false, merge_status: { phase: 'merging', total_files: 2, current_file_name: 'y.mp4', elapsed_time: 3, total_duration: 20, total_gb: 0 }, items: [], log: [] });
  check('⑥进入合并阶段后 phase=merge', phase() === 'merge', `phase=${phase()}`);
  ev('isPaused = true;');
  render({ status: 'running', paused: true, merge_status: null, current_input: 'D:\\v\\a.mp4', current_index: 0, total: 3, items: [], log: [] });
  check('⑥暂停时进度标签显示「已暂停」（暂停态覆盖阶段文案）',
    lbl().includes('已暂停'), `"${lbl()}"`);

  // 恢复运行 → 「已暂停」必须被撤除（team-lead 要求的断言；既存缺陷，本次修）
  ev('isPaused = false;');
  render({ status: 'running', paused: false, merge_status: null, current_input: 'D:\\v\\a.mp4', current_index: 0, total: 3, items: [], log: [] });
  check('⑥恢复运行后 progressLabel 不再包含「已暂停」（暂停标签被撤除）',
    lbl().indexOf('已暂停') < 0, `"${lbl()}"`);
  check('⑥恢复运行后露出编码阶段文案「转换中...」',
    lbl() === '转换中...', `"${lbl()}"`);

  // 从未暂停过的普通轮询不得被误覆盖：直接给 running + paused=false，
  // 标签应保留本轮合并分支写的完整文案，而不是被「转换中...」冲掉。
  reset();
  ev("beginJob('j8','encode','merge')");
  render({ status: 'running', paused: false, merge_status: { phase: 'merging', total_files: 4, current_file_name: 'z.mp4', elapsed_time: 12, total_duration: 40, total_gb: 0 }, items: [], log: [] });
  // 注意：两轮之间 elapsed_time 变了（8→12），合并文案本就应随之更新，
  // 故不能断言文案逐字不变；真正的不变量是「仍是完整的合并进度文案，
  // 未被暂停块误覆盖成『转换中...』」。
  check('⑥未暂停过的普通轮询不被覆盖（合并进度文案保留，未被误写成转换中）',
    lbl().includes('合并') && lbl().includes('预计还需') && lbl() !== '转换中...',
    `"${lbl()}"`);
  reset();

  // ══ ⑦ metadata 任务用「应用中...」而非「转换中...」═════════
  reset();
  ev("beginJob('j6','metadata','encode')");
  ev("ActiveJob.phase = 'merge';");
  render({ status: 'running', paused: false, merge_status: null, current_input: 'D:\\v\\a.mp4', current_index: 0, total: 1, items: [], log: [] });
  check('⑦metadata 任务切回后文案为「应用中...」', lbl() === '应用中...', `"${lbl()}"`);
  reset();

  // ══ ⑧ 已删掉旧的文案嗅探（源码层）═════════════════════════
  const src = require('fs').readFileSync(path.resolve(__dirname, '../../static/js/60-jobs.js'), 'utf8');
  check('⑧源码不再有 textContent.startsWith 反推阶段',
    !/textContent\.startsWith\(/.test(src), '');
  check('⑧源码无字面合并链图标（含注释，避免 P0 扫描误报）',
    !/\u{1F517}/u.test(src), '');
  check('⑧endJob 含 ActiveJob.phase = null', /function endJob\(\)[\s\S]{0,400}ActiveJob\.phase = null/.test(src), '');
  check('⑧beginJob 含 phase 兜底赋值', /ActiveJob\.phase = phase \|\| 'encode'/.test(src), '');

  // ══ ⑨ startConversion 按 items 判定初始 phase ═════════════
  // 批量任务里带 is_merge 的合并项同样会产生 merge 阶段，只判 currentMode 会漏
  check('⑨startConversion 以 items 判定初始 phase（覆盖批量合并项）',
    /const hasMergeItem = items\.some\(it => Array\.isArray\(it\.inputs\)\)/.test(src)
    // 合并分支必须显式传 'merge'（QA A12.5 要求字面可见）；非合并分支走两参兜底。
    // 早前写成三元 hasMergeItem ? 'merge' : 'encode'，语义等价但字面不可见，
    // 静态校验锁不住，故改为显式 if/else 两分支。
    && /beginJob\(data\.job_id, 'encode', 'merge'\)/.test(src)
    && /\} else if \(!beginJob\(data\.job_id, 'encode'\)\) return;/.test(src), '');
  const callSites = [...src.matchAll(/(?<![A-Za-z.])beginJob\(([^)]*)\)/g)]
    .map(m => m[1]).filter(x => !/^id, type/.test(x));
  check('⑨VR3D / 元数据调用点仍为两参（走默认 encode 兜底）',
    callSites.some(x => x === "data.job_id, 'encode'") && callSites.some(x => x === "data.job_id, 'metadata'"),
    `调用点=${JSON.stringify(callSites)}`);

  // ══ ⑩ XSS：文件名来自后端，进 innerHTML 必须转义 ════════════
  ev("beginJob('j7','encode','merge')");
  render({ status: 'running', paused: false, merge_status: { phase: 'merging', total_files: 1, current_file_name: '<img src=x onerror=alert(1)>.mp4', elapsed_time: 1, total_duration: 5, total_gb: 0 }, items: [], log: [] });
  const injected = $('progressLabel').querySelector('img');
  check('⑩恶意文件名被 esc 转义（未注入真实 img 元素）', injected === null,
    `img 元素=${injected ? '存在（注入成功！）' : '无（已转义）'} 文本="${lbl().slice(0, 60)}"`);

  check('页面无 JS 错误', errors.length === 0, errors.slice(0, 3).join(' | '));

  const failed = results.filter(r => !r.ok).length;
  console.log(`\n══ 裁决2 ActiveJob.phase 验证：${results.length - failed}/${results.length} PASS ══`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('运行异常:', e); process.exit(1); });
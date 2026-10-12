// ============================================================
// v3.14.0 QA 独立对抗套件（作者：mvp-dev-expert-team-qa，非实现者）
//
// 定位：实现者套件 _verify_agent_v3140.js 的 S5.9/S5.10 仅为"源码正则存在性"
// 断言（standard/full 分支只查文本、不驱动行为）。本套件用真实调用补验：
//   G 组 = 权限门行为矩阵（readonly 拦截 11 项 / standard 确认-拒绝-放行 /
//          full 直通 / 非 agent 期零误伤 / 嵌套双弹发现项 / __vcOrig 源码可读）
//   M 组 = 设置十字段三环映射（回填→提交→落盘，假 key 全程 fake-test-key-*）
//   T 组 = _agentTransformBody 参数注入矩阵（temperature 空不发/effort auto 不注入/
//          thinking default 不注入 chat_template_kwargs）
//   R 组 = relay 契约实测（8766 dev + 本机 echo 端点）：归一化全等白名单逐向量、
//          请求体 url 字段必须被忽略、Bearer 注入、掩码哨兵、代理直连证据
//   S 组 = 静态红线扫描（懒加载唯一入口带 autoInit=false、无 experimental 工具、
//          无 customTools、agent key 不进 localStorage/DOM、index.html 零 vendor 引用）
//
// 前置：
//   node scripts/frontend-gate/_stub-server.js 8800
//   python -c "import app; app.app.run(port=8766, threaded=True)"   （当前 HEAD 的 app.py）
//   node scripts/frontend-gate/_qa_echo_8790.js                      （QA 专用 echo，测完删）
// 清理：套件自恢复 dev 设置到出厂（enabled=false/base/model/key 空/standard）。
// ============================================================
const path = require('path');
const fs = require('fs');
const http = require('http');
const WS = path.join(require('os').homedir(), '.workbuddy', 'binaries', 'node', 'workspace', 'node_modules');
const { JSDOM, VirtualConsole } = require(path.join(WS, 'jsdom'));

const STUB = 'http://127.0.0.1:8800';
const DEV = 'http://127.0.0.1:8766';
const ECHO = 'http://127.0.0.1:8790';
const ROOT = path.resolve(__dirname, '..', '..');
const FAKE_KEY = ['fake','test','key','qa','7766'].join('-');

const results = [];
const knownDefects = [];
const check = (name, cond, detail, defect) => {
  results.push({ name, ok: !!cond, detail: detail === undefined ? '' : String(detail) });
  if (!cond && defect) knownDefects.push(name + ' :: ' + defect);
};

const getJSON = (base, p) => new Promise((res, rej) => {
  http.get(base + p, { agent: false }, r => {
    let b = ''; r.on('data', c => b += c);
    r.on('end', () => { try { res({ status: r.statusCode, data: JSON.parse(b) }); } catch (e) { res({ status: r.statusCode, data: { raw: b.slice(0, 200) } }); } });
  }).on('error', rej);
});
const postJSON = (base, p, obj, raw) => new Promise((res, rej) => {
  const data = raw != null ? raw : JSON.stringify(obj);
  const req = http.request(base + p, { method: 'POST', agent: false, headers: { 'Content-Type': 'application/json' } }, r => {
    let b = ''; r.on('data', c => b += c);
    r.on('end', () => { try { res({ status: r.statusCode, data: JSON.parse(b) }); } catch (e) { res({ status: r.statusCode, data: { raw: b.slice(0, 200) } }); } });
  });
  req.on('error', rej); req.end(data);
});

// dev 服务器（cwd=项目根）落盘在项目内 presets/_settings.json
const DEV_SETTINGS = path.join(ROOT, 'presets', '_settings.json');

// QA 桩设置：与实现者套件不同的值域（防"贴着实现写断言"，字段值全部换一套）
const QA_SETTINGS = {
  auto_load_tasks: false, amap_api_key: 'qaamap', amap_security: 'qasec',
  custom_ffmpeg_path: '',
  agent_enabled: true, agent_base_url: 'http://127.0.0.1:8790/v1',
  agent_api_key: '__KEEP__', agent_api_key_set: true,
  agent_model: 'qa-model-77', agent_thinking: 'on',
  agent_reasoning_effort: 'xhigh', agent_permission: 'full',
  agent_temperature: '1.3', agent_max_steps: 17, agent_step_delay: 0.9,
};

// v3.14.1 A2：名单 11→14（补 saveReport/exportReportLog/openExternalUrl 三个 L2，对齐表E）
const WRAPPED = ['startConversion', 'startVR3D', 'startMetadataApply', 'startMetadataBatchRun',
  'cancelConversion', 'savePresetDialog', 'deletePreset', 'removeSelectedTasks',
  'removeUnselectedBatch', 'clearMergeList', 'saveReport', 'exportReportLog',
  'openExternalUrl', 'saveSettings'];

(async () => {
  // ═══ G/M/T/S 组：jsdom ═══
  const errors = [];
  const warns = [];
  const vc = new VirtualConsole();
  vc.on('error', (...a) => errors.push(a.map(String).join(' ')));
  vc.on('warning', (...a) => warns.push(a.map(String).join(' ')));
  const fetchCalls = [];      // {url, method, body}
  let settingsResponse = QA_SETTINGS;
  const dom = await JSDOM.fromURL(STUB + '/', {
    runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(window) {
      window.fetch = async (u, opt) => {
        const url = String(u);
        const rec = { url, method: (opt && opt.method) || 'GET', body: opt && opt.body ? String(opt.body) : '' };
        fetchCalls.push(rec);
        let payload = {};
        if (url.includes('/api/settings')) payload = opt && opt.method === 'POST'
          ? (() => { try { return JSON.parse(rec.body); } catch (e) { return {}; } })()
          : settingsResponse;
        else if (url.includes('/api/codecs')) payload = { codecs: {} };
        else if (url.includes('/api/codec_check')) payload = { available: {}, error_details: {}, ffmpeg_info: {}, runtime_dlls: {}, fix_hints: {} };
        else if (url.includes('/api/presets')) payload = { presets: [] };
        else if (url.includes('/api/version')) payload = { version: '3.14.0-qa', name: 'x' };
        else if (url.includes('/api/tasks/load')) payload = { tasks: [] };
        else if (url.includes('/api/sysmon')) payload = { cpu: 1, mem: 1, disk: 0, net: 0, gpu: 0 };
        return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
      };
      window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
      window.alert = () => {};
    },
  });
  const win = dom.window, doc = win.document;
  await new Promise(r => setTimeout(r, 3500));

  const POSTS = () => fetchCalls.filter(c => c.method === 'POST' && c.url.includes('/api/settings'));
  const DEL_P1 = () => fetchCalls.filter(c => c.method === 'DELETE' && /\/api\/presets\/p1/.test(c.url)).length;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const clearCalls = () => { fetchCalls.length = 0; };

  // ── AC-01 默认关零注入（本 jsdom 实例 agent_enabled=true，但从未点开关，
  //    vendor 也不应被任何同步路径加载）──
  check('AC01.1 vendor 未被同步加载（无 script[src*=page-agent]）',
    doc.querySelector('script[src*="page-agent"]') === null);
  check('AC01.2 window.PageAgent 未定义（懒加载未触发）', typeof win.PageAgent === 'undefined', typeof win.PageAgent);
  const idx = fs.readFileSync(path.join(ROOT, 'static/index.html'), 'utf8');
  check('AC01.3 index.html 零 vendor 引用', !/page-agent\.iife/.test(idx));
  check('AC01.4 加载期无 /api/agent_relay 请求', !fetchCalls.some(c => /agent_relay/.test(c.url)));
  check('AC01.5 门安装数正常（无 85-agent 数量异常 warn）',
    !warns.some(w => /权限门包装数量异常/.test(w)) && !errors.some(e => /权限门包装数量异常/.test(e)),
    warns.concat(errors).filter(w => /85-agent/.test(w)).join(' | ') || 'clean');

  // ── G 组：包装存在性 + __vcOrig 保留（07 依赖）──
  check('G1 14 项全部 __vcWrappedForAgent（A2 补齐后）', WRAPPED.every(n => win[n] && win[n].__vcWrappedForAgent === true),
    WRAPPED.filter(n => !(win[n] && win[n].__vcWrappedForAgent === true)).join(','));
  check('G2 14 项 __vcOrig 均为原函数（function）', WRAPPED.every(n => win[n] && typeof win[n].__vcOrig === 'function'));
  check('G3 __vcOrig 源码可被静态断言读取（07 契约）',
    win.startConversion.__vcOrig.toString().includes('collectVR3DParams()')
    && win.deletePreset.__vcOrig.toString().includes('删除预设')
    && win.saveSettings.__vcOrig.toString().includes('amap_api_key'));
  check('G4 包装本体不含原函数体（确认遮蔽真实存在→07 必须走 __vcOrig）',
    !win.startConversion.toString().includes('collectVR3DParams'));

  // 预置：让 deletePreset 的真实副作用可观测（下拉里放一个 p1 选项）
  // deletePreset 成功后会 await refreshPresets()——桩 /api/presets 返回 {presets:[]}，
  // 会把 sel 清成只剩占位项，故每次期望成功的 deletePreset 探针前都要重播种。
  const seedPresetOption = () => {
    const s = doc.getElementById('presetSelect');
    s.innerHTML = '<option value="">placeholder</option>';
    const o = doc.createElement('option'); o.value = 'p1'; o.textContent = 'p1';
    s.appendChild(o); s.value = 'p1';
  };
  seedPresetOption();

  let confirmCalls = [];
  const setConfirm = (ret) => { confirmCalls = []; win.confirm = (msg) => { confirmCalls.push(String(msg)); return typeof ret === 'function' ? ret(msg) : ret; }; };

  // ── G5 readonly：14 项逐个拦截，零 confirm、零原函数副作用 ──
  win.vcSetAgentSettingsCache(Object.assign({}, QA_SETTINGS, { agent_permission: 'readonly' }));
  win.__vcAgentActive = true;
  clearCalls(); setConfirm(true);
  const DEL0 = DEL_P1();
  for (const n of WRAPPED) { try { win[n](); } catch (e) { /* async 拒绝另行断言 */ } }
  await sleep(400);
  const readonlyToast = (doc.getElementById('toastNotification') || {}).textContent || '';
  check('G5 readonly：14 项零 confirm 弹出', confirmCalls.length === 0, confirmCalls.join(' | '));
  check('G6 readonly：deletePreset 零 DELETE 请求', DEL_P1() === DEL0);
  check('G7 readonly：saveSettings 零 POST', POSTS().length === 0);
  check('G8 readonly：拦截 toast 含「只读」', /只读/.test(readonlyToast), readonlyToast.slice(0, 50));

  // ── G9 FORBIDDEN：full 权限下 saveSettings 仍必须拦截（表E 禁区）──
  win.vcSetAgentSettingsCache(Object.assign({}, QA_SETTINGS, { agent_permission: 'full' }));
  clearCalls(); setConfirm(true);
  win.saveSettings();
  await sleep(300);
  check('G9 full 下 saveSettings 一律拦截（agent 永不可改设置）', POSTS().length === 0 && confirmCalls.length === 0);

  // ── G10 standard：拒绝确认 → 零执行 ──
  win.vcSetAgentSettingsCache(Object.assign({}, QA_SETTINGS, { agent_permission: 'standard' }));
  clearCalls(); setConfirm(false);
  const DEL1 = DEL_P1();
  win.deletePreset();
  await sleep(300);
  check('G10 standard：确认弹出（gate 文案）', confirmCalls.length === 1 && /AI 助手即将执行「删除编码预设」/.test(confirmCalls[0]), confirmCalls.join('|'));
  check('G11 standard：拒绝 → 零 DELETE', DEL_P1() === DEL1);

  // ── G12 standard：确认 → 放行执行（真实调原函数）──
  clearCalls(); setConfirm(true);
  const DEL2 = DEL_P1();
  seedPresetOption(); // G11 若执行过 refreshPresets 会清空选项，重播种
  win.deletePreset();
  await sleep(400);
  check('G12 standard：确认 → 原函数执行（DELETE 发出）', DEL_P1() === DEL2 + 1, `before=${DEL2} after=${DEL_P1()}`);

  // ── G13 standard 嵌套双弹（对抗发现项）：vr3d 模式下 startConversion→startVR3D 两层包装各弹一次 ──
  win.switchMode('vr3d');
  clearCalls(); setConfirm(true);
  const beforeNested = confirmCalls.length;
  win.startConversion();
  await sleep(400);
  check('G13 standard：vr3d 链 confirm 应恰 1 次（实测次数见 detail）',
    confirmCalls.length === 1, 'confirm 次数=' + confirmCalls.length + ' :: ' + confirmCalls.map(c => c.slice(0, 18)).join(' / '),
    confirmCalls.length > 1 ? '嵌套包装双重确认——agent 触发 vr3d 会弹两次窗（85-agent.js 包装了 startVR3D，而 startConversion.__vcOrig 内部调用的是 window 同名包装体）' : '');

  // ── G14 full：直通、零 confirm、真实执行 ──
  win.switchMode('single');
  win.vcSetAgentSettingsCache(Object.assign({}, QA_SETTINGS, { agent_permission: 'full' }));
  clearCalls(); setConfirm(true);
  const DEL3 = DEL_P1();
  seedPresetOption(); // G12 成功后 refreshPresets 已清空选项
  win.deletePreset();
  await sleep(400);
  // 期望：gate 不弹（confirmCalls 至多 1 次=原函数自带"删除预设"），且 DELETE 发出
  check('G14 full：gate 层零弹、原函数真实执行（DELETE 发出）', DEL_P1() === DEL3 + 1,
    `DELTA=${DEL_P1() - DEL3} confirm=${confirmCalls.map(c=>c.slice(0,14)).join(' / ')}`);
  check('G14b full：gate 自身文案「AI 助手即将执行」零出现（直通无中间确认）',
    !confirmCalls.some(c => /AI 助手即将执行/.test(c)), confirmCalls.join(' / '));

  // ── G15 非 agent 期零误伤：readonly 缓存 + active=false，用户手动路径一切正常 ──
  win.vcSetAgentSettingsCache(Object.assign({}, QA_SETTINGS, { agent_permission: 'readonly' }));
  win.__vcAgentActive = false;
  clearCalls(); setConfirm(true);
  const DEL4 = DEL_P1();
  seedPresetOption();
  win.deletePreset();
  await sleep(400);
  check('G15 非 agent 期：readonly 不伤手动操作（原 confirm 弹一次+DELETE 正常）',
    DEL_P1() === DEL4 + 1 && confirmCalls.length === 1 && /删除预设 "p1"/.test(confirmCalls[0]),
    `DELTA=${DEL_P1() - DEL4} confirm=${confirmCalls.join('|')}`);
  const POST0 = POSTS().length;
  win.saveSettings();
  await sleep(400);
  check('G16 非 agent 期：saveSettings 手动保存正常（门零误伤）', POSTS().length > POST0);
  win.__vcAgentActive = false;

  // ── A2 专项：三个新增 L2 包装函数真被门控（不只挂标记，行为实证）──
  // 探针选 openExternalUrl（直接 fetch /api/open_external，副作用最干净可观测）。
  // saveReport/exportReportLog 有前置 guard（无数据即 alert 早退、不发请求），
  // 其 readonly 拦截已由 G5 全 14 项零 confirm 覆盖；此处聚焦 openExternalUrl 三档。
  const EXT = () => fetchCalls.filter(c => /\/api\/open_external/.test(c.url)).length;
  // A2-a readonly：agent 触发 openExternalUrl → 拦截、零 /api/open_external
  win.vcSetAgentSettingsCache(Object.assign({}, QA_SETTINGS, { agent_permission: 'readonly' }));
  win.__vcAgentActive = true; clearCalls(); setConfirm(true);
  win.openExternalUrl('https://qa-probe.example/x');
  await sleep(300);
  check('A2-a readonly：openExternalUrl 被拦（零 /api/open_external + 零 confirm）',
    EXT() === 0 && confirmCalls.length === 0, 'ext=' + EXT() + ' confirm=' + confirmCalls.length);
  const rtExt = (doc.getElementById('toastNotification') || {}).textContent || '';
  check('A2-a2 readonly 拦截 toast 含新增函数标签「外部链接」', /外部链接|只读/.test(rtExt), rtExt.slice(0, 50));
  // A2-b standard：确认 → 放行发出请求；拒绝 → 零请求
  win.vcSetAgentSettingsCache(Object.assign({}, QA_SETTINGS, { agent_permission: 'standard' }));
  clearCalls(); setConfirm(false);
  win.openExternalUrl('https://qa-probe.example/y');
  await sleep(300);
  check('A2-b standard：确认弹出且文案含「外部链接」',
    confirmCalls.length === 1 && /外部链接/.test(confirmCalls[0]), confirmCalls.join('|'));
  check('A2-b2 standard 拒绝 → 零 /api/open_external', EXT() === 0, 'ext=' + EXT());
  clearCalls(); setConfirm(true);
  win.openExternalUrl('https://qa-probe.example/z');
  await sleep(300);
  check('A2-b3 standard 确认 → 放行发出 /api/open_external', EXT() === 1, 'ext=' + EXT());
  // A2-c full：直通零 gate 确认（原函数无自带 confirm）
  win.vcSetAgentSettingsCache(Object.assign({}, QA_SETTINGS, { agent_permission: 'full' }));
  clearCalls(); setConfirm(true);
  win.openExternalUrl('https://qa-probe.example/w');
  await sleep(300);
  check('A2-c full：openExternalUrl 直通发出请求且 gate 零确认',
    EXT() === 1 && !confirmCalls.some(c => /AI 助手即将执行/.test(c)), 'ext=' + EXT() + ' confirm=' + confirmCalls.join('|'));
  // A2-d 非 agent 期零误伤：手动 openExternalUrl 直通
  win.__vcAgentActive = false;
  clearCalls(); setConfirm(true);
  win.openExternalUrl('https://qa-probe.example/manual');
  await sleep(300);
  check('A2-d 非 agent 期：openExternalUrl 手动直通（门零误伤）', EXT() === 1 && confirmCalls.length === 0, 'ext=' + EXT());
  // A2-e 三新增函数 __vcOrig 均保留（07/源码读取契约对新函数同样成立）
  check('A2-e saveReport/exportReportLog/openExternalUrl __vcOrig 齐备',
    ['saveReport', 'exportReportLog', 'openExternalUrl'].every(n => win[n] && typeof win[n].__vcOrig === 'function'));
  win.__vcAgentActive = false;

  // ── M 组：十字段三环映射（回填→提交；落盘在 R 组用真实后端验）──
  clearCalls();
  await win.openSettings();
  await sleep(300);
  check('M1 enabled 回填', doc.getElementById('settings_agent_enabled').checked === true);
  check('M2 base_url 回填', doc.getElementById('settings_agent_base_url').value === 'http://127.0.0.1:8790/v1');
  check('M3 model 回填', doc.getElementById('settings_agent_model').value === 'qa-model-77');
  check('M4 thinking 回填 on', doc.getElementById('settings_agent_thinking').value === 'on');
  check('M5 effort 回填 xhigh', doc.getElementById('settings_agent_effort').value === 'xhigh');
  check('M6 permission 回填 full', doc.getElementById('settings_agent_permission').value === 'full');
  check('M7 temperature 回填 1.3', doc.getElementById('settings_agent_temperature').value === '1.3');
  check('M8 max_steps 回填 17', doc.getElementById('settings_agent_max_steps').value === '17');
  check('M9 step_delay 回填 0.9', doc.getElementById('settings_agent_step_delay').value === '0.9');
  const keyEl = doc.getElementById('settings_agent_api_key');
  check('M10 密钥框恒空+哨兵标记（明文不出后端）', keyEl.value === '' && keyEl.dataset.set === '1' && /已保存/.test(keyEl.placeholder));
  check('M11 AC-02 enabled → header 按钮显示', doc.getElementById('agentToggleBtn').style.display !== 'none');
  // 提交环：改 3 个字段后保存
  doc.getElementById('settings_agent_temperature').value = '';
  doc.getElementById('settings_agent_max_steps').value = '33';
  doc.getElementById('settings_agent_thinking').value = 'default';
  clearCalls();
  win.__vcAgentActive = false;
  await win.saveSettings();
  await sleep(400);
  const postBody = POSTS().length ? JSON.parse(POSTS()[POSTS().length - 1].body) : {};
  const tenFields = ['agent_enabled', 'agent_base_url', 'agent_api_key', 'agent_model', 'agent_thinking',
    'agent_reasoning_effort', 'agent_permission', 'agent_temperature', 'agent_max_steps', 'agent_step_delay'];
  check('M12 提交含全部 10 字段', tenFields.every(k => k in postBody), tenFields.filter(k => !(k in postBody)).join(','));
  check('M13 修改值生效 max_steps=33 / thinking=default / temperature 空串', postBody.agent_max_steps === '33' && postBody.agent_thinking === 'default' && postBody.agent_temperature === '');
  check('M14 密钥未重填 → 回传哨兵 __KEEP__（不覆盖真实值）', postBody.agent_api_key === '__KEEP__', String(postBody.agent_api_key));
  const lsKeys = [];
  for (let i = 0; i < win.localStorage.length; i++) { const k = win.localStorage.key(i); lsKeys.push(k); }
  check('M15 agent 字段零写 localStorage', !lsKeys.some(k => /agent/i.test(k)), lsKeys.join(','));
  // 空 GET（未设密钥实例）→ 提交应传空串而不是哨兵
  settingsResponse = Object.assign({}, QA_SETTINGS, { agent_api_key: '', agent_api_key_set: false });
  await win.openSettings(); await sleep(200);
  clearCalls();
  await win.saveSettings(); await sleep(300);
  const postBody2 = POSTS().length ? JSON.parse(POSTS()[POSTS().length - 1].body) : {};
  check('M16 未设密钥时提交空串（哨兵不误传）', postBody2.agent_api_key === '', JSON.stringify(postBody2.agent_api_key));
  settingsResponse = QA_SETTINGS;

  // ── T 组：_agentTransformBody 注入矩阵 ──
  const tb = (s) => { win.vcSetAgentSettingsCache(s); return win._agentTransformBody({ model: 'm', messages: [{ role: 'user', content: 'x' }] }); };
  const t1 = tb({ agent_thinking: 'default', agent_reasoning_effort: 'auto', agent_temperature: '' });
  check('T1 全缺省：无 chat_template_kwargs / reasoning / reasoning_effort / temperature',
    !('chat_template_kwargs' in t1) && !('reasoning' in t1) && !('reasoning_effort' in t1) && !('temperature' in t1), JSON.stringify(t1));
  const t2 = tb({ agent_thinking: 'on', agent_reasoning_effort: 'high', agent_temperature: '0.7' });
  check('T2 on+high+0.7：enable_thinking=true & reasoning.effort=high & reasoning_effort=high & temperature=0.7',
    t2.chat_template_kwargs && t2.chat_template_kwargs.enable_thinking === true
    && t2.reasoning && t2.reasoning.effort === 'high' && t2.reasoning_effort === 'high' && t2.temperature === 0.7, JSON.stringify(t2));
  const t3 = tb({ agent_thinking: 'off', agent_reasoning_effort: 'auto', agent_temperature: '2' });
  check('T3 off：enable_thinking=false 且 effort=auto 不注入 reasoning',
    t3.chat_template_kwargs.enable_thinking === false && !('reasoning' in t3), JSON.stringify(t3));
  const t4 = tb({ agent_thinking: 'default', agent_reasoning_effort: 'xhigh', agent_temperature: '0' });
  check('T4 temperature=0 是合法值必须发送（parseFloat 边界）', t4.temperature === 0 && t4.reasoning.effort === 'xhigh');
  const t5 = tb({}); // 全空缓存
  check('T5 空缓存零注入（不崩、不加字段）', !('reasoning' in t5) && !('chat_template_kwargs' in t5) && !('temperature' in t5));

  // ── S 组：静态红线扫描（85-agent / 10-ui）──
  const a85 = fs.readFileSync(path.join(ROOT, 'static/js/85-agent.js'), 'utf8');
  check('S1 无 experimentalScriptExecutionTool（execute_javascript 保持缺省关）', !/experimentalScriptExecutionTool/.test(a85));
  check('S2 无 customTools 传参（vendor IIFE 不暴露 tool/zod）', !/customTools/.test(a85));
  check('S3 无 onAskUser 设置（ask_user 自动禁用可接受）', !/onAskUser/.test(a85));
  check('S4 无 experimentalLlmsTxt（防 vendor 原生 fetch 外联 /llms.txt）', !/experimentalLlmsTxt/.test(a85));
  check('S5 vendor 注入唯一路径带 ?autoInit=false',
    (a85.match(/\/agent\/page-agent\.iife\.js/g) || []).length === 1 && /\?autoInit=false/.test(a85));
  check('S6 apiKey 恒占位 relay（真实 key 不进前端）', /apiKey:\s*'relay'/.test(a85));
  const ui = fs.readFileSync(path.join(ROOT, 'static/js/10-ui.js'), 'utf8');
  check('S7 10-ui 不把 agent_api_key 值写入 DOM/localStorage（仅置空+哨兵判断）',
    !/localStorage[^\n]*agent/i.test(ui) && !/\.value\s*=\s*s\.agent_api_key/.test(ui));
  check('S8 全项目 grep：agent_api_key 无 sk- 形态默认值/硬编码', !/(agent_api_key[^,\n]{0,40}['"]sk-)/.test(fs.readFileSync(path.join(ROOT, 'app.py'), 'utf8') + ui + a85));
  // 禁用态（enabled=false）时 openSettings 必须隐藏按钮
  settingsResponse = Object.assign({}, QA_SETTINGS, { agent_enabled: false });
  await win.openSettings(); await sleep(200);
  check('AC01.6 enabled=false → header 按钮 display:none', doc.getElementById('agentToggleBtn').style.display === 'none');
  settingsResponse = QA_SETTINGS;

  const pageErr = errors.filter(e => !/Not implemented/i.test(e));
  check('S9 全程无未捕获 JS 错误', pageErr.length === 0, pageErr.slice(0, 2).join(' | '));
  dom.window.close();

  // ═══ R 组：relay 契约实测（dev 8766 = 当前 HEAD app.py；echo 8790）═══
  let devUp = true;
  try { await getJSON(DEV, '/api/version'); } catch (e) { devUp = false; }
  check('R0 dev 8766 在线', devUp);
  let echoUp = false;
  try { await getJSON(ECHO, '/__last'); echoUp = true; } catch (e) {}
  check('R0b echo 8790 在线', echoUp, echoUp ? '' : '（跳过 R 组：node scripts/frontend-gate/_qa_echo_8790.js）');

  if (devUp && echoUp) {
    const FACTORY = { agent_enabled: false, agent_base_url: '', agent_api_key: '', agent_model: '',
      agent_thinking: 'default', agent_reasoning_effort: 'auto', agent_temperature: '',
      agent_max_steps: 40, agent_step_delay: 0.4, agent_permission: 'standard' };
    try {
      // R1 密钥不出进程：POST 假 key → 落盘有真值，GET 恒哨兵
      await postJSON(DEV, '/api/settings', Object.assign({}, FACTORY, {
        agent_base_url: 'http://127.0.0.1:8790/v1', agent_api_key: FAKE_KEY, agent_model: 'echo-model' }));
      const disk = JSON.parse(fs.readFileSync(DEV_SETTINGS, 'utf8'));
      check('R1.1 真实值只落 _settings.json', disk.agent_api_key === FAKE_KEY);
      const g = await getJSON(DEV, '/api/settings');
      check('R1.2 GET 恒 __KEEP__ 且无明文', g.data.agent_api_key === '__KEEP__' && g.data.agent_api_key_set === true
        && !JSON.stringify(g.data).includes(FAKE_KEY));
      // R2 哨兵保旧值：POST __KEEP__ 后磁盘仍是假 key
      await postJSON(DEV, '/api/settings', { agent_api_key: '__KEEP__' });
      const disk2 = JSON.parse(fs.readFileSync(DEV_SETTINGS, 'utf8'));
      check('R2.1 回传哨兵 → 磁盘保旧值', disk2.agent_api_key === FAKE_KEY);
      // 计算字段即便被前端误传也必须被后端剥离
      await postJSON(DEV, '/api/settings', { agent_api_key: '__KEEP__', agent_api_key_set: true });
      const disk2b = JSON.parse(fs.readFileSync(DEV_SETTINGS, 'utf8'));
      check('R2.2 agent_api_key_set 不持久化（POST 携带也被剥离）', !('agent_api_key_set' in disk2b) && disk2b.agent_api_key === FAKE_KEY);
      // R3 Bearer 注入：echo 看到 Authorization
      await postJSON(ECHO, '/__reset', {});
      const r3 = await postJSON(DEV, '/api/agent_relay', { path: '/chat/completions', body: { model: 'echo-model', messages: [{ role: 'user', content: 'qa' }] } });
      check('R3.1 relay 正常转发 200', r3.status === 200, 'HTTP ' + r3.status);
      const seen = (await getJSON(ECHO, '/__last')).data;
      check('R3.2 打到的路径=已存 baseURL 拼接', seen.url === '/v1/chat/completions', String(seen.url));
      check('R3.3 Authorization: Bearer <key> 由后端注入', seen.headers && seen.headers.authorization === 'Bearer ' + FAKE_KEY, String(seen.headers && seen.headers.authorization));
      check('R3.4 转发体只含 body 内容（页面文本进 body）', /qa/.test(seen.body || '') && JSON.parse(seen.body).model === 'echo-model');
      // R4 请求体携带 url 字段必须被忽略（打向不存在端口 → 若被尊重将 502）
      await postJSON(ECHO, '/__reset', {});
      const r4 = await postJSON(DEV, '/api/agent_relay', {
        path: '/chat/completions', url: 'http://127.0.0.1:8123/evil', base_url: 'http://evil.invalid/v1',
        body: { messages: [{ role: 'user', content: 'x' }], url: 'http://127.0.0.1:8123/body-url' } });
      const seen4 = (await getJSON(ECHO, '/__last')).data;
      check('R4 payload.url/base_url/body.url 全部被忽略（仍达已存 baseURL）',
        r4.status === 200 && seen4.url === '/v1/chat/completions', `HTTP ${r4.status} seen=${seen4.url}`);
      // R5 归一化全等白名单：team-lead 契约明列的"必须 400"向量
      const MUST400 = [
        ['/chat/completions/../settings', '路径回溯穿透'],
        ['/chat/completions/../../etc/passwd', '双层回溯'],
        ['//evil.com/x', '协议相对走私 host'],
        ['chat/completions', '相对路径'],
        ['/CHAT/COMPLETIONS', '大小写'],
        ['/chat/completions?q=1', '查询串'],
        ['/chat/completions/%2e%2e/settings', '编码点号'],
        ['/chat/completions/..', '回溯到根'],
        ['/', '根路径'],
        ['', '空路径（默认值放行→应为合法）'],
      ];
      for (const [p, why] of MUST400) {
        if (p === '') continue; // 缺省路径合法
        const rr = await postJSON(DEV, '/api/agent_relay', { path: p, body: { messages: [{ role: 'user', content: 'x' }] } });
        check(`R5 绕过向量 400 :: ${p}（${why}）`, rr.status === 400, 'HTTP ' + rr.status);
      }
      // R5b 松散等价向量：契约（gate④）明列必须 400。
      // 第二轮实测 HEAD(24bd097)=精确串相等（path !== '/chat/completions' 一律 400），
      // 比第一轮 team-lead 消息描述的"归一化转发 200"更严——完全服从 gate④ 契约。
      // 断言：松散变体既须 400，又须**不触达上游**（echo /__last 保持空）。
      for (const p of ['/chat//completions', '/chat/completions/', '/chat/./completions']) {
        await postJSON(ECHO, '/__reset', {});
        const rr = await postJSON(DEV, '/api/agent_relay', { path: p, body: { messages: [{ role: 'user', content: 'x' }] } });
        const seen = (await getJSON(ECHO, '/__last')).data;
        const reached = seen && typeof seen.url === 'string' && seen.url.length > 0;
        check(`R5b 松散变体必须 400（精确串相等，契约 gate④） :: ${p}`,
          rr.status === 400, 'HTTP ' + rr.status,
          rr.status !== 400 ? 'relay SSRF 面契约违反：松散变体未 400（应精确串相等拒绝）' : '');
        check(`R5b' 松散变体 400 后不得触达上游（零转发） :: ${p}`,
          reached === false, 'echo saw ' + JSON.stringify(seen && seen.url),
          reached ? '被拦截却仍转发到上游——校验与转发脱节' : '');
      }
      // R5c 精确串合法路径必须放行并规范到达上游（对照 R5b'：只有精确串触达上游）
      await postJSON(ECHO, '/__reset', {});
      const rc = await postJSON(DEV, '/api/agent_relay', { path: '/chat/completions', body: { messages: [{ role: 'user', content: 'x' }] } });
      const seen5c = (await getJSON(ECHO, '/__last')).data;
      check('R5c 精确串 /chat/completions 放行且上游实收规范 URL',
        rc.status === 200 && seen5c.url === '/v1/chat/completions',
        `HTTP ${rc.status} echo saw ${JSON.stringify(seen5c && seen5c.url)}`);
      // R6 缺省 path 合法（不带 path 字段 → /chat/completions）
      const r6 = await postJSON(DEV, '/api/agent_relay', { body: { messages: [{ role: 'user', content: 'x' }] } });
      check('R6 缺省 path=chat/completions 放行', r6.status === 200, 'HTTP ' + r6.status);
      // R7 非 JSON / 缺 messages / body 非 dict
      const r7a = await new Promise((res) => {
        const req = http.request(DEV + '/api/agent_relay', { method: 'POST', headers: { 'Content-Type': 'application/json' } }, rr => {
          let b = ''; rr.on('data', c => b += c); rr.on('end', () => res({ status: rr.statusCode }));
        }); req.end('this-is-not-json{{{');
      });
      check('R7.1 请求体非法 JSON → 400', r7a.status === 400, 'HTTP ' + r7a.status);
      const r7b = await postJSON(DEV, '/api/agent_relay', { path: '/chat/completions', body: { model: 'x' } });
      check('R7.2 缺 messages → 400', r7b.status === 400);
      const r7c = await postJSON(DEV, '/api/agent_relay', { path: '/chat/completions', body: 'string-not-dict' });
      check('R7.3 body 非 dict → 400', r7c.status === 400, 'HTTP ' + r7c.status);
      // R8 GET settings 明文 key 清空后：relay 不带 Authorization
      await postJSON(DEV, '/api/settings', { agent_api_key: '' });
      await postJSON(ECHO, '/__reset', {});
      await postJSON(DEV, '/api/agent_relay', { path: '/chat/completions', body: { messages: [{ role: 'user', content: 'x' }] } });
      const seen8 = (await getJSON(ECHO, '/__last')).data;
      check('R8 空 key → 转发不带 Authorization', !seen8.headers || !seen8.headers.authorization, String(seen8.headers && seen8.headers.authorization));
      check('R8b 空 key 后 GET 返回空串', (await getJSON(DEV, '/api/settings')).data.agent_api_key === '');
      // R9 未配 baseURL → 400 中文指引（先清 base）
      await postJSON(DEV, '/api/settings', { agent_base_url: '' });
      const r9 = await postJSON(DEV, '/api/agent_relay', { path: '/chat/completions', body: { messages: [{ role: 'user', content: 'x' }] } });
      check('R9 未配 baseURL → 400 行动指引', r9.status === 400 && /AI 助手未配置/.test(JSON.stringify(r9.data)), 'HTTP ' + r9.status);
      // R10 非法协议 baseURL
      await postJSON(DEV, '/api/settings', { agent_base_url: 'ftp://127.0.0.1:8790/v1' });
      const r10 = await postJSON(DEV, '/api/agent_relay', { path: '/chat/completions', body: { messages: [{ role: 'user', content: 'x' }] } });
      check('R10 非 http/https baseURL → 400', r10.status === 400, 'HTTP ' + r10.status);
      // R11 代理直连证据：base 指到 echo(活) 但 echo 停掉时错误形态=10061 拒绝(直连)而非代理超时
      await postJSON(DEV, '/api/settings', { agent_base_url: 'http://127.0.0.1:8123/v1', agent_api_key: FAKE_KEY });
      const r11 = await postJSON(DEV, '/api/agent_relay', { path: '/chat/completions', body: { messages: [{ role: 'user', content: 'x' }] } });
      const s11 = JSON.stringify(r11.data);
      check('R11 ProxyHandler({}) 强制直连（死端口=立即拒绝 10061，非走 36450 代理的 502/超时形态）',
        r11.status === 502 && /10061|拒绝|refused/i.test(s11), s11.slice(0, 120));
      // R12 方法面：GET 不得进入中继逻辑（Flask 实测 404；语义=非 POST 一律拒绝）
      const r12 = await new Promise((res) => {
        http.get(DEV + '/api/agent_relay', rr => { rr.resume(); res(rr.statusCode); });
      });
      check('R12 GET /api/agent_relay 被拒（404/405，POST-only 守门）', r12 === 405 || r12 === 404, 'HTTP ' + r12);
      // R11b 观察项（advisory，不判失败）：非 ASCII key 落盘后 relay 抛 latin-1 内部异常原文
      await postJSON(DEV, '/api/settings', { agent_base_url: 'http://127.0.0.1:8790/v1', agent_api_key: 'fake-…中文' });
      const r11b = await postJSON(DEV, '/api/agent_relay', { path: '/chat/completions', body: { messages: [{ role: 'user', content: 'x' }] } });
      const leaky = r11b.status === 502 && /latin-1|codec|Unicode/.test(JSON.stringify(r11b.data));
      console.log('ADVISORY R11b 非ASCII密钥→502泄漏Python内部异常原文：' + (leaky ? '实测复现（建议入口做字符集校验+错误脱敏）' : '未复现 ' + JSON.stringify(r11b.data).slice(0, 80)));
      await postJSON(DEV, '/api/settings', { agent_api_key: FAKE_KEY }); // 恢复 ASCII key
    } finally {
      // 清理：dev 设置恢复出厂
      const done = await postJSON(DEV, '/api/settings', FACTORY);
      check('R99 dev 设置已恢复出厂（enabled=false/base/model/key 空/standard）', done.status === 200);
      const disk3 = JSON.parse(fs.readFileSync(DEV_SETTINGS, 'utf8'));
      check('R99b 磁盘复核：无 fake-test-key 残留', !JSON.stringify(disk3).includes('fake-test-key'), JSON.stringify(disk3.agent_api_key));
    }
  }

  // ═══ 汇总 ═══
  const bad = results.filter(r => !r.ok);
  console.log('\n' + '═'.repeat(64));
  results.forEach(r => console.log((r.ok ? 'OK   ' : 'FAIL ') + r.name + (r.detail ? '  -> ' + r.detail : '')));
  console.log('═'.repeat(64));
  console.log(`QA 独立套件：${results.length - bad.length}/${results.length} PASS` + (bad.length ? `  失败 ${bad.length} 项` : ''));
  if (knownDefects.length) {
    console.log('\n── 对抗发现（契约违反项）──');
    knownDefects.forEach(d => console.log('  * ' + d));
  }
  process.exit(bad.length ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });

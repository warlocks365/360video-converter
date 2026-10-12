// ============================================================
// v3.14.0 AI 助手（page-agent 集成）验收套件
//
// 两段结构：
//   S 组 = jsdom 真实 DOM（8800 桩服务器）：设置组控件存在性/回填/保存协议/
//          权限门包装/懒加载安全参数/派发注册。
//   B 组 = 后端契约实测（8766 dev 服务器，真 app.py）：relay 白名单绕过拦截、
//          settings 掩码协议、agent key 不回显明文。
//
// 前置：node scripts/frontend-gate/_stub-server.js 8800（同门禁 07）；
//       dev 服务器 python -c "import app; app.app.run(port=8766, threaded=True)"。
// 红线清单（真实 vendor 行为）见尾部 RUNTIME-CHECKLIST —— 由 team-lead 用 CDP 在
// 重建后的 exe 上复跑，本套件不伪造 vendor 运行断言。
// ============================================================
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const WS = path.join(os.homedir(), '.workbuddy', 'binaries', 'node', 'workspace', 'node_modules');
const { JSDOM, VirtualConsole } = require(path.join(WS, 'jsdom'));

const STUB = 'http://127.0.0.1:8800';
const DEV = 'http://127.0.0.1:8766';
const ROOT = path.resolve(__dirname, '..', '..');

const results = [];
const check = (name, cond, detail) => {
  results.push({ name, ok: !!cond, detail: detail === undefined ? '' : String(detail) });
};

const getJSON = (base, p) => new Promise((res, rej) => {
  http.get(base + p, { agent: false }, r => {
    let b = ''; r.on('data', c => b += c);
    r.on('end', () => { try { res({ status: r.statusCode, data: JSON.parse(b) }); } catch (e) { rej(e); } });
  }).on('error', rej);
});
const postJSON = (base, p, obj) => new Promise((res, rej) => {
  const data = JSON.stringify(obj);
  const req = http.request(base + p, { method: 'POST', agent: false, headers: { 'Content-Type': 'application/json' } }, r => {
    let b = ''; r.on('data', c => b += c);
    r.on('end', () => { try { res({ status: r.statusCode, data: JSON.parse(b) }); } catch (e) { res({ status: r.statusCode, data: { raw: b.slice(0, 120) } }); } });
  });
  req.on('error', rej); req.end(data);
});

// 与门禁 07 同形状的桩（API 返回 {} 的 /api/settings 会吞掉 agent 字段，
// 这里必须返回完整 agent 形状才能验回填逻辑）
const AGENT_SETTINGS = {
  auto_load_tasks: false, amap_api_key: 'testamap', amap_security: '',
  custom_ffmpeg_path: '',
  agent_enabled: true, agent_base_url: 'http://127.0.0.1:8888/v1',
  agent_api_key: '__KEEP__', agent_api_key_set: true,
  agent_model: 'test-model-x', agent_thinking: 'off',
  agent_reasoning_effort: 'high', agent_permission: 'readonly',
  agent_temperature: '0.7', agent_max_steps: 25, agent_step_delay: 0.8,
};
const API = (url) => {
  if (url.includes('/api/codecs')) return { codecs: {} };
  if (url.includes('/api/codec_check')) return { available: {}, error_details: {}, ffmpeg_info: {}, runtime_dlls: {}, fix_hints: {} };
  if (url.includes('/api/presets')) return { presets: [] };
  if (url.includes('/api/version')) return { version: '3.14.0-test', name: 'x' };
  if (url.includes('/api/tasks/load')) return { tasks: [] };
  if (url.includes('/api/settings')) return AGENT_SETTINGS;
  if (url.includes('/api/sysmon')) return { cpu: 10, mem: 40, disk: 0, net: 0, gpu: 0 };
  if (url.includes('/api/extract_date')) return { date_str: null };
  if (url.includes('/api/status/')) return { overall_progress: 0, file_progress: 0, items: [], log: [], status: 'running' };
  return {};
};

(async () => {
// ═══ S 组：jsdom 真实 DOM ═══
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('error', (...a) => errors.push(a.map(String).join(' ')));
  let posts = [];
  const dom = await JSDOM.fromURL(STUB + '/', {
    runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(window) {
      window.fetch = async (u, opt) => ({
        ok: true, status: 200,
        json: async () => API(String(u)),
        text: async () => JSON.stringify(API(String(u))),
      });
      window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    },
  });
  const win = dom.window, doc = win.document;
  await new Promise(r => setTimeout(r, 3500)); // 等 init() 落定

  // S1 设置组控件存在性与类型
  const IDS = ['settings_agent_enabled','settings_agent_base_url','settings_agent_api_key','settings_agent_model','settings_agent_thinking','settings_agent_effort','settings_agent_permission','settings_agent_temperature','settings_agent_max_steps','settings_agent_step_delay'];
  let missing = IDS.filter(id => !doc.getElementById(id));
  check('S1.1 十个 AI 助手控件齐备', missing.length === 0, missing.join(','));
  const keyEl = doc.getElementById('settings_agent_api_key');
  check('S1.2 API Key 用 password 输入框', keyEl && keyEl.type === 'password', keyEl && keyEl.type);
  const permSel = doc.getElementById('settings_agent_permission');
  const permOpts = permSel ? [...permSel.options].map(o => o.value).join(',') : '';
  check('S1.3 权限三档值与 Spec 一致', permOpts === 'readonly,standard,full', permOpts);
  const effSel = doc.getElementById('settings_agent_effort');
  const effOpts = effSel ? [...effSel.options].map(o => o.value).join(',') : '';
  check('S1.4 推理深度六档值一致', effOpts === 'auto,low,medium,high,xhigh,max', effOpts);
  const thSel = doc.getElementById('settings_agent_thinking');
  check('S1.5 思考模式三档值一致', thSel && [...thSel.options].map(o=>o.value).join(',') === 'default,on,off', thSel && [...thSel.options].map(o=>o.value).join(','));
  const warnBox = [...doc.querySelectorAll('#settingsModal .info-box')].some(el => el.textContent.includes('页面文本') && el.textContent.includes('模型端点'));
  check('S1.6 数据流向警示文案存在', warnBox);

  // S2 header 按钮与派发注册
  const toggleBtn = doc.getElementById('agentToggleBtn');
  check('S2.1 header 存在 agentToggleBtn', !!toggleBtn);
  check('S2.2 按钮 data-action=agent-toggle', toggleBtn && toggleBtn.dataset.action === 'agent-toggle');
  const core = fs.readFileSync(path.join(ROOT, 'static/js/00-core.js'), 'utf8');
  check('S2.3 agent-toggle 已注册 DELEGATED_ACTIONS', /'agent-toggle':\s*\(\)\s*=>\s*vcToggleAgentPanel\(\)/.test(core));
  // v3.14.1 A1 行为变更：boot 期即按设置恢复按钮（不再等 openSettings）——
  // enabled=true 加载完就应显示；enabled=false 才隐藏（S2.4b 验反面）。
  check('S2.4 boot 期按 enabled=true 恢复显示（A1 修复语义）', toggleBtn && toggleBtn.style.display !== 'none', toggleBtn && toggleBtn.style.display);

  // S2.4b enabled=false → 恢复函数置隐藏（直接喂假设置对象，行为级验证）
  win.vcRestoreAgentUI(Object.assign({}, AGENT_SETTINGS, { agent_enabled: false }));
  check('S2.4b enabled=false 恢复后隐藏', toggleBtn.style.display === 'none', toggleBtn.style.display);
  win.vcRestoreAgentUI(AGENT_SETTINGS);  // 还原 enabled=true 供后续断言

  // S3 openSettings 回填（含掩码协议）
  await win.openSettings();
  await new Promise(r => setTimeout(r, 300));
  check('S3.1 enabled 回填 → header 按钮显示', toggleBtn.style.display !== 'none', toggleBtn.style.display);
  check('S3.2 base_url 回填', doc.getElementById('settings_agent_base_url').value === AGENT_SETTINGS.agent_base_url);
  check('S3.3 model 回填', doc.getElementById('settings_agent_model').value === 'test-model-x');
  check('S3.4 thinking 回填 off', doc.getElementById('settings_agent_thinking').value === 'off');
  check('S3.5 effort 回填 high', doc.getElementById('settings_agent_effort').value === 'high');
  check('S3.6 permission 回填 readonly', doc.getElementById('settings_agent_permission').value === 'readonly');
  check('S3.7 temperature 回填 0.7', doc.getElementById('settings_agent_temperature').value === '0.7');
  check('S3.8 max_steps 回填 25', doc.getElementById('settings_agent_max_steps').value === '25');
  check('S3.9 密钥输入框永远为空（明文不出后端）', keyEl.value === '', keyEl.value);
  check('S3.10 已设密钥 → 哨兵标记+已保存 placeholder', keyEl.dataset.set === '1' && keyEl.placeholder.includes('已保存'), keyEl.placeholder);
  check('S3.11 设置弹窗标题已更名（不再仅地图）', doc.querySelector('#settingsModal .modal-header h3').textContent.trim() === '设置');

  // S4 saveSettings 提交协议
  const postedBodies = [];
  const origFetch = win.fetch;
  win.fetch = async (u, opt) => {
    if (String(u).includes('/api/settings') && opt && opt.method === 'POST') postedBodies.push(JSON.parse(opt.body));
    return origFetch(u, opt);
  };
  doc.getElementById('settings_agent_max_steps').value = '50';
  await win.saveSettings();
  await new Promise(r => setTimeout(r, 300));
  const body = postedBodies[postedBodies.length - 1] || {};
  check('S4.1 提交含全部 10 个 agent 字段', ['agent_enabled','agent_base_url','agent_api_key','agent_model','agent_thinking','agent_reasoning_effort','agent_permission','agent_temperature','agent_max_steps','agent_step_delay'].every(k => k in body), Object.keys(body).filter(k=>k.startsWith('agent_')).length);
  check('S4.2 key 框留空且此前已设 → 回传哨兵 __KEEP__', body.agent_api_key === '__KEEP__', body.agent_api_key);
  check('S4.3 修改值生效 max_steps=50', String(body.agent_max_steps) === '50');
  check('S4.4 amap 老字段仍在提交（兼容不破坏）', body.amap_api_key === 'testamap');
  // agent key 不写 localStorage
  const ls = [];
  for (let i = 0; i < win.localStorage.length; i++) { const k = win.localStorage.key(i); if (/agent/i.test(k)) ls.push(k); }
  check('S4.5 agent 字段零写 localStorage', ls.length === 0, ls.join(','));
  // S4.6 v3.14.2：Base URL 粘完整聊天端点 → 保存时归一为根地址（防双路径 404）
  doc.getElementById('settings_agent_base_url').value = 'http://127.0.0.1:8888/v1/chat/completions';
  await win.saveSettings();
  await new Promise(r => setTimeout(r, 300));
  const body2 = postedBodies[postedBodies.length - 1] || {};
  check('S4.6 完整端点保存时归一为根地址', body2.agent_base_url === 'http://127.0.0.1:8888/v1', body2.agent_base_url);
  doc.getElementById('settings_agent_base_url').value = AGENT_SETTINGS.agent_base_url; // 还原

  // S5 权限门：包装已安装 + 行为
  check('S5.1 85-agent 载入即安装（无 enable 调用）', /function _installAgentGate/.test(fs.readFileSync(path.join(ROOT, 'static/js/85-agent.js'), 'utf8')));
  // jsdom 里 60/30/40/10 的原函数都在（顶层 function 声明=window 属性），包装后带标记
  check('S5.2 包装标记生效', win.startConversion && win.startConversion.__vcWrappedForAgent === true);
  check('S5.3 包装名单全覆盖 14 项（v3.14.1 补 saveReport/exportReportLog/openExternalUrl）', ['startConversion','startVR3D','startMetadataApply','startMetadataBatchRun','cancelConversion','savePresetDialog','deletePreset','removeSelectedTasks','removeUnselectedBatch','clearMergeList','saveReport','exportReportLog','openExternalUrl','saveSettings'].every(n => win[n] && win[n].__vcWrappedForAgent === true));
  // 用户手动路径：__vcAgentActive=false → 直通（saveSettings 刚被真实调用过，证明直通生效）
  check('S5.4 非 agent 期间直通生效（saveSettings 已实际执行）', postedBodies.length > 0);
  // agent 期间 readonly：confirm 不应弹出（拦截在 confirm 前），函数不执行
  win.__vcAgentActive = true;
  let confirmCalled = false;
  win.confirm = () => { confirmCalled = true; return false; };
  const mergeCountBefore = (doc.getElementById('mergeTableBody') || {}).children ? doc.getElementById('mergeTableBody').children.length : -1;
  win.clearMergeList();
  const toasts = (doc.getElementById('toastNotification') || {}).textContent || '';
  check('S5.5 readonly 下 agent 触发被拦截（无 confirm）', confirmCalled === false);
  check('S5.6 readonly 拦截有 toast 说明', /只读/.test(toasts), toasts.slice(0, 60));
  check('S5.7 被拦动作确未执行', (doc.getElementById('mergeTableBody') || { children: [] }).children.length === Math.max(mergeCountBefore, 0));
  // agent 期间 saveSettings=禁区（即使 full 也拦）
  win.clearTimeout && (() => {})();
  const postCountBefore = postedBodies.length;
  win.saveSettings();
  await new Promise(r => setTimeout(r, 200));
  check('S5.8 agent 期间 saveSettings 一律拦截（含 full）', postedBodies.length === postCountBefore);
  // standard：confirm 弹且拒绝=不执行
  win.__vcAgentSettings = null; // 让 _agentSettingsCache 保持 readonly 之外再验 standard
  // 直接改缓存不可达（模块私有），改验源码级逻辑存在
  const agent85 = fs.readFileSync(path.join(ROOT, 'static/js/85-agent.js'), 'utf8');
  check('S5.9 standard 确认分支存在', /perm === 'standard'/.test(agent85) && /window\.confirm\(/.test(agent85));
  check('S5.10 full 放行分支存在', /perm === 'full'|放行（权限/.test(agent85));
  win.__vcAgentActive = false;

  // S6 懒加载红线：URL 必带 autoInit=false
  check('S6.1 vendor URL 带 ?autoInit=false', /\/agent\/page-agent\.iife\.js\?autoInit=false/.test(agent85));
  check('S6.2 不出现裸路径加载（无查询串形态）', !/\.src\s*=\s*['"`]\/agent\/page-agent\.iife\.js['"`]/.test(agent85));
  check('S6.3 apiKey 恒为占位 relay', /apiKey:\s*'relay'/.test(agent85));
  check('S6.4 customFetch 指向同源中继', /fetch\('\/api\/agent_relay'/.test(agent85));
  check('S6.5 思考参数注入逻辑存在', /chat_template_kwargs/.test(agent85) && /enable_thinking/.test(agent85));
  check('S6.6 effort 注入逻辑存在', /reasoning_effort/.test(agent85));
  check('S6.7 __vcAgentActive 由生命周期钩子置/清', /onBeforeTask:.*__vcAgentActive = true/.test(agent85) && /onAfterTask:.*__vcAgentActive = false/.test(agent85));
  check('S6.8 加载失败防重试风暴（broken 标志）', /__vcAgentBroken/.test(agent85));

  // S7 index.html 脚本顺序：85 在 90 之前
  const html = fs.readFileSync(path.join(ROOT, 'static/index.html'), 'utf8');
  check('S7.1 85-agent.js 在 90-boot 之前加载', html.indexOf('85-agent.js') > html.indexOf('80-codec.js') && html.indexOf('85-agent.js') < html.indexOf('90-boot.js'));

  dom.window.close();

// ═══ B 组：后端契约实测（真 app.py @8766）═══
  let dev = true;
  try { await getJSON(DEV, '/api/version'); } catch (e) { dev = false; }
  check('B0 dev 服务器在线（8766）', dev, dev ? '' : '跳过 B 组');
  if (dev) {
    // B1 GET settings：key 必为哨兵/空，绝不回显 sk- 形态明文
    const g1 = await getJSON(DEV, '/api/settings');
    const key = g1.data.agent_api_key;
    check('B1.1 GET 含全部 agent 默认字段', 'agent_enabled' in g1.data && 'agent_max_steps' in g1.data && 'agent_permission' in g1.data);
    check('B1.2 key 值 ∈ {__KEEP__, ""}', key === '__KEEP__' || key === '', JSON.stringify(key));
    check('B1.3 响应不含 sk- 明文形态', !/sk-[A-Za-z0-9]{8,}/.test(JSON.stringify(g1.data)));

    // B2 哨兵保旧值：先写伪 key，再 POST __KEEP__，GET 仍为已设标志
    await postJSON(DEV, '/api/settings', { agent_base_url: DEV, agent_api_key: 'fake-test-key-123', agent_model: 'gate-test' });
    const g2 = await getJSON(DEV, '/api/settings');
    check('B2.1 写入后 GET 回哨兵', g2.data.agent_api_key === '__KEEP__' && g2.data.agent_api_key_set === true);
    await postJSON(DEV, '/api/settings', { agent_api_key: '__KEEP__' });
    const g3 = await getJSON(DEV, '/api/settings');
    check('B2.2 回传哨兵保旧值（set 标志仍真）', g3.data.agent_api_key_set === true);
    // B2.3 relay 用保留的旧 key 仍能通过结构校验（打到 8766 自己：预期 405 透传而非 401/密钥错）
    const r2 = await postJSON(DEV, '/api/agent_relay', { path: '/chat/completions', body: { messages: [{ role: 'user', content: 'x' }] } });
    check('B2.3 中继可达已存 baseURL（结构透传）', r2.status === 405 || r2.status === 200, 'HTTP ' + r2.status);

    // B4 路径白名单（归一化全等）：绕过向量必须 400
    const badPaths = ['/chat/completions/../settings', '/chat/completions/../../etc/passwd', '//evil.com/x', 'chat/completions', '/CHAT/COMPLETIONS', '/chat/completions?q=1'];
    let all400 = true, det = [];
    for (const p of badPaths) {
      const r = await postJSON(DEV, '/api/agent_relay', { path: p, body: { messages: [{ role: 'user', content: 'x' }] } });
      if (r.status !== 400) { all400 = false; det.push(p + '->' + r.status); }
    }
    check('B4 六组路径绕过全拦截(400)', all400, det.join(' '));

    // B5 body 校验
    const r5 = await postJSON(DEV, '/api/agent_relay', { path: '/chat/completions', body: {} });
    check('B5 缺 messages → 400', r5.status === 400);

    // B6 未配置 baseURL → 400 中文指引
    await postJSON(DEV, '/api/settings', { agent_base_url: '', agent_api_key: '' });
    const r6 = await postJSON(DEV, '/api/agent_relay', { path: '/chat/completions', body: { messages: [{ role: 'user', content: 'x' }] } });
    check('B6 空 baseURL → 400 + 中文行动指引', r6.status === 400 && /AI 助手未配置/.test(JSON.stringify(r6.data)), 'HTTP ' + r6.status);

    // B6b v3.14.2 回归：Base URL 粘**完整聊天端点**时必须剥离尾段再拼接。
    // 用户实报缺陷（2026-10-13）：完整端点 + 白名单路径 = 双路径，
    // 上游 llama.cpp 回 404 "File Not Found"。用临时 echo 靶做字节级判定：
    // 剥离后上游实收 /v1/chat/completions；未剥离则实收 /v1/chat/completions/chat/completions。
    const echoPort = 8793;
    const echoSrv = http.createServer((rq, rs) => {
      let b = ''; rq.on('data', c => b += c);
      rq.on('end', () => { rs.writeHead(200, { 'Content-Type': 'application/json' }); rs.end(JSON.stringify({ got: rq.url })); });
    });
    await new Promise(r => echoSrv.listen(echoPort, '127.0.0.1', r));
    await postJSON(DEV, '/api/settings', { agent_base_url: `http://127.0.0.1:${echoPort}/v1/chat/completions`, agent_api_key: '', agent_model: 'm' });
    const r6b = await postJSON(DEV, '/api/agent_relay', { path: '/chat/completions', body: { messages: [{ role: 'user', content: 'x' }] } });
    check('B6b 完整端点 Base URL 被剥离尾段（上游实收规范单路径，无双路径 404）',
      r6b.status === 200 && r6b.data && r6b.data.got === '/v1/chat/completions',
      'HTTP ' + r6b.status + ' 上游实收 ' + (r6b.data && r6b.data.got));
    echoSrv.close();

    // 恢复出厂：清掉本套件写入的测试值（fake-test-key-123 是假值但同样不留盘）
    const done = await postJSON(DEV, '/api/settings', { agent_base_url: '', agent_model: '', agent_api_key: '' });
    check('B7 测试残留已清理', done.status === 200);
  }

  // ═══ 汇总 ═══
  const bad = results.filter(r => !r.ok);
  console.log('\n' + '═'.repeat(58));
  results.forEach(r => console.log((r.ok ? 'OK   ' : 'FAIL ') + r.name + (r.detail ? '  -> ' + r.detail : '')));
  console.log('═'.repeat(58));
  console.log(`v3.14.0 AI 助手验收：${results.length - bad.length}/${results.length} PASS`);
  process.exit(bad.length ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });

// RUNTIME-CHECKLIST（真实 vendor 行为，由 team-lead 在重建 exe 后用 CDP 复跑）：
// R1  点击 agentToggleBtn → Network 域记录：绝无 page-ag-testing-*.fcapp.run 请求（autoInit 防线）
// R2  点击后 document 出现 vendor Panel DOM（page-agent 容器），且面板可用
// R3  execute("切换到元数据工具") → modeTab(metadata) 变为激活态，零 confirm（L1 导航不受门）
// R4  readonly + agent 触发「开始转换」→ 拦截 toast、零 POST /api/convert
// R5  standard + agent 触发 → confirm 弹出；拒绝 → 零请求；确认 → 请求发出
// R6  任务运行中点 agentToggleBtn → agent.stop() 在 2s 内终止（AC-09）
// R7  端点不可达时打开面板执行 → 中文错误 toast，六模式仍可用（AC-04）
// R8  full 权限 agent 触发 L2 → 无 confirm 直接执行且 logBox 有「放行」记录
// R9  agent 期间窗口内任何路径均无法改 settings（包装 saveSettings 拦截，AC 禁区）
// R10 transformRequestBody：effort=high 请求体含 reasoning.effort=high 与 reasoning_effort；
//     thinking=off 含 chat_template_kwargs.enable_thinking=false（经 relay 请求日志/抓包）

// 门禁 08：打包产物端到端验证
// 启动打包后的 EXE，验证其内置 HTTP 服务能正确提供**重构后的前端资源**。
// 这能证明：PyInstaller 确实打进了 static/js/*.js 与 static/css/app.css，
// 且应用在打包形态下可正常启动（静态资源路由 + 前端资源可访问）。
//
// 说明：EXE 会尝试创建 pywebview 窗口；在无显示环境下窗口可能失败，但 Flask
// 运行在守护线程中并会先于窗口启动，因此 HTTP 端口仍可访问 —— 这正是要验证的部分。
const { spawn, execFileSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');

const EXE = path.resolve(__dirname, '../../dist/360VideoConverter.exe');
const PORT = 8765;

if (!fs.existsSync(EXE)) { console.error('FAIL: 未找到打包产物 ' + EXE); process.exit(1); }
console.log(`产物: ${EXE}  ${(fs.statSync(EXE).size / 1048576).toFixed(1)} MB\n`);

// ── 进程清理：必须用 taskkill /F /T 杀整棵进程树 ──
// 陷阱：spawn(detached:true) + process.kill(-pid) 在 Windows 上**不生效**，
// 会留下僵尸实例占着 8765 端口。后果不仅是资源泄漏 —— 下一次验证会连到那个
// 旧实例上，于是「测的是旧版本、却报告为通过」。这在 v3.12.2 排查中真实发生过。
const killAll = () => {
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq 360VideoConverter.exe', '/FO', 'CSV', '/NH'],
      { encoding: 'utf8', windowsHide: true });
    const pids = [...out.matchAll(/"360VideoConverter\.exe","(\d+)"/g)].map(m => m[1]);
    pids.forEach(p => {
      try { execFileSync('taskkill', ['/F', '/T', '/PID', p], { encoding: 'utf8', windowsHide: true }); } catch (e) {}
    });
    return pids;
  } catch (e) { return []; }
};

const portBusy = () => new Promise(resolve => {
  const s = net.connect({ host: '127.0.0.1', port: PORT });
  const done = v => { try { s.destroy(); } catch (e) {} resolve(v); };
  s.on('connect', () => done(true));
  s.on('error', () => done(false));
  setTimeout(() => done(false), 1000);
});

// ── 收尾清理 ──
const cleanup = () => { killAll(); };
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

const get = (p) => new Promise(resolve => {
  const req = http.get({ host: '127.0.0.1', port: PORT, path: p, timeout: 3000 }, res => {
    let d = ''; res.on('data', c => d += c);
    res.on('end', () => resolve({ code: res.statusCode, len: d.length, body: d, headers: res.headers }));
  });
  req.on('error', e => resolve({ err: e.message }));
  req.on('timeout', () => { req.destroy(); resolve({ err: 'timeout' }); });
});

// v3.14.0：POST 探针（中继端点存活校验）+ 取字节（sha1 逐字节校验必须用 Buffer，
// 字符串解码会破坏字节数）。均走原生 http，node http 不经系统代理，与既有教训一致。
const rawHttp = (method, p, payload) => new Promise(resolve => {
  const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method, timeout: 4000,
    headers: { 'Content-Type': 'application/json' } }, res => {
    let d = ''; res.on('data', c => d += c);
    res.on('end', () => resolve({ code: res.statusCode, body: d }));
  });
  req.on('error', e => resolve({ code: 0, body: '', err: e.message }));
  req.on('timeout', () => { req.destroy(); resolve({ code: 0, body: '', err: 'timeout' }); });
  req.end(payload);
});

const getBytes = (p) => new Promise(resolve => {
  const req = http.get({ host: '127.0.0.1', port: PORT, path: p, timeout: 8000 }, res => {
    const chunks = [];
    res.on('data', c => chunks.push(c));   // 不设 encoding → c 是 Buffer
    res.on('end', () => resolve(Buffer.concat(chunks)));
  });
  req.on('error', () => resolve(Buffer.alloc(0)));
  req.on('timeout', () => { req.destroy(); resolve(Buffer.alloc(0)); });
});

(async () => {
  // ── 前置检查：先清掉遗留实例，再确认端口空闲 ──
  // 若端口已被占用，本次启动的进程会因单实例检查而退出，测试将连到那个旧实例上，
  // 于是「测的是旧版本、却报告为通过」—— 必须显式拦住这种情况。
  killAll();
  await new Promise(r => setTimeout(r, 600));
  if (await portBusy()) {
    console.error(`FAIL: 端口 ${PORT} 已被占用，无法确认被测进程就是本次启动的实例。`);
    console.error('      请先结束所有 360VideoConverter.exe 后重试。');
    process.exit(1);
  }

  // 启动 EXE（分离进程，稍后 taskkill 结束整棵树）
  const child = spawn(EXE, [], { detached: true, stdio: 'ignore' });
  child.unref();
  console.log(`已启动 EXE (pid=${child.pid})，等待内置服务就绪...`);

  // 轮询等待端口就绪（最多 40 秒）
  let ready = false;
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const r = await get('/');
    if (r.code === 200) { ready = true; console.log(`服务就绪（${i + 1}s）\n`); break; }
  }
  if (!ready) {
    console.log('FAIL: 40 秒内未能在 127.0.0.1:' + PORT + ' 访问到内置服务');
    cleanup();
    process.exit(1);
  }

  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: String(detail === undefined ? '' : detail) });

  // 1. 首页
  const home = await get('/');
  check('首页可访问', home.code === 200, `${home.code}, ${home.len}B`);
  check('首页为重构后的骨架（含 /js/ 与 /css/ 外链，无内联代码）',
    home.body && home.body.includes('/js/00-core.js') && home.body.includes('/css/app.css')
    && !/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/.test(home.body)
    && !/<style[^>]*>/.test(home.body),
    '外链 00-core.js/app.css；无内联 script/style');
  // 三栏工作台结构必须在打包页面里（否则会退回旧版单列观感）
  const wsCount = (home.body.match(/class="workspace"/g) || []).length;
  const wsCols = (home.body.match(/ws-col-(left|center|right)/g) || []).length;
  check('打包页面含三栏工作台结构', wsCount === 1 && wsCols === 3,
    `.workspace=${wsCount}, .ws-col-*=${wsCols}`);
  // 注意：必须精确匹配 class 值，否则 "class=\"param-group" 会连带匹配
  // param-group-head / param-group-body（9 组 × 3 = 27，误判为失败）
  const pgCount = (home.body.match(/class="param-group(?: collapsed)?"/g) || []).length;
  check('打包页面含 9 个手风琴分组与单一操作栏',
    pgCount === 9 && home.body.includes('id="mainActionBar"'),
    `param-group=${pgCount}, mainActionBar=${home.body.includes('id="mainActionBar"') ? 'YES' : 'NO'}`);

  // 2. 全部前端资源（拆分后的关键文件）
  const assets = [
    '/js/00-core.js', '/js/10-ui.js', '/js/20-map.js', '/js/30-params.js', '/js/40-files.js',
    '/js/50-meta.js', '/js/60-jobs.js', '/js/70-report.js', '/js/80-codec.js', '/js/90-boot.js',
    '/css/app.css', '/leaflet/leaflet.js', '/leaflet/leaflet.css',
  ];
  let missing = [];
  for (const a of assets) {
    const r = await get(a);
    if (r.code !== 200 || r.len < 100) missing.push(`${a}(${r.code || r.err})`);
  }
  check(`打包内 ${assets.length} 项前端资源全部可访问`, missing.length === 0, missing.length ? missing.join(', ') : '全部 200');

  // 3. 关键内容校验（证明不是旧版本残留）
  const core = await get('/js/00-core.js');
  check('00-core.js 含事件委托分发器（v3.12.0 特征）', core.body && core.body.includes('DELEGATED_ACTIONS'));
  const ui = await get('/js/10-ui.js');
  check('10-ui.js 含手风琴与路径工厂（v3.12.0 特征）',
    ui.body && ui.body.includes('toggleParamGroup') && ui.body.includes('renderPathField'));
  const jobs = await get('/js/60-jobs.js');
  // 注意：不能用 includes('_origPollStatus') 判断——源码注释里记录了被删除的旧代码。
  // 应检查"可执行语句"是否存在：行首（非注释）的赋值/声明。
  check('60-jobs.js 含 ActiveJob 控制器且覆盖式补丁已移除（v3.11.0 特征）',
    jobs.body && jobs.body.includes('ActiveJob') && jobs.body.includes('beginJob')
    && !/^pollStatus = async function/m.test(jobs.body)
    && !/^const _origPollStatus = pollStatus/m.test(jobs.body),
    'ActiveJob/beginJob 存在；无行首 pollStatus 重新赋值与 _origPollStatus 声明');

  // 4. 版本号
  const ver = await get('/api/version');
  let v = '';
  try { v = JSON.parse(ver.body).version; } catch (e) {}
  check('版本接口返回 3.14.6', v === "3.14.6", `version = "${v}"`);

  // 4b. 缓存策略：界面资源必须 no-store，否则旧版页面可能被 WebView2 缓存复用，
  //     表现为"装了新版本但界面毫无变化"（v3.12.0 实际遇到的风险点）
  const homeHdr = (home.headers && home.headers['cache-control']) || '';
  check('首页下发 no-store（防止旧版页面被缓存复用）', /no-store/.test(homeHdr), `Cache-Control: ${homeHdr || '(缺失)'}`);
  const cssHdr = await get('/css/app.css');
  const cssCC = (cssHdr.headers && cssHdr.headers['cache-control']) || '';
  check('CSS 资源下发 no-store', /no-store/.test(cssCC), `Cache-Control: ${cssCC || '(缺失)'}`);

  // 4c. 打包产物必须真的包含本版新增的前端功能（v3.13.18 起）
  //     起因：门禁 08 原先只校验静态特征 + 硬编码版本号，对「exe 漏打最新前端资源」零覆盖 ——
  //     exe 时间戳早于源码时它依然 12/12 全绿，反而掩盖了「发布产物里新功能根本不存在」。
  //     QA 曾实测：未重建的 exe 首页中 metaBatchRunBtn / geo-copy 出现 0 次。
  //     这条断言让此类问题在门禁层面自动暴露，不再依赖人工比对时间戳。
  const homeHtml = home.body || '';
  for (const [label, needle] of [
    ['批量列队执行按钮 metaBatchRunBtn', 'metaBatchRunBtn'],
    ['AI 助手入口 agentToggleBtn', 'agentToggleBtn'],
    ['AI 助手设置组 settings_agent_enabled', 'settings_agent_enabled'],
    ['GPS 一键复制 geo-copy', 'geo-copy'],
    ['GPS 地图选点 geo-map-pick', 'geo-map-pick'],
  ]) {
    const n = (homeHtml.match(new RegExp(needle, 'g')) || []).length;
    check(`打包产物包含${label}`, n >= 1, `首页命中 ${n} 次`);
  }

  // 5. 关键 API 端点存活
  const apiPaths = ['/api/codecs', '/api/settings', '/api/presets', '/api/sysmon'];
  let apiBad = [];
  for (const a of apiPaths) {
    const r = await get(a);
    if (r.code !== 200) apiBad.push(`${a}(${r.code || r.err})`);
  }
  check('关键 API 端点存活', apiBad.length === 0, apiBad.length ? apiBad.join(', ') : '全部 200');

  // 5b. v3.14.0 AI 助手后端与资源必须真进包（中继端点存在 + vendor bundle 逐字节一致）
  // 中继路由必须已打包。三种形态都证明"路由存在且守门在跑"：
  //   400 = 未配置 baseURL 的守门拒绝；502 = 已配置但上游不可达；
  //   200 = 测试机恰好配置了可达端点、转发成功（环境相关，同样证明路由在）。
  // 只有 404（路由没打包）或超时才是失败。v3.14.2 修正：原断言只收 400/502，
  // 在"已配置可达端点"的机器上误报 FAIL（实测 200）。
  const relayR = await rawHttp('POST', '/api/agent_relay',
    '{"path":"/chat/completions","body":{"messages":[{"role":"user","content":"x"}]}}');
  check('中继端点已打包且守门激活（200/400/502，非 404）',
    relayR.code === 400 || relayR.code === 502 || relayR.code === 200, `HTTP ${relayR.code || relayR.err}`);
  // 期望值直接读仓库源文件——门禁 08 的语义就是"exe 内容与仓库源码一致"，
  // 升级 vendor 只改 static/agent/ 下文件，不回头改门禁。
  // 取字节必须用 Buffer 流（getBytes）：get() 的字符串 body 经 UTF-8 解码后
  // 字节数与 sha 都会失真，证明不了"逐字节一致"。
  const vendorBytes = await getBytes('/agent/page-agent.iife.js');
  const vendorSrc = path.resolve(__dirname, '../../static/agent/page-agent.iife.js');
  const srcBytes = fs.readFileSync(vendorSrc);
  const gotSha = crypto.createHash('sha1').update(vendorBytes).digest('hex');
  const expectSha = crypto.createHash('sha1').update(srcBytes).digest('hex');
  check('vendor bundle 已随包分发（字节数=仓库源文件）',
    vendorBytes.length === srcBytes.length, `exe=${vendorBytes.length} / 源=${srcBytes.length}`);
  check('vendor bundle 内容与仓库源文件 sha1 逐字节一致', gotSha === expectSha,
    `exe sha1=${gotSha.slice(0, 16)}… 源 sha1=${expectSha.slice(0, 16)}…`);

  // 收尾：结束整棵进程树（必须用 taskkill，见文件顶部说明）
  cleanup();

  let failed = 0;
  console.log('══ 打包产物端到端验证 ══\n');
  for (const c of checks) { if (!c.ok) failed++; console.log(`${c.ok ? 'OK  ' : 'FAIL'} ${c.name}${c.detail ? '  → ' + c.detail : ''}`); }
  console.log(`\n合计 ${checks.length} 项，通过 ${checks.length - failed}，失败 ${failed}`);
  process.exit(failed ? 1 : 0);
})();

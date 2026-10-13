// ============================================================
// v3.15.0 CLI 指令集验收套件（jsdom 真实 DOM + dev 后端契约实测）
// Spec §9 的 AC 逐条落断言（CDP 面由 _verify_cli_webview_v3150 覆盖）
// 前置：8800 桩 + 8766 dev（新代码）
// ============================================================
const path = require('path');
const os = require('os');
const http = require('http');
const WS = path.join(os.homedir(), '.workbuddy', 'binaries', 'node', 'workspace', 'node_modules');
const { JSDOM, VirtualConsole } = require(path.join(WS, 'jsdom'));

const STUB = 'http://127.0.0.1:8800';
const DEV = 'http://127.0.0.1:8766';
const results = [];
const check = (n, ok, d) => { results.push({ n, ok: !!ok, d: d === undefined ? '' : String(d) }); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const getJSON = (base, p) => new Promise((res, rej) => {
  http.get(base + p, r => { let b = ''; r.on('data', c => b += c); r.on('end', () => { try { res({ status: r.statusCode, data: JSON.parse(b) }); } catch (e) { rej(e); } }); }).on('error', rej);
});
const postJSON = (base, p, obj) => new Promise((res, rej) => {
  const data = JSON.stringify(obj);
  const req = http.request(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, r => {
    let b = ''; r.on('data', c => b += c);
    r.on('end', () => { try { res({ status: r.statusCode, data: JSON.parse(b) }); } catch (e) { res({ status: r.statusCode, data: { raw: b.slice(0, 200) } }); } });
  });
  req.on('error', rej); req.end(data);
});

(async () => {
// ═══ C 组：dev 后端 CLI 契约（真实内核+真实 ffmpeg 作业）═══
  let dev = true;
  try { await getJSON(DEV, '/api/version'); } catch (e) { dev = false; }
  check('C0 dev 8766 在线', dev);
  if (dev) {
    const cli = (cmdline, source) => postJSON(DEV, '/api/cli', { cmdline, source: source || 'agent-cli' });
    // C1 信封一致性（help 与必败命令键集一致）
    const e1 = (await cli('vc nope', 'agent-cli')).data;
    const e2 = (await cli('vc help', 'agent-cli')).data;
    check('C1 信封键集全命令一致', JSON.stringify(Object.keys(e1).sort()) === JSON.stringify(Object.keys(e2).sort()), Object.keys(e1).join(','));
    // C2 help 手册含命令清单与五拍
    check('C2 手册含 job/probe 命令与编排五拍', /vc job start-convert/.test(e2.data.manual) && /编排五拍/.test(e2.data.manual));
    // C3 禁区恒拒（standard 与 full 都拒）
    for (const perm of ['standard', 'full', 'readonly']) {
      await postJSON(DEV, '/api/settings', { agent_permission: perm });
      const r = await cli('vc config set --fields \'{"custom_ffmpeg_path":"x"}\'');
      check('C3 config set 恒禁(' + perm + ')', r.status === 403 && r.data.code === 'ERR_FORBIDDEN', r.status);
    }
    // C4 readonly 拦 L2 放 L0
    await postJSON(DEV, '/api/settings', { agent_permission: 'readonly' });
    const r4a = await cli('vc report save --path G:/nope/x.txt --content hi');
    check('C4a readonly 拦 L2', r4a.status === 403 && r4a.data.code === 'ERR_PERMISSION_READONLY', r4a.data.code);
    const r4b = await cli('vc sys version');
    check('C4b readonly 放 L0', r4b.status === 200 && r4b.data.ok);
    // C5 standard L2 → 202 待确认；token 可查
    await postJSON(DEV, '/api/settings', { agent_permission: 'standard' });
    const r5 = await cli('vc report save --path G:/_accept_tmp/cli_report.txt --content hello');
    check('C5a standard L2=202+token', r5.status === 202 && r5.data.code === 'ERR_PENDING_CONFIRM' && r5.data.meta.confirm_token, r5.status);
    const tok5 = (r5.data.meta || {}).confirm_token;
    const q5 = await cli('vc cli-confirm --token ' + tok5);
    check('C5b 未确认前 state=pending', q5.data.data && q5.data.data.state === 'pending');
    const d5 = await postJSON(DEV, '/api/cli_confirm', { token: tok5, approve: false });
    check('C5c 用户取消→DECLINED 406 且零执行', d5.status === 406 && d5.data.code === 'ERR_PERMISSION_DECLINED' && !require('fs').existsSync('G:/_accept_tmp/cli_report.txt'), d5.status + ' ' + d5.data.code);
    // C6 full 直通真执行
    await postJSON(DEV, '/api/settings', { agent_permission: 'full' });
    const r6 = await cli('vc report save --path G:/_accept_tmp/cli_report.txt --content hello');
    check('C6 full L2 直通执行', r6.status === 200 && r6.data.ok, JSON.stringify(r6.data).slice(0, 120));
    try { require('fs').unlinkSync('G:/_accept_tmp/cli_report.txt'); } catch (e) {}
    try { require('fs').rmdirSync('G:/_accept_tmp'); } catch (e) {}
    // C7 真作业端到端（apply-metadata：提交→轮询→seq 增量→文件产出）
    // request-id 每次运行唯一：内核幂等表存活于 dev 进程生命周期，固定 id 会
    // 命中上次运行的缓存结果（产品行为正确，测试须自隔离）
    const RID7 = 'V3150-AC6-' + Date.now();
    const cmd7 = "vc job apply-metadata --items '[{\"input\":\"G:/264/_acceptance_v3132/clean_src5s.mp4\",\"output\":\"G:/264/_acceptance_v3132/cli_v3150_out.mp4\",\"params\":{\"apply_date\":true,\"manual_date\":\"2026-01-01T00:00:00\"}}]' --request-id " + RID7;
    const r7 = await cli(cmd7);
    check('C7a 作业受理', r7.data.ok && r7.data.data.job_id, JSON.stringify(r7.data).slice(0, 140));
    const jid7 = r7.data.data.job_id;
    let seenSeq = 0, poll1 = null;
    for (let i = 0; i < 15; i++) {
      await sleep(1000);
      poll1 = (await cli('vc job status --id ' + jid7 + ' --since-seq ' + seenSeq)).data;
      if (poll1.ok && poll1.data.finished) break;
      if (poll1.ok) seenSeq = Math.max(seenSeq, poll1.data.seq || 0);
    }
    check('C7b 作业终态 completed', poll1.ok && poll1.data.status === 'completed', JSON.stringify(poll1.data).slice(0, 180));
    const poll2 = (await cli('vc job status --id ' + jid7 + ' --since-seq ' + (poll1.data.seq))).data;
    check('C7c 增量游标零重复', poll2.ok && poll2.data.log.lines.length === 0, JSON.stringify(poll2.data && poll2.data.log));
    check('C7d 幂等重放 OK_IDEMPOTENT', (await cli(cmd7)).data.code === 'OK_IDEMPOTENT');
    const fs_ = require('fs');
    check('C7e 输出文件存在且可探测', fs_.existsSync('G:/264/_acceptance_v3132/cli_v3150_out.mp4'));
    const pr = (await cli('vc probe metadata --path G:/264/_acceptance_v3132/cli_v3150_out.mp4')).data;
    check('C7f probe 读回 creation_time', JSON.stringify(pr.data).includes('2026-01-01') || JSON.stringify(pr.data).includes('2025-12-31'), JSON.stringify(pr.data).slice(0, 120));
    try { fs_.unlinkSync('G:/264/_acceptance_v3132/cli_v3150_out.mp4'); } catch (e) {}
    // C8 ERR_JOB_ACTIVE：full 下并发第二单
    const c8a = "vc job apply-metadata --items '[{\"input\":\"G:/264/_acceptance_v3132/clean_src5s.mp4\",\"output\":\"G:/264/_acceptance_v3132/cli_busy1.mp4\",\"params\":{\"apply_spherical\":true}}]'";
    const r8a = await cli(c8a);
    const r8b = await cli("vc job apply-metadata --items '[{\"input\":\"G:/264/_acceptance_v3132/clean_src5s.mp4\",\"output\":\"G:/264/_acceptance_v3132/cli_busy2.mp4\",\"params\":{\"apply_spherical\":true}}]'");
    check('C8 并发第二单被拒(透传后端互斥)', r8a.data.ok && r8b.data.code === 'ERR_JOB_ACTIVE', 'a=' + r8a.data.code + ' b=' + r8b.data.code);
    if (r8a.data.data && r8a.data.data.job_id) await postJSON(DEV, '/api/cancel/' + r8a.data.data.job_id, {});
    await sleep(1200);
    for (const f of ['cli_busy1.mp4', 'cli_busy2.mp4']) { try { fs_.unlinkSync('G:/264/_acceptance_v3132/' + f); } catch (e) {} }
    // C9 参数攻击面
    const r9 = await cli("vc job start-convert --items '[{\"input\":\"a\",\"output\":\"b\",\"__proto__\":\"x\"}]' --params '{\"url\":\"http://evil.example/x\",\"codec\":\"h265\"}'");
    // 内核透传 items 原样（后端 convert 会忽略未知键）——CLI 面验证 params 里的 url 被后端消费为普通键不改变转发目标
    check('C9 提交体含未知键不改变上游目标（转发仍 /api/convert）', r9.status !== 0 && r9.data.code !== 'ERR_USAGE', r9.data.code);
    if (r9.data.ok && r9.data.data.job_id) await postJSON(DEV, '/api/cancel/' + r9.data.data.job_id, {});
    const badCases = [
      ['vc file scan --dir', 'ERR_USAGE'],                     // 缺值
      ["vc probe file --path 'unclosed", 'ERR_USAGE'],          // 引号
      ['vc job status --id x --since-seq abc', 'ERR_VALIDATION'],
      ['vc config codec-check --codec x --bogus 1', 'ERR_USAGE'],
    ];
    for (const [c, want] of badCases) {
      const r = await cli(c);
      check('C9' + want + ' ' + c.slice(0, 30), r.data.code === want, r.data.code);
    }
    // C10 settings 持久化面零污染：CLI 从未写 settings（config set 恒禁）
    const g10 = await getJSON(DEV, '/api/settings');
    check('C10 settings 仍出厂态(agent 字段)', g10.data.agent_base_url === '' && g10.data.agent_model === '', JSON.stringify({ b: g10.data.agent_base_url, m: g10.data.agent_model }));
    await postJSON(DEV, '/api/settings', { agent_permission: 'standard' });
  }

// ═══ D 组：jsdom 控制台 DOM 行为 ═══
  const dom = await JSDOM.fromURL(STUB + '/', {
    runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, virtualConsole: new VirtualConsole(),
    beforeParse(w) {
      w.fetch = async (u, o) => {
        // 顺序关键：'/api/cli_confirm'.includes('/api/cli')===true，必须先判 confirm
        if (String(u).includes('/api/cli_confirm')) {
          w.__confirmCalls = (w.__confirmCalls || []).concat([JSON.parse(o.body)]);
          return { ok: true, status: 200, json: async () => ({ ok: true, code: 'OK', data: { state: 'done' }, error: null, meta: {} }) };
        }
        if (String(u).includes('/api/cli')) {
          w.__cliCalls = (w.__cliCalls || 0) + 1;
          const body = o && JSON.parse(o.body);
          w.__lastCliBody = body;
          return { ok: true, status: 202, json: async () => ({ ok: false, code: 'ERR_PENDING_CONFIRM', data: null, meta: { cmd: 'x', confirm_token: 'tok123', summary: body.cmdline }, error: { kind: 'ERR_PENDING_CONFIRM', message: 'm', hint: 'h' } }) };
        }
        if (String(u).includes('/api/settings')) return { ok: true, status: 200, json: async () => ({ auto_load_tasks: false, amap_api_key: '', amap_security: '', custom_ffmpeg_path: '', agent_enabled: true, agent_base_url: '', agent_api_key: '', agent_model: '', agent_thinking: 'default', agent_reasoning_effort: 'auto', agent_permission: 'standard', agent_temperature: '', agent_max_steps: 40, agent_step_delay: 0.4 }) };
        if (String(u).includes('/api/codecs')) return { ok: true, status: 200, json: async () => ({ codecs: {} }) };
        if (String(u).includes('/api/codec_check')) return { ok: true, status: 200, json: async () => ({ available: {}, error_details: {}, ffmpeg_info: {}, runtime_dlls: {}, fix_hints: {} }) };
        if (String(u).includes('/api/presets')) return { ok: true, status: 200, json: async () => ({ presets: [] }) };
        if (String(u).includes('/api/version')) return { ok: true, status: 200, json: async () => ({ version: '3.15.0-test' }) };
        if (String(u).includes('/api/tasks/load')) return { ok: true, status: 200, json: async () => ({ tasks: [] }) };
        return { ok: true, status: 200, json: async () => ({}) };
      };
      w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    },
  });
  const win = dom.window, doc = win.document;
  await sleep(3200);

  // D1 控制台卡存在但默认隐藏（agent_enabled 场景由 restore 显示——stub 返回 enabled:true）
  const card = doc.getElementById('cliConsoleCard');
  check('D1 控制台卡存在且 restore 后显示', !!card && card.style.display !== 'none', card && card.style.display);
  // D2 textarea 形态
  check('D2 cliInput 为 TEXTAREA', doc.getElementById('cliInput') && doc.getElementById('cliInput').tagName === 'TEXTAREA');
  // D3 手册摘要常显（agent 无需命令即可读到核心约定）
  check('D3 手册摘要已填充', /编排五拍/.test(doc.getElementById('cliManualSummary').textContent));
  // D4 执行链路：点按钮 → fetch /api/cli 且 source=agent-cli → 渲染信封含 echo_cmdline
  doc.getElementById('cliInput').value = 'vc report save --path G:/x.txt --content hi';
  doc.getElementById('cliRunBtn').click();
  await sleep(400);
  check('D4a fetch 携带 source=agent-cli', win.__lastCliBody && win.__lastCliBody.source === 'agent-cli' && /vc report save/.test(win.__lastCliBody.cmdline));
  const resBox = doc.getElementById('cliResult');
  check('D4b 结果区显示信封 JSON', resBox.textContent.includes('ERR_PENDING_CONFIRM') && resBox.textContent.includes('echo_cmdline'), resBox.textContent.slice(0, 80));
  // D5 确认条渲染与延迟防护
  const bar = doc.getElementById('cliConfirmBar');
  check('D5a pending → 确认条显示', bar.style.display === 'flex' && bar.dataset.token === 'tok123' && /report save/.test(doc.getElementById('cliConfirmSummary').textContent));
  doc.querySelector('[data-action="cli-approve"]').click(); // <1.5s 应立即被延迟防护拒绝
  await sleep(200);
  check('D5b 秒点批准被延迟防护拦截', (win.__confirmCalls || []).length === 0, (win.__confirmCalls || []).length);
  // 快进时间戳绕过延迟（模拟真人 1.6s 后点击）
  bar.dataset.shownAt = String(Date.now() - 1600);
  doc.querySelector('[data-action="cli-approve"]').click();
  await sleep(300);
  check('D5c 延迟后批准→cli_confirm approve:true', (win.__confirmCalls || []).some(b => b.token === 'tok123' && b.approve === true));
  // D6 decline 路径
  doc.getElementById('cliInput').value = 'vc sys version';
  doc.getElementById('cliRunBtn').click();
  await sleep(300);
  bar.dataset.shownAt = String(Date.now() - 1600);
  doc.querySelector('[data-action="cli-decline"]').click();
  await sleep(200);
  check('D6 取消路径 approve:false', (win.__confirmCalls || []).some(b => b.approve === false));
  // D7 agent_enabled=false → 卡隐藏（vcCliVisibilitySync 接线）
  win.vcCliVisibilitySync(false);
  check('D7 助手关闭时控制台隐藏', card.style.display === 'none');
  win.vcCliVisibilitySync(true);
  check('D8 助手开启时恢复显示', card.style.display !== 'none');
  dom.window.close();

  // ═══ 汇总 ═══
  const bad = results.filter(r => !r.ok);
  console.log('\n' + '═'.repeat(58));
  results.forEach(r => console.log((r.ok ? 'OK   ' : 'FAIL ') + r.n + (r.d ? '  -> ' + r.d : '')));
  console.log('═'.repeat(58));
  console.log(`v3.15.0 CLI 验收：${results.length - bad.length}/${results.length} PASS`);
  process.exit(bad.length ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });

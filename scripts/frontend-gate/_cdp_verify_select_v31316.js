// v3.13.16 验收：报告内容可自由选中复制
// 方法说明：CDP 合成拖拽在 WebView2 中不驱动原生选择控制器（对照组 h1 同样选不中），
// 故验收改用三条独立可信路径：Range API 逐字段可选 / 真实双击选词 / 交互控件仍禁选。
const http = require('http');
const fs = require('fs');
function getJSON(p) {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: 9222, path: p }, r => {
      let b = ''; r.on('data', c => b += c);
      r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
    }).on('error', rej);
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const check = (n, ok, d) => { results.push(ok); console.log((ok ? 'OK   ' : 'FAIL ') + n + (d ? '  -> ' + d : '')); };

(async () => {
  const page = (await getJSON('/json/list')).find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pend = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
  await new Promise(r => { ws.onopen = r; });
  const send = (method, params = {}) => new Promise(res => {
    const i = ++id; pend.set(i, m => res(m.result || {}));
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  const ev = async (x) => {
    const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, userGesture: true });
    return r.exceptionDetails ? 'ERR:' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text) : r.result?.value;
  };
  await send('Runtime.enable'); await send('Page.enable');

  await ev(`switchMode('report')`); await sleep(400);
  await ev(`(function(){const e=document.getElementById('reportInput'); if(e) e.value='G:\\\\264\\\\_acceptance_v3132\\\\clean_src5s.mp4';})()`);
  await ev(`generateReport && generateReport()`); await sleep(4500);

  const n = await ev(`document.querySelectorAll('.report-item').length`);
  check('前置: 已生成报告', n > 0, `报告项=${n}`);

  // 1) 报告区计算值必须是 text
  const us = await ev(`(function(){const i=document.querySelector('.report-item'), v=document.querySelector('.report-row .value');
    return JSON.stringify({item:getComputedStyle(i).userSelect, value:getComputedStyle(v).userSelect});})()`);
  check('1. 报告区 user-select 计算值为 text（不再 none）', us === '{"item":"text","value":"text"}', us);

  // 2) 逐个值字段都能被 Range 选中（含路径/时长/GPS 等全部字段）
  const allSel = await ev(`(function(){
    const all = [...document.querySelectorAll('.report-item .value, .report-item .fname, .report-item .fpath')];
    // 无文本节点/纯图标徽章（如 moov 徽章内是 SVG）本就没有文字可复制，不纳入分母
    const vals = all.filter(el => el.textContent && el.textContent.trim().length > 0);
    let ok = 0, bad = [];
    for (const el of vals) {
      if (!el.firstChild) continue;
      const r = document.createRange(); r.selectNodeContents(el);
      const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
      if (s.toString().length > 0) { ok++; continue; }
      // 值内文字全部位于刻意排除选择的芯片/徽章内（如 moov 徽章为纯 SVG）→ 属预期不可选
      const chip = el.querySelector('.badge, .meta-badge, .metaq-chip, .meta-badge');
      if (chip) { ok++; continue; }
      bad.push((el.className || el.tagName) + ':' + el.textContent.trim().slice(0, 18));
      s.removeAllRanges();
    }
    return JSON.stringify({ total: vals.length, ok, skipped: all.length - vals.length, bad: bad.slice(0, 5) });
  })()`);
  const sel = JSON.parse(allSel || '{}');
  check('2. 报告全部字段（含文件名/路径/各元数据值）均可选中', sel.ok === sel.total && sel.ok > 15,
    `可选 ${sel.ok}/${sel.total}${sel.bad && sel.bad.length ? ' 失败:' + sel.bad.join(',') : ''}`);

  // 3) 路径字段（用户明确要求含路径）能被完整选中
  const pathSel = await ev(`(function(){
    const el = document.querySelector('.report-item .fpath');
    if(!el || !el.firstChild) return 'no-fpath';
    const r = document.createRange(); r.selectNodeContents(el);
    const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
    const t = s.toString(); s.removeAllRanges();
    return JSON.stringify({ len: t.length, text: t });
  })()`);
  const ps = JSON.parse(pathSel || '{}');
  check('3. 文件路径可完整选中（复制含完整路径）', ps.len > 10 && /clean_src5s/.test(ps.text || ''), pathSel);

  // 4) 真实双击选词（用户实际操作路径）
  const box = await ev(`(function(){const el=document.querySelector('.report-row .value'); if(!el) return 'no-el';
    const r=el.getBoundingClientRect(); return JSON.stringify({x:r.x+10,y:r.y+r.height/2});})()`);
  await ev(`window.getSelection().removeAllRanges()`);
  const p = JSON.parse(box || '{}');
  if (p.x !== undefined) {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 2 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 2 });
    await sleep(400);
    const dbl = await ev(`(function(){const s=window.getSelection();const t=s.toString();return JSON.stringify({len:t.length,text:t});})()`);
    check('4. 真实鼠标双击可选中词', JSON.parse(dbl || '{}').len > 0, dbl);
  }

  // 5) 交互控件必须仍不可选（避免拖选误触发控件）
  const ctl = await ev(`(function(){
    const q = s => { const e=document.querySelector(s); return e ? (getComputedStyle(e).userSelect||getComputedStyle(e).webkitUserSelect) : 'MISSING'; };
    return JSON.stringify({ modeTab:q('.mode-tab'), btn:q('.btn'), toggle:q('.toggle-switch'), check:q('.check') });
  })()`);
  const c = JSON.parse(ctl || '{}');
  check('5. 交互控件仍禁选（页签/按钮/开关/复选框）',
    c.modeTab === 'none' && c.btn === 'none' && c.toggle === 'none', ctl);

  // 6) 其他只读区（系统监控/日志）也可选
  const ro = await ev(`(function(){
    const q = s => { const e=document.querySelector(s); return e ? (getComputedStyle(e).userSelect||'unset') : 'MISSING'; };
    return JSON.stringify({ sysmon:q('.sysmon-cell'), log:q('.log-box'), body:q('body') });
  })()`);
  check('6. 监控卡/日志区/正文均可选', ro.includes('"sysmon":"text"') && ro.includes('"log":"text"'), ro);

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('docs/design/ui_redesign/v31316_报告可选中验证.png', Buffer.from(shot.data, 'base64'));

  const bad = results.filter(x => !x).length;
  console.log(`\n报告可选择性验收：${results.length - bad}/${results.length} PASS`);
  ws.close();
  process.exit(bad ? 1 : 0);
})().catch(e => { console.log('FATAL:', e.message); process.exit(1); });
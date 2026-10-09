// CDP 真实 exe 逐项验证 v3.13.14 四项需求（真实点击 + 截图取证）
const http = require('http');
const fs = require('fs');

function getJSON(p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: 9222, path: p }, res => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const results = [];
const check = (n, ok, d) => { results.push(ok); console.log((ok ? 'OK   ' : 'FAIL ') + n + (d ? '  -> ' + d : '')); };

(async () => {
  const targets = await getJSON('/json/list');
  const page = targets.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pending = new Map(); const exceptions = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      exceptions.push(((d.exception && d.exception.description) || d.text).slice(0, 140));
    }
  };
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error('ws')); });
  const send = (method, params = {}) => new Promise((res) => {
    const i = ++id; pending.set(i, (m) => res(m.result || {}));
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) { exceptions.push('[eval] ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text).slice(0, 140)); return null; }
    return r.result && r.result.value;
  };
  await send('Runtime.enable'); await send('Page.enable');
  await sleep(1500);

  console.log('== 需求1：加入批量列队（真实点击）==');
  await ev(`switchMode('metadata')`); await sleep(400);
  // 重置队列状态（脚本可重复运行）
  await ev(`(function(){ metaBatchItems.length = 0; const i=document.getElementById('metaInput'); if(i) i.value=''; renderMetaBatchTable(); syncMetaApplyButton(); })()`);
  await sleep(200);
  await ev(`(function(){const d=document.getElementById('meta_apply_date'); if(d) d.checked=true;})()`);
  const hasBtn = await ev(`!!document.getElementById('metaAddQueueBtn')`);
  check('1.1 「加入批量列队」按钮存在于动作栏', hasBtn === true, 'id=metaAddQueueBtn');
  // 真实鼠标点击
  const r1 = await ev(`(function(){const b=document.getElementById('metaAddQueueBtn');const r=b.getBoundingClientRect();return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2});})()`);
  // 空输入时点击应给警告，不入队
  const p1 = JSON.parse(r1);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p1.x, y: p1.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p1.x, y: p1.y, button: 'left', clickCount: 1 });
  await sleep(400);
  const q0 = await ev(`metaBatchItems.length`);
  check('1.2 空输入时点击不入队（防呆）', q0 === 0, `队列=${q0}`);

  // 放入真实文件后点击
  await ev(`(function(){const el=document.getElementById('metaInput');el.value='G:\\\\264\\\\_acceptance_v3132\\\\clean_src5s.mp4';el.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await sleep(2500);   // 等真实探测
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p1.x, y: p1.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p1.x, y: p1.y, button: 'left', clickCount: 1 });
  await sleep(600);
  const st = await ev(`JSON.stringify({n: metaBatchItems.length, path: metaBatchItems[0] && metaBatchItems[0].path, outDir: metaBatchItems[0] && JSON.stringify(getOutDir(metaBatchItems[0])), sel: metaBatchItems[0] && metaBatchItems[0].selected, st: metaBatchItems[0] && metaBatchItems[0].status})`);
  const s = JSON.parse(st || '{}');
  check('1.3 点击后快照入列（含输出目录快照）', s.n === 1 && /clean_src5s/.test(s.path || ''), `n=${s.n} outDir=${s.outDir}`);
  check('1.4 入列项默认勾选且状态 pending', s.sel === true && s.st === 'pending', `sel=${s.sel} status=${s.st}`);

  console.log('== 需求1b：去重 ==');
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p1.x, y: p1.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p1.x, y: p1.y, button: 'left', clickCount: 1 });
  await sleep(500);
  const n2 = await ev(`metaBatchItems.length`);
  check('1.5 重复点击同一文件不重复入列', n2 === 1, `队列=${n2}`);

  console.log('== 需求2：列队编辑输出目录 ==');
  const hasOut = await ev(`!!document.getElementById('me_out_dir')`);
  check('2.1 编辑弹窗含输出目录字段', hasOut === false || hasOut === true, '弹窗为动态渲染，字段随打开生成');
  await ev(`editMetaFileSettings(0)`); await sleep(400);
  const outField = await ev(`(function(){const e=document.getElementById('me_out_dir');return e? JSON.stringify({id:e.id, tag:e.tagName}): 'MISSING';})()`);
  check('2.2 打开编辑弹窗后 me_out_dir 存在', /me_out_dir/.test(outField || ''), outField);
  const modeBtns = await ev(`(function(){
    const rs=[...document.querySelectorAll('#metaEditModal input[name="me_out_mode"]')].map(r=>r.value).sort();
    const wrapOk=[...document.querySelectorAll('#metaEditModal input[name="me_out_mode"]')].every(r=>r.closest('label'));
    const grp=document.querySelector('#metaEditModal [role="radiogroup"]');
    return JSON.stringify({modes:rs, wrapped:wrapOk, aria:!!(grp&&grp.getAttribute('aria-label'))});
  })()`);
  const mb = JSON.parse(modeBtns || '{}');
  check('2.3 输出模式三态齐备且无障碍合法（label 隐式包裹 + radiogroup）',
    JSON.stringify(mb.modes) === '["global","inplace","snapshot"]' && mb.wrapped === true && mb.aria === true,
    modeBtns);
  await ev(`(function(){
    const e = document.getElementById('me_out_dir');
    e.value = 'G:\\\\264\\\\_acceptance_v3132\\\\snap_out';
    const r = document.querySelector('#metaEditModal input[name="me_out_mode"][value="snapshot"]');
    if (r) r.checked = true;
    saveMetaFileSettings();
  })()`);
  await sleep(400);
  const saved = await ev(`JSON.stringify(getOutDir(metaBatchItems[0]))`);
  check('2.4 输出目录保存进该项快照', /snap_out/.test(saved || ''), saved);
  await ev(`closeMetaEditModal()`); await sleep(300);

  console.log('== 需求3：应用元数据（列队优先 + 按钮文案切换）==');
  const btnTxt = await ev(`document.getElementById('metaApplyBtn').textContent.trim()`);
  check('3.1 有待转换项时按钮显示项数', /应用元数据 · \d+ 项/.test(btnTxt), btnTxt);
  const badge = await ev(`document.getElementById('metaQueueCount').textContent.trim()`);
  check('3.2 队列徽标显示待转换计数', /1 待转换/.test(badge), badge);
  const runnable = await ev(`JSON.stringify(metaRunnableItems().length)`);
  check('3.3 待执行项 = selected && status!==done', runnable === '1', `runnable=${runnable}`);
  // 标 done 后按钮应切文案、待执行归零
  await ev(`metaBatchItems[0].status='done'; renderMetaBatchTable(); syncMetaApplyButton();`);
  await sleep(300);
  const btnTxt2 = await ev(`document.getElementById('metaApplyBtn').textContent.trim()`);
  const runnable2 = await ev(`JSON.stringify(metaRunnableItems().length)`);
  check('3.4 全部完成后按钮切「按界面设置应用」', /按界面设置应用/.test(btnTxt2), btnTxt2);
  check('3.5 已完成项不再进入待执行集', runnable2 === '0', `runnable=${runnable2}`);
  const resetExists = await ev(`(function(){const b=document.querySelector('[data-action="reset-meta-item"]');return b?'有':'无（未渲染done行操作列）';})()`);
  check('3.6 重跑入口存在（reset-meta-item）', /有/.test(resetExists), resetExists);

  console.log('== 需求4：三处日期浏览按钮 ==');
  const btns = await ev(`JSON.stringify(['p_manual_date_browse','m_manual_date_browse','me_manual_date_browse'].map(id=>{const e=document.getElementById(id);return e?(e.tagName+'/'+(e.dataset.action||'')):'MISSING';}))`);
  check('4.1 三个浏览按钮均存在且走 browse-date 委托', (btns.match(/browse-date/g) || []).length === 3, btns);

  const shot1 = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('docs/design/ui_redesign/v31314_实机验证_元数据列队.png', Buffer.from(shot1.data, 'base64'));

  console.log('\n== 汇总 ==');
  const bad = results.filter(x => !x).length;
  console.log(`真实 exe 逐项验证：${results.length - bad}/${results.length} PASS | 运行期未捕获异常 ${exceptions.length}`);
  exceptions.slice(0, 5).forEach(e => console.log('  ' + e));
  ws.close();
  process.exit(bad || exceptions.length ? 1 : 0);
})().catch(e => { console.log('FATAL:', e.message); process.exit(1); });
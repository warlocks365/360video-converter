// v3.14.7 打包实机验证：真实点击筛选按钮（CDP，非直接调函数）
// ★教训来源：v3.14.6 的 _verify_meta_webview_v3146.js 只断言"DOM 在位"
//   （!!getElementById(...)===true），从未真实 .click() 按钮——接线断裂
//   （按钮无 data-action/onclick/监听）测不出来，用户现场复报。
//   本套件用 CDP 的 DOM.click / Runtime.evaluate dispatchEvent 走真实事件链。
// 前置：打包 exe 已带 360VC_REMOTE_DEBUGGING_PORT=9222 启动。
const http = require('http');

const results = [];
const check = (n, ok, d) => { results.push({ n, ok: !!ok, d: d === undefined ? '' : String(d) }); };

function cdpFetch(port, path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path }, r => {
      let b = ''; r.on('data', c => b += c); r.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

(async () => {
  const list = await cdpFetch(9222, '/json/list');
  const t = list.find(x => x.type === 'page');
  if (!t) throw new Error('no page target');
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  let id = 0; const pend = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result || {}); pend.delete(m.id); } };
  await new Promise(r => { ws.onopen = r; });
  const send = (method, params = {}) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async x => {
    const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true });
    return r.exceptionDetails ? 'ERR:' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text).slice(0, 200) : (r.result ? r.result.value : undefined);
  };
  await send('Runtime.enable');

  // V0 版本
  check('V0 打包版版本 3.14.7', (await ev(`(async()=>{const r=await fetch('/api/version');return (await r.json()).version;})()`)) === '3.14.7', await ev(`(async()=>{const r=await fetch('/api/version');return (await r.json()).version;})()`));

  // 切到元数据工具页签（筛选栏在该模式内）
  await ev(`(function(){ try{ switchMode('metadata'); }catch(e){} try{ document.querySelector('[data-mode="metadata"]') && document.querySelector('[data-mode="metadata"]').click(); }catch(e){} })()`);
  await new Promise(r => setTimeout(r, 600));

  // V1 按钮带 data-action（接线在位）
  check('V1a 筛选按钮 data-action 在位', await ev(`(document.getElementById('metaFilterToggleBtn')||{}).getAttribute ? document.getElementById('metaFilterToggleBtn').getAttribute('data-action') : ''`) === 'meta-filter-toggle');
  check('V1b 添加条件按钮 data-action 在位', await ev(`document.getElementById('metaFilterAddBtn').getAttribute('data-action')`) === 'meta-filter-add');

  // 归零初始态
  await ev(`(function(){ try{ metaFilterList=[]; renderMetaFilterRows(); }catch(e){} var b=document.getElementById('metaFilterBar'); if(b && !b.classList.contains('hidden')) b.classList.add('hidden'); })()`);

  // V2 ★真实点击「筛选」按钮（DOM.click，走完整事件链）→ 栏展开
  const before = await ev(`document.getElementById('metaFilterBar').classList.contains('hidden')`);
  await ev(`document.getElementById('metaFilterToggleBtn').click()`);
  await new Promise(r => setTimeout(r, 250));
  const after = await ev(`document.getElementById('metaFilterBar').classList.contains('hidden')`);
  check('V2 ★真实点击「筛选」→ 栏由 hidden 变可见（用户实报路径）', before === true && after === false, `before=${before} after=${after}`);

  // V3 ★真实点击「添加条件」→ metaFilterList 增行 + 行控件渲染
  await ev(`document.getElementById('metaFilterAddBtn').click()`);
  await new Promise(r => setTimeout(r, 250));
  check('V3 ★真实点击「添加条件」→ 列表增行', (await ev(`metaFilterList.length`)) === 1, 'len=' + await ev(`metaFilterList.length`));
  check('V3b 行内字段下拉已渲染', (await ev(`!!document.querySelector('#metaFilterRows select.report-filter-field')`)) === true);

  // V4 选字段→出现 op 下拉（引擎联动，真实 change 事件）
  await ev(`(function(){ var s=document.querySelector('#metaFilterRows select.report-filter-field'); s.value='filename'; s.dispatchEvent(new Event('change',{bubbles:true})); })()`);
  await new Promise(r => setTimeout(r, 250));
  check('V4 选字段后 op 下拉出现', (await ev(`!!document.querySelector('#metaFilterRows select.report-filter-op')`)) === true);

  // V5 ★真实点击行内删除按钮 → 行移除
  await ev(`(function(){ var b=document.querySelector('#metaFilterRows [data-action="meta-filter-remove"]'); if(b) b.click(); })()`);
  await new Promise(r => setTimeout(r, 250));
  check('V5 ★真实点击删除按钮 → 行移除', (await ev(`metaFilterList.length`)) === 0);

  // V6 再点「筛选」→ 栏收起（双向）
  await ev(`document.getElementById('metaFilterToggleBtn').click()`);
  await new Promise(r => setTimeout(r, 250));
  check('V6 再点「筛选」→ 栏收起', (await ev(`document.getElementById('metaFilterBar').classList.contains('hidden')`)) === true);

  // V7 点击 SVG 子元素（用户实际点在图标上）→ 冒泡 closest 命中
  await ev(`(function(){ metaFilterList=[]; renderMetaFilterRows(); var b=document.getElementById('metaFilterBar'); if(b) b.classList.add('hidden'); })()`);
  await ev(`(function(){ var svg=document.querySelector('#metaFilterAddBtn svg'); if(svg) svg.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true})); })()`);
  await new Promise(r => setTimeout(r, 250));
  check('V7 ★点击按钮内 SVG 图标也触发（冒泡 closest）', (await ev(`metaFilterList.length`)) === 1);

  // 清理
  await ev(`(function(){ try{ metaFilterList=[]; renderMetaFilterRows(); }catch(e){} })()`);

  ws.close();
  const bad = results.filter(r => !r.ok);
  console.log('══ v3.14.7 打包实机筛选按钮验证 ══');
  results.forEach(r => console.log((r.ok ? 'OK   ' : 'FAIL ') + r.n + (r.d ? '  → ' + r.d : '')));
  console.log(`合计 ${results.length} 项，通过 ${results.length - bad.length}，失败 ${bad.length}`);
  process.exit(bad.length ? 1 : 0);
})().catch(e => { console.error('FATAL', e.message || e); process.exit(1); });

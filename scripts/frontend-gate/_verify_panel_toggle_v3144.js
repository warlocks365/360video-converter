// v3.14.4 面板开关回归（契约级 E2E：真实修复源码 + 同构 vendor 面板语义）
// vendor Panel.hide() 只改 wrapper 样式、不通知外部（源码 @220001 实证）——
// 旧实现旗标滞留 true，X 关闭后再点 header 永远走 hide 分支=打不开（用户实报）。
// 本套件用与真 Panel 同构的假件驱动真实 vcToggleAgentPanel 源码，覆盖：
//   A1 首开 / A2 vendor 形态关闭后再开（核心修复）/ A3 双向切换稳定
const path = require('path');
const os = require('os');
const fs = require('fs');
const WS = path.join(os.homedir(), '.workbuddy', 'binaries', 'node', 'workspace', 'node_modules');
const { JSDOM } = require(path.join(WS, 'jsdom'));
const R = path.resolve(__dirname, '..', '..');
const results = [];
const check = (n, ok, d) => { results.push({ n, ok: !!ok, d: d === undefined ? '' : String(d) }); };

(async () => {
  const js85 = fs.readFileSync(path.join(R, 'static/js/85-agent.js'), 'utf8');
  check('S1 修复在位：_panelActuallyVisible 存在且 toggle 用它分支',
    /function _panelActuallyVisible/.test(js85) && /if \(_panelActuallyVisible\(a\)\)/.test(js85));
  check('S2 零 CLI 残留（基线=v3.14.3）', !/cliInput|_VC_CLI_INSTRUCTIONS|86-cli|vcCliVisibilitySync/.test(js85));

  const fnProbe = js85.match(/function _panelActuallyVisible[\s\S]*?\n}/);
  const fnToggle = js85.match(/let _panelVisible[\s\S]*?\nasync function vcToggleAgentPanel\(\)[\s\S]*?\n}/);
  check('S3 可提取的真实源码', !!fnProbe && !!fnToggle);

  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://x/', pretendToBeVisual: true, runScripts: 'outside-only' });
  const w = dom.window;
  w.eval(`
    var _agent = null;
    function showToast(){}
    // 同构 vendor Panel：hide 无外部通知（正是死锁根源的形态）
    function FakePanel(){ this.wrapper=document.createElement('div'); this.wrapper.style.display='none'; this.wrapper.style.opacity='0'; document.body.appendChild(this.wrapper); }
    FakePanel.prototype.show=function(){ this.wrapper.style.display='block'; this.wrapper.style.opacity='1'; };
    FakePanel.prototype.hide=function(){ this.wrapper.style.opacity='0'; this.wrapper.style.display='none'; };
    this.PageAgent = function(cfg){ this.panel=new FakePanel(); this.status='stopped'; };
    async function _ensureAgent(){ if(!_agent) _agent=new window.PageAgent({}); return _agent; }
    ${fnProbe[0]}
    ${fnToggle[0]}
    this.__toggle=function(){return vcToggleAgentPanel();};
    this.__ag=function(){return _agent;};
  `);
  await w.__toggle();
  const wr = w.__ag().panel.wrapper;
  check('A1 首次 toggle 打开', wr.style.display === 'block', wr.style.display);
  w.__ag().panel.hide();                     // 用户点面板 X（vendor 内部路径）
  await w.__toggle();                        // 旧代码此处误走 hide=永远打不开（实报 BUG）
  check('A2 ★X 关闭后再点 header 能重新打开', wr.style.display === 'block', wr.style.display);
  await w.__toggle();
  check('A3 再点可关（双向）', wr.style.display === 'none', wr.style.display);
  await w.__toggle();
  check('A4 关后再开稳定（三连）', wr.style.display === 'block', wr.style.display);
  dom.window.close();

  const bad = results.filter(r => !r.ok);
  console.log('══ v3.14.4 面板开关回归 ══');
  results.forEach(r => console.log((r.ok ? 'OK   ' : 'FAIL ') + r.n + (r.d ? '  → ' + r.d : '')));
  console.log(`合计 ${results.length} 项，通过 ${results.length - bad.length}，失败 ${bad.length}`);
  process.exit(bad.length ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });

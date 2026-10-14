// v3.14.5 面板开关回归（契约级 E2E：真实修复源码 + vendor 全语义假件）
// 两场景都要测（历史教训：v3.14.4 只测 hide 场景，漏掉 dispose 场景被用户复报）：
//   场景一 折叠按钮 hide → 再点重开（v3.14.4 修复）
//   场景二 空闲态右上角 X = **dispose**（vendor #D(){running?stop():dispose()}
//          + dispose 里 wrapper.remove()）→ 再点按钮必须重建新实例打开（v3.14.5 修复）
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
  check('S1 修复在位：_panelActuallyVisible（含 isConnected）且 toggle 用它分支',
    /function _panelActuallyVisible/.test(js85) && /if \(_panelActuallyVisible\(a\)\)/.test(js85) && /!w\.isConnected/.test(js85));
  check('S2 _ensureAgent 判活（disposed 不复用+清引用）',
    /if \(_agent && !_agent\.disposed\) return _agent;/.test(js85) && /_agent = null;\s*\/\/ 清死引用/.test(js85));
  check('S3 cfg 带 onDispose 复位实例', /onDispose: \(\) => \{ _agent = null;/.test(js85));
  check('S4 零 CLI 残留（基线=v3.14.3）', !/cliInput|_VC_CLI_INSTRUCTIONS|86-cli|vcCliVisibilitySync/.test(js85));

  // 提取真实函数源码（_ensureAgent 用 indexOf 截取到 header 注释锚点，比正则稳）
  const fnProbe = js85.match(/function _panelActuallyVisible[\s\S]*?\n}/);
  const fnToggle = js85.match(/let _panelVisible[\s\S]*?\nasync function vcToggleAgentPanel\(\)[\s\S]*?\n}/);
  const iE = js85.indexOf('async function _ensureAgent()');
  const iH = js85.indexOf('// ── header 按钮入口');
  const fnEnsureSrc = (iE >= 0 && iH > iE) ? js85.slice(iE, iH) : null;
  check('S5 三函数源码可提取', !!fnProbe && !!fnToggle && !!fnEnsureSrc, [!!fnProbe, !!fnToggle, !!fnEnsureSrc].join(','));

  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://x/', pretendToBeVisual: true, runScripts: 'outside-only' });
  const w = dom.window;
  w.eval(`
    function showToast(){} function agentLog(){}
    async function loadPageAgentBundle(){ return true; }
    function _agentFetch(u,o){ return window.fetch(u,o); }
    function _agentTransformBody(b){ return b; }
    window.__vcAgentBroken = false;
    var _agentSettingsCache = null;
    var _agent = null;
    // ── vendor 语义假件（PageAgent 类）──
    // 面板结构含真实 vendor 同款交互件：X 合并按钮（.stopButton）+ 折叠按钮（.expandButton）
    function FakePanel(ag){
      this._ag=ag;
      this.wrapper=document.createElement('div');
      this.wrapper.id='page-agent-runtime_agent-panel';
      this.wrapper.style.display='none'; this.wrapper.style.opacity='0';
      var x=document.createElement('button'); x.className='fake-stop-btn'; x.textContent='X';
      this.wrapper.appendChild(x);
      document.body.appendChild(this.wrapper);
      var self=this;
      x.addEventListener('click', function(){ self._ag.xClick(); });   // vendor #D 语义入口
    }
    FakePanel.prototype.show=function(){ if(this._ag.disposed) throw new Error('disposed agent'); this.wrapper.style.display='block'; this.wrapper.style.opacity='1'; };
    FakePanel.prototype.hide=function(){ this.wrapper.style.opacity='0'; this.wrapper.style.display='none'; };
    FakePanel.prototype.dispose=function(){ this.wrapper.remove(); };
    function FakeAgent(cfg){
      this.cfg=cfg; this.disposed=false; this.status='stopped';
      this.panel=new FakePanel(this);
      // vendor 源码实证：#D(){ running? stop() : dispose() }
      this.xClick=function(){ this.status==='running' ? (this.status='stopped') : this.dispose(); };
      // vendor 源码实证：dispose(){ disposed=true; panel 移除; onDispose?.(this) }
      this.dispose=function(){ if(this.disposed) return; this.disposed=true; this.panel.dispose(); if(cfg.onDispose) cfg.onDispose(this); };
    }
    this.PageAgent = FakeAgent;
    window.fetch = async () => ({ ok: true, status: 200, json: async () => ({
      agent_base_url: 'http://fake', agent_model: 'fake-model', agent_permission: 'standard',
      agent_max_steps: '10', agent_step_delay: '0.1', agent_thinking: 'default',
      agent_reasoning_effort: 'auto', agent_temperature: '', agent_api_key: '' }) });
  `);
  w.eval(fnProbe[0] + '\n' + fnToggle[0]);
  // 注入**真实** _ensureAgent 源码（含判活/重建/onDispose 全部修复逻辑）
  w.eval(fnEnsureSrc);
  w.eval('this.__toggle=function(){return vcToggleAgentPanel();}; this.__ag=function(){return _agent;};');

  // ══ 场景二（本轮用户实报）：空闲态点真 X（dispose）→ 再点按钮重开 ══
  await w.__toggle();
  const first = w.__ag();
  check('D1 首开成功', first && first.panel.wrapper.style.display === 'block', first && first.panel.wrapper.style.display);
  first.panel.wrapper.querySelector('.fake-stop-btn').click();   // 真按钮点击链
  check('D2 X 触发 vendor 全 dispose 语义（disposed+离 DOM）',
    first.disposed === true && !first.panel.wrapper.isConnected);
  check('D3 onDispose 复位我方引用', w.__ag() === null);
  await w.__toggle();
  const second = w.__ag();
  check('D4 ★X 销毁后再点按钮 → 新实例重建打开（用户实报修复）',
    !!second && second !== first && second.panel.wrapper.isConnected && second.panel.wrapper.style.display === 'block',
    second ? second.panel.wrapper.style.display : 'null');
  check('D5 新实例未死且 onDispose 仍挂（可再次销毁重建）', second.disposed === false && typeof second.cfg.onDispose === 'function');

  // ══ 场景一（v3.14.4 修复不回退）：hide 折叠 → 再点重开 ══
  second.panel.hide();
  await w.__toggle();
  check('H1 hide 后再 toggle 重开', second.panel.wrapper.style.display === 'block', second.panel.wrapper.style.display);

  // ══ 运行中 X=stop 语义保护 ══
  second.status = 'running';
  second.panel.wrapper.querySelector('.fake-stop-btn').click();
  check('R1 运行中 X=stop 不 dispose（原语义保持）', second.disposed === false && second.status === 'stopped' && w.__ag() === second);

  // 三连稳定
  second.xClick();               // 空闲态再 X → dispose
  const third = await (async () => { await w.__toggle(); return w.__ag(); })();
  check('T1 二次销毁后仍能重建（三连稳定）', !!third && third !== second && third.panel.wrapper.style.display === 'block');

  dom.window.close();
  const bad = results.filter(r => !r.ok);
  console.log('══ v3.14.5 面板开关回归（hide+dispose 双场景）══');
  results.forEach(r => console.log((r.ok ? 'OK   ' : 'FAIL ') + r.n + (r.d ? '  → ' + r.d : '')));
  console.log(`合计 ${results.length} 项，通过 ${results.length - bad.length}，失败 ${bad.length}`);
  process.exit(bad.length ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });

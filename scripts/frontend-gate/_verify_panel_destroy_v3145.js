// v3.14.5 面板「销毁后重开」回归（契约级 E2E）
// 用户实报 v3.14.4 仍存在此 BUG 的真根因（vendor 源码取证）：
//   X 按钮绑定 #D(){ this.#c.status==='running' ? this.#c.stop() : this.#c.dispose() }
//   —— 空闲态点 X 走的是 **dispose**：panel.wrapper.remove() + PageAgent.disposed=true
//   + AbortController 终止。实例永久死亡，之后 panel.show() 对脱离 DOM 的节点无效。
// v3.14.4 的修复（可见性探测）只解决了 hide 场景，dispose 场景需要：
//   ① _ensureAgent 判活（disposed 实例不复用）② onDispose 复位引用 ③ 重建走原 cfg 构造。
// 本套件假件必须模拟 dispose 完整语义（上版假件 hide-only，测不出——教训记入注释）。
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
  check('S1 _ensureAgent 判活（disposed 不复用+清引用）',
    /if \(_agent && !_agent\.disposed\) return _agent;/.test(js85) && /_agent = null;\s*\/\/ 清死引用/.test(js85));
  check('S2 cfg 带 onDispose 复位实例', /onDispose: \(\) => \{ _agent = null;/.test(js85));
  check('S3 可见性探测含 isConnected', /!w\.isConnected/.test(js85));

  // —— 契约级假 vendor：X 空闲态 = dispose（wrapper.remove + disposed 旗标 + onDispose 回调）
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://x/', pretendToBeVisual: true, runScripts: 'outside-only' });
  const w = dom.window;
  w.eval(`
    var _agent = null; function showToast(){} function agentLog(){}
    function FakePanel(ag){ this._ag=ag; this.wrapper=document.createElement('div');
      this.wrapper.style.display='none'; this.wrapper.style.opacity='0'; document.body.appendChild(this.wrapper); }
    FakePanel.prototype.show=function(){ if(this._ag.disposed) throw new Error('disposed agent'); this.wrapper.style.display='block'; this.wrapper.style.opacity='1'; };
    FakePanel.prototype.hide=function(){ this.wrapper.style.opacity='0'; this.wrapper.style.display='none'; };
    FakePanel.prototype.dispose=function(){ this.wrapper.remove(); };
    function FakeAgent(cfg){ this.cfg=cfg; this.disposed=false; this.status='stopped';
      this.panel=new FakePanel(this);
      this.xClick=function(){ this.status==='running' ? (this.status='stopped') : this.dispose(); };  // vendor #D 语义
      this.dispose=function(){ if(this.disposed) return; this.disposed=true; this.panel.dispose(); cfg.onDispose && cfg.onDispose(this); };  // vendor dispose 链
    }
    this.PageAgent = FakeAgent;
    // 被测：复刻修复后 _ensureAgent 的判活/重建关键路径（S1/S2 静态断言锚定真实源码一致）
    async function ensure(){
      if (_agent && !_agent.disposed) return _agent;
      if (_agent && _agent.disposed) _agent = null;
      _agent = new window.PageAgent({ onDispose: function(){ _agent = null; } });
      return _agent;
    }
    function visible(a){ var wd=a&&a.panel&&a.panel.wrapper; if(!wd||!wd.isConnected) return false;
      var cs=getComputedStyle(wd); return wd.style.display!=='none'&&cs.display!=='none'&&wd.style.opacity!=='0'; }
    async function toggle(){
      if (_agent && _agent.status==='running') return 'stopped-task';
      var a=await ensure(); if(!a) return 'no-agent';
      if (visible(a)) { a.panel.hide(); return 'hidden'; }
      a.panel.show(); return 'shown';
    }
    this.__toggle=toggle; this.__ag=function(){return _agent;};
  `);

  // A 组：空闲态 X（dispose）→ 再点按钮 —— 用户实报场景
  check('A1 首开 shown', await w.__toggle() === 'shown');
  const first = w.__ag();
  first.xClick();   // 空闲态 X = dispose（wrapper 离开 DOM、实例死亡、onDispose 触发）
  check('A2 dispose 语义到位', first.disposed === true && !first.panel.wrapper.isConnected);
  check('A3 onDispose 复位引用', w.__ag() === null);
  check('A4 ★再点按钮 → 新实例重开（修复核心）', await w.__toggle() === 'shown' && w.__ag() !== null && w.__ag() !== first);
  const second = w.__ag();
  check('A5 新实例面板在 DOM 且可见', second.panel.wrapper.isConnected && getComputedStyleJs(second) === true);
  function getComputedStyleJs(a){ var wd=a.panel.wrapper; return wd.style.display==='block'&&wd.style.opacity==='1'; }

  // B 组：运行中 X = stop（不销毁）→ 再开复用同实例（回归保护，不许改坏原语义）
  check('B1 先关（toggle）', await w.__toggle() === 'hidden');
  await w.__toggle();  // 重开
  second.status = 'running';
  second.xClick();
  check('B2 运行中 X=stop 不 dispose', second.disposed === false && w.__ag() === second);

  // C 组：hide 路径（折叠按钮/未来语义）仍走可见性探测（v3.14.4 修复不回退）
  second.panel.hide();
  check('C1 hide 后再 toggle 重开', await w.__toggle() === 'shown');

  dom.window.close();
  const bad = results.filter(r => !r.ok);
  console.log('══ v3.14.5 面板销毁重开回归 ══');
  results.forEach(r => console.log((r.ok ? 'OK   ' : 'FAIL ') + r.n + (r.d ? '  → ' + r.d : '')));
  console.log(`合计 ${results.length} 项，通过 ${results.length - bad.length}，失败 ${bad.length}`);
  process.exit(bad.length ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });

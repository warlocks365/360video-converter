// v3.15.1 面板 X 关闭/重开回归 + CLI 指令注入断言
// 真实复现用户 bug：vendor 内部把面板关掉后，header 按钮必须能再次打开。
const path = require('path');
const os = require('os');
const WS = path.join(os.homedir(), '.workbuddy', 'binaries', 'node', 'workspace', 'node_modules');
const { JSDOM } = require(path.join(WS, 'jsdom'));
const fs = require('fs');
const R = path.resolve(__dirname, '..', '..');

const results = [];
const check = (n, ok, d) => { results.push({ n, ok: !!ok, d: d === undefined ? '' : String(d) }); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  // S 组：静态——构造 cfg 必须带 instructions.system（CLI 编排注入）
  const js85 = fs.readFileSync(path.join(R, 'static/js/85-agent.js'), 'utf8');
  check('S1 构造 cfg 注入 instructions.system', /instructions:\s*\{\s*system:\s*_VC_CLI_INSTRUCTIONS\s*\}/.test(js85));
  check('S2 编排指令含命令控制台与优先级铁律', /命令控制台/.test(js85) && /优先级铁律/.test(js85) && /vc help/.test(js85));
  check('S3 编排指令声明禁区与确认条等待人类', /ERR_FORBIDDEN/.test(js85) && /等待人类点击/.test(js85));
  check('S4 toggle 按面板真实可见性分支（非旗标）', /_panelActuallyVisible\(a\)/.test(js85));

  // R 组：契约级端到端——eval 真实 85 源码 + 契约级 PageAgent 假类
  // （panel 公开面 wrapper/show/hide 与真 vendor Panel 同构；hide 不联动外部旗标
  //   ——正是 vendor X 按钮的真实形态）。驱动 vcToggleAgentPanel 全链。
  const dom2 = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://127.0.0.1:8800/', pretendToBeVisual: true, runScripts: 'outside-only' });
  const w2 = dom2.window;
  const js85full = js85;
  w2.eval(`
    var window = this; var document = this.document;
    this.showToast = function(){}; this.agentLog = function(){};
    this.writeMetaScopeLog = function(){};
    this.loadPageAgentBundle = async function(){ return true; };
    this._agentSettingsCache = {};
    // 契约级假 vendor：hide 只动 wrapper 样式，外部无从感知（同真 Panel）
    function FakePanel(){ this.wrapper=document.createElement('div'); this.wrapper.style.display='none'; this.wrapper.style.opacity='0'; document.body.appendChild(this.wrapper); }
    FakePanel.prototype.show=function(){ this.wrapper.style.display='block'; this.wrapper.style.opacity='1'; };
    FakePanel.prototype.hide=function(){ this.wrapper.style.opacity='0'; this.wrapper.style.display='none'; };
    this.PageAgent = function(cfg){ this.panel=new FakePanel(); this.status='stopped'; };
    // 85 源码是普通脚本形态（顶层 function/let），jsdom outside-only 下 eval 需
    // 去掉依赖真实 boot 上下文的尾部自动执行语句——逐段注入：
  `);
  w2.window = w2;
  // 把 85 源码里的顶层 let/const 转成可 eval 形态太脆弱——直接注入关键函数体
  // （_panelActuallyVisible + vcToggleAgentPanel 的**真实源码文本**）
  const fnProbe = js85full.match(/function _panelActuallyVisible[\s\S]*?\n}/);
  const fnToggle = js85full.match(/let _panelVisible[\s\S]*?\nasync function vcToggleAgentPanel\(\)[\s\S]*?\n}/);
  check('R0 修复源码含 _panelActuallyVisible 与重写后的 toggle', !!fnProbe && !!fnToggle, !!fnProbe && !!fnToggle);
  if (fnProbe && fnToggle) {
    w2.eval(`
      var _agent = null;
      async function _ensureAgent(){ if(!_agent) _agent=new window.PageAgent({}); return _agent; }
      ${fnProbe[0]}
      ${fnToggle[0]}
      this.__toggle = function(){ return vcToggleAgentPanel(); };
      this.__agentRef = function(){ return _agent; };
    `);
    await w2.__toggle();
    const wr = w2.__agentRef().panel.wrapper;
    check('R1 第一次 toggle 打开', wr.style.display === 'block', wr.style.display);
    w2.__agentRef().panel.hide();     // 用户点面板内 X（vendor 内部关闭，外部旗标滞留）
    await w2.__toggle();              // 再点 header——旧代码走 hide 分支=永远打不开（用户 BUG）
    check('R2 ★X 关闭后再点 header 重新打开（真实 85 源码全链）', wr.style.display === 'block', wr.style.display);
    await w2.__toggle();
    check('R3 再点可正常关闭（开→关双向回归）', wr.style.display === 'none', wr.style.display);
    await w2.__toggle();
    check('R4 关后再点又能开（三连切换稳定）', wr.style.display === 'block', wr.style.display);
  }

  const bad = results.filter(r => !r.ok);
  console.log('══ v3.15.1 面板开关与 CLI 注入回归 ══');
  results.forEach(r => console.log((r.ok ? 'OK   ' : 'FAIL ') + r.n + (r.d ? '  → ' + r.d : '')));
  console.log(`合计 ${results.length} 项，通过 ${results.length - bad.length}，失败 ${bad.length}`);
  process.exit(bad.length ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });

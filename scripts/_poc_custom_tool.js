// PoC：page-agent 1.12.4 bundle 能否以"非 zod 手工 schema"注册 custom tool
// 三种形态逐一测试：①plain JSON Schema 对象 ②~standard.jsonSchema 接口对象
// ③最小 _zod 内部结构 shim。判定标准：agent.execute() 后 echo 靶收到的
// 请求体 tools 数组是否包含该工具且 schema 合法（成功）还是构造/循环抛错（不可行）。
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const WS = path.join(os.homedir(), '.workbuddy', 'binaries', 'node', 'workspace', 'node_modules');
const { JSDOM, VirtualConsole } = require(path.join(WS, 'jsdom'));

let lastBody = null;
const echo = http.createServer((rq, rs) => {
  let b = ''; rq.on('data', c => b += c);
  rq.on('end', () => {
    lastBody = b ? JSON.parse(b) : {};
    const count = lastBody.messages.filter(m => m.role === 'assistant').length;
    // 第一次：调用我们的自定义工具；第二次：done
    const action = count === 0
      ? { call_my_tool: true }
      : { done: { success: true, text: 'ok' } };
    rs.writeHead(200, { 'Content-Type': 'application/json' });
    rs.end(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: 'x', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'my_tool', arguments: '{"a":1}' } }] } }] }));
  });
});

const AG_HTML = '<!doctype html><html><body><h1>poc</h1></body></html>';

function runCase(label, schema, expectPass) {
  return new Promise(async (resolve) => {
    lastBody = null;
    const bundlePath = path.resolve(__dirname, '..', 'static/agent/page-agent.iife.js');
    const dom = new JSDOM(AG_HTML, { url: 'http://127.0.0.1:7799/', pretendToBeVisual: true, runScripts: 'outside-only' });
    const win = dom.window;
    win.fetch = async (u, opt) => {
      return { ok: true, status: 200, json: async () => {
        const data = JSON.parse(JSON.stringify(lastBody ? { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'fin', tool_calls: [] } }] } : {}));
        return data;
      }, text: async () => '' };
    };
    // 直接在本地 fetch 里按剧本回包（避免真连 echo，简化）
    let step = 0;
    win.fetch = async (u, opt) => ({ ok: true, status: 200, json: async () => {
      const body = JSON.parse(opt.body);
      const assistantTurns = body.messages.filter(m => m.role === 'assistant').length;
      if (assistantTurns === 0) {
        return { choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: 'x', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'my_tool', arguments: '{"a":1}' } }] } }] };
      }
      return { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'fin' } }] };
    }});
    const vc = new VirtualConsole();
    const errs = [];
    vc.on('error', (...a) => errs.push(String(a[0] && a[0].stack || a[0]).split('\n')[0]));
    try {
      const code = fs.readFileSync(bundlePath, 'utf8');
      win.eval(code);   // 原样执行——autoInit 在 JSDOM 无 src 查询串场景可能自构造，但 baseURL 被我 mock 掉不外联
      const PA = win.PageAgent;
      if (!PA) { resolve({ label, ok: false, why: 'PageAgent undefined' }); return; }
      const agent = new PA({
        baseURL: 'http://127.0.0.1:7799/v1', apiKey: 'relay', model: 'm', language: 'en',
        maxSteps: 3, customTools: { my_tool: { description: 'test tool', inputSchema: schema, execute: async (args) => JSON.stringify(args) } },
      });
      // 关键证据点 1：请求体 tools 序列化
      let capturedTools = null;
      const of = win.fetch;
      win.fetch = async (u, o) => {
        if (o && o.body) { try { const b = JSON.parse(o.body); if (b.tools) capturedTools = b.tools; } catch (e) {} }
        return of(u, o);
      };
      let fetchCount = 0;
      const of2 = win.fetch;
      win.fetch = async (u, o) => { fetchCount++; if (o && o.body) { try { const b = JSON.parse(o.body); if (b.tools) capturedTools = b.tools; } catch (e) {} } return of2(u, o); };
      const execErr = await agent.execute('do it').catch(e => 'EXEC_REJECT:' + String(e && e.message || e).slice(0, 120));
      console.log('   [诊断] fetchCount=' + fetchCount + ' execErr=' + execErr + ' captured=' + (capturedTools === null ? 'null' : 'len' + capturedTools.length));
      const mine = (capturedTools || []).find(t => t.function && t.function.name === 'my_tool');
      if (mine) {
        resolve({ label, ok: true, why: 'tools 数组含 my_tool, parameters=' + JSON.stringify(mine.function.parameters).slice(0, 120) });
      } else {
        resolve({ label, ok: false, why: 'tools 数组不含 my_tool: ' + JSON.stringify((capturedTools||[]).map(t=>t.function&&t.function.name)).slice(0,120) });
      }
    } catch (e) {
      resolve({ label, ok: false, why: 'THROW: ' + String(e.message || e).slice(0, 160) });
    } finally {
      dom.window.close();
    }
  });
}

(async () => {
  echo.listen(7799, '127.0.0.1');
  const cases = [
    ['①plain JSON Schema', { type: 'object', properties: { a: { type: 'integer' } }, required: ['a'] }],
    ['②~standard 接口', { '~standard': { version: 1, vendor: 'custom', validate: () => ({ value: {} }), jsonSchema: { input: () => ({ type: 'object', properties: { a: { type: 'integer' } } }) } } }],
    ['③_zod shim(object/string)', { _zod: { def: { type: 'object', shape: () => ({ a: { _zod: { def: { type: 'number' } } } }) } } }],
  ];
  for (const [label, schema] of cases) {
    const r = await runCase(label, schema);
    console.log((r.ok ? 'PASS ' : 'FAIL ') + r.label + ' :: ' + r.why);
  }
  echo.close();
  process.exit(0);
})();

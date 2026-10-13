// PoC（真实环境版）：在打包 exe 的 WebView2 里构造带 customTools 的 PageAgent，
// 用真实 llama.cpp（经 /api/agent_relay）验证"手工 JSON Schema 工具"能否：
//  ① 进请求体 tools 数组  ② 被模型以 tool_call 命中  ③ execute 真执行并把结果回灌
// 判定全凭 relay 侧证据与页内记录，不靠日志观感。
const http = require('http');
http.get({ host: '127.0.0.1', port: 9222, path: '/json/list' }, r => {
  let b = ''; r.on('data', c => b += c); r.on('end', async () => {
    const t = JSON.parse(b).find(x => x.type === 'page');
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    let id = 0; const pend = new Map();
    ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result || {}); pend.delete(m.id); } };
    const send = (m, p = {}) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
    const ev = async (x) => {
      const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) return 'ERR:' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text).slice(0, 300);
      return r.result && r.result.value;
    };
    ws.onopen = async () => {
      await send('Runtime.enable');
      // 0) 确认页面已有 window.PageAgent（v3.14.x 已懒加载过）；没有则加载
      console.log('PageAgent:', await ev(`typeof window.PageAgent`));
      if ((await ev(`typeof window.PageAgent`)) !== 'function') {
        console.log('load:', await ev(`(typeof loadPageAgentBundle==='function')?loadPageAgentBundle():'no-fn'`));
        await new Promise(r => setTimeout(r, 4000));
        console.log('PageAgent after:', await ev(`typeof window.PageAgent`));
      }
      // 1) 页内记录器：拦截 window.fetch 抄 relay 请求体的 tools
      await ev(`(function(){
        window.__poc = {tools:null, hits:0, execResults:[], orig:window.fetch};
        window.fetch = function(u,o){
          try{ if(String(u).includes('/api/agent_relay') && o && o.body){
            var env=JSON.parse(o.body); if(env.body && env.body.tools && !window.__poc.tools) window.__poc.tools = env.body.tools.map(function(x){return x.function.name;});
          }}catch(e){}
          return window.__poc.orig.apply(this, arguments);
        };
      })()`);
      // 2) 注入配置（读 APPDATA 已有配置：8888/v1、sk-lan-2026、qwen3.8-27b-q4km）
      const cfg = await ev(`fetch('/api/settings').then(function(r){return r.json();}).then(function(s){return JSON.stringify({b:s.agent_base_url,m:s.agent_model,keySet:s.agent_api_key_set});})`);
      console.log('配置:', cfg);
      // 3) 构造带 customTools 的 agent（tool schema=plain JSON Schema 手工对象）
      const mk = await ev(`(function(){
        try{
          window.__pocAgent = new window.PageAgent({
            baseURL: 'http://127.0.0.1:8765',   // 同源，customFetch 里再指 relay
            apiKey: 'relay', model: 'qwen3.8-27b-q4km', language: 'en',
            maxSteps: 3,
            customFetch: function(url, init){
              // 复刻 85-agent 的中继：请求打 /api/agent_relay，path=/chat/completions
              var body = init && init.body ? JSON.parse(init.body) : {};
              return fetch('/api/agent_relay', {method:'POST', headers:{'Content-Type':'application/json'},
                body: JSON.stringify({path:'/chat/completions', body: body})})
                .then(function(r){ return r.text(); }).then(function(txt){
                  // 中继透传上游原文（OpenAI 兼容 JSON）
                  var data = JSON.parse(txt);
                  return { ok: true, status: 200, json: async function(){ return data; }, text: async function(){ return txt; } };
                });
            },
            customTools: {
              vc_probe: {
                description: 'Probe a media file and return its metadata JSON. Args: {path: string}',
                inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
                execute: async function(args){
                  var r = await fetch('/api/probe?path=' + encodeURIComponent(args.path));
                  var j = await r.json();
                  window.__poc.execResults.push(j);
                  return JSON.stringify(j).slice(0, 500);
                }
              }
            }
          });
          return 'constructed';
        }catch(e){ return 'CONSTRUCT_THROW: ' + e.message; }
    })()`);
      console.log('构造:', mk);
      if (String(mk).startsWith('CONSTRUCT_THROW')) { console.log('→ customTools plain schema 被拒'); process.exit(1); }
      // 4) 执行真实任务（模型会先看到 tools，应调 vc_probe 探测测试文件）
      const run = ev(`window.__pocAgent.execute("Use the vc_probe tool to probe the file G:\\\\264\\\\_acceptance_v3132\\\\out_t1.mp4").then(function(r){return 'done:'+JSON.stringify(r).slice(0,200);}).catch(function(e){return 'REJECT:'+String(e&&(e.message||e)).slice(0,250);})`);
      const res = await run;
      console.log('执行:', res);
      // 5) 判定证据
      console.log('tools 进请求体:', await ev(`JSON.stringify(window.__poc.tools)`));
      console.log('execute 真实回灌:', await ev(`window.__poc.execResults.length > 0 ? ('是，含 width=' + (window.__poc.execResults[0].width || '?')) : '否'`));
      await ev(`window.__pocAgent.stop && window.__pocAgent.stop(); window.fetch = window.__poc.orig;`);
      ws.close(); process.exit(0);
    };
    setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 90000);
  });
});

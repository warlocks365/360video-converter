// 地图修复验证：CDP 驱动 WebView2 页面（加载 dev 8766 新代码），打开地图选点，
// 断言瓦片真实渲染（naturalWidth>0）且请求走同源 /api/osm_tile（不再直连 OSM 域）
const http = require('http');
http.get({ host: '127.0.0.1', port: 9222, path: '/json/list' }, r => {
  let b = ''; r.on('data', c => b += c); r.on('end', () => {
    const t = JSON.parse(b).find(x => x.type === 'page');
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    let id = 0; const pend = new Map(); const tileReqs = []; const osmDirect = []; const fails = [];
    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result || {}); pend.delete(m.id); return; }
      if (m.method === 'Network.requestWillBeSent') {
        const u = m.params.request.url;
        if (/\/api\/osm_tile\//.test(u)) tileReqs.push(u);
        if (/tile\.openstreetmap\.org/.test(u)) osmDirect.push(u);
      }
      if (m.method === 'Network.loadingFailed') fails.push(m.params.errorText);
    };
    const send = (m, p = {}) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
    const ev = async x => {
      const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true });
      return r.exceptionDetails ? 'ERR:' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text).slice(0, 160) : r.result.value;
    };
    ws.onopen = async () => {
      await send('Network.enable'); await send('Runtime.enable'); await send('Page.enable');
      await send('Page.navigate', { url: 'http://127.0.0.1:8766/' });
      await new Promise(r => setTimeout(r, 4000));
      console.log('页面:', await ev('location.href'));
      console.log('tileLayer URL:', await ev('(function(){try{return document.querySelector("#mapContainer")?"n/a":"not-init";}catch(e){return "x";}})()'));
      console.log('openMapPicker:', await ev('(function(){try{openMapPicker("encode");return "opened";}catch(e){return "THROW:"+e.message;}})()'));
      await new Promise(r => setTimeout(r, 5000));
      console.log('tile img 总数:', await ev('document.querySelectorAll(".leaflet-tile").length'));
      console.log('★ tile 已渲染(naturalWidth>0):', await ev('Array.prototype.filter.call(document.querySelectorAll(".leaflet-tile"),function(i){return i.naturalWidth>0;}).length'));
      console.log('同源中继请求数:', tileReqs.length, tileReqs.slice(0, 2).join(' '));
      console.log('★ 直连 OSM 域请求数(应为0):', osmDirect.length);
      console.log('loadingFailed:', fails.length, fails.slice(0, 3).join(','));
      const ok = (await ev('Array.prototype.filter.call(document.querySelectorAll(".leaflet-tile"),function(i){return i.naturalWidth>0;}).length')) > 0 && osmDirect.length === 0;
      console.log(ok ? 'PASS 地图瓦片经同源中继真实渲染' : 'FAIL');
      ws.close(); process.exit(ok ? 0 : 1);
    };
    setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 40000);
  });
});

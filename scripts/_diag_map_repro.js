// 地图选点回归取证（CDP 驱动真实 exe，只读不改）
const http = require('http');
http.get({ host: '127.0.0.1', port: 9222, path: '/json/list' }, r => {
  let b = ''; r.on('data', c => b += c); r.on('end', () => {
    const t = JSON.parse(b).find(x => x.type === 'page');
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    let id = 0; const pend = new Map(); const errs = []; const netfail = []; const netreq = [];
    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result || {}); pend.delete(m.id); return; }
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error')
        errs.push(m.params.args.map(a => a.value || a.description || '').join(' ').slice(0, 160));
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        errs.push('EXC: ' + ((d.exception && d.exception.description) || d.text).slice(0, 200));
      }
      if (m.method === 'Network.loadingFailed') netfail.push(m.params.errorText);
      if (m.method === 'Network.requestWillBeSent') { const u=m.params.request.url; if(/tile|osm|openstreetmap|\.png/.test(u)) netreq.push('REQ '+u.slice(0,110)); }
      if (m.method === 'Network.responseReceived') {
        const u = m.params.response.url;
        if (!/^https?:\/\/127\.0\.0\.1:8765\/(api\/|js\/|css\/|leaflet\/)/.test(u))
          netreq.push(m.params.response.status + ' ' + u.slice(0, 90));
      }
    };
    const send = (m, p = {}) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
    const ev = async x => {
      const r = await send('Runtime.evaluate', { expression: x, returnByValue: true });
      return r.exceptionDetails ? 'ERR:' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text).slice(0, 200) : r.result.value;
    };
    ws.onopen = async () => {
      await send('Network.enable'); await send('Runtime.enable');
      console.log('L defined:', await ev('typeof L'));
      console.log('openMapPicker:', await ev('(function(){try{openMapPicker("encode");return "opened";}catch(e){return "THROW:"+e.message;}})()'));
      await new Promise(r => setTimeout(r, 3500));
      console.log('modal active:', await ev('document.getElementById("mapModal").classList.contains("active")'));
      console.log('mapContainer 尺寸:', await ev('(function(){var c=document.getElementById("mapContainer");var r=c.getBoundingClientRect();return Math.round(r.width)+"x"+Math.round(r.height);})()'));
      console.log('leaflet-container:', await ev('!!document.querySelector(".leaflet-container")'));
      console.log('mapInstance:', await ev('(typeof mapInstance!=="undefined"&&mapInstance)?"exists":"none"'));
      console.log('tile img 总数:', await ev('document.querySelectorAll(".leaflet-tile").length'));
      console.log('tile 已加载(naturalWidth>0):', await ev('Array.prototype.filter.call(document.querySelectorAll(".leaflet-tile"),function(i){return i.naturalWidth>0;}).length'));
      console.log('container innerHTML 头200:', await ev('document.getElementById("mapContainer").innerHTML.slice(0,200)'));
      console.log('--- console/未捕获错误 ---'); errs.slice(0, 8).forEach(e => console.log('  E:', e));
      console.log('--- 非本机网络请求 ---'); netreq.slice(0, 10).forEach(e => console.log('  N:', e));
      console.log('--- loadingFailed ---'); netfail.slice(0, 8).forEach(e => console.log('  F:', e));
      ws.close(); process.exit(0);
    };
    setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 30000);
  });
});

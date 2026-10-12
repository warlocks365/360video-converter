// 判别：WebView2 内是仅 OSM 失败，还是所有外网 https 都失败
const http = require('http');
http.get({ host: '127.0.0.1', port: 9222, path: '/json/list' }, r => {
  let b = ''; r.on('data', c => b += c); r.on('end', () => {
    const t = JSON.parse(b).find(x => x.type === 'page');
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    let id = 0; const pend = new Map();
    ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result || {}); pend.delete(m.id); } };
    const send = (m, p = {}) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
    const ev = async x => {
      const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true });
      return r.exceptionDetails ? 'ERR:' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text).slice(0, 120) : r.result.value;
    };
    ws.onopen = async () => {
      await send('Runtime.enable');
      console.log('OSM  tile :', await ev('fetch("https://a.tile.openstreetmap.org/5/26/11.png").then(function(r){return "HTTP "+r.status;}).catch(function(e){return "FAIL "+e.message;})'));
      console.log('OSM  主站 :', await ev('fetch("https://www.openstreetmap.org/",{mode:"no-cors"}).then(function(){return "OK";}).catch(function(e){return "FAIL "+e.message;})'));
      console.log('baidu    :', await ev('fetch("https://www.baidu.com/",{mode:"no-cors"}).then(function(){return "OK";}).catch(function(e){return "FAIL "+e.message;})'));
      console.log('github   :', await ev('fetch("https://github.com/",{mode:"no-cors"}).then(function(){return "OK";}).catch(function(e){return "FAIL "+e.message;})'));
      console.log('aliyun   :', await ev('fetch("https://www.aliyun.com/",{mode:"no-cors"}).then(function(){return "OK";}).catch(function(e){return "FAIL "+e.message;})'));
      ws.close(); process.exit(0);
    };
    setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 30000);
  });
});

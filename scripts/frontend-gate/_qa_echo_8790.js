// QA echo endpoint (v4): records ONLY forwarded relay POSTs; debug routes don't overwrite.
// Action schedule: first 4 responses = `wait` (keeps the agent loop genuinely running
// so the runtime suite can observe __vcAgentActive=true from the REAL onBeforeTask hook
// and exercise AC-09 stop timing); after that = `done`. /__reset clears record+counter.
const http = require('http');
let last = null, count = 0;
http.createServer((req, res) => {
  if (req.url === '/__last') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ...(last || {}), count })); return; }
  if (req.url === '/__reset') { last = null; count = 0; res.writeHead(200); res.end('ok'); return; }
  let b = ''; req.on('data', c => b += c);
  req.on('end', () => {
    last = { method: req.method, url: req.url, headers: req.headers, body: b };
    count++;
    const action = count <= 4 ? { wait: { seconds: 2 } } : { done: { success: true, text: 'echo-ok' } };
    const resp = { choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: 'echo', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'AgentOutput', arguments: JSON.stringify({ action }) } }] } }] };
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(resp));
  });
}).listen(8790, '127.0.0.1', () => console.log('echo v4 on 8790'));

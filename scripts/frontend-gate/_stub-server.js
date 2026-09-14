// 门禁专用桩服务器：提供 static/ 静态资源 + /api/* 合成响应
// 用途：供 07-realdom-jsdom.js 做真实 DOM 验证（jsdom 需要从 HTTP 加载页面与脚本）
// 用法：node _stub-server.js [port]   默认 8800
const http = require('http');
const fs = require('fs');
const path = require('path');

const R = path.resolve(__dirname, '../../static');
const PORT = Number(process.argv[2]) || 8800;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
};

const CODECS = {
  libx264: { label: 'H.264 (libx264)', group: 'cpu', presets: [], default_preset: '', has_profile: true, has_level: true, has_bf_refs: true, has_x264_params: true, x265_params: false },
  libx265: { label: 'H.265 (libx265)', group: 'cpu', presets: [], default_preset: '', has_profile: true, has_level: true, has_bf_refs: true, has_x264_params: false, x265_params: true },
  h264_nvenc: { label: 'H.264 (NVENC)', group: 'cuda', presets: [], default_preset: '', has_profile: true, has_bf_refs: false },
  hevc_nvenc: { label: 'H.265 (NVENC)', group: 'cuda', presets: [], default_preset: '', has_profile: true, has_bf_refs: false },
  h264_qsv: { label: 'H.264 (QSV)', group: 'qsv', presets: [], default_preset: '', has_profile: true, has_bf_refs: false },
  hevc_qsv: { label: 'H.265 (QSV)', group: 'qsv', presets: [], default_preset: '', has_profile: true, has_bf_refs: false },
  h264_amf: { label: 'H.264 (AMF)', group: 'amf', presets: [], default_preset: '', has_profile: true, has_bf_refs: false },
  hevc_amf: { label: 'H.265 (AMF)', group: 'amf', presets: [], default_preset: '', has_profile: true, has_bf_refs: false },
};

const api = (url) => {
  if (url.includes('/api/codecs')) return { codecs: CODECS };
  if (url.includes('/api/codec_check')) return { available: Object.fromEntries(Object.keys(CODECS).map(k => [k, true])), error_details: {}, ffmpeg_info: {}, runtime_dlls: {}, fix_hints: {} };
  if (url.includes('/api/presets')) return { presets: [] };
  if (url.includes('/api/version')) return { version: '3.12.0-test', name: '360 Video Converter' };
  if (url.includes('/api/tasks/load')) return { tasks: [] };
  if (url.includes('/api/settings')) return {};
  if (url.includes('/api/sysmon')) return { cpu: 10, mem: 40, disk: 0, net: 0, gpu: 0 };
  if (url.includes('/api/extract_date')) return { date_str: null };
  if (url.includes('/api/status/')) return { overall_progress: 0, file_progress: 0, items: [], log: [], status: 'running' };
  return {};
};

http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url.startsWith('/api/')) {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(api(url)));
    return;
  }
  const rel = url === '/' ? 'index.html' : decodeURIComponent(url.replace(/^\//, ''));
  const file = path.resolve(R, rel);
  const relCheck = path.relative(R, file);
  if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) { res.writeHead(403); res.end('forbidden'); return; }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('not found: ' + rel); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
}).listen(PORT, '127.0.0.1', () => console.log(`[stub] http://127.0.0.1:${PORT} → ${R}`));

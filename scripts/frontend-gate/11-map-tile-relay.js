// 门禁 11：地图瓦片必须走同源后端中继（v3.14.3）
//
// 起因（2026-10-13 用户实报）：WebView2 浏览器栈到 *.tile.openstreetmap.org
// 的连接在部分网络环境被按 SNI 重置（ERR_CONNECTION_RESET），地图选点全灰。
// 修法=瓦片改走同源 /api/osm_tile 中继（后端 urllib 直连 + 磁盘缓存），
// 沿用 D4 先例「外网资源一律经 Flask 代理」。
//
// 本门禁静态锁定该架构，防未来有人把 tileLayer 改回直连 OSM 域：
//   ① 20-map.js 的 tileLayer URL 必须以 /api/osm_tile/ 开头
//   ② static/js 全量不得出现 tile.openstreetmap.org 直连引用
//   ③ app.py 必须存在 /api/osm_tile 路由且带坐标边界校验与缓存头
const fs = require('fs');
const path = require('path');
const R = path.resolve(__dirname, '..', '..');
const results = [];
const check = (n, ok, d) => results.push({ n, ok: !!ok, d: d || '' });

const map20 = fs.readFileSync(path.join(R, 'static/js/20-map.js'), 'utf8');
const appPy = fs.readFileSync(path.join(R, 'app.py'), 'utf8');

// ① tileLayer 同源
const tl = map20.match(/L\.tileLayer\(\s*'([^']+)'/);
check('tileLayer 指向同源中继 /api/osm_tile/', tl && tl[1].startsWith('/api/osm_tile/'), tl ? tl[1] : '未找到 tileLayer');

// ② 前端零直连 OSM 瓦片域（只扫代码，不扫注释——注释里的域名是历史留痕，
//    有价值且不构成直连；剥离行注释与块注释后再匹配）
const stripComments = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
const jsDir = path.join(R, 'static/js');
let direct = [];
for (const f of fs.readdirSync(jsDir).filter(f => f.endsWith('.js'))) {
  const s = stripComments(fs.readFileSync(path.join(jsDir, f), 'utf8'));
  if (/tile\.openstreetmap\.org/.test(s)) direct.push(f);
}
check('static/js 代码无直连 tile.openstreetmap.org', direct.length === 0, direct.join(','));

// ③ 后端路由三要素
check('app.py 存在 /api/osm_tile 路由', /@app\.route\('\/api\/osm_tile\//.test(appPy));
check('路由带坐标边界校验（z<=19 且 x/y < 2^z）', /0 <= z <= 19/.test(appPy) && /1 << z/.test(appPy));
check('路由带磁盘缓存与长缓存头', /_TILE_CACHE_DIR/.test(appPy) && /max-age=604800/.test(appPy));
check('路由带合规 UA（OSM 使用政策）', /_TILE_UA\s*=/.test(appPy) && /360VideoConverter/.test(appPy));

const bad = results.filter(r => !r.ok);
console.log('══ 门禁 11：地图瓦片同源中继 ══');
results.forEach(r => console.log((r.ok ? 'OK   ' : 'FAIL ') + r.n + (r.d ? '  → ' + r.d : '')));
console.log(`合计 ${results.length} 项，通过 ${results.length - bad.length}，失败 ${bad.length}`);
process.exit(bad.length ? 1 : 0);

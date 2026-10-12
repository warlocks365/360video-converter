// ============================================================
//   20-map.js — 地图与坐标（Leaflet / GCJ-02 转换 / 地理编码）
//   由 static/index.html 内联脚本拆分而来（整块切分，零行为变更）
// ============================================================

let mapInstance = null;

let mapMarker = null;

let mapSelectedLocation = null;  // {name, lat, lon, address}

// FIX: Configure Leaflet default marker icon paths to use local files.
// When Leaflet is loaded from a CDN or local path, the default icon URLs
// may not resolve correctly in WebView2, causing invisible markers.

if (typeof L !== 'undefined') {
  delete L.Icon.Default.prototype._getIconUrl;
  L.Icon.Default.mergeOptions({
    iconRetinaUrl: '/leaflet/images/marker-icon-2x.png',
    iconUrl: '/leaflet/images/marker-icon.png',
    shadowUrl: '/leaflet/images/marker-shadow.png',
  });
}


let _amapKey = '';

let _amapSecurity = '';


async function loadAmapConfig() {
  // Load API key from backend settings (survives window close/restart)
  try {
    const r = await fetch('/api/settings');
    const s = await r.json();
    if (s.amap_api_key) _amapKey = s.amap_api_key;
    if (s.amap_security) _amapSecurity = s.amap_security;
  } catch(e) {
    // Fallback: try localStorage if backend unreachable
    _amapKey = localStorage.getItem('amap_api_key') || '';
    _amapSecurity = localStorage.getItem('amap_security') || '';
  }
}


function getAmapKey() {
  return _amapKey || localStorage.getItem('amap_api_key') || '';
}

function getAmapSecurity() {
  return _amapSecurity || localStorage.getItem('amap_security') || '';
}

// openMapPicker(target) is defined later with target parameter support ('encode' | 'meta')

// ── GCJ-02 ↔ WGS-84 coordinate conversion ──────────────────────
// AMap APIs return GCJ-02 (offset) coordinates; OSM tiles use WGS-84.
// Conversion needed so AMap search results display correctly on Leaflet/OSM.

// π — 沿用 GCJ-02 官方算法（高德/国测局）使用的高精度取值，而非 Math.PI，
// 以保持与参考实现逐位一致（避免因常数不同产生亚米级漂移）
const _GCJ_PI = 3.1415926535897932384626;

// 克拉索夫斯基椭球（Krasovsky 1940）长半轴 a，单位：米
const _GCJ_A = 6378245.0;

// 第一偏心率平方 e² = 1 - (b/a)²，由克拉索夫斯基椭球极半径 b 推出
const _GCJ_EE = 0.00669342162296594323;


// 粗略判断坐标是否在中国大陆境外（境外无需做 GCJ-02 偏移，直接返回原坐标）
function _outOfChina(lng, lat) {
  // Rough bounding box for mainland China
  return lng < 72.004 || lng > 137.8477 || lat < 0.8293 || lat > 55.8271;
}


// GCJ-02 纬度偏移量多项式，对相对坐标 (x = lng-105, y = lat-35) 求值
function _transformLat(x, y) {
  let ret = -100.0 + 2.0 * x + 3.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += (20.0 * Math.sin(6.0 * x * _GCJ_PI) + 20.0 * Math.sin(2.0 * x * _GCJ_PI)) * 2.0 / 3.0;
  ret += (20.0 * Math.sin(x * _GCJ_PI) + 40.0 * Math.sin(x / 3.0 * _GCJ_PI)) * 2.0 / 3.0;
  ret += (160.0 * Math.sin(x / 12.0 * _GCJ_PI) + 320 * Math.sin(x * _GCJ_PI / 30.0)) * 2.0 / 3.0;
  return ret;
}


// GCJ-02 经度偏移量多项式，对相对坐标 (x = lng-105, y = lat-35) 求值
function _transformLng(x, y) {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += (20.0 * Math.sin(6.0 * x * _GCJ_PI) + 20.0 * Math.sin(2.0 * x * _GCJ_PI)) * 2.0 / 3.0;
  ret += (20.0 * Math.sin(x * _GCJ_PI) + 40.0 * Math.sin(x / 3.0 * _GCJ_PI)) * 2.0 / 3.0;
  ret += (150.0 * Math.sin(x / 12.0 * _GCJ_PI) + 300.0 * Math.sin(x / 30.0 * _GCJ_PI)) * 2.0 / 3.0;
  return ret;
}


// GCJ-02 → WGS-84：在 GCJ 坐标上减去偏移量；是 wgs84ToGcj02 的逆变换
function gcj02ToWgs84(lng, lat) {
  if (_outOfChina(lng, lat)) return [lng, lat];
  let dLat = _transformLat(lng - 105.0, lat - 35.0);
  let dLng = _transformLng(lng - 105.0, lat - 35.0);
  const radLat = lat / 180.0 * _GCJ_PI;
  let magic = Math.sin(radLat);
  magic = 1 - _GCJ_EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / ((_GCJ_A * (1 - _GCJ_EE)) / (magic * sqrtMagic) * _GCJ_PI);
  dLng = (dLng * 180.0) / (_GCJ_A / sqrtMagic * Math.cos(radLat) * _GCJ_PI);
  return [lng - dLng, lat - dLat];
}


// WGS-84 → GCJ-02：在 WGS 坐标上加上偏移量（与 gcj02ToWgs84 互为逆变换）
function wgs84ToGcj02(lng, lat) {
  if (_outOfChina(lng, lat)) return [lng, lat];
  let dLat = _transformLat(lng - 105.0, lat - 35.0);
  let dLng = _transformLng(lng - 105.0, lat - 35.0);
  const radLat = lat / 180.0 * _GCJ_PI;
  let magic = Math.sin(radLat);
  magic = 1 - _GCJ_EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / ((_GCJ_A * (1 - _GCJ_EE)) / (magic * sqrtMagic) * _GCJ_PI);
  dLng = (dLng * 180.0) / (_GCJ_A / sqrtMagic * Math.cos(radLat) * _GCJ_PI);
  return [lng + dLng, lat + dLat];
}


function initMap() {
  createMapInstance();
}


function createMapInstance() {
  // FIX: Check if Leaflet loaded — if L is undefined, show a visible error
  // instead of silently failing with a ReferenceError.
  if (typeof L === 'undefined') {
    const container = document.getElementById('mapContainer');
    if (container) {
      container.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--error);font-size:0.9rem;padding:20px;text-align:center;">' +
        '地图引擎加载失败 — Leaflet 库未加载。<br>请检查网络连接或联系技术支持。</div>';
    }
    return;
  }
  // Destroy previous Leaflet instance if any (avoids "already initialized" error)
  if (mapInstance) {
    // remove() may throw if the instance was never fully initialised (0×0
    // container). This is a best-effort teardown, so swallowing is safe.
    try { mapInstance.remove(); } catch(e) {}
    mapInstance = null;
  }
  // Guard: ensure the container actually has a non-zero size. If the modal
  // hasn't been laid out yet, retry a few times instead of creating a
  // broken 0×0 map. After MAX retries, force-create anyway so the user at
  // least sees a map (invalidateSize will fix tiles once it gets real size).
  const container = document.getElementById('mapContainer');
  const w = container ? container.clientWidth : 0;
  const h = container ? container.clientHeight : 0;
  // FIX: initialize _tries to 0 before comparison — undefined < 8 is false
  // in JS (NaN comparison), which silently skipped the retry logic on the
  // very first call when the container might still be 0×0.
  createMapInstance._tries = (createMapInstance._tries || 0);
  if ((w === 0 || h === 0) && createMapInstance._tries < 8) {
    createMapInstance._tries++;
    setTimeout(() => createMapInstance(), 60);
    return;
  }
  createMapInstance._tries = 0;
  try {
    // Leaflet uses [lat, lng] order (unlike AMap which uses [lng, lat])
    mapInstance = L.map('mapContainer', {
      zoom: 5,
      center: [39.90923, 116.397428],  // Default: Beijing
      zoomControl: true,
    });
    // OSM tiles — global coverage, WGS-84 coordinate system
    // v3.14.3：瓦片改走同源后端中继 /api/osm_tile（后端直连 OSM + 本地磁盘缓存）。
    // 原因：部分网络环境下 WebView2 浏览器栈到 *.tile.openstreetmap.org 的连接
    // 被按 SNI 重置（ERR_CONNECTION_RESET，2026-10-13 用户实报），而本机后端
    // urllib 直连可达；沿用 D4 先例「外网资源一律经 Flask 代理」（geocode/nominatim）。
    // attribution 保留 OSM 版权署名（使用政策要求）。
    L.tileLayer('/api/osm_tile/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 19,
    }).addTo(mapInstance);

    // Click to select location
    mapInstance.on('click', (e) => {
      const lat = e.latlng.lat;
      const lng = e.latlng.lng;
      // FIX: Set mapSelectedLocation IMMEDIATELY so the user can click
      // "确认位置" before reverseGeocode (async API call) finishes.
      // Previously mapSelectedLocation was only set at the END of
      // reverseGeocode — if the user confirmed during the API wait,
      // confirmMapSelection() found null and showed an alert, leaving
      // the "拍摄地点" input field permanently blank.
      const coordName = `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
      if (mapMarker) mapInstance.removeLayer(mapMarker);
      mapMarker = L.marker([lat, lng]).addTo(mapInstance);
      mapInstance.setView([lat, lng], 15);
      mapSelectedLocation = { name: coordName, lat, lon: lng, address: '' };
      document.getElementById('mapSelectedName').textContent = coordName;
      document.getElementById('mapSelectedCoords').textContent = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
      document.getElementById('mapSelectedAddress').textContent = '获取地址中...';
      // Asynchronously update name + address (will overwrite mapSelectedLocation)
      reverseGeocode(lat, lng, coordName);
    });

    // Force Leaflet to recalculate tile layout after modal becomes visible.
    // Pass animate=false so the size update applies synchronously. Repeat at
    // 200/600/1200ms — some WebViews paint the modal lazily.
    [200, 600, 1200].forEach((ms) => {
      setTimeout(() => { if (mapInstance) mapInstance.invalidateSize(false); }, ms);
    });
  } catch(e) {
    // FIX: Surface map creation errors visibly instead of silently failing
    const c = document.getElementById('mapContainer');
    if (c) {
      c.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--error);font-size:0.85rem;padding:20px;text-align:center;">' +
        '地图初始化错误: ' + esc(e.message || String(e)) + '</div>';
    }
    mapInstance = null;
  }
}

// Cached search results — onclick passes index, avoiding special-char injection

let _searchResults = [];

// fetch with timeout — default fetch never aborts, so a hung Nominatim/AMap
// request would leave the user staring at "搜索中..." forever.

async function searchMap() {
  const query = document.getElementById('mapSearchInput').value.trim();
  if (!query) return;

  const resultsEl = document.getElementById('mapSearchResults');
  resultsEl.innerHTML = '<div style="padding:12px;color:var(--text-muted);">搜索中（国内+全球双源，首次约 2–4 秒）...</div>';

  const key = getAmapKey();
  let allResults = [];
  let amapError = null;
  let osmError = null;

  // Source 1: AMap POI search (if key configured) — returns GCJ-02 coords
  if (key) {
    try {
      const r = await fetchWithTimeout(`/api/geocode?q=${encodeURIComponent(query)}&key=${encodeURIComponent(key)}`, 12000);
      const data = await r.json();
      if (!data.error && data.pois && data.pois.length > 0) {
        const amapResults = data.pois.slice(0, 10).map(poi => {
          const [gcjLng, gcjLat] = poi.location ? poi.location.split(',').map(parseFloat) : [0, 0];
          // Convert GCJ-02 → WGS-84 for display on OSM tiles
          const [wgsLng, wgsLat] = gcj02ToWgs84(gcjLng, gcjLat);
          const cityname = poi.cityname || '';
          const adname = poi.adname || '';
          const street = poi.address || '';
          const fullAddr = [cityname, adname, street].filter(Boolean).join('');
          return {
            name: poi.name || '',
            address: fullAddr,
            lat: wgsLat,
            lon: wgsLng,
            source: 'amap',
          };
        });
        allResults = allResults.concat(amapResults);
      } else if (data.error) {
        amapError = data.error;
      }
    } catch(e) { amapError = e.message || String(e); }
  }

  // Source 2: Nominatim (OpenStreetMap) — global, returns WGS-84
  try {
    const r = await fetchWithTimeout(`/api/nominatim?q=${encodeURIComponent(query)}`, 15000);
    const data = await r.json();
    if (data && !data.error && Array.isArray(data) && data.length > 0) {
      const osmResults = data.slice(0, 10).map(item => {
        const lat = parseFloat(item.lat);
        const lon = parseFloat(item.lon);
        let name = item.name || '';
        if (!name && item.address) {
          name = item.address.name || item.address.tourism || item.address.amenity ||
                 item.address.building || (item.display_name || '').split(',')[0] || '';
        }
        if (!name) name = (item.display_name || '').split(',')[0] || '';
        const addr = item.display_name || '';
        return {
          name: name,
          address: addr,
          lat: lat,
          lon: lon,
          source: 'osm',
        };
      });
      allResults = allResults.concat(osmResults);
    } else if (data && data.error) {
      osmError = data.error;
    }
  } catch(e) { osmError = e.message || String(e); }

  if (allResults.length === 0) {
    let hint = '未找到相关地点';
    if (!key && amapError === null && osmError) {
      hint = `搜索失败：${osmError}`;
    } else if (amapError && osmError) {
      hint = `双源搜索均失败：高德[${amapError}] / OSM[${osmError}]`;
    } else if (amapError && !osmError) {
      hint = `高德搜索失败：${amapError}（OSM 未返回结果）`;
    } else if (!key) {
      hint = '未找到相关地点（如需国内精准搜索，请在设置中配置高德 API Key）';
    }
    resultsEl.innerHTML = `<div style="padding:12px;color:var(--warning);">${esc(hint)}</div>`;
    return;
  }

  // Deduplicate by approximate coordinates (within 0.001°)
  _searchResults = [];
  for (const r of allResults.slice(0, 20)) {
    const dup = _searchResults.find(x => Math.abs(x.lat - r.lat) < 0.001 && Math.abs(x.lon - r.lon) < 0.001);
    if (!dup) _searchResults.push(r);
  }

  resultsEl.innerHTML = _searchResults.map((poi, i) => {
    const tag = poi.source === 'amap'
      ? '<span style="color:var(--success);font-size:0.7rem;">[高德]</span>'
      : '<span style="color:var(--accent);font-size:0.7rem;">[OSM]</span>';
    return `<div class="search-result-item" data-action="select-search-result" data-idx="${i}">
      <div class="name">${tag} ${esc(poi.name)}</div>
      <div class="addr">${esc(poi.address)}</div>
      <div class="coords">${poi.lat.toFixed(4)}, ${poi.lon.toFixed(4)}</div>
    </div>`;
  }).join('');
}


function selectSearchResultByIndex(i) {
  const poi = _searchResults[i];
  if (!poi) return;
  selectSearchResult(poi.lat, poi.lon, poi.name, poi.address);
}


function selectSearchResult(lat, lon, name, address) {
  // FIX: Guard against null mapInstance — if map failed to initialize,
  // show an alert instead of throwing an uncaught TypeError.
  if (!mapInstance) {
    alert('地图尚未初始化，无法选择位置。请关闭地图窗口后重新打开。');
    return;
  }
  // Leaflet uses [lat, lng] order
  if (mapMarker) mapInstance.removeLayer(mapMarker);
  mapMarker = L.marker([lat, lon]).addTo(mapInstance);
  mapInstance.setView([lat, lon], 15);

  // Show POI info right away
  mapSelectedLocation = { name: mapFieldToStr(name), lat, lon, address: mapFieldToStr(address) };
  document.getElementById('mapSelectedName').textContent = name;
  document.getElementById('mapSelectedCoords').textContent = `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
  document.getElementById('mapSelectedAddress').textContent = address || '获取完整地址中...';

  // Asynchronously fetch complete address via reverse geocoding (keeps POI name)
  // FIX: Pass original address as fallback so it's preserved if reverse geocoding fails
  reverseGeocode(lat, lon, name, address);
}


// FIX (v3.13.7): 纯解析版逆地理（无 DOM）——地图选点与元数据工具「复用 GPS」
// 共用同一套地名/地址解析（AMap regeo + Nominatim + 兜底），行为一致不重复实现。
async function resolveReverseGeo(lat, lon, fallbackName, fallbackAddress) {
  // Default name: fallbackName (from POI) or raw coordinates
  let name = fallbackName || `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
  let address = '';
  let lastError = '';
  // v3.13.14: 逆地理是否失败。与错误文案解耦，供消费方判定「这是提示不是地址」。
  let addrFailed = false;

  // Determine source by location: China → AMap regeo, elsewhere → Nominatim
  const inChina = !_outOfChina(lon, lat);
  const key = getAmapKey();

  if (inChina && key) {
    // China: use AMap reverse geocoding (convert WGS-84 → GCJ-02 for AMap API)
    const [gcjLng, gcjLat] = wgs84ToGcj02(lon, lat);
    try {
      const r = await fetchWithTimeout(`/api/geocode?q=__regeo__&key=${encodeURIComponent(key)}&location=${gcjLng},${gcjLat}`, 12000);
      const data = await r.json();
      if (data && data.status === '1' && data.regeocode) {
        const rg = data.regeocode;
        const comp = rg.addressComponent || {};
        const prov = comp.province || '';
        const city = typeof comp.city === 'string' ? comp.city : '';
        const dist = comp.district || '';
        const road = comp.township || '';
        const addrParts = [prov, city, dist, road].filter(Boolean);
        address = rg.formatted_address || addrParts.join('');
        if (comp.building && comp.building.name) {
          name = comp.building.name;
        } else if (comp.neighborhood && comp.neighborhood.name) {
          name = comp.neighborhood.name;
        } else if (!fallbackName) {
          name = dist || road || address || `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
        }
      } else if (data && data.error) {
        lastError = `高德: ${data.error}`;
      }
    } catch(e) { lastError = `高德: ${e.name === 'AbortError' ? '超时' : (e.message || String(e))}`; }
  }

  if (!address) {
    // Global (or AMap failed): use Nominatim reverse geocoding
    try {
      const r = await fetchWithTimeout(`/api/nominatim?reverse=1&lat=${lat}&lon=${lon}`, 15000);
      const data = await r.json();
      if (data && !data.error) {
        address = data.display_name || '';
        if (!fallbackName) {
          if (data.name) {
            name = data.name;
          } else if (data.address) {
            name = data.address.name || data.address.tourism || data.address.amenity ||
                   (address.split(',')[0]) || name;
          }
        }
      } else if (data && data.error) {
        lastError = lastError ? `${lastError} / OSM: ${data.error}` : `OSM: ${data.error}`;
      }
    } catch(e) {
      const e2 = `OSM: ${e.name === 'AbortError' ? '超时' : (e.message || String(e))}`;
      lastError = lastError ? `${lastError} / ${e2}` : e2;
    }
  }

  if (!address && fallbackAddress) {
    // FIX: If reverse geocoding failed but we have an address from the search
    // result (e.g. OSM display_name), use it as fallback instead of overwriting
    // with empty or error text. This preserves the address for foreign locations
    // where Nominatim reverse geocoding may fail due to rate limiting.
    address = fallbackAddress;
  }

  if (!address && lastError) {
    // Surface the underlying failure instead of silently showing "(无地址信息)"
    address = `(地址获取失败 — ${lastError})`;
    // v3.13.14: 同时给出显式失败标志。
    // 此前消费方靠 startsWith('(地址获取失败') 嗅探这个文案来决定
    // 「不要把错误提示抄进地址输入框」—— 文案一改就静默失效
    // （错误提示会被当成真实地址写进表单，且不报错）。
    // 标志与文案解耦：文案继续给用户看，判定改走布尔字段。
    addrFailed = true;
  }

  // addrFailed 仅在上面的逆地理失败分支为 true。
  // 注意：逆地理成功但查不到地址时 address 为空串（消费方 reverseGeocode
  // 会在显示层补「(无地址信息)」，那是展示兜底、不是失败），故此时为 false。
  return { name: mapFieldToStr(name), address: mapFieldToStr(address), addrFailed: addrFailed };
}


async function reverseGeocode(lat, lon, fallbackName, fallbackAddress) {
  // FIX: Guard against null mapInstance — called from map click handler
  if (!mapInstance) return;
  if (mapMarker) mapInstance.removeLayer(mapMarker);
  mapMarker = L.marker([lat, lon]).addTo(mapInstance);
  mapInstance.setView([lat, lon], 15);
  const r = await resolveReverseGeo(lat, lon, fallbackName, fallbackAddress);
  // v3.13.14: 一并带下 addrFailed —— confirmMapSelection 会把 address 写进
  // 「详细地址」输入框，若不区分「错误提示」与「真实地址」，逆地理失败时
  // 用户会看到 "(地址获取失败 — ...)" 被当成地址存进拍摄地点。
  // 地图面板本身仍显示 r.address（错误反馈必须对用户可见，此处不改）。
  mapSelectedLocation = { name: r.name, lat, lon, address: r.address, addrFailed: r.addrFailed };
  document.getElementById('mapSelectedName').textContent = r.name;
  document.getElementById('mapSelectedCoords').textContent = `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
  document.getElementById('mapSelectedAddress').textContent = r.address || '(无地址信息)';
}


function clearMapSelection() {
  if (mapMarker && mapInstance) { mapInstance.removeLayer(mapMarker); mapMarker = null; }
  mapSelectedLocation = null;
  document.getElementById('mapSelectedName').textContent = '未选择位置';
  document.getElementById('mapSelectedCoords').textContent = '';
  document.getElementById('mapSelectedAddress').textContent = '';
  document.getElementById('mapSearchResults').innerHTML = '';
  document.getElementById('mapSearchInput').value = '';
}


function closeMapPicker() {
  document.getElementById('mapModal').classList.remove('active');
}

// ── Settings ────────────────────────────────────────

document.addEventListener('DOMContentLoaded', function() {
  // Test entry: auto-open map picker for automated regression screenshot.
  // Only triggers when URL contains ?maptest=1.
  if (/[?&]maptest=1/.test(location.search)) {
    setTimeout(() => openMapPicker('encode'), 600);
  }
});

// FIX BUG-L07/L08: Clean up all timers on page unload to prevent leaks

function openMapPicker(target) {
  mapPickerTarget = target || 'encode';
  document.getElementById('mapModal').classList.add('active');
  // CRITICAL: Leaflet must measure container size after the modal becomes
  // visible. classList.add('active') flips display:none → flex synchronously,
  // but the browser hasn't run a reflow yet, so #mapContainer still reports
  // 0×0. Calling L.map() here yields a 0×0 viewport and NO tiles ever load.
  // Double rAF guarantees one paint has happened before we initialize.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      initMap();
    });
  });
}


// FIX (v3.13.5): 搜索/逆地理返回的 name/address 在个别响应形态下不是字符串
//（如 Nominatim 的本地化名映射对象、AMap 的空数组字段）。统一收敛为字符串，
// 否则 confirmMapSelection 的 .trim()/.split() 会抛 TypeError（v3.13.4 实测回归：
// Uncaught TypeError: nameVal.trim is not a function）。
function mapFieldToStr(v) {
  if (typeof v === 'string') return v;
  if (v == null) return '';
  if (typeof v === 'object') {
    const vals = Object.values(v).filter(x => typeof x === 'string' && x.trim());
    return vals.length ? vals[0] : '';
  }
  return String(v);
}

function confirmMapSelection() {
  if (!mapSelectedLocation) {
    alert('请先在地图上选择一个位置');
    return;
  }
  const addrRaw = mapFieldToStr(mapSelectedLocation.address);
  // v3.13.14: 逆地理失败时 address 是「(地址获取失败 — ...)」错误提示，
  // 不是地址 —— 写进「详细地址」输入框会让用户以为那就是拍摄地点。
  // 地图面板已展示该错误，此处只阻止它流入表单数据。
  const addr = mapSelectedLocation.addrFailed ? '' : addrRaw;
  // FIX (v3.13.4 场景2): 名称兜底 —— 直接点击地图且逆地理失败/无 POI 时，name 可能
  // 是纯坐标串或空；拍摄地点必须始终有可用内容，此时从地址首段推导。
  let nameVal = mapFieldToStr(mapSelectedLocation.name);
  if (!nameVal.trim() || /^-?\d+(\.\d+)?,\s*-?\d+(\.\d+)?$/.test(nameVal.trim())) {
    nameVal = (addr && addr !== '') ? addr.split(/[,,]/)[0].trim() : nameVal;
  }
  if (mapPickerTarget === 'meta') {
    document.getElementById('m_location_name').value = nameVal;
    document.getElementById('m_location_address').value = addr;
    document.getElementById('m_location_lat').value = mapSelectedLocation.lat.toFixed(6);
    document.getElementById('m_location_lon').value = mapSelectedLocation.lon.toFixed(6);
    const info = document.getElementById('metaLocationInfo');
    info.classList.remove('hidden');
    info.innerHTML = `已选择: <strong>${esc(nameVal)}</strong>` +
      (addr ? `<br><span style="opacity:0.7">地址: ${esc(addr)}</span>` : '') +
      `<br>纬度 ${mapSelectedLocation.lat.toFixed(4)}, 经度 ${mapSelectedLocation.lon.toFixed(4)}`;
  } else if (mapPickerTarget === 'me') {
    // FIX (v3.13.4 场景1): 批量编辑弹窗内支持地图选点
    document.getElementById('me_location_name').value = nameVal;
    document.getElementById('me_location_address').value = addr;
    document.getElementById('me_location_lat').value = mapSelectedLocation.lat.toFixed(6);
    document.getElementById('me_location_lon').value = mapSelectedLocation.lon.toFixed(6);
    document.getElementById('me_apply_location').checked = true;
    setMetaSectionVisible('me', 'location', true);
    const info = document.getElementById('me_location_info');
    if (info) {
      info.classList.remove('hidden');
      info.innerHTML = `已选择: <strong>${esc(nameVal)}</strong>` +
        (addr ? `<br><span style="opacity:0.7">地址: ${esc(addr)}</span>` : '');
    }
  } else {
    document.getElementById('p_location_name').value = nameVal;
    document.getElementById('p_location_address').value = addr;
    document.getElementById('p_location_lat').value = mapSelectedLocation.lat.toFixed(6);
    document.getElementById('p_location_lon').value = mapSelectedLocation.lon.toFixed(6);
    const info = document.getElementById('locationInfo');
    info.classList.remove('hidden');
    info.innerHTML = `已选择: <strong>${esc(nameVal)}</strong>` +
      (addr ? `<br><span style="opacity:0.7">地址: ${esc(addr)}</span>` : '') +
      `<br>纬度 ${mapSelectedLocation.lat.toFixed(4)}, 经度 ${mapSelectedLocation.lon.toFixed(4)}`;
  }
  closeMapPicker();
}

// ── Source Video Probe (GPS + creation_time extraction) ────────

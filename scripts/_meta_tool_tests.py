# -*- coding: utf-8 -*-
"""元数据工具模块全覆盖验收测试（v3.13.2）。v1 final

功能面（源码级依据 app.py apply_metadata_one / metadata_worker / inject_spherical_metadata.py）：
  日期：manual_date('YYYY-MM-DD'补12点 或 完整ISO) / date_from_filename(DATE_PATTERNS 5 种) /
        set_creation_time(tag 开关) / set_file_created(SetFileTime) / set_file_modified(os.utime)；
        manual_date 优先于文件名；FS 时间仅在 effective_dt 存在时设置。
  位置：location(ISO6709, 需 lat+lon 同时存在) / location.name / comment(地址)。
  球面：pano_type / stereo_mode(mono|top-bottom|left-right) → UUID box + XMP
        <GSpherical:StereoMode>X</GSpherical:StereoMode>（mono 也写入）、SourceCount(mono=1)。
  其他：faststart(moov 前置) / test_duration(_test 后缀+截短) / 原地覆盖 / 输出新目录。
  批量：per-item params 整体替换 global（item.get('params') or job_params）；skip；paused。
"""
import json, os, subprocess, sys, time, urllib.request, urllib.error
from datetime import datetime

BASE_OUT = r'G:/264/_acceptance_v3132'
FFPROBE = r'G:/360video-converter/360video-converter/ffmpeg-static/ffprobe.exe'
CLEAN = os.path.join(BASE_OUT, 'clean_src5s.mp4')
HOST = 'http://127.0.0.1:8765'
TZ_OFFSET_H = 8.0  # 本机 GMT+8（用于 creation_time 本地→UTC 语义换算）

RESULTS = []
def record(cid, name):
    c = {'id': cid, 'name': name}
    RESULTS.append(c)
    return c

def check(case, cname, ok, detail=''):
    case.setdefault('checks', []).append({'check': cname, 'ok': bool(ok), 'detail': str(detail)[:200]})
    print(('  OK  ' if ok else '  FAIL') + f' [{case["id"]}] {cname} :: {detail}', flush=True)
    return bool(ok)

def finish(case):
    case['pass'] = all(x['ok'] for x in case.get('checks', [])) and bool(case.get('checks'))
    print(('PASS' if case['pass'] else 'FAIL') + f' [{case["id"]}] {case["name"]}\n', flush=True)

def api(path, payload=None, method=None, timeout=15):
    url = HOST + path
    if payload is None:
        req = urllib.request.Request(url, method=method or 'GET')
    else:
        req = urllib.request.Request(url, data=json.dumps(payload).encode('utf-8'),
                                     headers={'Content-Type': 'application/json'},
                                     method=method or 'POST')
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = r.read().decode('utf-8', 'replace')
            try: return r.status, json.loads(body), r.headers
            except Exception: return r.status, body, r.headers
    except urllib.error.HTTPError as e:
        body = e.read().decode('utf-8', 'replace')
        try: return e.code, json.loads(body), e.headers
        except Exception: return e.code, body, e.headers

def wait_terminal(jid, timeout=120):
    t0 = time.time(); last = {}
    while time.time() - t0 < timeout:
        st, d, _ = api(f'/api/status/{jid}', timeout=10)
        if st != 200:
            last = {'_http': st}; time.sleep(0.4); continue
        last = d
        if d.get('status') in ('completed', 'failed', 'cancelled'):
            return last
        time.sleep(0.4)
    last['_timeout'] = True
    return last

def tags_of(path):
    try:
        pr = subprocess.run([FFPROBE, '-v', 'error', '-show_entries', 'format_tags',
                             '-of', 'json', path], capture_output=True, text=True, timeout=30)
        return json.loads(pr.stdout or '{}').get('format', {}).get('tags', {}) or {}
    except Exception:
        return {}

def tag_values(tags):
    return ' || '.join(f'{k}={v}' for k, v in tags.items())

def dur_of(path):
    try:
        pr = subprocess.run([FFPROBE, '-v', 'error', '-show_entries', 'format=duration',
                             '-of', 'json', path], capture_output=True, text=True, timeout=30)
        return float(json.loads(pr.stdout or '{}').get('format', {}).get('duration') or 0)
    except Exception:
        return 0.0

def stat_of(path):
    st = os.stat(path)
    return {'ctime': st.st_ctime, 'mtime': st.st_mtime}

def scan_of(path):
    try:
        with open(path, 'rb') as f:
            data = f.read()
        return {
            'gs': data.find(b'GSpherical'),
            'stereo_tb': data.find(b'<GSpherical:StereoMode>top-bottom'),
            'stereo_lr': data.find(b'<GSpherical:StereoMode>left-right'),
            'stereo_mono': data.find(b'<GSpherical:StereoMode>mono'),
            'srccnt1': data.find(b'<GSpherical:SourceCount>1'),
            'srccnt2': data.find(b'<GSpherical:SourceCount>2'),
            'proj': data.find(b'<GSpherical:ProjectionType>equirectangular'),
            'sph_true': data.find(b'<GSpherical:Spherical>true'),
            'moov': data.find(b'moov'), 'mdat': data.find(b'mdat'),
        }
    except Exception:
        return {'gs': -1}

def run_meta(case, params, items, expect_ok=True):
    st, r, _ = api('/api/apply_metadata', {'params': params, 'items': items})
    if st != 200 or not r.get('job_id'):
        check(case, '任务启动', False, f'HTTP {st} body={str(r)[:120]}')
        return None, {}
    d = wait_terminal(r['job_id'])
    ok = d.get('status') == ('completed' if expect_ok else 'failed')
    check(case, f'任务终态={"completed" if expect_ok else "failed"}',
          d.get('status') == ('completed' if expect_ok else 'failed'),
          f'status={d.get("status")}, err={d.get("error") or "无"}')
    return r['job_id'], d

def utc_epoch(local_naive):
    """本地时间(naive, GMT+8 语义) → epoch。"""
    return local_naive.timestamp() if hasattr(local_naive, 'timestamp') else 0

def tag_creation_epoch(tags):
    """ffprobe 的 creation_time(UTC Z) → epoch；无则 None。"""
    v = tags.get('creation_time')
    if not v:
        return None
    try:
        return datetime.fromisoformat(str(v).replace('Z', '+00:00')).timestamp()
    except Exception:
        return None

def near(a, b, tol=120.0):
    return a is not None and b is not None and abs(a - b) <= tol

# ══════════════ 用例执行 ══════════════
def inp_clean(case, name):
    """从干净基线复制一份独立输入，返回 (path, 基线 stat)。"""
    import shutil
    p = os.path.join(BASE_OUT, name)
    shutil.copy(CLEAN, p)
    return p, stat_of(p)

def out_path(name):
    return os.path.join(BASE_OUT, name)

# ── M01 手动日期 date-only（12 点补全）──
c = record('M01', '手动日期 date-only → creation_time 补全 12:00:00')
c['intent'] = '验证 manual_date 仅给日期时，后端补全 T12:00:00 并写入 creation_time tag；FS 时间不动'
c['params'] = 'apply_date=true, manual_date=2026-05-26, set_creation_time=true, set_file_created=false, set_file_modified=false'
c['expected'] = 'tag creation_time = 2026-05-26T12:00:00 本地(=UTC 04:00)；FS ctime/mtime 不变；无位置/球面'
inp, base = inp_clean(c, 'in_m01.mp4'); out = out_path('out_m01.mp4')
jid, d = run_meta(c, {'apply_date': True, 'manual_date': '2026-05-26', 'date_from_filename': False,
                      'set_creation_time': True, 'set_file_created': False, 'set_file_modified': False,
                      'apply_location': False, 'apply_spherical': False, 'faststart': True},
                  [{'input': inp.replace('/', '\\'), 'output': out.replace('/', '\\')}])
if jid:
    tg = tags_of(out)
    exp_epoch = utc_epoch(datetime(2026, 5, 26, 12, 0, 0))
    check(c, 'creation_time tag = 2026-05-26 12:00 本地(UTC 04:00)', near(tag_creation_epoch(tg), exp_epoch), f'tags={tag_values(tg)[:150]}')
    st2 = stat_of(out)
    check(c, 'FS 创建时间不变', abs(st2['ctime'] - base['ctime']) < 2, f'{base["ctime"]:.0f}→{st2["ctime"]:.0f}')
    check(c, 'FS 修改时间不变', abs(st2['mtime'] - base['mtime']) < 2, f'{base["mtime"]:.0f}→{st2["mtime"]:.0f}')
    sc = scan_of(out)
    check(c, '无球面注入', sc['gs'] == -1, f'gs@{sc.get("gs")}')
finish(c)

# ── M02 手动日期完整 ISO（分钟级保真）──
c = record('M02', '手动日期完整 ISO → creation_time 精确保留')
c['intent'] = 'manual_date=完整 ISO '+"2026-05-26T15:30:00"+' 时，tag 按该时刻写入（UTC 07:30）'
c['params'] = 'apply_date=true, manual_date=2026-05-26T15:30:00, set_creation_time=true, FS 均关'
c['expected'] = 'tag creation_time = UTC 07:30（本地 15:30）'
inp, _ = inp_clean(c, 'in_m02.mp4'); out = out_path('out_m02.mp4')
jid, d = run_meta(c, {'apply_date': True, 'manual_date': '2026-05-26T15:30:00', 'date_from_filename': False,
                      'set_creation_time': True, 'set_file_created': False, 'set_file_modified': False,
                      'apply_location': False, 'apply_spherical': False, 'faststart': True},
                  [{'input': inp.replace('/', '\\'), 'output': out.replace('/', '\\')}])
if jid:
    tg = tags_of(out)
    exp_epoch = utc_epoch(datetime(2026, 5, 26, 15, 30, 0))
    check(c, 'creation_time tag = 15:30 本地(UTC 07:30)', near(tag_creation_epoch(tg), exp_epoch), f'tags={tag_values(tg)[:150]}')
finish(c)

# ── M03 文件名日期（datetime_compact：VID_20260526_103000.mp4）──
c = record('M03', '文件名日期提取（Insta360/GoPro 紧凑格式）')
c['intent'] = 'date_from_filename=true，文件名 VID_20260526_103000.mp4 命中 datetime_compact 模式'
c['params'] = 'manual_date 空, date_from_filename=true, set_creation_time=true, FS 均关'
c['expected'] = 'tag creation_time = 2026-05-26T10:30:00 本地(UTC 02:30)'
inp = os.path.join(BASE_OUT, 'VID_20260526_103000.mp4'); out = out_path('out_m03.mp4')
jid, d = run_meta(c, {'apply_date': True, 'manual_date': '', 'date_from_filename': True,
                      'set_creation_time': True, 'set_file_created': False, 'set_file_modified': False,
                      'apply_location': False, 'apply_spherical': False, 'faststart': True},
                  [{'input': inp.replace('/', '\\'), 'output': out.replace('/', '\\')}])
if jid:
    tg = tags_of(out)
    exp_epoch = utc_epoch(datetime(2026, 5, 26, 10, 30, 0))
    check(c, 'creation_time tag = 文件名日期 10:30 本地(UTC 02:30)', near(tag_creation_epoch(tg), exp_epoch), f'tags={tag_values(tg)[:150]}')
finish(c)

# ── M04 优先级：manual_date 胜于文件名日期 ──
c = record('M04', '优先级：manual_date 与 date_from_filename 同开 → manual 胜')
c['intent'] = '源码语义 manual_date 优先；文件名日期 2026-01-01T08:00 不得覆盖 manual 2026-03-15T09:00'
c['params'] = 'manual_date=2026-03-15T09:00:00, date_from_filename=true, 输入文件名含 20260101_080000'
c['expected'] = 'tag = 2026-03-15T09:00 本地(UTC 01:30)，而非 01-01T08:00'
inp = os.path.join(BASE_OUT, 'VID_20260101_080000.mp4'); out = out_path('out_m04.mp4')
jid, d = run_meta(c, {'apply_date': True, 'manual_date': '2026-03-15T09:00:00', 'date_from_filename': True,
                      'set_creation_time': True, 'set_file_created': False, 'set_file_modified': False,
                      'apply_location': False, 'apply_spherical': False, 'faststart': True},
                  [{'input': inp.replace('/', '\\'), 'output': out.replace('/', '\\')}])
if jid:
    tg = tags_of(out)
    exp_epoch = utc_epoch(datetime(2026, 3, 15, 9, 0, 0))
    got = tag_creation_epoch(tg)
    check(c, 'creation_time = manual 的 03-15 09:00', near(got, exp_epoch), f'tags={tag_values(tg)[:150]}')
    check(c, '文件名日期未生效(≠01-01 08:00)', not near(got, utc_epoch(datetime(2026, 1, 1, 8, 0, 0)), 60), f'got={got}')
finish(c)

# ── M05 仅设置 FS 创建时间 ──
c = record('M05', '仅 FS 创建时间（SetFileTime），不写 tag')
c['intent'] = 'set_creation_time=false + set_file_created=true：只改 Windows 创建时间，不写 creation_time tag，mtime 不动'
c['params'] = 'manual_date=2026-04-18T06:00:00, set_creation_time=false, set_file_created=true, set_file_modified=false'
c['expected'] = '无 creation_time tag；FS ctime=2026-04-18 06:00 本地；mtime 不变'
inp, base = inp_clean(c, 'in_m05.mp4'); out = out_path('out_m05.mp4')
jid, d = run_meta(c, {'apply_date': True, 'manual_date': '2026-04-18T06:00:00', 'date_from_filename': False,
                      'set_creation_time': False, 'set_file_created': True, 'set_file_modified': False,
                      'apply_location': False, 'apply_spherical': False, 'faststart': True},
                  [{'input': inp.replace('/', '\\'), 'output': out.replace('/', '\\')}])
if jid:
    tg = tags_of(out)
    check(c, '无 creation_time tag（tag 写入开关关闭）', tg.get('creation_time') is None, f'tags={tag_values(tg)[:150]}')
    st2 = stat_of(out)
    exp_ct = utc_epoch(datetime(2026, 4, 18, 6, 0, 0))
    check(c, 'FS 创建时间 = 2026-04-18 06:00 本地', abs(st2['ctime'] - exp_ct) < 5, f'ctime={st2["ctime"]:.0f} exp={exp_ct:.0f}')
    check(c, 'FS 修改时间不变', abs(st2['mtime'] - base['mtime']) < 2, f'{base["mtime"]:.0f}→{st2["mtime"]:.0f}')
finish(c)

# ── M06 仅设置 FS 修改时间 ──
c = record('M06', '仅 FS 修改时间（os.utime），不写 tag')
c['intent'] = 'set_file_modified=true 且 set_creation_time=false：只改 mtime'
c['params'] = 'manual_date=2026-09-01T22:10:00, set_creation_time=false, set_file_created=false, set_file_modified=true'
c['expected'] = '无 tag；FS mtime=2026-09-01 22:10 本地；ctime 不变'
inp, base = inp_clean(c, 'in_m06.mp4'); out = out_path('out_m06.mp4')
jid, d = run_meta(c, {'apply_date': True, 'manual_date': '2026-09-01T22:10:00', 'date_from_filename': False,
                      'set_creation_time': False, 'set_file_created': False, 'set_file_modified': True,
                      'apply_location': False, 'apply_spherical': False, 'faststart': True},
                  [{'input': inp.replace('/', '\\'), 'output': out.replace('/', '\\')}])
if jid:
    tg = tags_of(out)
    check(c, '无 creation_time tag', tg.get('creation_time') is None, f'tags={tag_values(tg)[:150]}')
    st2 = stat_of(out)
    exp_mt = utc_epoch(datetime(2026, 9, 1, 22, 10, 0))
    check(c, 'FS 修改时间 = 2026-09-01 22:10 本地', abs(st2['mtime'] - exp_mt) < 5, f'mtime={st2["mtime"]:.0f} exp={exp_mt:.0f}')
    check(c, 'FS 创建时间不变', abs(st2['ctime'] - base['ctime']) < 2, f'{base["ctime"]:.0f}→{st2["ctime"]:.0f}')
finish(c)

# ── M07 GPS 三件套 ──
c = record('M07', 'GPS 位置三字段：坐标+地名+地址')
c['intent'] = 'apply_location + lat/lon/location_name/location_address → location(ISO6709) + location.name + comment 三 tag'
c['params'] = 'lat=36.0671, lon=120.3826, name=Qingdao May Fourth Square, address=青岛市市南区东海西路'
c['expected'] = 'location=+36.0671+120.3826/；存在值含 Qingdao May Fourth Square 的 tag；存在值含 东海西路 的 tag'
inp, _ = inp_clean(c, 'in_m07.mp4'); out = out_path('out_m07.mp4')
jid, d = run_meta(c, {'apply_date': False, 'apply_location': True, 'location_lat': 36.0671,
                      'location_lon': 120.3826, 'location_name': 'Qingdao May Fourth Square',
                      'location_address': '青岛市市南区东海西路', 'apply_spherical': False, 'faststart': True},
                  [{'input': inp.replace('/', '\\'), 'output': out.replace('/', '\\')}])
if jid:
    tg = tags_of(out)
    tv = tag_values(tg)
    check(c, 'location tag = +36.0671+120.3826/', tg.get('location') == '+36.0671+120.3826/', f'location={tg.get("location")}')
    check(c, '地名 tag 存在', 'Qingdao May Fourth Square' in tv, f'tags={tv[:160]}')
    check(c, '地址 tag 存在', '东海西路' in tv, f'tags={tv[:160]}')
finish(c)

# ── M08 球面 mono ──
c = record('M08', '球面注入 mono（StereoMode=mono、SourceCount=1）')
c['intent'] = 'apply_spherical + stereo_mode=mono：XMP 写 StereoMode=mono 与 SourceCount=1（源码行为：mono 也写 StereoMode）'
c['params'] = 'pano_type=360, stereo_mode=mono, faststart=true'
c['expected'] = 'GSpherical 存在；StereoMode=mono；SourceCount=1；ProjectionType=equirectangular；Spherical=true'
inp, _ = inp_clean(c, 'in_m08.mp4'); out = out_path('out_m08.mp4')
jid, d = run_meta(c, {'apply_date': False, 'apply_location': False, 'apply_spherical': True,
                      'pano_type': '360', 'stereo_mode': 'mono', 'faststart': True},
                  [{'input': inp.replace('/', '\\'), 'output': out.replace('/', '\\')}])
if jid:
    sc = scan_of(out)
    check(c, 'GSpherical UUID box 存在', sc['gs'] >= 0, f'gs@{sc["gs"]}')
    check(c, 'StereoMode=mono', sc['stereo_mono'] >= 0, f'@{sc["stereo_mono"]}')
    check(c, 'SourceCount=1', sc['srccnt1'] >= 0, f'@{sc["srccnt1"]}')
    check(c, 'ProjectionType=equirectangular', sc['proj'] >= 0, f'@{sc["proj"]}')
    check(c, 'Spherical=true', sc['sph_true'] >= 0, f'@{sc["sph_true"]}')
finish(c)

# ── M09 日期+位置 组合 ──
c = record('M09', '组合：日期 + GPS 位置')
c['intent'] = 'apply_date 与 apply_location 同开（都走 ffmpeg mux 分支），两组 tag 同时写入'
c['params'] = 'manual_date=2026-02-14T19:45:00 + lat=22.54 lon=114.05(深圳) + name/address'
c['expected'] = 'creation_time=19:45 本地(UTC 11:45)；location=+22.5400+114.0500/；地名地址 tag 齐全'
inp, _ = inp_clean(c, 'in_m09.mp4'); out = out_path('out_m09.mp4')
jid, d = run_meta(c, {'apply_date': True, 'manual_date': '2026-02-14T19:45:00', 'date_from_filename': False,
                      'set_creation_time': True, 'set_file_created': False, 'set_file_modified': False,
                      'apply_location': True, 'location_lat': 22.54, 'location_lon': 114.05,
                      'location_name': 'Shenzhen Bay', 'location_address': '深圳市南山区',
                      'apply_spherical': False, 'faststart': True},
                  [{'input': inp.replace('/', '\\'), 'output': out.replace('/', '\\')}])
if jid:
    tg = tags_of(out)
    tv = tag_values(tg)
    check(c, 'creation_time = 02-14 19:45 本地', near(tag_creation_epoch(tg), utc_epoch(datetime(2026, 2, 14, 19, 45, 0))), f'tags={tv[:150]}')
    check(c, 'location = +22.5400+114.0500/', tg.get('location') == '+22.5400+114.0500/', f'location={tg.get("location")}')
    check(c, '地名(location.name) tag 存在', 'Shenzhen Bay' in tv, f'tags={tv[:160]}')
    check(c, '地址(comment) tag 存在', '南山区' in tv, f'tags={tv[:160]}')
finish(c)

# ── M10 全功能组合（新目录）──
c = record('M10', '全组合：日期+位置+球面（输出到全新目录）')
c['intent'] = '三类功能同开且输出目录不存在：tag、UUID box 双写且互相不干扰'
c['params'] = 'manual_date=2026-08-08T08:08:00 + lat=30.65 lon=104.06(成都) + spherical top-bottom + faststart'
c['expected'] = 'creation_time=08:08 本地；location=+30.6500+104.0600/；GSpherical+StereoMode=top-bottom 全存在'
inp, _ = inp_clean(c, 'in_m10.mp4'); out = os.path.join(BASE_OUT, 'meta_newdir_m10', 'out_m10.mp4')
jid, d = run_meta(c, {'apply_date': True, 'manual_date': '2026-08-08T08:08:00', 'date_from_filename': False,
                      'set_creation_time': True, 'set_file_created': False, 'set_file_modified': False,
                      'apply_location': True, 'location_lat': 30.65, 'location_lon': 104.06,
                      'location_name': 'Chengdu', 'location_address': '成都市',
                      'apply_spherical': True, 'pano_type': '360', 'stereo_mode': 'top-bottom', 'faststart': True},
                  [{'input': inp.replace('/', '\\'), 'output': out.replace('/', '\\')}])
if jid:
    tg = tags_of(out); sc = scan_of(out)
    check(c, 'creation_time = 08-08 08:08 本地', near(tag_creation_epoch(tg), utc_epoch(datetime(2026, 8, 8, 8, 8, 0))), f'tags={tag_values(tg)[:150]}')
    check(c, 'location = +30.6500+104.0600/', tg.get('location') == '+30.6500+104.0600/', f'location={tg.get("location")}')
    check(c, 'GSpherical + StereoMode=top-bottom', sc['gs'] >= 0 and sc['stereo_tb'] >= 0, f'gs@{sc["gs"]} tb@{sc["stereo_tb"]}')
    check(c, '地名(location.name) tag 存在', 'Chengdu' in tag_values(tg), f'tags={tag_values(tg)[:160]}')
    check(c, '地址(comment) tag 存在', '成都市' in tag_values(tg), f'tags={tag_values(tg)[:160]}')
finish(c)

# ── M11 球面单独（elif 分支）──
c = record('M11', '球面单独注入（不经 ffmpeg 元数据 mux 的独立分支）')
c['intent'] = '仅 apply_spherical：走 elif need_spherical 分支；其余 tag 保持源样（干净基线=无 tag）'
c['params'] = '仅 apply_spherical=true, stereo_mode=left-right'
c['expected'] = 'GSpherical+StereoMode=left-right+SourceCount=2；creation_time/location tag 不存在'
inp, _ = inp_clean(c, 'in_m11.mp4'); out = out_path('out_m11.mp4')
jid, d = run_meta(c, {'apply_date': False, 'apply_location': False, 'apply_spherical': True,
                      'pano_type': '360', 'stereo_mode': 'left-right', 'faststart': True},
                  [{'input': inp.replace('/', '\\'), 'output': out.replace('/', '\\')}])
if jid:
    tg = tags_of(out); sc = scan_of(out)
    check(c, 'GSpherical + StereoMode=left-right', sc['gs'] >= 0 and sc['stereo_lr'] >= 0, f'gs@{sc["gs"]} lr@{sc["stereo_lr"]}')
    check(c, 'SourceCount=2', sc['srccnt2'] >= 0, f'@{sc["srccnt2"]}')
    check(c, '无 creation_time tag（干净基线未被污染）', tg.get('creation_time') is None, f'tags={tag_values(tg)[:150]}')
    check(c, '无 location tag', tg.get('location') is None, f'tags={tag_values(tg)[:150]}')
finish(c)

# ── M12 faststart=false（moov 在尾）──
c = record('M12', 'faststart=false：moov 置尾 + 元数据完整')
c['intent'] = '关闭 faststart 时 MP4 box 顺序 mdat 在前 moov 在后，且已启用的元数据不受影响'
c['params'] = 'manual_date + lat/lon + spherical mono, faststart=false'
c['expected'] = 'mdat 偏移 < moov 偏移；creation_time/location/GSpherical 均存在'
inp, _ = inp_clean(c, 'in_m12.mp4'); out = out_path('out_m12.mp4')
jid, d = run_meta(c, {'apply_date': True, 'manual_date': '2026-06-18T12:00:00', 'date_from_filename': False,
                      'set_creation_time': True, 'set_file_created': False, 'set_file_modified': False,
                      'apply_location': True, 'location_lat': 45.75, 'location_lon': 126.65,
                      'location_name': 'Harbin', 'location_address': '哈尔滨市',
                      'apply_spherical': True, 'pano_type': '360', 'stereo_mode': 'mono', 'faststart': False},
                  [{'input': inp.replace('/', '\\'), 'output': out.replace('/', '\\')}])
if jid:
    tg = tags_of(out); sc = scan_of(out)
    check(c, 'box 顺序 mdat 在 moov 之前（faststart 关闭生效）', 0 <= sc['mdat'] < sc['moov'], f'mdat@{sc["mdat"]} moov@{sc["moov"]}')
    check(c, 'creation_time = 06-18 12:00 本地', near(tag_creation_epoch(tg), utc_epoch(datetime(2026, 6, 18, 12, 0, 0))), f'tags={tag_values(tg)[:150]}')
    check(c, 'location = +45.7500+126.6500/', tg.get('location') == '+45.7500+126.6500/', f'location={tg.get("location")}')
    check(c, 'GSpherical 存在', sc['gs'] >= 0, f'gs@{sc["gs"]}')
finish(c)

# ── M13 test 模式（截短 + _test 后缀）──
c = record('M13', 'test_duration=3：输出截短 + _test 后缀 + 元数据齐全')
c['intent'] = 'test 模式下元数据全部照常写入，输出名加 _test 且时长≈3s'
c['params'] = 'test_duration=3 + manual_date + lat/lon + spherical mono'
c['expected'] = '产物名 out_m13_test.mp4；时长≈3s；creation_time/location/GSpherical 齐全'
inp, _ = inp_clean(c, 'in_m13.mp4'); out = out_path('out_m13.mp4')
jid, d = run_meta(c, {'apply_date': True, 'manual_date': '2026-07-07T07:07:00', 'date_from_filename': False,
                      'set_creation_time': True, 'set_file_created': False, 'set_file_modified': False,
                      'apply_location': True, 'location_lat': 34.26, 'location_lon': 108.94,
                      'location_name': 'Xian', 'location_address': '西安市',
                      'apply_spherical': True, 'pano_type': '360', 'stereo_mode': 'mono',
                      'faststart': True, 'test_duration': 3},
                  [{'input': inp.replace('/', '\\'), 'output': out.replace('/', '\\')}])
if jid:
    real_out = out_path('out_m13_test.mp4')
    tg = tags_of(real_out); sc = scan_of(real_out)
    dur = dur_of(real_out)
    check(c, '产物为 _test 后缀文件', os.path.isfile(real_out), f'exists={os.path.isfile(real_out)}')
    check(c, '时长≈3s', 2.0 < dur < 4.5, f'dur={dur}')
    check(c, 'creation_time = 07-07 07:07 本地', near(tag_creation_epoch(tg), utc_epoch(datetime(2026, 7, 7, 7, 7, 0))), f'tags={tag_values(tg)[:150]}')
    check(c, 'location = +34.2600+108.9400/', tg.get('location') == '+34.2600+108.9400/', f'location={tg.get("location")}')
    check(c, 'GSpherical 存在', sc['gs'] >= 0, f'gs@{sc["gs"]}')
finish(c)

# ── M14 负坐标（南半球/西半球）──
c = record('M14', '负坐标符号处理（南半球 + 西半球）')
c['intent'] = 'ISO6709 符号：lat<0 → 前缀 -，lon<0 → 前缀 -（悉尼）'
c['params'] = 'lat=-33.86, lon=-151.21'
c['expected'] = 'location=-33.8600-151.2100/'
inp, _ = inp_clean(c, 'in_m14.mp4'); out = out_path('out_m14.mp4')
jid, d = run_meta(c, {'apply_date': False, 'apply_location': True, 'location_lat': -33.86,
                      'location_lon': -151.21, 'location_name': 'Sydney', 'location_address': '',
                      'apply_spherical': False, 'faststart': True},
                  [{'input': inp.replace('/', '\\'), 'output': out.replace('/', '\\')}])
if jid:
    tg = tags_of(out)
    check(c, 'location = -33.8600-151.2100/', tg.get('location') == '-33.8600-151.2100/', f'location={tg.get("location")}')
finish(c)

# ── M15 批量：per-item 参数完全隔离（干扰性全局参数）──
c = record('M15', '批量 per-item 参数隔离（3 项各不相同 + 干扰性全局参数）')
c['intent'] = '每项带自己的完整参数（整体替换 global 语义），全局参数故意设为不同干扰值：逐项验证输出=各自预设，无串扰无遗漏'
c['params'] = 'item1=日期06-01 08:00；item2=坐标上海31.23/121.47；item3=球面top-bottom；global=干扰(2020-01-01 + lat1/lon2 + mono)'
c['expected'] = 'out1 仅含 item1 日期；out2 仅含 item2 坐标；out3 仅含 item3 球面——全局干扰值不得出现'
inp1, _ = inp_clean(c, 'in_m15_1.mp4'); inp2, _ = inp_clean(c, 'in_m15_2.mp4'); inp3, _ = inp_clean(c, 'in_m15_3.mp4')
o1, o2, o3 = out_path('out_m15_1.mp4'), out_path('out_m15_2.mp4'), out_path('out_m15_3.mp4')
glob = {'apply_date': True, 'manual_date': '2020-01-01T00:00:00', 'set_creation_time': True,
        'set_file_created': False, 'set_file_modified': False, 'apply_location': True,
        'location_lat': 1.0, 'location_lon': 2.0, 'location_name': 'BAD', 'location_address': 'BAD',
        'apply_spherical': True, 'pano_type': '360', 'stereo_mode': 'mono', 'faststart': True}
p1 = {**glob, 'manual_date': '2026-06-01T08:00:00', 'apply_location': False, 'apply_spherical': False}
p2 = {**glob, 'apply_date': False, 'location_lat': 31.23, 'location_lon': 121.47,
      'location_name': 'Shanghai', 'location_address': '上海市', 'apply_spherical': False}
p3 = {**glob, 'apply_date': False, 'apply_location': False, 'stereo_mode': 'top-bottom'}
jid, d = run_meta(c, glob, [
    {'input': inp1.replace('/', '\\'), 'output': o1.replace('/', '\\'), 'params': p1},
    {'input': inp2.replace('/', '\\'), 'output': o2.replace('/', '\\'), 'params': p2},
    {'input': inp3.replace('/', '\\'), 'output': o3.replace('/', '\\'), 'params': p3},
])
if jid:
    t1, t2, t3 = tags_of(o1), tags_of(o2), tags_of(o3)
    s1, s2, s3 = scan_of(o1), scan_of(o2), scan_of(o3)
    check(c, 'out1 日期=item1 的 06-01 08:00（非 global 2020）',
          near(tag_creation_epoch(t1), utc_epoch(datetime(2026, 6, 1, 8, 0, 0))), f't1={tag_values(t1)[:120]}')
    check(c, 'out1 无位置/球面（干扰值未串入）',
          t1.get('location') is None and s1['gs'] == -1, f'loc={t1.get("location")} gs@{s1["gs"]}')
    check(c, 'out2 坐标=item2 的上海（非 global 1.0/2.0）',
          t2.get('location') == '+31.2300+121.4700/', f'loc={t2.get("location")}')
    check(c, 'out2 无日期/球面',
          t2.get('creation_time') is None and s2['gs'] == -1, f'ct={t2.get("creation_time")} gs@{s2["gs"]}')
    check(c, 'out3 球面=item3 的 top-bottom（非 global mono）',
          s3['stereo_tb'] >= 0 and s3['stereo_mono'] == -1, f'tb@{s3["stereo_tb"]} mono@{s3["stereo_mono"]}')
    check(c, 'out3 无日期/位置',
          t3.get('creation_time') is None and t3.get('location') is None, f't3={tag_values(t3)[:120]}')
finish(c)

# ── M16 批量：同参数全功能 ×3（逐项逐参数不遗漏）──
c = record('M16', '批量同参数全功能 ×3（每项逐参数核验，不遗漏任一项）')
c['intent'] = '批量 3 项共用同一组全功能参数：每项输出对 日期/坐标/地名/球面/SourceCount 逐项核验'
c['params'] = 'global=manual_date=2026-07-04T20:00:00 + lat39.9/lon116.4 + name Beijing + spherical mono + faststart'
c['expected'] = '3 个输出各自满足全部 5 项断言（共 15 项子核验）'
ins, outs = [], []
for i in range(3):
    ip, _ = inp_clean(c, f'in_m16_{i}.mp4')
    ins.append(ip); outs.append(out_path(f'out_m16_{i}.mp4'))
gp = {'apply_date': True, 'manual_date': '2026-07-04T20:00:00', 'date_from_filename': False,
      'set_creation_time': True, 'set_file_created': False, 'set_file_modified': False,
      'apply_location': True, 'location_lat': 39.9, 'location_lon': 116.4,
      'location_name': 'Beijing', 'location_address': '北京市',
      'apply_spherical': True, 'pano_type': '360', 'stereo_mode': 'mono', 'faststart': True}
jid, d = run_meta(c, gp, [{'input': p.replace('/', '\\'), 'output': q.replace('/', '\\')} for p, q in zip(ins, outs)])
if jid:
    exp_ct = utc_epoch(datetime(2026, 7, 4, 20, 0, 0))
    for i in range(3):
        tg = tags_of(outs[i]); sc = scan_of(outs[i])
        check(c, f'out{i+1}: creation_time=07-04 20:00 本地', near(tag_creation_epoch(tg), exp_ct), f't={tag_values(tg)[:120]}')
        check(c, f'out{i+1}: location=+39.9000+116.4000/', tg.get('location') == '+39.9000+116.4000/', f'loc={tg.get("location")}')
        check(c, f'out{i+1}: 地址(comment)存在', '北京市' in tag_values(tg), f'tags={tag_values(tg)[:140]}')
        check(c, f'out{i+1}: 地名(location.name)存在', 'Beijing' in tag_values(tg), f'tags={tag_values(tg)[:140]}')
        check(c, f'out{i+1}: GSpherical+mono+SourceCount1', sc['gs'] >= 0 and sc['stereo_mono'] >= 0 and sc['srccnt1'] >= 0,
              f'gs@{sc["gs"]} mono@{sc["stereo_mono"]}')
        check(c, f'out{i+1}: faststart(moov 在 mdat 前)', 0 <= sc['moov'] < sc['mdat'], f'moov@{sc["moov"]} mdat@{sc["mdat"]}')
finish(c)

# ── M17 批量 skip（暂停→跳过→恢复 的确定性时序）──
c = record('M17', '批量运行中跳过第 4 项（暂停保证 skip 命中未开始项）')
c['intent'] = 'pause 使 worker 在项间等待 → 对未开始的项 skip → resume：被跳过项不产出文件且 error=Skipped by user，其余项正常完成。同时顺带验证批量暂停/恢复功能'
c['params'] = '6 项同参数（manual_date=2026-05-05T05:05:00），启动后立即 pause，1s 后 skip idx=3，再 resume'
c['expected'] = 'item4 无输出、error=Skipped by user；其余 5 项产出且日期正确'
ins, outs = [], []
for i in range(6):
    ip, _ = inp_clean(c, f'in_m17_{i}.mp4')
    ins.append(ip); outs.append(out_path(f'out_m17_{i}.mp4'))
gp = {'apply_date': True, 'manual_date': '2026-05-05T05:05:00', 'date_from_filename': False,
      'set_creation_time': True, 'set_file_created': False, 'set_file_modified': False,
      'apply_location': False, 'apply_spherical': False, 'faststart': True}
st, r, _ = api('/api/apply_metadata', {'params': gp,
               'items': [{'input': p.replace('/', '\\'), 'output': q.replace('/', '\\')} for p, q in zip(ins, outs)]})
j = r.get('job_id') if st == 200 else None
if not j:
    check(c, '任务启动', False, f'HTTP {st}')
else:
    pz_st, _, _ = api(f'/api/pause/{j}', method='POST')   # worker 在下一个项边界暂停
    time.sleep(1.0)
    sk_st, sk_body, _ = api(f'/api/item/{j}/3/skip', method='POST')
    rs_st, _, _ = api(f'/api/resume/{j}', method='POST')
    d = wait_terminal(j, timeout=180)
    its = d.get('items', [])
    check(c, 'pause/skip/resume 请求均成功', pz_st == 200 and sk_st == 200 and rs_st == 200,
          f'pause={pz_st} skip={sk_st} resume={rs_st}')
    check(c, 'item4 标记 skipped 且无输出文件', its[3].get('skipped') is True and not os.path.isfile(outs[3]),
          f'skipped={its[3].get("skipped")} exists={os.path.isfile(outs[3])}')
    check(c, 'item4 error=Skipped by user', 'Skipped' in str(its[3].get('error') or ''), f'err={its[3].get("error")}')
    check(c, '其余 5 项全部正常完成', all(its[i].get('ok') for i in (0, 1, 2, 4, 5)),
          f'oks={[its[i].get("ok") for i in (0,1,2,4,5)]}')
    tg0, tg5 = tags_of(outs[0]), tags_of(outs[5])
    exp_ct = utc_epoch(datetime(2026, 5, 5, 5, 5, 0))
    check(c, 'item1/6 产出日期正确',
          near(tag_creation_epoch(tg0), exp_ct) and near(tag_creation_epoch(tg5), exp_ct),
          f't1ct={tg0.get("creation_time")} t6ct={tg5.get("creation_time")}')
finish(c)

# ── M18a 非法 manual_date + FS 开关全关（无可执行动作）──
c = record('M18a', '边界：manual_date 非法 + FS 开关全关 → 无可执行动作，任务失败')
c['intent'] = 'need_ffmpeg = apply_date and (effective_ct or set_file_created or set_file_modified)；日期解析失败且 FS 全关 → 三功能均未启用，返回 No metadata features enabled（代码语义）'
c['params'] = 'manual_date=not-a-date, set_creation_time=true, set_file_created=false, set_file_modified=false'
c['expected'] = 'item failed，error 含 No metadata features enabled；日志含 Invalid manual date 警告；不产出文件'
inp, _ = inp_clean(c, 'in_m18a.mp4'); out = out_path('out_m18a.mp4')
jid, d = run_meta(c, {'apply_date': True, 'manual_date': 'not-a-date', 'date_from_filename': False,
                      'set_creation_time': True, 'set_file_created': False, 'set_file_modified': False,
                      'apply_location': False, 'apply_spherical': False, 'faststart': True},
                  [{'input': inp.replace('/', '\\'), 'output': out.replace('/', '\\')}], expect_ok=False)
if jid:
    err = json.dumps(d.get('items', [{}])[0].get('error') or d.get('error') or '', ensure_ascii=False)
    warn = 'Invalid manual date' in json.dumps(d.get('log', []), ensure_ascii=False)
    check(c, '错误信息含 No metadata features enabled', 'No metadata features enabled' in err, f'err={err[:120]}')
    check(c, '日志含 Invalid manual date 警告', warn, 'log 未含警告' if not warn else '')
    check(c, '不产出输出文件', not os.path.isfile(out), f'exists={os.path.isfile(out)}')
finish(c)

# ── M18b 非法 manual_date + set_file_created=true（宽容路径）──
c = record('M18b', '边界：manual_date 非法 + set_file_created=true → completed 但全部无实际效果')
c['intent'] = 'need_ffmpeg 因 set_file_created=true 而成立 → mux 运行；但 effective_dt=None → FS 不设置、无 tag 写入（宽容但结果为空）'
c['params'] = 'manual_date=not-a-date, set_creation_time=true, set_file_created=true, set_file_modified=false'
c['expected'] = '任务 completed；日志含 Invalid manual date；无 creation_time tag；FS ctime/mtime 不变'
inp, base = inp_clean(c, 'in_m18b.mp4'); out = out_path('out_m18b.mp4')
jid, d = run_meta(c, {'apply_date': True, 'manual_date': 'not-a-date', 'date_from_filename': False,
                      'set_creation_time': True, 'set_file_created': True, 'set_file_modified': False,
                      'apply_location': False, 'apply_spherical': False, 'faststart': True},
                  [{'input': inp.replace('/', '\\'), 'output': out.replace('/', '\\')}])
if jid:
    tg = tags_of(out)
    st2 = stat_of(out)
    warn = 'Invalid manual date' in json.dumps(d.get('log', []), ensure_ascii=False)
    check(c, '日志含 Invalid manual date 警告', warn, 'log 未含警告' if not warn else '')
    check(c, '无 creation_time tag', tg.get('creation_time') is None, f'tags={tag_values(tg)[:150]}')
    check(c, 'FS 时间不变（effective_dt=None）',
          abs(st2['ctime'] - base['ctime']) < 2 and abs(st2['mtime'] - base['mtime']) < 2,
          f'ctime {base["ctime"]:.0f}→{st2["ctime"]:.0f}')
finish(c)

# ── M19 只有 lat 无 lon ──
c = record('M19', '边界：仅纬度无经度 → 功能未启用失败（明确报错）')
c['intent'] = 'need_ffmpeg 要求 lat+lon 同时存在；仅 lat 时三类功能均未启用 → 返回 No metadata features enabled'
c['params'] = 'apply_location=true, location_lat=36.0671（lon 缺失）'
c['expected'] = 'item failed，error 含 No metadata features enabled'
inp, _ = inp_clean(c, 'in_m19.mp4'); out = out_path('out_m19.mp4')
jid, d = run_meta(c, {'apply_date': False, 'apply_location': True, 'location_lat': 36.0671,
                      'location_lon': None, 'apply_spherical': False, 'faststart': True},
                  [{'input': inp.replace('/', '\\'), 'output': out.replace('/', '\\')}], expect_ok=False)
if jid:
    err = json.dumps(d.get('items', [{}])[0].get('error') or d.get('error') or '', ensure_ascii=False)
    check(c, '错误信息含 No metadata features enabled', 'No metadata features enabled' in err, f'err={err[:120]}')
    check(c, '不产出输出文件', not os.path.isfile(out), f'exists={os.path.isfile(out)}')
finish(c)

# ── M20 文件名无日期 ──
c = record('M20', '边界：文件名提取开启但文件名无日期 → 警告不失败')
c['intent'] = 'date_from_filename=true 但文件名无日期：warn + 无 tag + FS 不动（effective_dt=None）'
c['params'] = 'manual_date 空, date_from_filename=true, set_creation_time=true, set_file_created=true, set_file_modified=true'
c['expected'] = '任务 completed；日志含 No date found；无 tag；FS ctime/mtime 不变'
inp, base = inp_clean(c, 'in_m20_no_date_in_name.mp4'); out = out_path('out_m20.mp4')
jid, d = run_meta(c, {'apply_date': True, 'manual_date': '', 'date_from_filename': True,
                      'set_creation_time': True, 'set_file_created': True, 'set_file_modified': True,
                      'apply_location': False, 'apply_spherical': False, 'faststart': True},
                  [{'input': inp.replace('/', '\\'), 'output': out.replace('/', '\\')}])
if jid:
    tg = tags_of(out)
    st2 = stat_of(out)
    warn = 'No date found in filename' in json.dumps(d.get('log', []), ensure_ascii=False)
    check(c, '日志含 No date found 警告', warn, 'log 未含警告' if not warn else '')
    check(c, '无 creation_time tag', tg.get('creation_time') is None, f'tags={tag_values(tg)[:150]}')
    check(c, 'FS 时间不变（effective_dt=None 不触发 FS 设置）',
          abs(st2['ctime'] - base['ctime']) < 2 and abs(st2['mtime'] - base['mtime']) < 2,
          f'ctime {base["ctime"]:.0f}→{st2["ctime"]:.0f}, mtime {base["mtime"]:.0f}→{st2["mtime"]:.0f}')
finish(c)

# ══════════════ 汇总 ══════════════
for c in RESULTS:
    c.pop('checks', None) if False else None
passed = sum(1 for c in RESULTS if c.get('pass'))
print(f'\n════ 元数据工具测试完成：{passed}/{len(RESULTS)} PASS ════', flush=True)
with open(os.path.join(BASE_OUT, 'meta_results.json'), 'w', encoding='utf-8') as f:
    json.dump(RESULTS, f, ensure_ascii=False, indent=2)
print('meta_results.json 已写入', flush=True)
sys.exit(0 if passed == len(RESULTS) else 1)

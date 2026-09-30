# -*- coding: utf-8 -*-
"""v3.13.2 全面功能验收测试驱动（HTTP 驱动打包 exe，全部真实运行）。v3 final

前提：dist/360VideoConverter.exe 已启动，127.0.0.1:8765 就绪。
素材：G:/264 真实 360 全景视频（h264 4096x2048 + AAC），截短样本在本目录。
产物：results.json（逐用例 实际输入/过程/真实输出/结论）。
"""
import json, os, subprocess, sys, time, urllib.request, urllib.parse, urllib.error

BASE_OUT = r'G:/264/_acceptance_v3132'
FFPROBE = r'G:/360video-converter/360video-converter/ffmpeg-static/ffprobe.exe'
SRC5 = os.path.join(BASE_OUT, 'acc_src5s.mp4')
NOAU5 = os.path.join(BASE_OUT, 'acc_noaudio5s.mp4')
CORRUPT = os.path.join(BASE_OUT, 'acc_corrupt.mp4')
HOST = 'http://127.0.0.1:8765'

RESULTS = []
def record(cid, name, inp, process, out, ok):
    RESULTS.append({'id': cid, 'name': name, 'input': inp, 'process': process,
                    'output': out, 'pass': bool(ok)})
    print(('PASS' if ok else 'FAIL') + f' [{cid}] {name} :: {out}', flush=True)

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

def hdr_get(headers, name):
    try:
        return headers.get(name)
    except Exception:
        for k in headers:
            if k.lower() == name.lower():
                return headers[k]
    return None

def probe(path):
    try:
        r = subprocess.run([FFPROBE, '-v', 'error', '-show_entries',
                            'stream=codec_type,codec_name,width,height:format=duration',
                            '-of', 'json', path],
                           capture_output=True, text=True, timeout=30)
        d = json.loads(r.stdout or '{}')
        v = next((s for s in d.get('streams', []) if s.get('codec_type') == 'video'), {})
        return {'codec': v.get('codec_name'), 'w': v.get('width'), 'h': v.get('height'),
                'dur': d.get('format', {}).get('duration'),
                'has_audio': any(s.get('codec_type') == 'audio' for s in d.get('streams', []))}
    except Exception as e:
        return {'error': str(e)}

def out_name_for(name, test_dur):
    """test 模式下后端把输出重命名为 *_test.mp4（convert_one/apply_metadata_one 行为）。"""
    return name.replace('.mp4', '_test.mp4') if (test_dur or 0) > 0 else name

def gspherical(path):
    """全文件搜索球面元数据。inject_uuid 写入的 XMP 实际标签为
    <GSpherical:StereoMode>top-bottom|left-right</GSpherical:StereoMode>。"""
    try:
        with open(path, 'rb') as f:
            data = f.read()
        pos = data.find(b'GSpherical')
        tb = data.find(b'<GSpherical:StereoMode>top-bottom')
        lr = data.find(b'<GSpherical:StereoMode>left-right')
        return (pos >= 0, tb >= 0, lr >= 0, pos)
    except Exception:
        return (False, False, False, -1)

def wait_terminal(jid, timeout=240, sampler=None):
    t0 = time.time()
    last = {}
    while time.time() - t0 < timeout:
        st, d, _ = api(f'/api/status/{jid}', timeout=10)
        if st != 200:
            last = {'_http': st}; time.sleep(0.5); continue
        last = d
        if sampler: sampler(d)
        if d.get('status') in ('completed', 'failed', 'cancelled'):
            return last
        time.sleep(0.5)
    last['_timeout'] = True
    return last

def item_summary(d):
    return [{'i': i, 'ok': it.get('ok'), 'skipped': it.get('skipped'),
             'err': (it.get('error') or '')[:80]}
            for i, it in enumerate(d.get('items', []))]

def log_grep(d, *keywords):
    log = json.dumps(d.get('log', []), ensure_ascii=False)
    return [k for k in keywords if k in log]

def job_failure(d):
    it = next((x for x in d.get('items', []) if x.get('ok') is False), None)
    return (d.get('error') or (it or {}).get('error') or '')[:160]

# ══ A 组：环境与基础 ═════════════════════════════════════════
st, ver, hdr = api('/api/version')
st_home, _, hdr_home = api('/')
cc = hdr_get(hdr_home, 'Cache-Control') or ''
record('A1', '版本与静态资源策略（no-store 作用于界面资源 /）',
       'GET /api/version + GET /（分别取响应头）',
       f'version HTTP {st}; 首页 HTTP {st_home}; Cache-Control={cc}',
       f'version={ver.get("version")}, 平台={ver.get("platform")}',
       ver.get('version') == '3.13.2' and 'no-store' in cc)

st, sm, _ = api('/api/sysmon')
need_keys = ['cpu_percent', 'mem_percent', 'gpu_percent', 'gpu_name',
             'gpu_enc_percent', 'gpu_dec_percent', 'gpu_temp']
missing = [k for k in need_keys if k not in sm]
record('A2', '系统监控（含 GPU 编解码利用率 P1-1）',
       'GET /api/sysmon',
       f'gpu_name={sm.get("gpu_name")}, gpu={sm.get("gpu_percent")}%, enc={sm.get("gpu_enc_percent")}, dec={sm.get("gpu_dec_percent")}',
       f'缺失键={missing or "无"}',
       st == 200 and not missing and 'RTX 3090' in str(sm.get('gpu_name')))

st, codecs, _ = api('/api/codecs')
codec_names = list((codecs.get('codecs') or {}).keys())
need_codec = ['libx264', 'libx265', 'h264_nvenc', 'hevc_nvenc']
miss_c = [c for c in need_codec if c not in codec_names]
record('A3', '编码器矩阵（软编+NVENC）',
       'GET /api/codecs',
       f'返回 {len(codec_names)} 个编码器',
       f'缺失={miss_c or "无"}; 全列表={codec_names}',
       st == 200 and not miss_c)

qs = urllib.parse.quote('G:/264/20260526 欧乐堡骑士酒店温泉.mp4', safe='')
st, pv, _ = api(f'/api/probe-source?path={qs}')
pv_ok = (st == 200 and isinstance(pv, dict) and not pv.get('error')
         and pv.get('has_gps') is True and pv.get('has_time') is True)
record('A4', '源文件探测（真实 609GB 素材成员，含源内 GPS/时间解析）',
       'GET /api/probe-source?path=20260526 欧乐堡骑士酒店温泉.mp4',
       f'HTTP {st}',
       json.dumps(pv, ensure_ascii=False)[:220] if isinstance(pv, dict) else str(pv)[:220],
       pv_ok)

# ══ B 组：转码核心 ═══════════════════════════════════════════
def single_convert(cid, name, codec, test_dur, out_name, extra=None, preset=None, sampler=None):
    out = os.path.join(BASE_OUT, out_name)
    real_out = os.path.join(BASE_OUT, out_name_for(out_name, test_dur))
    params = {'codec': codec, 'test_duration': test_dur, 'resolution': 'original'}
    if preset: params['preset'] = preset
    if extra: params.update(extra)
    payload = {'mode': 'single', 'params': params,
               'items': [{'input': SRC5.replace('/', '\\'), 'output': out.replace('/', '\\'),
                          'params': params}]}
    st, r, _ = api('/api/convert', payload)
    if st != 200 or not r.get('job_id'):
        record(cid, name, json.dumps(payload, ensure_ascii=False)[:150], f'HTTP {st}',
               f'启动失败: {r}', False)
        return None, {}
    d = wait_terminal(r['job_id'], sampler=sampler)
    ok = d.get('status') == 'completed'
    pf = probe(real_out) if ok else {'error': 'no output'}
    detail = (f'status={d.get("status")}, err={job_failure(d) or "无"}; '
              f'产物[{os.path.basename(real_out)}]={json.dumps(pf, ensure_ascii=False)}')
    record(cid, name, f'codec={codec}, test={test_dur}s, 源=acc_src5s.mp4(4096x2048+h264+aac)',
           f'job={r["job_id"]}, status={d.get("status")}, 耗时≈{d.get("end_time",0)-d.get("start_time",0):.0f}s',
           detail, ok and pf.get('codec') in ('h264', 'hevc') and pf.get('dur'))
    return r['job_id'], d

jid_b1, _ = single_convert('B1', '单文件软编 libx264（test 4s）', 'libx264', 4, 'out_b1.mp4')

# B2+B3 合并执行：NVENC 真机编码，编码期间采样 sysmon（P1-1 端到端）
max_enc, max_dec, samples = 0, 0, 0
def _sampler(d):
    global max_enc, max_dec, samples
    try:
        _, sm2, _ = api('/api/sysmon', timeout=5)
        e, dc = sm2.get('gpu_enc_percent') or 0, sm2.get('gpu_dec_percent') or 0
        max_enc, max_dec, samples = max(max_enc, e), max(max_dec, dc), samples + 1
    except Exception:
        pass
jid_b2, d_b2 = single_convert('B2', '单文件硬编 h264_nvenc（test 4s，RTX 3090 真机）',
                              'h264_nvenc', 4, 'out_b2.mp4', sampler=_sampler)
nvenc_kw = log_grep(d_b2, 'h264_nvenc')
fallback_kw = log_grep(d_b2, 'fallback', '回退', 'Falling back')
record('B3', 'P1-1 端到端：NVENC 编码期间 gpu_enc_percent 实测',
       f'编码期间轮询 /api/sysmon ×{samples}',
       f'峰值 gpu_enc_percent={max_enc}, gpu_dec_percent={max_dec}; 日志含nvenc={bool(nvenc_kw)}, 含回退={bool(fallback_kw)}',
       '编码器利用率实时可见（修复前该键恒缺失）' if max_enc > 0 else '利用率始终为 0/缺失',
       max_enc > 0 and samples >= 3 and bool(nvenc_kw) and not fallback_kw)

single_convert('B5', '单文件软编 libx265（test 4s, preset faster）', 'libx265', 4,
               'out_b5.mp4', preset='faster')

# B4: copy 模式（源本身就是 5s 短段，无需 test_duration）
out_b4 = os.path.join(BASE_OUT, 'out_b4.mp4')
payload_b4 = {'mode': 'single',
              'params': {'copy_mode': True, 'resolution': 'original'},
              'items': [{'input': SRC5.replace('/', '\\'), 'output': out_b4.replace('/', '\\'),
                         'params': {'copy_mode': True}}]}
st, r, _ = api('/api/convert', payload_b4)
d = wait_terminal(r.get('job_id', 'x'), timeout=120) if st == 200 else {'status': f'http{st}'}
pf_b4 = probe(out_b4) if d.get('status') == 'completed' else {}
record('B4', 'copy 模式流复制（-c copy）',
       'copy_mode=true, 源=acc_src5s.mp4',
       f'status={d.get("status")}, 耗时≈{(d.get("end_time",0)-d.get("start_time",0)):.1f}s',
       f'产物={json.dumps(pf_b4, ensure_ascii=False)}（应与源同为 h264+aac、时长≈5s）',
       d.get('status') == 'completed' and pf_b4.get('codec') == 'h264' and pf_b4.get('has_audio')
       and abs(float(pf_b4.get('dur') or 0) - 5.0) < 0.6)

# ══ C 组：合并与批量 ═════════════════════════════════════════
def merge_case(cid, name, src_file, out_name, note):
    out = os.path.join(BASE_OUT, out_name)
    real_out = out.replace('.mp4', '_test.mp4')  # merge 用例固定 test_duration=4
    a = os.path.join(BASE_OUT, f'_m_{cid}_a.mp4'); b = os.path.join(BASE_OUT, f'_m_{cid}_b.mp4')
    import shutil; shutil.copy(src_file, a); shutil.copy(src_file, b)
    payload = {'mode': 'merge',
               'params': {'codec': 'libx264', 'test_duration': 4, 'resolution': 'original'},
               'items': [{'inputs': [a.replace('/', '\\'), b.replace('/', '\\')],
                          'output': out.replace('/', '\\')}]}
    st, r, _ = api('/api/convert', payload)
    if st != 200 or not r.get('job_id'):
        record(cid, name, note, f'HTTP {st}', f'启动失败: {r}', False); return
    d = wait_terminal(r['job_id'])
    pf = probe(real_out) if d.get('status') == 'completed' else {}
    record(cid, name, note,
           f'status={d.get("status")}, err={job_failure(d) or "无"}',
           f'产物[{os.path.basename(real_out)}]={json.dumps(pf, ensure_ascii=False)}',
           d.get('status') == 'completed' and pf.get('dur'))

merge_case('C1', '合并转换：两段带音轨视频', SRC5, 'out_c1.mp4',
           'inputs=acc_src5s×2(h264+aac), concat→mkv→libx264 test4s')
merge_case('C2', 'P0-1 回归：合并两段无音轨视频（v3.13.1 必败场景）', NOAU5, 'out_c2.mp4',
           'inputs=acc_noaudio5s×2(无音轨), 必须成功')

# C3: 批量 3 项
items_c3 = [{'input': SRC5.replace('/', '\\'),
             'output': os.path.join(BASE_OUT, f'out_c3_{i}.mp4').replace('/', '\\'),
             'params': {'codec': 'libx264', 'test_duration': 3, 'resolution': 'original'}}
            for i in range(3)]
st, r, _ = api('/api/convert', {'mode': 'batch',
                                'params': {'codec': 'libx264', 'test_duration': 3},
                                'items': items_c3})
d = wait_terminal(r.get('job_id', 'x')) if st == 200 else {}
its = item_summary(d) if d else []
record('C3', '批量模式：3 个任务逐项完成',
       '3×acc_src5s, libx264 test3s',
       f'status={d.get("status")}, items={json.dumps(its, ensure_ascii=False)}',
       f'overall={d.get("overall_progress")}%',
       d.get('status') == 'completed' and len(its) == 3 and all(x['ok'] for x in its))

# C4: 批量 + 运行中 skip 第 2 项（skip 是 POST-only 端点）
items_c4 = [{'input': SRC5.replace('/', '\\'),
             'output': os.path.join(BASE_OUT, f'out_c4_{i}.mp4').replace('/', '\\'),
             'params': {'codec': 'libx264', 'test_duration': 6, 'resolution': 'original'}}
            for i in range(3)]
st, r, _ = api('/api/convert', {'mode': 'batch',
                                'params': {'codec': 'libx264', 'test_duration': 6},
                                'items': items_c4})
j_c4 = r.get('job_id') if st == 200 else None
skip_st, skip_body = None, ''
if j_c4:
    time.sleep(2.0)
    skip_st, skip_body, _ = api(f'/api/item/{j_c4}/1/skip', method='POST')
d = wait_terminal(j_c4) if j_c4 else {}
its = item_summary(d) if d else []
ok_c4 = (d.get('status') in ('completed', 'failed') and len(its) == 3
         and its[1]['skipped'] is True and its[0]['ok'] and its[2]['ok'])
record('C4', '批量运行中跳过第 2 项（POST skip + P0-4 后端侧）',
       '3×acc_src5s test6s; 启动 2s 后 POST /api/item/{jid}/1/skip',
       f'skip HTTP={skip_st}, body={str(skip_body)[:60]}, 终态 items={json.dumps(its, ensure_ascii=False)}',
       'item1 skipped、item0/item2 正常完成' if ok_c4 else '跳过未按预期生效',
       ok_c4)

# ══ D 组：元数据与 VR3D ══════════════════════════════════════
# D1: 日期+位置 元数据
out_d1 = os.path.join(BASE_OUT, 'out_d1.mp4')
md_params = {'apply_date': True, 'manual_date': '2026-05-26T10:00:00',
             'date_from_filename': False, 'set_creation_time': True,
             'apply_location': True, 'location_lat': 36.0671, 'location_lon': 120.3826,
             'location_name': 'Qingdao May Fourth Square',
             'location_address': '青岛市市南区东海西路',
             'apply_spherical': False, 'faststart': True}
st, r, _ = api('/api/apply_metadata',
               {'params': md_params,
                'items': [{'input': SRC5.replace('/', '\\'),
                           'output': out_d1.replace('/', '\\')}]})
d = wait_terminal(r.get('job_id', 'x'), timeout=120) if st == 200 else {}
tags = {}
if d.get('status') == 'completed':
    pr = subprocess.run([FFPROBE, '-v', 'error', '-show_entries', 'format_tags',
                         '-of', 'json', out_d1], capture_output=True, text=True, timeout=30)
    tags = json.loads(pr.stdout or '{}').get('format', {}).get('tags', {})
ct_ok = '2026-05-26' in str(tags.get('creation_time', ''))
loc_ok = '+36.0671' in str(tags.get('location', ''))
record('D1', '元数据工具：日期+GPS 位置写入',
       'manual_date=2026-05-26T10:00:00, lat=36.0671, lon=120.3826',
       f'status={d.get("status")}, tags keys={list(tags.keys())[:8]}',
       f'creation_time={tags.get("creation_time")}, location={str(tags.get("location"))[:40]}',
       d.get('status') == 'completed' and ct_ok and loc_ok)

# D2: 球面注入 + 输出到全新目录（P0-3 原崩溃场景）
out_d2 = os.path.join(BASE_OUT, 'newdir_d2', 'out_d2.mp4')
st, r, _ = api('/api/apply_metadata',
               {'params': {'apply_date': False, 'apply_location': False,
                           'apply_spherical': True, 'pano_type': '360',
                           'stereo_mode': 'mono', 'faststart': True},
                'items': [{'input': SRC5.replace('/', '\\'),
                           'output': out_d2.replace('/', '\\')}]})
d = wait_terminal(r.get('job_id', 'x'), timeout=120) if st == 200 else {}
gs = gspherical(out_d2) if d.get('status') == 'completed' else (False, False, False, -1)
residue = os.path.exists(out_d2 + '.spherical_tmp.mp4')
record('D2', 'P0-3 回归：球面注入+输出到全新目录（v3.13.1 必败场景）',
       'apply_spherical=true, output=…/newdir_d2/out_d2.mp4(目录原本不存在)',
       f'status={d.get("status")}, err={job_failure(d) or "无"}',
       f'GSpherical={gs[0]}@offset{gs[3]}, 临时文件残留={residue}',
       d.get('status') == 'completed' and gs[0] and not residue)

# D3: 球面注入原地覆盖（回归）
import shutil as _sh
inplace_d3 = os.path.join(BASE_OUT, 'inplace_d3.mp4')
_sh.copy(SRC5, inplace_d3)
st, r, _ = api('/api/apply_metadata',
               {'params': {'apply_date': False, 'apply_location': False,
                           'apply_spherical': True, 'pano_type': '360',
                           'stereo_mode': 'mono', 'faststart': True},
                'items': [{'input': inplace_d3.replace('/', '\\'),
                           'output': inplace_d3.replace('/', '\\')}]})
d = wait_terminal(r.get('job_id', 'x'), timeout=120) if st == 200 else {}
gs3 = gspherical(inplace_d3) if d.get('status') == 'completed' else (False, False, False, -1)
record('D3', '球面注入原地覆盖（回归不劣化）',
       'input == output（replace_original 路径）',
       f'status={d.get("status")}, err={job_failure(d) or "无"}',
       f'GSpherical={gs3[0]}@offset{gs3[3]}',
       d.get('status') == 'completed' and gs3[0])

def vr3d_case(cid, name, layout, stereo, out_name):
    out = os.path.join(BASE_OUT, out_name)
    params = {'codec': 'libx264', 'preset': 'faster', 'resolution': '4096x2048',
              'vr3d_layout': layout, 'vr3d_check_alignment': False,
              'inject_spherical': True, 'pano_type': '360', 'stereo_mode': stereo}
    payload = {'params': params,
               'items': [{'left_input': SRC5.replace('/', '\\'),
                          'right_input': SRC5.replace('/', '\\'),
                          'output': out.replace('/', '\\')}]}
    st, r, _ = api('/api/start_vr3d', payload)
    if st != 200 or not r.get('job_id'):
        record(cid, name, f'layout={layout}', f'HTTP {st}', f'启动失败: {r}', False); return
    d = wait_terminal(r['job_id'], timeout=420)
    pf = probe(out) if d.get('status') == 'completed' else {}
    gsx = gspherical(out) if d.get('status') == 'completed' else (False, False, False, -1)
    stack_kw = 'hstack' if layout == 'side-by-side' else 'vstack'
    kws = log_grep(d, stack_kw)
    dims_ok = (pf.get('w') == 4096 and pf.get('h') == 2048)
    st_ok = gsx[2] if layout == 'side-by-side' else gsx[1]
    record(cid, name, f'layout={layout}, resolution=4096x2048(非 original, P0-2 场景)',
           f'status={d.get("status")}, err={job_failure(d) or "无"}, log含{stack_kw}={bool(kws)}, 耗时≈{(d.get("end_time",0)-d.get("start_time",0)):.0f}s',
           f'产物={json.dumps(pf, ensure_ascii=False)}, StereoMode 元数据 {"left-right" if gsx[2] else ("top-bottom" if gsx[1] else "缺失")}@{gsx[3]}',
           d.get('status') == 'completed' and dims_ok and st_ok and bool(kws))

vr3d_case('D4', 'P0-2 回归：VR3D 合成 非 original 分辨率（v3.13.1 必败场景）',
          'top-bottom', 'top-bottom', 'out_d4.mp4')
vr3d_case('D5', 'P0-5 回归：VR3D Side-by-Side 布局真实生效',
          'side-by-side', 'left-right', 'out_d5.mp4')

# ══ E 组：边界与异常 ═════════════════════════════════════════
# E1: 不存在的输入
bad_in = r'G:\264\__no_such_file__.mp4'
st, r, _ = api('/api/convert', {'mode': 'single', 'params': {'codec': 'libx264', 'test_duration': 2},
                                'items': [{'input': bad_in,
                                           'output': os.path.join(BASE_OUT, 'out_e1.mp4').replace('/', '\\')}]})
d = wait_terminal(r.get('job_id', 'x'), timeout=60) if st == 200 else {}
record('E1', '异常：输入文件不存在 → 优雅失败',
       f'input={bad_in}',
       f'status={d.get("status")}, err={job_failure(d) or "无"}',
       '任务 failed 且给出明确错误，服务存活' if d.get('status') == 'failed' and job_failure(d) else '未按预期失败',
       d.get('status') == 'failed' and bool(job_failure(d)))

# E2: 损坏文件（64KB 截断，无 moov）
st, r, _ = api('/api/convert', {'mode': 'single', 'params': {'codec': 'libx264', 'test_duration': 2},
                                'items': [{'input': CORRUPT.replace('/', '\\'),
                                           'output': os.path.join(BASE_OUT, 'out_e2.mp4').replace('/', '\\')}]})
d = wait_terminal(r.get('job_id', 'x'), timeout=90) if st == 200 else {}
alive = api('/api/version')[0] == 200
record('E2', '异常：损坏文件（截断无 moov）→ 优雅失败且服务存活',
       'input=acc_corrupt.mp4(64KB 截断)',
       f'status={d.get("status")}, err={job_failure(d) or "无"}',
       f'失败后 /api/version 存活={alive}',
       d.get('status') == 'failed' and alive and bool(job_failure(d)))

# E3: 输出到不存在的多层嵌套目录
out_e3 = os.path.join(BASE_OUT, 'deep', 'nested', 'dir', 'out_e3.mp4')
st, r, _ = api('/api/convert', {'mode': 'single', 'params': {'copy_mode': True},
                                'items': [{'input': SRC5.replace('/', '\\'),
                                           'output': out_e3.replace('/', '\\'),
                                           'params': {'copy_mode': True}}]})
d = wait_terminal(r.get('job_id', 'x'), timeout=120) if st == 200 else {}
record('E3', '边界：输出到不存在的多层嵌套目录 → 自动创建',
       f'output={out_e3}',
       f'status={d.get("status")}, err={job_failure(d) or "无"}',
       f'产物存在={os.path.isfile(out_e3)}',
       d.get('status') == 'completed' and os.path.isfile(out_e3))

# E4: 运行中取消（cancel 是 POST-only 端点）
st, r, _ = api('/api/convert', {'mode': 'single',
                                'params': {'codec': 'h264_nvenc', 'test_duration': 15, 'resolution': 'original'},
                                'items': [{'input': SRC5.replace('/', '\\'),
                                           'output': os.path.join(BASE_OUT, 'out_e4.mp4').replace('/', '\\'),
                                           'params': {'codec': 'h264_nvenc', 'test_duration': 15}}]})
j_e4 = r.get('job_id') if st == 200 else None
cancel_st, cancel_body = None, ''
if j_e4:
    time.sleep(1.5)
    cancel_st, cancel_body, _ = api(f'/api/cancel/{j_e4}', method='POST')
t0 = time.time(); d = {}
while j_e4 and time.time() - t0 < 20:
    _, d, _ = api(f'/api/status/{j_e4}')
    if d.get('status') in ('cancelled', 'completed', 'failed'): break
    time.sleep(0.4)
alive = api('/api/version')[0] == 200
record('E4', '异常：任务运行中取消 → cancelled 且服务存活',
       'h264_nvenc test15s, 启动 1.5s 后 POST /api/cancel',
       f'cancel HTTP={cancel_st}, body={str(cancel_body)[:50]}, 终态={d.get("status")}',
       f'取消生效, 服务存活={alive}',
       d.get('status') == 'cancelled' and alive)

# E5: 导出编码日志（P1-4 后端侧，用 B1 的 job）
st, lg, _ = api(f'/api/encode_log/{jid_b1}') if jid_b1 else (0, {}, {})
body = lg.get('log') if isinstance(lg, dict) else str(lg)
record('E5', '导出编码日志（任务完成后）',
       f'GET /api/encode_log/{jid_b1}',
       f'HTTP {st}, 日志长度={len(body) if body else 0}',
       (body or '')[:120].replace('\n', ' '),
       st == 200 and bool(body) and 'libx264' in str(body))

# ══ 收尾 ═════════════════════════════════════════════════════
st_final, ver_final, _ = api('/api/version')
record('Z1', '全部用例结束后服务仍存活',
       'GET /api/version', f'HTTP {st_final}',
       f'version={ver_final.get("version") if isinstance(ver_final, dict) else "?"}',
       st_final == 200 and isinstance(ver_final, dict) and ver_final.get('version') == '3.13.2')

passed = sum(1 for x in RESULTS if x['pass'])
print(f'\n════ 验收测试完成：{passed}/{len(RESULTS)} PASS ════', flush=True)
with open(os.path.join(BASE_OUT, 'results.json'), 'w', encoding='utf-8') as f:
    json.dump(RESULTS, f, ensure_ascii=False, indent=2)
print('results.json 已写入', flush=True)
sys.exit(0 if passed == len(RESULTS) else 1)

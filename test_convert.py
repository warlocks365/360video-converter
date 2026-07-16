import urllib.request, json, time

BASE = 'http://localhost:8765'

def api(path, method='GET', data=None):
    if data:
        req = urllib.request.Request(
            f'{BASE}{path}', method=method,
            data=json.dumps(data).encode(),
            headers={'Content-Type': 'application/json'}
        )
    else:
        req = urllib.request.Request(f'{BASE}{path}', method=method)
    resp = urllib.request.urlopen(req)
    return json.loads(resp.read())

# 1. Probe existing file
print('=== Probe test_360_10s.mp4 ===')
try:
    import urllib.parse
    path = urllib.parse.quote(r'C:\msys64\tmp\test_360_10s.mp4')
    r = api(f'/api/probe?path={path}')
    v = r.get('streams', [{}])[0]
    print(f'  codec: {v.get("codec_name")}, profile: {v.get("profile")}')
    print(f'  resolution: {v.get("width")}x{v.get("height")}')
    print(f'  duration: {r.get("format", {}).get("duration", "?")}s')
except Exception as e:
    print(f'  Error: {e}')

# 2. Start a quick conversion (3-second test clip)
print('\n=== Starting test conversion ===')
params = {
    'resolution': '4096x2048', 'profile': 'high', 'level': '5.1',
    'pix_fmt': 'yuv420p', 'color_range': 'tv', 'color_space': 'bt709',
    'color_primaries': 'bt709', 'color_trc': 'bt709',
    'bf': 3, 'refs': 5, 'gop': 48, 'sc_threshold': 0,
    'rate_mode': 'crf', 'crf': 23, 'maxrate': '40M', 'bufsize': '20M',
    'target_bitrate': '50000k', 'preset': 'ultrafast',
    'x264_params': 'hrd=1:pic_init_qp=26',
    'audio_bitrate': '96k', 'audio_sample_rate': '48000',
    'audio_channels': 2, 'audio_profile': 'aac_low',
    'brand': 'mp42', 'faststart': True, 'inject_spherical': True,
}
items = [{
    'input': r'C:\msys64\tmp\test_360_10s.mp4',
    'output': r'C:\msys64\tmp\test_ui_convert.mp4',
}]
result = api('/api/convert', 'POST', {'mode': 'single', 'params': params, 'items': items})
jid = result['job_id']
print(f'  Job ID: {jid}')

# 3. Poll status
for i in range(60):
    time.sleep(2)
    status = api(f'/api/status/{jid}')
    print(f'  [{i*2}s] status={status["status"]} file={status["file_progress"]}% overall={status["overall_progress"]}%')
    # Show last log line
    if status['log']:
        last = status['log'][-1]
        print(f'        log: {last["ts"]} {last["msg"][:80]}')
    if status['status'] in ('completed', 'cancelled'):
        break

print(f'\n=== Final status: {status["status"]} ===')
if status['status'] == 'completed':
    print('  SUCCESS! Conversion pipeline working.')
else:
    print(f'  Logs:')
    for l in status['log'][-10:]:
        print(f'    {l["ts"]} [{l["level"]}] {l["msg"][:100]}')

import urllib.request, json

# Test scan
data = json.dumps({'directory': r'C:\msys64\tmp', 'recursive': False}).encode()
req = urllib.request.Request('http://localhost:8765/api/scan', data=data, headers={'Content-Type': 'application/json'})
try:
    resp = urllib.request.urlopen(req)
    result = json.loads(resp.read())
    print('=== Scan result ===')
    print(f'Found {result["count"]} files')
    for f in result['files'][:5]:
        print(f'  {f["name"]} ({f["size_mb"]} MB)')
except Exception as e:
    print(f'Scan error: {e}')

# Test formula preview
data2 = json.dumps({
    'formula': '{source_dir}/{name}_360.mp4',
    'params': {},
    'files': [r'D:\Videos\test1.mp4', r'D:\Videos\subdir\test2.mov']
}).encode()
req2 = urllib.request.Request('http://localhost:8765/api/preview_formula', data=data2, headers={'Content-Type': 'application/json'})
try:
    resp2 = urllib.request.urlopen(req2)
    result2 = json.loads(resp2.read())
    print('\n=== Formula preview ===')
    for r in result2['results']:
        print(f'  {r["input"]} -> {r["output"]}')
except Exception as e:
    print(f'Formula error: {e}')

# Test probe
try:
    resp3 = urllib.request.urlopen('http://localhost:8765/api/probe?path=' + urllib.request.quote(r'C:\msys64\tmp\test_360_fixed.mp4'))
    result3 = json.loads(resp3.read())
    v = result3.get('streams', [{}])[0]
    print(f'\n=== Probe result ===')
    print(f'  codec: {v.get("codec_name")}, profile: {v.get("profile")}')
    print(f'  resolution: {v.get("width")}x{v.get("height")}')
    sd = v.get('side_data_list', [])
    if sd:
        print(f'  side_data: {sd[0].get("side_data_type", "?")}')
except Exception as e:
    print(f'Probe error: {e}')

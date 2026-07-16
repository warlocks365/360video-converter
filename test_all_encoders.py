#!/usr/bin/env python3
"""
test_all_encoders.py - Test all encoding functions with 10-second test encoding.
Starts Flask backend, submits conversion jobs via API, monitors progress, reports results.
"""

import sys
import os
import time
import json
import urllib.request
import urllib.error
import threading

# Add project dir to path
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPT_DIR)

# Import app module (but don't run __main__)
import app as app_module

PORT = 8766  # Use different port to avoid conflicts
BASE_URL = f'http://127.0.0.1:{PORT}'

# Test video file
TEST_VIDEO = r'C:\Users\warlocks\Videos\原片\20260627 乌兰哈达火山 露营车拍摄.mp4'
TEST_OUTPUT_DIR = os.path.join(os.environ.get('TEMP', r'C:\temp'), '360vc_test_output')
os.makedirs(TEST_OUTPUT_DIR, exist_ok=True)


def start_server():
    """Start Flask server in a background thread."""
    def run():
        app_module.app.run(host='127.0.0.1', port=PORT, debug=False, threaded=True)
    t = threading.Thread(target=run, daemon=True)
    t.start()
    # Wait for server to start
    for _ in range(30):
        try:
            urllib.request.urlopen(f'{BASE_URL}/api/version', timeout=1)
            print(f'[OK] Server started on port {PORT}')
            return True
        except:
            time.sleep(0.3)
    print('[FAIL] Server did not start')
    return False


def api_call(path, method='GET', data=None):
    """Make an API call and return the response."""
    url = f'{BASE_URL}{path}'
    headers = {'Content-Type': 'application/json'}
    req = urllib.request.Request(url, method=method, headers=headers)
    if data:
        req.data = json.dumps(data).encode('utf-8')
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        body = e.read().decode('utf-8')
        return {'error': f'HTTP {e.code}: {body}'}
    except Exception as e:
        return {'error': str(e)}


def wait_for_job(jid, timeout=120):
    """Wait for a job to complete, polling status every 1s. Returns final status."""
    start = time.time()
    last_progress = -1
    while time.time() - start < timeout:
        status = api_call(f'/api/status/{jid}')
        if not status:
            print(f'  [ERROR] Status check returned None')
            return None
        err = status.get('error')
        if err:
            print(f'  [ERROR] Status check failed: {err}')
            return None

        prog = status.get('file_progress', 0)
        overall = status.get('overall_progress', 0)
        st = status.get('status', 'unknown')

        if prog != last_progress:
            print(f'  [{time.time()-start:.1f}s] status={st} file={prog:.1f}% overall={overall:.1f}%')
            last_progress = prog

        if st in ('completed', 'failed', 'cancelled'):
            return status

        time.sleep(1)

    print(f'  [TIMEOUT] Job did not complete within {timeout}s')
    return None


def get_job_log(jid):
    """Get the full job log."""
    result = api_call(f'/api/encode_log/{jid}')
    if isinstance(result, dict) and 'log' in result:
        return result['log']
    return str(result)


def test_encoder(codec, rate_mode='crf', label=''):
    """Test a specific encoder with 10-second test encoding."""
    print(f'\n{"="*60}')
    print(f'  TEST: {codec} ({rate_mode}) - {label}')
    print(f'{"="*60}')

    output_file = os.path.join(TEST_OUTPUT_DIR, f'test_{codec}_{rate_mode}.mp4')

    params = {
        'codec': codec,
        'resolution': '4096x2048',
        'rate_mode': rate_mode,
        'crf': 23,
        'preset': 'fast',
        'test_duration': 10,
        'inject_spherical': True,
        'date_from_filename': True,
        'set_creation_time': True,
        'set_file_created': True,
        'set_file_modified': True,
        'profile': 'high',
        'pix_fmt': 'yuv420p',
        'color_range': 'tv',
        'color_space': 'bt709',
        'color_primaries': 'bt709',
        'color_trc': 'bt709',
        'bf': 3,
        'refs': 5,
        'gop': 48,
        'sc_threshold': 0,
        'maxrate': '40M',
        'bufsize': '20M',
        'target_bitrate': '50000k',
        'x264_params': 'hrd=1:pic_init_qp=26',
        'x265_params': '',
        'audio_codec': 'aac',
        'audio_profile': 'aac_low',
        'audio_bitrate': '96k',
        'audio_sample_rate': '48000',
        'audio_channels': 2,
        'brand': 'mp42',
        'faststart': True,
    }

    # For NVENC, adjust preset
    if 'nvenc' in codec or 'amf' in codec:
        if codec.startswith('h264'):
            params['preset'] = 'p4'
        else:
            params['preset'] = 'p4'
        params['x264_params'] = ''

    items = [{'input': TEST_VIDEO, 'output': output_file}]

    result = api_call('/api/convert', method='POST', data={
        'mode': 'single',
        'params': params,
        'items': items,
    })

    if 'error' in result:
        print(f'  [FAIL] Could not start job: {result["error"]}')
        return False

    jid = result.get('job_id')
    if not jid:
        print(f'  [FAIL] No job_id returned: {result}')
        return False

    print(f'  Job ID: {jid}')

    # Wait for completion (10s test encoding should take < 120s even for software encoders)
    timeout = 600 if 'libx265' in codec else 180
    status = wait_for_job(jid, timeout=timeout)

    if status is None:
        print(f'  [FAIL] Job timed out or errored')
        log = get_job_log(jid)
        print(f'  Log:\n{log}')
        return False

    st = status.get('status')
    prog = status.get('file_progress', 0)
    print(f'  Final: status={st}, file_progress={prog:.1f}%')

    if st == 'completed':
        # Check if output file exists
        test_output = output_file.replace('.mp4', '_test.mp4')
        if os.path.exists(test_output):
            size_mb = os.path.getsize(test_output) / 1024 / 1024
            print(f'  [OK] Output file: {test_output} ({size_mb:.1f} MB)')
            return True
        elif os.path.exists(output_file):
            size_mb = os.path.getsize(output_file) / 1024 / 1024
            print(f'  [OK] Output file: {output_file} ({size_mb:.1f} MB)')
            return True
        else:
            print(f'  [FAIL] Job completed but output file not found')
            log = get_job_log(jid)
            print(f'  Log:\n{log}')
            return False
    else:
        print(f'  [FAIL] Job status: {st}')
        log = get_job_log(jid)
        print(f'  Log:\n{log}')
        return False


def test_metadata_tool():
    """Test the standalone metadata tool (ffmpeg -c copy)."""
    print(f'\n{"="*60}')
    print(f'  TEST: Metadata Tool (date + spherical injection, no re-encode)')
    print(f'{"="*60}')

    output_file = os.path.join(TEST_OUTPUT_DIR, 'test_metadata.mp4')

    params = {
        'apply_date': True,
        'apply_location': False,
        'apply_spherical': True,
        'date_from_filename': True,
        'set_creation_time': True,
        'set_file_created': True,
        'set_file_modified': True,
        'manual_date': '',
        'faststart': True,
        'test_duration': 10,  # Only process first 10 seconds for testing
    }

    items = [{'input': TEST_VIDEO, 'output': output_file}]

    result = api_call('/api/apply_metadata', method='POST', data={
        'params': params,
        'items': items,
    })

    if 'error' in result:
        print(f'  [FAIL] Could not start job: {result["error"]}')
        return False

    jid = result.get('job_id')
    print(f'  Job ID: {jid}')

    status = wait_for_job(jid, timeout=120)

    if status and status.get('status') == 'completed':
        # In test mode, output has _test suffix
        test_output = output_file.replace('.mp4', '_test.mp4')
        check_file = test_output if os.path.exists(test_output) else output_file
        if os.path.exists(check_file):
            size_mb = os.path.getsize(check_file) / 1024 / 1024
            print(f'  [OK] Output file: {check_file} ({size_mb:.1f} MB)')
        return True
    else:
        st = status.get('status') if status else 'None'
        print(f'  [FAIL] Job status: {st}')
        log = get_job_log(jid)
        print(f'  Log:\n{log}')
        return False


def test_metadata_report():
    """Test the metadata/probe report."""
    print(f'\n{"="*60}')
    print(f'  TEST: Metadata Report (ffprobe)')
    print(f'{"="*60}')

    # /api/probe uses GET with query params, not POST
    import urllib.parse
    encoded_path = urllib.parse.quote(TEST_VIDEO)
    result = api_call(f'/api/probe?path={encoded_path}')

    if 'error' in result:
        print(f'  [FAIL] Probe failed: {result["error"]}')
        return False

    # Print some key info
    streams = result.get('streams', [])
    format_info = result.get('format', {})
    print(f'  Format: {format_info.get("format_name", "unknown")}')
    print(f'  Duration: {float(format_info.get("duration", 0)):.1f}s')
    for s in streams:
        if s.get('codec_type') == 'video':
            print(f'  Video: {s.get("codec_name")} {s.get("width")}x{s.get("height")} @{s.get("r_frame_rate")}')
        elif s.get('codec_type') == 'audio':
            print(f'  Audio: {s.get("codec_name")} {s.get("sample_rate")}Hz {s.get("channels")}ch')

    print(f'  [OK] Probe report generated')
    return True


def main():
    print('='*60)
    print('  360 Video Converter - Full Encoding Test Suite')
    print(f'  Test video: {TEST_VIDEO}')
    print(f'  Output dir: {TEST_OUTPUT_DIR}')
    print('='*60)

    # Start server
    if not start_server():
        sys.exit(1)

    # Check version
    ver = api_call('/api/version')
    print(f'  App version: {ver.get("version", "unknown")}')

    # Check available codecs
    codecs = api_call('/api/codecs')
    print(f'  Available codecs: {codecs}')

    results = {}

    # Test 1: libx264 CRF
    results['libx264_crf'] = test_encoder('libx264', 'crf', 'H.264 software CRF')

    # Test 2: libx265 CRF
    results['libx265_crf'] = test_encoder('libx265', 'crf', 'H.265 software CRF')

    # Test 3: libx264 2-pass
    results['libx264_2pass'] = test_encoder('libx264', '2pass', 'H.264 software 2-pass')

    # Test 4: h264_nvenc
    results['h264_nvenc'] = test_encoder('h264_nvenc', 'crf', 'H.264 NVENC hardware')

    # Test 5: hevc_nvenc
    results['hevc_nvenc'] = test_encoder('hevc_nvenc', 'crf', 'H.265 NVENC hardware')

    # Test 6: Metadata tool
    results['metadata_tool'] = test_metadata_tool()

    # Test 7: Metadata report
    results['metadata_report'] = test_metadata_report()

    # Summary
    print(f'\n{"="*60}')
    print(f'  TEST RESULTS SUMMARY')
    print(f'{"="*60}')
    for name, result in results.items():
        if result == 'SKIP':
            status = 'SKIP'
        elif result is True:
            status = 'PASS'
        else:
            status = 'FAIL'
        print(f'  {name:30s} {status}')

    failed = [k for k, v in results.items() if v is False]
    if failed:
        print(f'\n  {len(failed)} test(s) FAILED: {", ".join(failed)}')
        sys.exit(1)
    else:
        print(f'\n  All tests PASSED!')
        sys.exit(0)


if __name__ == '__main__':
    main()

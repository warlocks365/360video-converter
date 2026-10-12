#!/usr/bin/env python3
"""
360° Video Converter - Flask Backend
Batch convert 360 panoramic videos with ffmpeg + GSpherical metadata injection.
Supports: codec selection (H.264/H.265/NVENC/QSV/AMF), date metadata from filename,
          GPS location metadata via AMap integration.
"""

import os, sys, json, re, time, subprocess, threading, uuid as uuid_mod, struct, tempfile
import ctypes
import platform as platform_module
import urllib.request
import urllib.parse
import ssl as _ssl
from pathlib import Path, PurePath
from datetime import datetime
from flask import Flask, request, jsonify, send_from_directory

# ── Windows: suppress console window for all subprocess calls ──
NO_WINDOW = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0

# ── HTTPS SSL context (certifi CA bundle with robust fallback) ──
# Some Windows systems have an incomplete/outdated system CA store, causing
# 'CERTIFICATE VERIFY FAILED' when verifying the AMap cert chain. We prefer
# the certifi Mozilla CA bundle (cross-platform, regularly updated), then
# fall back to the system store, then (last resort) an unverified context.
#
# IMPORTANT: certifi 2026.x uses importlib.resources.as_file() to locate
# cacert.pem, which can FAIL under PyInstaller onefile frozen mode (the
# resource extraction to a temp file may break). So we use multiple
# strategies to find cacert.pem, and — crucially — we also retry urlopen
# with an unverified context if SSL verification fails at request time.
_HTTPS_SSL_CONTEXT = None

def _find_certifi_cafile():
    """Locate certifi's cacert.pem with multiple strategies for frozen mode."""
    try:
        import certifi
    except ImportError:
        return None
    # Strategy 1: certifi.where() (works in dev; may fail/return bad path frozen)
    try:
        cafile = certifi.where()
        if cafile and os.path.exists(cafile):
            return cafile
    except Exception:
        pass
    # Strategy 2: look directly in _MEIPASS (PyInstaller onefile extracts here)
    meipass = getattr(sys, '_MEIPASS', None)
    if meipass:
        for p in (os.path.join(meipass, 'certifi', 'cacert.pem'),
                  os.path.join(meipass, 'cacert.pem')):
            if os.path.exists(p):
                return p
    # Strategy 3: relative to the certifi package __file__
    try:
        pkg_dir = os.path.dirname(os.path.abspath(certifi.__file__))
        p = os.path.join(pkg_dir, 'cacert.pem')
        if os.path.exists(p):
            return p
    except Exception:
        pass
    # Strategy 4: certifi.contents() → write to a temp file (last resort for certifi)
    try:
        content = certifi.contents()
        fd, tmp = tempfile.mkstemp(suffix='.pem', prefix='certifi_ca_')
        with os.fdopen(fd, 'w') as f:
            f.write(content)
        return tmp
    except Exception:
        pass
    return None

def _get_https_ssl_context():
    """Return a cached SSLContext for HTTPS urllib calls.

    Tries (in order): certifi CA bundle → system default → unverified.
    Note: this only chooses the initial context; if verification fails at
    urlopen time, _https_urlopen() retries with an unverified context.
    """
    global _HTTPS_SSL_CONTEXT
    if _HTTPS_SSL_CONTEXT is not None:
        return _HTTPS_SSL_CONTEXT
    # Try 1: certifi CA bundle (Mozilla, cross-platform, regularly updated)
    cafile = _find_certifi_cafile()
    if cafile:
        try:
            _HTTPS_SSL_CONTEXT = _ssl.create_default_context(cafile=cafile)
            return _HTTPS_SSL_CONTEXT
        except Exception:
            pass
    # Try 2: system default CA store
    try:
        _HTTPS_SSL_CONTEXT = _ssl.create_default_context()
        return _HTTPS_SSL_CONTEXT
    except Exception:
        pass
    # Try 3 (last resort): unverified — keeps app functional
    _HTTPS_SSL_CONTEXT = _ssl._create_unverified_context()
    return _HTTPS_SSL_CONTEXT

def _https_urlopen(url, timeout=10):
    """urlopen with automatic SSL fallback.

    First tries the preferred (verifying) context. If SSL verification
    fails at request time, retries with an unverified context and caches
    it so subsequent calls skip the failing verify step. This guarantees
    the AMap API stays reachable even on systems with broken CA stores.
    """
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    try:
        return urllib.request.urlopen(req, timeout=timeout,
                                       context=_get_https_ssl_context())
    except urllib.error.URLError as e:
        err_str = str(e)
        if ('CERTIFICATE VERIFY FAILED' in err_str or
                'certificate verify failed' in err_str or
                'unable to get local issuer certificate' in err_str):
            # SSL verification failed — switch to unverified and retry
            global _HTTPS_SSL_CONTEXT
            _HTTPS_SSL_CONTEXT = _ssl._create_unverified_context()
            req2 = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
            return urllib.request.urlopen(req2, timeout=timeout,
                                           context=_HTTPS_SSL_CONTEXT)
        raise

# ── Configuration ──────────────────────────────────────────────
BASE_DIR     = os.path.dirname(os.path.abspath(__file__))

# When running as PyInstaller exe, detect bundled paths
if getattr(sys, 'frozen', False):
    BASE_DIR     = os.path.dirname(sys.executable)
    _bundle_dir  = sys._MEIPASS
    # ffmpeg/ffprobe expected alongside the exe (not inside _MEIPASS to avoid huge single-file)
    FFMPEG_PATH  = os.path.join(BASE_DIR, 'ffmpeg.exe')
    FFPROBE_PATH = os.path.join(BASE_DIR, 'ffprobe.exe')
    FFMPEG_BIN   = BASE_DIR
    MINGW_BIN    = BASE_DIR
    # User data (presets, tasks, settings) goes to %APPDATA% to avoid
    # write-permission issues when installed in Program Files
    _appdata = os.environ.get('APPDATA', os.path.expanduser('~'))
    PRESETS_DIR  = os.path.join(_appdata, '360VideoConverter', 'presets')
    # inject_spherical_metadata is bundled inside _MEIPASS
    sys.path.insert(0, _bundle_dir)
else:
    # Priority: ffmpeg-static/ (has hardware encoders) > shared build > PATH
    _static_ffmpeg = os.path.join(BASE_DIR, 'ffmpeg-static', 'ffmpeg.exe')
    _static_ffprobe = os.path.join(BASE_DIR, 'ffmpeg-static', 'ffprobe.exe')
    if os.path.isfile(_static_ffmpeg):
        FFMPEG_PATH  = _static_ffmpeg
        FFPROBE_PATH = _static_ffprobe if os.path.isfile(_static_ffprobe) else os.environ.get('FFPROBE_PATH', r'C:\ffmpeg-dev\ffmpeg-build\bin\ffprobe.exe')
    else:
        FFMPEG_PATH  = os.environ.get('FFMPEG_PATH',  r'C:\ffmpeg-dev\ffmpeg-build\bin\ffmpeg.exe')
        FFPROBE_PATH = os.environ.get('FFPROBE_PATH', r'C:\ffmpeg-dev\ffmpeg-build\bin\ffprobe.exe')
    FFMPEG_BIN   = os.path.dirname(FFMPEG_PATH)
    MINGW_BIN    = r'C:\msys64\mingw64\bin'
    PRESETS_DIR  = os.path.join(BASE_DIR, 'presets')
    # Try local dir first, then workspace
    _local_meta = os.path.join(BASE_DIR, 'inject_spherical_metadata.py')
    if os.path.exists(_local_meta):
        sys.path.insert(0, BASE_DIR)
    else:
        _ws = r'C:\Users\warlocks\WorkBuddy\2026-07-14-13-37-44'
        sys.path.insert(0, _ws)

os.makedirs(PRESETS_DIR, exist_ok=True)

# Task persistence and settings files
TASKS_FILE   = os.path.join(PRESETS_DIR, '_last_task.json')
SETTINGS_FILE = os.path.join(PRESETS_DIR, '_settings.json')

# Fallback: if ffmpeg not found locally, search in PATH
def _find_in_path(name):
    for d in os.environ.get('PATH', '').split(os.pathsep):
        p = os.path.join(d, name)
        if os.path.isfile(p):
            return p
    return None

if not os.path.isfile(FFMPEG_PATH):
    found = _find_in_path('ffmpeg.exe')
    if found:
        FFMPEG_PATH = found
        FFMPEG_BIN = os.path.dirname(found)
if not os.path.isfile(FFPROBE_PATH):
    found = _find_in_path('ffprobe.exe')
    if found:
        FFPROBE_PATH = found

# Import the metadata injection module
try:
    from inject_spherical_metadata import inject_uuid, read_gspherical, inject_uuid_inplace, relocate_moov_front
except ImportError:
    inject_uuid = None
    read_gspherical = None
    print('[WARN] inject_spherical_metadata not found -- injection disabled')

# Import the system resource monitor (global singleton)
try:
    from sysmon import get_global_sysmon, shutdown_global_sysmon
    _sysmon_available = True
except ImportError:
    _sysmon_available = False
    print('[WARN] sysmon not found -- resource monitoring disabled')

# Import the video stabilization module
try:
    from stabilize import (detect_video_type, vidstab_detect,
                           vidstab_transform_filter, stabilize_panoramic)
    STAB_AVAILABLE = True
except ImportError:
    detect_video_type = None
    vidstab_detect = None
    vidstab_transform_filter = None
    stabilize_panoramic = None
    STAB_AVAILABLE = False
    print('[WARN] stabilize not found -- video stabilization disabled')

app = Flask(__name__, static_folder='static', static_url_path='')


@app.after_request
def _disable_cache_for_ui(response):
    """禁用 WebView2 对界面资源的缓存。

    背景：应用通过 http://127.0.0.1:<port>/ 提供界面，各版本使用**同一个 URL**。
    WebView2（Chromium）会按 URL 做磁盘缓存，而 Flask 对静态文件只发
    Last-Modified/ETag、不发 Cache-Control，浏览器会套用启发式新鲜度，
    于是可能直接复用上一個版本缓存的 index.html —— 表现为"装了新版本但界面毫无变化"，
    且控制台无报错、无失败请求，极难定位（v3.12.0 排查时即遇到该风险点）。

    这里对 HTML 与静态资源统一禁用缓存：本应用是本地单机、资源极小，
    代价可忽略，换来的是"安装即生效"的确定性。
    API 响应不在此列（它们本就应当每次实时计算）。
    """
    if not request.path.startswith('/api/'):
        response.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
        response.headers['Pragma'] = 'no-cache'
        response.headers['Expires'] = '0'
    return response

# Read app version from VERSION file
def _read_app_version():
    # When bundled by PyInstaller (onefile), VERSION is extracted into sys._MEIPASS
    if getattr(sys, 'frozen', False):
        meipass = getattr(sys, '_MEIPASS', None)
        if meipass:
            p = os.path.join(meipass, 'VERSION')
            if os.path.isfile(p):
                try:
                    with open(p, 'r') as f:
                        return f.read().strip()
                except Exception:
                    pass
    # Dev / editable build: look relative to this file, its parent, and cwd
    version_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'VERSION')
    if os.path.isfile(version_file):
        try:
            with open(version_file, 'r') as f:
                return f.read().strip()
        except Exception:
            pass
    for p in [os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'VERSION'),
              os.path.join(os.getcwd(), 'VERSION')]:
        p = os.path.normpath(p)
        if os.path.isfile(p):
            try:
                with open(p, 'r') as f:
                    return f.read().strip()
            except Exception:
                pass
    return 'unknown'

APP_VERSION = _read_app_version()

VIDEO_EXTS = {'.mp4', '.mov', '.mkv', '.avi', '.insv', '.lrv', '.ts', '.m2ts', '.flv', '.wmv'}
INSTA360_VIDEO_EXTS = {'.insv', '.lrv'}    # Insta360 video formats (MP4 with trailer metadata)
INSTA360_PHOTO_EXTS = {'.insp'}             # Insta360 photo format (JPEG with trailer metadata)

# ── Codec Profiles ─────────────────────────────────────────────
CODEC_PROFILES = {
    'libx264': {
        'label': 'H.264 (libx264 软件编码)',
        'group': 'cpu',
        'encoder': 'libx264',
        'tag': None,
        'has_profile': True,
        'profiles': ['high', 'main', 'baseline'],
        'has_x264_params': True,
        'x265_params': False,
        'preset_key': '-preset',
        'presets': ['ultrafast','superfast','veryfast','faster','fast','medium','slow','slower'],
        'default_preset': 'fast',
        'default_crf': 23,
        'has_bf_refs': True,
        'has_sc_threshold': True,
    },
    'libx265': {
        'label': 'H.265/HEVC (libx265 软件编码)',
        'group': 'cpu',
        'encoder': 'libx265',
        'tag': 'hvc1',
        'has_profile': False,
        'has_x264_params': False,
        'x265_params': True,
        'preset_key': '-preset',
        'presets': ['ultrafast','superfast','veryfast','faster','fast','medium','slow','slower'],
        'default_preset': 'fast',
        'default_crf': 28,
        'has_bf_refs': True,
        'has_sc_threshold': False,
    },
    'h264_nvenc': {
        'label': 'H.264 (NVIDIA NVENC 硬件编码)',
        'group': 'cuda',
        'encoder': 'h264_nvenc',
        'tag': None,
        'has_profile': True,
        'profiles': ['high', 'main', 'baseline'],
        'has_x264_params': False,
        'x265_params': False,
        'preset_key': '-preset',
        'presets': ['p1','p2','p3','p4','p5','p6','p7'],
        'default_preset': 'p4',
        'default_crf': 23,
        'has_bf_refs': True,
        'has_sc_threshold': False,
    },
    'hevc_nvenc': {
        'label': 'H.265/HEVC (NVIDIA NVENC 硬件编码)',
        'group': 'cuda',
        'encoder': 'hevc_nvenc',
        'tag': 'hvc1',
        'has_profile': False,
        'has_x264_params': False,
        'x265_params': False,
        'preset_key': '-preset',
        'presets': ['p1','p2','p3','p4','p5','p6','p7'],
        'default_preset': 'p4',
        'default_crf': 28,
        'has_bf_refs': True,
        'has_sc_threshold': False,
    },
    'h264_qsv': {
        'label': 'H.264 (Intel QSV 硬件编码)',
        'group': 'qsv',
        'encoder': 'h264_qsv',
        'tag': None,
        'has_profile': True,
        'profiles': ['high', 'main', 'baseline'],
        'has_x264_params': False,
        'x265_params': False,
        'preset_key': '-preset',
        'presets': ['veryfast','faster','fast','medium','slow','slower'],
        'default_preset': 'fast',
        'default_crf': 23,
        'has_bf_refs': False,
        'has_sc_threshold': False,
    },
    'hevc_qsv': {
        'label': 'H.265/HEVC (Intel QSV 硬件编码)',
        'group': 'qsv',
        'encoder': 'hevc_qsv',
        'tag': 'hvc1',
        'has_profile': False,
        'has_x264_params': False,
        'x265_params': False,
        'preset_key': '-preset',
        'presets': ['veryfast','faster','fast','medium','slow','slower'],
        'default_preset': 'fast',
        'default_crf': 28,
        'has_bf_refs': False,
        'has_sc_threshold': False,
    },
    'h264_amf': {
        'label': 'H.264 (AMD AMF 硬件编码)',
        'group': 'amf',
        'encoder': 'h264_amf',
        'tag': None,
        'has_profile': True,
        'profiles': ['high', 'main', 'baseline'],
        'has_x264_params': False,
        'x265_params': False,
        'preset_key': '-quality',
        'presets': ['speed','balanced','quality'],
        'default_preset': 'balanced',
        'default_crf': 23,
        'has_bf_refs': False,
        'has_sc_threshold': False,
    },
    'hevc_amf': {
        'label': 'H.265/HEVC (AMD AMF 硬件编码)',
        'group': 'amf',
        'encoder': 'hevc_amf',
        'tag': 'hvc1',
        'has_profile': False,
        'has_x264_params': False,
        'x265_params': False,
        'preset_key': '-quality',
        'presets': ['speed','balanced','quality'],
        'default_preset': 'balanced',
        'default_crf': 28,
        'has_bf_refs': False,
        'has_sc_threshold': False,
    },
}

DEFAULT_PARAMS = {
    'codec':            'libx264',
    'resolution':       '4096x2048',
    'profile':          'high',
    'level':            '5.1',
    'pix_fmt':          'yuv420p',
    'color_range':      'tv',
    'color_space':      'bt709',
    'color_primaries':  'bt709',
    'color_trc':        'bt709',
    'bf':               3,
    'refs':             5,
    'gop':              48,
    'sc_threshold':     0,
    'rate_mode':        'crf',
    'crf':              23,
    'maxrate':          '40M',
    'bufsize':          '20M',
    'target_bitrate':   '50000k',
    'preset':           'fast',
    'x264_params':      '',
    'x265_params':      '',
    'audio_codec':      'aac',
    'audio_profile':    'aac_low',
    'audio_bitrate':    '96k',
    'audio_sample_rate':'48000',
    'audio_channels':   2,
    'brand':            'mp42',
    'faststart':        True,
    'inject_spherical': True,
    'pano_type':        '360',     # '360' or '180'
    'stereo_mode':      'mono',    # 'mono' (2D), 'left-right' (3D SBS), 'top-bottom' (3D TB)
    # Date metadata options
    'date_from_filename':   False,
    'set_creation_time':    True,   # Write creation_time metadata tag
    'set_file_created':     True,   # Set filesystem creation date
    'set_file_modified':    True,   # Set filesystem modification date
    'manual_date':          '',     # Override date (YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS)
    # Location metadata options
    'set_location':     False,
    'location_name':    '',
    'location_address': '',
    'location_lat':     '',
    'location_lon':     '',
    'amap_api_key':     '',
    # Video stabilization (v3.0)
    'stabilize':            False,   # master switch
    'stabilize_smoothing':  30,      # smoothing window (frames)
    'stabilize_shakiness':  5,       # vidstab shakiness estimate (1-10)
    'stabilize_zoom':       0.05,    # zoom/border fill ratio (0-0.2)
    # Insta360 native file processing (v3.9.0)
    'insv_stitch':          True,    # convert dual-fisheye to equirectangular via v360 filter
    'insv_stabilize':       False,   # Insta360 FlowState alternative (vidstab)
    'insv_direction_lock':   False,   # horizon leveling / direction lock
    'insv_denoise':          False,   # noise reduction (hqdn3d filter)
}

DEFAULT_BATCH_FORMULA = '{project_dir}/{name}_360.mp4'

# ── Date Extraction ────────────────────────────────────────────
DATE_PATTERNS = [
    # Full datetime with separators: 2024-01-15_14-30-00 or 2024_01_15_14_30_00 or 2024-01-15T14:30:00
    (re.compile(r'(\d{4})[-_](\d{1,2})[-_](\d{1,2})[-_T ](\d{1,2})[-_:](\d{1,2})[-_:](\d{1,2})'), 'datetime'),
    # Full datetime compact with sep: 20240115_143000 or 20240115-143000 (Insta360/GoPro style)
    (re.compile(r'(?<!\d)(20\d{2})(\d{2})(\d{2})[-_](\d{2})(\d{2})(\d{2})(?!\d)'), 'datetime_compact'),
    # Full datetime all compact: 20240115143000 (14 consecutive digits)
    (re.compile(r'(?<!\d)(20\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?!\d)'), 'datetime_compact'),
    # Date with separators: 2024-01-15 or 2024_01_15
    (re.compile(r'(\d{4})[-_](\d{1,2})[-_](\d{1,2})(?!\d)'), 'date'),
    # Date compact: 20240115 (8 consecutive digits starting with 20, not preceded/followed by digit)
    (re.compile(r'(?<!\d)(20\d{2})(\d{2})(\d{2})(?!\d)'), 'date_compact'),
]

def extract_date_from_filename(filename):
    """Extract date/datetime from filename. Returns (datetime_str or None, parsed_datetime or None)."""
    name = Path(filename).stem

    for pattern, dtype in DATE_PATTERNS:
        m = pattern.search(name)
        if not m:
            continue
        try:
            groups = m.groups()
            if dtype in ('datetime', 'datetime_compact'):
                y, mo, d, h, mi, s = groups
                dt = datetime(int(y), int(mo), int(d), int(h), int(mi), int(s))
            elif dtype in ('date', 'date_compact'):
                y, mo, d = groups
                dt = datetime(int(y), int(mo), int(d), 12, 0, 0)
            else:
                continue
            # Sanity check
            if dt.year < 2000 or dt.year > 2099:
                continue
            return dt.strftime('%Y-%m-%dT%H:%M:%S'), dt
        except (ValueError, IndexError):
            continue

    return None, None


def set_file_dates(filepath, dt, set_created=True, set_modified=True):
    """Set file creation and/or modification dates on Windows."""
    results = {'created': False, 'modified': False}

    # Unix timestamp
    ts = dt.timestamp()

    # Set modification and access time (works on all platforms)
    if set_modified:
        try:
            os.utime(filepath, (ts, ts))
            results['modified'] = True
        except Exception as e:
            results['modified_error'] = str(e)

    # Set creation time (Windows only via ctypes)
    # FIX (v3.13.3 BUG-2): the old call relied on ctypes' default restype (c_int).
    # On 64-bit Python a HANDLE must be read as c_void_p — the truncated value broke
    # the INVALID_HANDLE_VALUE check and SetFileTime silently failed, so the file
    # creation time was NEVER applied (verified: in-app job log had no success line
    # and ctime unchanged, while .NET SetCreationTime works on the same volume).
    # Explicit argtypes/restype + use_last_error make any remaining failure diagnosable.
    if set_created and os.name == 'nt':
        try:
            import ctypes
            from ctypes import wintypes

            kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
            kernel32.CreateFileW.restype = ctypes.c_void_p
            kernel32.CreateFileW.argtypes = [
                wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                wintypes.LPVOID, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE,
            ]
            kernel32.SetFileTime.restype = wintypes.BOOL
            kernel32.SetFileTime.argtypes = [
                wintypes.HANDLE, ctypes.POINTER(wintypes.FILETIME),
                ctypes.POINTER(wintypes.FILETIME), ctypes.POINTER(wintypes.FILETIME),
            ]
            kernel32.CloseHandle.restype = wintypes.BOOL
            kernel32.CloseHandle.argtypes = [wintypes.HANDLE]

            INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value
            handle = kernel32.CreateFileW(
                filepath,
                0x40000000,          # GENERIC_WRITE
                0x00000007,          # FILE_SHARE_READ|WRITE|DELETE
                None,                # no security attributes
                3,                   # OPEN_EXISTING
                0x00000080,          # FILE_ATTRIBUTE_NORMAL
                None,
            )
            if not handle or handle == INVALID_HANDLE_VALUE:
                results['created_error'] = f'CreateFileW failed (err={ctypes.get_last_error()})'
            else:
                win_ts = int((ts + 11644473600) * 10000000)  # 1601→1970 epoch, 100ns units
                ft = wintypes.FILETIME(dwLowDateTime=win_ts & 0xFFFFFFFF,
                                       dwHighDateTime=(win_ts >> 32) & 0xFFFFFFFF)
                # SetFileTime(handle, creation, access, modification) — creation only
                # (modification is set via os.utime above)
                if kernel32.SetFileTime(handle, ctypes.byref(ft), None, None):
                    results['created'] = True
                else:
                    results['created_error'] = f'SetFileTime failed (err={ctypes.get_last_error()})'
                kernel32.CloseHandle(handle)
        except Exception as e:
            results['created_error'] = str(e)

    return results


# ── Job State ──────────────────────────────────────────────────
jobs = {}
job_lock = threading.RLock()  # RLock: allows reentrant acquisition (fixes nested-lock deadlock BUG-S01)
_last_job_cleanup = 0.0  # FIX BUG-L09: throttle cleanup_old_jobs to once per minute


def new_job(mode, items, params):
    jid = uuid_mod.uuid4().hex[:12]
    jobs[jid] = {
        'id': jid,
        'status': 'pending',
        'mode': mode,
        'items': items,
        'params': params,
        'total': len(items),
        'current_index': 0,
        'current_input': '',
        'current_output': '',
        'file_progress': 0.0,
        'overall_progress': 0.0,
        'log': [],
        'error': None,
        'start_time': time.time(),
        'end_time': None,
        'proc': None,
        'paused': False,
        'merge_status': None,
    }
    return jid


def log_line(jid, msg, level='info'):
    with job_lock:
        j = jobs.get(jid)
        if j:
            ts = datetime.now().strftime('%H:%M:%S')
            j['log'].append({'ts': ts, 'msg': msg, 'level': level})
            if len(j['log']) > 800:
                j['log'] = j['log'][-800:]


def cleanup_old_jobs(max_age_seconds=3600):
    """FIX BUG-L09: Remove completed/cancelled/failed jobs older than max_age_seconds.
    Prevents unbounded memory growth from accumulated job data."""
    with job_lock:
        now = time.time()
        expired = [
            jid for jid, j in jobs.items()
            if j.get('status') in ('completed', 'cancelled', 'failed')
            and j.get('end_time')
            and (now - j['end_time']) > max_age_seconds
        ]
        for jid in expired:
            del jobs[jid]
    if expired:
        logger.info(f"Cleaned up {len(expired)} expired job(s) from memory")


# ── Path Formula Expansion ─────────────────────────────────────
def expand_formula(formula, source_path, params, project_dir=''):
    """Expand a path formula template with source file info."""
    p = Path(source_path)
    now = datetime.now()
    # Try to extract a date (YYYYMMDD) from the filename
    file_date = ''
    m = re.search(r'(20\d{2})(\d{2})(\d{2})', p.stem)
    if m:
        y, mo, d = m.group(1), m.group(2), m.group(3)
        # Validate month/day ranges
        if 1 <= int(mo) <= 12 and 1 <= int(d) <= 31:
            file_date = f'{y}{mo}{d}'
    return os.path.normpath(formula.format(
        source_dir   = str(p.parent),
        source_path  = str(p),
        filename     = p.name,
        name         = p.stem,
        ext          = p.suffix.lstrip('.'),
        parent       = p.parent.name,
        date         = now.strftime('%Y-%m-%d'),
        time         = now.strftime('%H-%M-%S'),
        yyyy         = now.strftime('%Y'),
        mm           = now.strftime('%m'),
        dd           = now.strftime('%d'),
        file_date    = file_date,
        resolution   = params.get('resolution', ''),
        profile      = params.get('profile', ''),
        project_dir  = project_dir or '',
    ))


# ── ffprobe / ffmpeg helpers ───────────────────────────────────

def validate_input_file(path):
    """Pre-validate an input file before ffmpeg encoding.

    Runs a quick ffprobe to check if the file is a readable media container.
    Returns (valid: bool, error_msg: str).
    If valid, error_msg is ''. If invalid, error_msg is a user-friendly
    Chinese message explaining the problem.
    """
    # 1. Check file exists and is non-empty
    if not os.path.exists(path):
        return False, '输入文件不存在，请检查文件路径'
    fsize = os.path.getsize(path)
    if fsize == 0:
        return False, '输入文件大小为 0 字节，文件为空'
    if fsize < 1024:
        return False, f'输入文件过小（{fsize} 字节），可能不是有效的视频文件'

    # 2. Quick ffprobe check — this catches corrupted MP4 (moov atom missing),
    #    truncated files, wrong format, etc. Much faster than letting ffmpeg
    #    start and fail later.
    try:
        r = subprocess.run(
            [FFPROBE_PATH, '-v', 'error', '-show_entries',
             'format=format_name,duration', '-of', 'csv=p=0', path],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding='utf-8', errors='replace', timeout=15,
            env=_ffmpeg_env(), creationflags=NO_WINDOW
        )
        if r.returncode != 0 or not (r.stdout or '').strip():
            stderr = (r.stderr or '').strip()
            # Parse known error patterns for user-friendly messages
            err_lower = stderr.lower()
            if 'moov atom not found' in err_lower:
                return False, ('文件损坏或未完成写入（缺少 moov atom 索引）。'
                               '常见原因：录制中断、文件传输不完整、或文件仍在被其他程序写入。'
                               '请重新获取完整文件后重试。')
            if 'invalid data found' in err_lower:
                return False, ('文件数据无效，可能不是支持的视频格式或文件已损坏。'
                               '请确认文件完整性后重试。')
            if 'no such file' in err_lower:
                return False, '输入文件不存在，请检查文件路径'
            if 'end of file' in err_lower:
                return False, ('文件意外结束（可能被截断）。'
                               '请确认文件已完整写入/传输后重试。')
            # Generic ffprobe failure
            short_err = stderr.split('\n')[0][:200] if stderr else '未知错误'
            return False, f'文件无法读取：{short_err}'
    except subprocess.TimeoutExpired:
        return False, '文件读取超时（ffprobe 15秒无响应），文件可能被锁定或存在I/O问题'
    except Exception as e:
        # If ffprobe itself crashes, don't block — let ffmpeg try
        # (validate is best-effort, not a hard gate)
        pass

    return True, ''


def parse_ffmpeg_error(stderr_lines, rc):
    """Parse ffmpeg stderr output for known error patterns.

    Args:
        stderr_lines: list of stderr line strings (last N lines from run_ffmpeg)
        rc: ffmpeg return code

    Returns a user-friendly Chinese error message, or '' if no pattern matches.
    """
    combined = '\n'.join(stderr_lines).lower() if stderr_lines else ''

    # File-level errors (input cannot be opened at all)
    if 'moov atom not found' in combined:
        return ('文件损坏或未完成写入（缺少 moov atom 索引）。'
                '常见原因：录制中断、文件传输不完整、或文件仍在被其他程序写入。'
                '请重新获取完整文件后重试。')
    if 'invalid data found when processing input' in combined:
        if 'error opening input' in combined:
            return ('无法打开输入文件，文件数据无效或已损坏。'
                    '请确认文件完整性后重试。')
        return '文件中存在无效数据，部分内容可能已损坏。请尝试使用软件编码模式重试。'
    if 'no such file or directory' in combined:
        return '输入文件不存在，请检查文件路径'
    if 'end of file' in combined:
        return '文件意外结束（可能被截断）。请确认文件已完整写入/传输后重试。'
    if 'permission denied' in combined:
        return '文件访问被拒绝，可能被其他程序锁定。请关闭占用该文件的程序后重试。'

    # Encoder-level errors
    if 'no capable devices found' in combined or 'not find any gpu' in combined:
        return '未检测到可用的 GPU 硬件编码器，请切换为软件编码（libx264/libx265）后重试'
    if 'out of memory' in combined or 'cuda error' in combined:
        return 'GPU 显存不足或 CUDA 错误，请降低分辨率或切换为软件编码后重试'

    # NVENC crash (0xC0000005) — this is handled separately in convert_one
    # for auto-fallback, so we only reach here if fallback also failed
    if rc in (3221225477, -1073741819):
        return '编码器崩溃（访问违规），文件可能包含损坏的数据。请尝试使用软件编码模式重试'

    # Disk full
    if 'no space left' in combined or 'disk full' in combined:
        return '磁盘空间不足，请清理输出目录所在磁盘后重试'

    return ''


def get_duration(path):
    """Get video duration in seconds via ffprobe."""
    try:
        # Explicit PIPE + utf-8 decode (capture_output=True misbehaves in frozen build)
        r = subprocess.run(
            [FFPROBE_PATH, '-v', 'quiet', '-show_entries', 'format=duration',
             '-of', 'csv=p=0', path],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding='utf-8', errors='replace', timeout=30,
            env=_ffmpeg_env(), creationflags=NO_WINDOW
        )
        out = (r.stdout or '').strip()
        return float(out) if out else 0
    except Exception:
        return 0


def _ffmpeg_env(ffmpeg_path=None):
    """Build environment for ffmpeg subprocess. 
    If ffmpeg_path is a system ffmpeg (not bundled), don't prepend bundled DLL dirs."""
    env = os.environ.copy()
    if ffmpeg_path and os.path.normpath(ffmpeg_path) != os.path.normpath(FFMPEG_PATH):
        # System ffmpeg - use its own directory + system PATH only
        ffmpeg_bin = os.path.dirname(ffmpeg_path)
        env['PATH'] = ffmpeg_bin + os.pathsep + env.get('PATH', '')
    else:
        # Bundled ffmpeg - prepend our DLL directories
        env['PATH'] = FFMPEG_BIN + os.pathsep + MINGW_BIN + os.pathsep + env.get('PATH', '')
    return env


# ── Hardware encoder detection (test-encode based) ──
_encoder_ffmpeg_map = {}  # codec_name -> ffmpeg_path to use for that encoder


def _get_custom_ffmpeg():
    """Load custom ffmpeg path from settings file."""
    try:
        if os.path.exists(SETTINGS_FILE):
            saved = json.loads(Path(SETTINGS_FILE).read_text(encoding='utf-8'))
            path = saved.get('custom_ffmpeg_path', '')
            if path and os.path.isfile(path):
                return path
    except Exception:
        pass
    return None


def _find_system_ffmpeg():
    """Find ffmpeg in system PATH (not the bundled one, not the custom one)."""
    bundled_dir = os.path.normpath(FFMPEG_BIN)
    custom = _get_custom_ffmpeg()
    for d in os.environ.get('PATH', '').split(os.pathsep):
        d = d.strip()
        if not d or os.path.normpath(d) == bundled_dir:
            continue
        candidate = os.path.join(d, 'ffmpeg.exe')
        if os.path.isfile(candidate) and (not custom or os.path.normpath(candidate) != os.path.normpath(custom)):
            return candidate
    return None


def _test_encoder(ffmpeg_path, encoder):
    """Test if an encoder is available by doing a minimal 0.1s encode.
    Returns (success: bool, error_detail: str)."""
    try:
        r = subprocess.run(
            [ffmpeg_path, '-hide_banner', '-f', 'lavfi', '-i',
             'color=black:s=640x480:d=0.1', '-c:v', encoder,
             '-f', 'null', 'NUL' if os.name == 'nt' else '-'],
            capture_output=True, text=True, timeout=20,
            env=_ffmpeg_env(ffmpeg_path),
            creationflags=NO_WINDOW
        )
        if r.returncode == 0:
            return True, ''
        # Parse error from stderr - extract the most relevant error line
        err_lines = (r.stderr or '').strip().split('\n')
        # Strategy: find lines that start with [xxx @ addr] and contain error keywords
        # These are ffmpeg's internal error messages
        error_patterns = [
            'cannot load', 'failed to open', 'failed to create',
            'error creating', 'error initializing', 'error opening',
            'not supported', 'not found', 'no capability',
            'no device', 'cannot find', 'unable to',
            'd3d', 'cuda', 'nvcuda', 'dxva', 'vaapi',
            'initializeencoder', 'frame dimension', 'minimum supported',
            'invalid param', 'mfx session', 'amfrt', 'driver does not',
        ]
        # Exclude generic lines
        exclude_patterns = ['stream mapping', 'stream #', 'press [q]',
                            'input #', 'output #', 'duration:', 'frame=',
                            'conversion failed', 'error while opening encoder',
                            'could not open encoder before eof',
                            'error sending frames', 'task finished',
                            'terminating thread', 'error code:',
                            'nothing was written', 'out#0', 'vf#', 'vost#',
                            'wrapped_avframe', 'mapping:']
        relevant = []
        for line in err_lines:
            stripped = line.strip()
            if not stripped:
                continue
            low = stripped.lower()
            # Skip excluded patterns
            if any(ep in low for ep in exclude_patterns):
                continue
            # Check for error patterns
            if any(ep in low for ep in error_patterns):
                relevant.append(stripped)
        if relevant:
            return False, relevant[0]  # First specific error is usually root cause
        # Fallback: any line with [xxx @] that's not excluded
        for line in err_lines:
            stripped = line.strip()
            if not stripped:
                continue
            low = stripped.lower()
            if any(ep in low for ep in exclude_patterns):
                continue
            # ffmpeg internal log lines look like: [h264_nvenc @ 0x...] message
            if stripped.startswith('[') and ' @ ' in stripped:
                relevant.append(stripped)
        if relevant:
            return False, relevant[0]
        return False, f'ffmpeg 退出码 {r.returncode}'
    except subprocess.TimeoutExpired:
        return False, '测试超时 (20s)'
    except Exception as e:
        return False, str(e)


def _check_hw_runtime_dlls():
    """Check for presence of hardware encoder runtime DLLs in System32/SysWOW64.
    Returns dict: {group: {dll_name: found_path_or_None}}"""
    import glob
    sys32 = os.path.join(os.environ.get('SystemRoot', r'C:\Windows'), 'System32')
    syswow64 = os.path.join(os.environ.get('SystemRoot', r'C:\Windows'), 'SysWOW64')

    checks = {
        'cuda': ['nvcuda.dll', 'nvEncodeApi64.dll'],
        'qsv': ['libmfxhw64.dll', 'mfx64.dll', 'libmfx-gen.dll', 'libvpl.dll'],
        'amf': ['amfrt64.dll', 'amfrt32.dll'],
    }
    result = {}
    for group, dlls in checks.items():
        result[group] = {}
        for dll in dlls:
            found = None
            for search_dir in [sys32, syswow64]:
                p = os.path.join(search_dir, dll)
                if os.path.isfile(p):
                    found = p
                    break
            result[group][dll] = found
    return result


def build_okaa_filter_complex(params):
    """Build an ffmpeg filter_complex that converts a side-by-side/top-bottom dual fisheye
    video (e.g. Okaa 360 camera) into a standard equirectangular 360° panorama.

    v3.5.0: Added seam blending (流光拼接) mode.
    - 'replace': Original hstack approach (fast, visible seam at center)
    - 'seam': Each lens projected to full 360° equirect, cosine-weighted blend
    - 'average': Full 360° projection, 50/50 blend in overlap
    - 'max': Full 360° projection, take brighter pixel at each position
    """
    fov = float(params.get('okaa_fov', 200))
    yaw_l = float(params.get('okaa_yaw_l', 0))
    yaw_r = float(params.get('okaa_yaw_r', 0))
    pitch_l = float(params.get('okaa_pitch_l', 0))
    pitch_r = float(params.get('okaa_pitch_r', 0))
    roll_l = float(params.get('okaa_roll_l', 0))
    roll_r = float(params.get('okaa_roll_r', 0))
    layout = params.get('okaa_layout', 'sbs')
    blend_mode = params.get('okaa_blend', 'replace')
    out_res = params.get('okaa_out_resolution', '3840x1920')
    out_w, out_h = out_res.split('x')
    out_w = int(out_w)
    out_h = int(out_h)
    # Each hemisphere is a 180°x180° square in equirectangular projection, so it occupies
    # half of the final width and the full height.
    half_w = int(out_w / 2)
    half_h = out_h

    if layout == 'tb':
        left_crop = 'iw:ih/2:0:0'
        right_crop = 'iw:ih/2:0:ih/2'
    else:
        # side-by-side (default)
        left_crop = 'iw/2:ih:0:0'
        right_crop = 'iw/2:ih:iw/2:0'

    # ── Seam blending modes (v3.5.0) ─────────────────────────────
    # Each lens is projected to a FULL 360° equirectangular panorama.
    # Areas outside the lens FOV are black; the two panoramas are blended
    # with cosine weighting that naturally handles the seam transition.
    if blend_mode in ('seam', 'average', 'max'):
        # Project each lens to full 360° equirect (h_fov=360, w=out_w)
        fc = (
            f"[0:v]split[left_in][right_in];"
            f"[left_in]crop={left_crop},"
            f"v360=fisheye:equirect:ih_fov={fov}:iv_fov={fov}:"
            f"h_fov=360:v_fov=180:"
            f"yaw={yaw_l}:pitch={pitch_l}:roll={roll_l}:"
            f"w={out_w}:h={out_h}:interp=lanczos[left_full];"
            f"[right_in]crop={right_crop},"
            f"v360=fisheye:equirect:ih_fov={fov}:iv_fov={fov}:"
            f"h_fov=360:v_fov=180:"
            f"yaw={yaw_r}:pitch={pitch_r}:roll={roll_r}:"
            f"w={out_w}:h={out_h}:interp=lanczos[right_full];"
        )

        if blend_mode == 'max':
            # Take the brighter pixel at each position — simple and effective
            # for non-overlapping regions (black=0 is never chosen over real data)
            fc += f"[left_full][right_full]blend=all_expr='max(A,B)'[vout]"
        elif blend_mode == 'average':
            # Simple 50/50 blend — smooths the seam but may soften detail
            fc += f"[left_full][right_full]blend=all_expr='0.5*A+0.5*B'[vout]"
        else:  # 'seam' — cosine-weighted blend (流光拼接)
            # Each pixel is weighted by cosine of its angular distance from
            # the lens center. This gives maximum weight at the center of
            # each lens's visible region and smoothly fades to zero at the
            # edges, producing a natural seamless transition.
            #
            # Azimuth in radians: T = (X/W)*2*PI - PI  (ranges -PI to +PI)
            # Weight for left lens (centered at yaw_l):  wl = (1+cos(T-yl))/2
            # Weight for right lens (centered at yaw_r): wr = (1+cos(T-yr))/2
            # Result = (wl*A + wr*B) / (wl + wr + epsilon)
            #
            # epsilon prevents division by zero in regions where both lenses
            # have no data (both weights ≈ 0). Using 0.001 is small enough
            # to be negligible in visible regions.
            import math
            yl_rad = yaw_l * math.pi / 180.0
            yr_rad = yaw_r * math.pi / 180.0
            # Build the blend expression
            # T = (X/W)*2*PI - PI
            T = "(X/W)*2*PI-PI"
            wl = f"(1+cos({T}-{yl_rad}))/2"
            wr = f"(1+cos({T}-{yr_rad}))/2"
            blend_expr = f"({wl}*A+{wr}*B)/({wl}+{wr}+0.001)"
            fc += f"[left_full][right_full]blend=all_expr='{blend_expr}'[vout]"
        return fc

    # ── Default: replace mode (original hstack approach) ─────────
    # h_fov=180:v_fov=180 makes each output a 180° hemisphere in equirectangular space.
    # Using square output (half_w x half_h) keeps the equirect 2:1 aspect after hstack.
    fc = (
        f"[0:v]split[left_in][right_in];"
        f"[left_in]crop={left_crop},"
        f"v360=fisheye:equirect:ih_fov={fov}:iv_fov={fov}:"
        f"h_fov=180:v_fov=180:"
        f"yaw={yaw_l}:pitch={pitch_l}:roll={roll_l}:"
        f"w={half_w}:h={half_h}:interp=lanczos[left];"
        f"[right_in]crop={right_crop},"
        f"v360=fisheye:equirect:ih_fov={fov}:iv_fov={fov}:"
        f"h_fov=180:v_fov=180:"
        f"yaw={yaw_r}:pitch={pitch_r}:roll={roll_r}:"
        f"w={half_w}:h={half_h}:interp=lanczos[right];"
        f"[left][right]hstack=inputs=2[vout]"
    )
    return fc


# ── Insta360 .insv helpers ─────────────────────────────────────

def detect_insv_pair(filepath):
    """Detect the paired .insv file for dual-lens cameras (pre-X4).
    Insta360 cameras produce pairs: VID_..._00_NNN.insv (front) + VID_..._10_NNN.insv (back).
    Returns the paired file path if found, else None.
    """
    p = Path(filepath)
    name = p.name
    # Match _00_ or _10_ pattern in filename
    m = re.match(r'^(.+_)(00|10)(_\d+\.insv)$', name, re.IGNORECASE)
    if not m:
        return None
    prefix, lens_id, suffix = m.groups()
    pair_id = '10' if lens_id == '00' else '00'
    pair_name = f"{prefix}{pair_id}{suffix}"
    pair_path = p.parent / pair_name
    if pair_path.exists():
        return str(pair_path)
    return None


def is_insv_file(path):
    """Check if a file is an Insta360 .insv video file."""
    return path.lower().endswith('.insv')


def is_insphoto_file(path):
    """Check if a file is an Insta360 .insp photo file."""
    return path.lower().endswith('.insp')


def build_insv_v360_filter(params):
    """Build ffmpeg v360 filter to convert Insta360 dual-fisheye to equirectangular.
    For paired .insv files (front+back lenses), caller should hstack them first.
    For single .insv files (X4+), the dual-fisheye is already in one stream.
    """
    res = params.get('resolution', '3840x1920')
    if res == 'original':
        res = '3840x1920'
    w, h = res.split('x')

    # Insta360 lens FOV is typically ~200° per lens
    fov = params.get('insv_fov', 200)
    yaw = params.get('insv_yaw', 0)
    pitch = params.get('insv_pitch', 0)
    roll = params.get('insv_roll', 0)

    # dfisheye = dual fisheye input (side-by-side circular fisheye)
    # equirect = equirectangular projection output
    return (f"v360=dfisheye:equirect:"
            f"ih_fov={fov}:iv_fov={fov}:"
            f"h_fov=360:v_fov=180:"
            f"yaw={yaw}:pitch={pitch}:roll={roll}:"
            f"w={w}:h={h}:interp=lanczos")


def build_insv_filter_chain(params):
    """Build the complete Insta360 filter chain: v360 + optional denoise.
    Returns a -vf filter string (not filter_complex).
    """
    filters = []

    # 1. Dual-fisheye to equirectangular conversion
    if params.get('insv_stitch', True):
        filters.append(build_insv_v360_filter(params))

    # 2. Denoise (alternative to Insta360 SDK denoise)
    if params.get('insv_denoise', False):
        filters.append('hqdn3d=3:2:2:3')

    # 3. Resolution scale (if not handled by v360 w/h)
    if not params.get('insv_stitch', True):
        res = params.get('resolution', '')
        if res and res != 'original':
            w, h = res.split('x')
            filters.append(f'scale={w}:{h}:flags=lanczos')

    return ','.join(filters) if filters else None


# ── High-resolution (6K/8K+) compatibility helpers ───────────────

# Max luma samples per frame per H.264/HEVC level table (conservative union)
_LEVEL_MAX_PIXELS = [
    (5.1, 8_912_896),     # 4K-class (3840x2160 / 4096x2048)
    (6.0, 35_651_584),    # 6K/8K equirect fits
    (6.1, 71_303_168),    # 8K UHD / extreme custom
]

# H.264 hardware encoders cap at 4096x4096 → HEVC variant for >4K
_HW_H264_TO_HEVC = {
    'h264_nvenc': 'hevc_nvenc',
    'h264_qsv':   'hevc_qsv',
    'h264_amf':   'hevc_amf',
}


def min_level_for_pixels(pixels):
    """Return minimum compliant level string ('5.1'/'6.0'/'6.1') or None if beyond spec."""
    for lvl, max_px in _LEVEL_MAX_PIXELS:
        if pixels <= max_px:
            return f'{lvl:.1f}'
    return None


def _level_val(level):
    try:
        return float(level)
    except (TypeError, ValueError):
        return 0.0


def enforce_hires_compat(params, log=None):
    """Auto-adjust codec/level for high resolutions (6K/8K/custom >4K).

    Mutates params in place:
    - H.264 HW encoders (max 4096x4096) are downgraded to their HEVC variant
    - Software encoder level is bumped to the minimum compliant value
    """
    res = params.get('resolution', '')
    if not res or res == 'original':
        return
    try:
        w, h = (int(x) for x in str(res).lower().split('x'))
    except ValueError:
        return
    pixels = w * h

    # 1. H.264 hardware encoder 4096 cap → HEVC downgrade
    if (w > 4096 or h > 4096) and params.get('codec') in _HW_H264_TO_HEVC:
        old = params['codec']
        params['codec'] = _HW_H264_TO_HEVC[old]
        if log:
            log(f'  分辨率 {w}x{h} 超出 H.264 硬件编码上限 (4096x4096)，'
                f'已自动切换编码器: {old} → {params["codec"]}', 'warn')

    # 2. Level auto-bump (software encoders only; HW encoders auto-select level)
    if params.get('codec') in ('libx264', 'libx265') and params.get('level'):
        need = min_level_for_pixels(pixels)
        cur = params.get('level', '5.1')
        if need and _level_val(cur) < _level_val(need):
            params['level'] = need
            if log:
                log(f'  分辨率 {w}x{h} 需要 Level {need}，已从 {cur} 自动提升', 'warn')
        elif need is None and log:
            log(f'  警告: {w}x{h} 超出 H.264/HEVC Level 表最大帧尺寸，'
                f'输出 Level 为非标值，部分播放器可能无法解码', 'warn')

    # 3. Bitrate hint: 6K+ resolutions need higher maxrate to avoid block artifacts
    if pixels > 9_000_000 and log:
        try:
            mr = str(params.get('maxrate', '40M')).strip().lower()
            if mr.endswith('m'):
                mbps = float(mr[:-1])
            elif mr.endswith('k'):
                mbps = float(mr[:-1]) / 1000.0
            else:
                mbps = float(mr) / 1_000_000.0
            if mbps < 60:
                log(f'  提示: {w}x{h} 分辨率建议 maxrate ≥ 80M（当前 {params.get("maxrate")}），'
                    f'码率上限过低会导致复杂画面出现块效应', 'warn')
        except (ValueError, AttributeError):
            pass


# ── VR 3D 360° synthesis helpers ────────────────────────────────

def build_vr3d_cmd(left_inp, right_inp, out, params):
    """Build ffmpeg command to merge left/right eye videos into a 3D 360° video.
    Uses vstack (Top-Bottom) or hstack (Side-by-Side) based on params.
    The output is a single equirectangular video with stereo metadata.
    """
    codec = params.get('codec', 'libx264')
    ffmpeg = _encoder_ffmpeg_map.get(codec, FFMPEG_PATH)
    cp = CODEC_PROFILES.get(codec, CODEC_PROFILES['libx264'])

    stack_mode = params.get('vr3d_layout', 'top-bottom')  # 'top-bottom' or 'side-by-side'
    stack_filter = 'vstack' if stack_mode == 'top-bottom' else 'hstack'

    # Build filter_complex: stack left+right, then optional scale
    res = params.get('resolution', '4096x2048')
    if res == 'original':
        # Use left eye resolution as reference (no scaling step)
        scale_filter = ''
    else:
        w, h = res.split('x')
        # For top-bottom: each eye gets full width, half height
        # For side-by-side: each eye gets half width, full height
        scale_filter = f'scale={w}:{h}:flags=lanczos,setsar=1'

    # FIX (v3.13.2 P0-2): the old graph reused the [v] label — defined as the
    # stack output and again as the scale chain's input AND output — and
    # scale_filter carried a leading comma (empty filter name after the chain
    # input label). ffmpeg rejected the whole graph for every non-original
    # resolution ("Invalid filterchain"). Use a dedicated intermediate label
    # [stk] and a clean second chain.
    fc = f"[0:v][1:v]{stack_filter}=inputs=2[stk]"
    if scale_filter:
        fc += f";[stk]{scale_filter}[v]"

    cmd = [ffmpeg, '-y',
           '-err_detect', 'ignore_err',
           '-fflags', '+discardcorrupt',
           '-i', left_inp,
           '-i', right_inp,
           '-filter_complex', fc,
           '-map', '[v]',
           '-map', '0:a?',
           '-c:v', cp['encoder']]

    # Tag for HEVC
    if cp.get('tag'):
        cmd += ['-tag:v', cp['tag']]

    # Profile
    if cp.get('has_profile') and params.get('profile'):
        cmd += ['-profile:v', params['profile']]

    # Level (software encoders accept string values like "6.0";
    # hardware encoders keep auto-selection — their -level is an int enum)
    if codec in ('libx264', 'libx265') and params.get('level'):
        cmd += ['-level:v', str(params['level'])]

    # Color params
    cmd += [
        '-pix_fmt', params.get('pix_fmt', 'yuv420p'),
        '-color_range', params.get('color_range', 'tv'),
        '-colorspace', params.get('color_space', 'bt709'),
        '-color_primaries', params.get('color_primaries', 'bt709'),
        '-color_trc', params.get('color_trc', 'bt709'),
    ]

    # B-frames, GOP
    if cp.get('has_bf_refs'):
        cmd += ['-bf', str(params.get('bf', 3)),
                '-g', str(params.get('gop', 48))]
        if codec in ('libx264', 'libx265'):
            cmd += ['-refs', str(params.get('refs', 5)),
                    '-keyint_min', str(params.get('gop', 48))]
        if cp.get('has_sc_threshold'):
            cmd += ['-sc_threshold', '0']

    # NVENC quality
    if cp['group'] == 'cuda':
        cmd += ['-spatial-aq', '1', '-temporal-aq', '1', '-rc-lookahead', '16']

    # Rate control
    mode = params.get('rate_mode', 'crf')
    group = cp['group']
    if group == 'cpu':
        if mode == 'crf':
            cmd += ['-crf', str(params.get('crf', cp['default_crf'])),
                    '-maxrate', params.get('maxrate', '40M'),
                    '-bufsize', params.get('bufsize', '20M')]
        elif mode == '2pass':
            cmd += ['-b:v', params.get('target_bitrate', '50000k'),
                    '-maxrate', params.get('maxrate', '80M'),
                    '-bufsize', params.get('bufsize', '40M')]
    elif group == 'cuda':
        qp = params.get('crf', cp['default_crf'])
        cmd += ['-qp', str(qp),
                '-preset', params.get('preset', cp['default_preset']),
                '-tune', 'hq',
                '-rc', 'vbr',
                '-maxrate', params.get('maxrate', '40M'),
                '-bufsize', params.get('bufsize', '20M')]
    elif group == 'qsv':
        cmd += ['-global_quality', str(params.get('crf', cp['default_crf'])),
                '-preset', params.get('preset', cp['default_preset'])]
    elif group == 'amf':
        cmd += ['-quality', 'quality',
                '-rc', 'cqp',
                '-qp_i', str(params.get('crf', cp['default_crf'])),
                '-qp_p', str(params.get('crf', cp['default_crf']))]

    # Preset
    if group == 'cpu':
        cmd += [cp['preset_key'], params.get('preset', cp['default_preset'])]

    # Audio
    cmd += ['-c:a', params.get('audio_codec', 'aac'),
           '-b:a', params.get('audio_bitrate', '96k'),
           '-ar', params.get('audio_sample_rate', '48000'),
           '-ac', str(params.get('audio_channels', 2))]

    # Container
    if params.get('faststart', True):
        cmd += ['-movflags', '+faststart']
    brand = params.get('brand', 'mp42')
    if brand:
        cmd += ['-brand', brand]

    # Output
    cmd.append(out)
    return cmd


def check_vr3d_alignment(left_path, right_path):
    """Check if left and right eye videos have compatible resolution and duration.
    Returns (aligned: bool, warnings: list, info: dict).
    """
    warnings = []
    info = {}

    left_dur = get_duration(left_path)
    right_dur = get_duration(right_path)
    info['left_duration'] = round(left_dur, 2)
    info['right_duration'] = round(right_dur, 2)

    # Duration mismatch check
    dur_diff = abs(left_dur - right_dur)
    if dur_diff > 0.5:
        warnings.append(f'时长差异 {dur_diff:.2f}s（左 {left_dur:.1f}s / 右 {right_dur:.1f}s）')
    elif dur_diff > 0.1:
        warnings.append(f'轻微时长差异 {dur_diff:.3f}s')

    # Resolution check via ffprobe
    def get_resolution(path):
        try:
            r = subprocess.run(
                [FFPROBE_PATH, '-v', 'quiet', '-print_format', 'json',
                 '-show_streams', '-select_streams', 'v:0', path],
                capture_output=True, text=True, timeout=15,
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0,
            )
            d = json.loads(r.stdout)
            s = d.get('streams', [{}])[0]
            return f"{s.get('width', '?')}x{s.get('height', '?')}"
        except Exception:
            return 'unknown'

    left_res = get_resolution(left_path)
    right_res = get_resolution(right_path)
    info['left_resolution'] = left_res
    info['right_resolution'] = right_res

    if left_res != right_res:
        warnings.append(f'分辨率不一致（左 {left_res} / 右 {right_res}）— 将自动缩放对齐')

    aligned = len(warnings) == 0
    return aligned, warnings, info

def build_cmd(inp, out, params, pass_num=0, passlogfile=None):
    """Build ffmpeg command list, supporting multiple codecs."""
    codec = params.get('codec', 'libx264')
    # Use the ffmpeg path determined by codec_check (may be system ffmpeg for hw encoders)
    ffmpeg = _encoder_ffmpeg_map.get(codec, FFMPEG_PATH)
    # 容错参数（v3.3.3）：合并临时文件或源文件可能包含损坏的 NAL unit，
    # 软件解码器（native h264）通常能容忍，但硬件解码器（NVENC cuvid）对
    # 损坏数据极敏感，容易触发 0xC0000005 访问违规崩溃。在输入前添加容错
    # 参数，让 ffmpeg 丢弃损坏包而不是终止进程。
    cmd = [ffmpeg, '-y',
           '-err_detect', 'ignore_err',
           '-fflags', '+discardcorrupt',
           '-i', inp]

    # Insta360 paired .insv: add second input (paired lens file)
    insv_pair = params.get('_insv_pair')
    if insv_pair and is_insv_file(inp):
        cmd += ['-i', insv_pair]


    # ── copy 模式（v3.13.0）：直接复制源流，不做任何重编码 ──
    # 用途：只改封装/元数据（GSpherical、faststart、creation_time、location），
    # 不想要转码损耗与画质损失，速度接近磁盘拷贝。
    # 约束：-c copy 不能与任何视频滤镜共存（滤镜必须重编码）。因此 copy 模式下
    # 强制关闭 okaa / insv 拼接 / vidstab / 缩放（前端已互斥禁用，这里再兜底一次）。
    copy_mode = bool(params.get('copy_mode'))
    if copy_mode:
        params = dict(params)          # 复制一份，不污染调用方的 dict
        for _k in ('okaa_correction', 'insv_stitch', 'insv_denoise', 'stabilize'):
            params[_k] = False
        params.pop('_insv_pair', None)
        params.pop('_stab_trf', None)
        params['resolution'] = 'original'   # 跳过 scale（缩放需重编码）
        insv_pair = None                    # 中和上面已赋值的局部变量
    codec = params.get('codec', 'libx264')
    cp = CODEC_PROFILES.get(codec, CODEC_PROFILES['libx264'])

    # Video filter chain: Okaa dual-fisheye correction OR Insta360 v360 OR vidstab transform + scale
    if params.get('okaa_correction'):
        # Okaa双鱼眼校正：使用 filter_complex，替换普通 -vf
        fc = build_okaa_filter_complex(params)
        cmd += ['-filter_complex', fc, '-map', '[vout]']
        if pass_num != 1:
            cmd += ['-map', '0:a?']
    elif is_insv_file(inp) and insv_pair and (params.get('insv_stitch', True) or params.get('insv_denoise', False)):
        # Insta360 paired .insv: hstack front+back lenses, then v360 stitch
        # Determine hstack order: front lens (_00_) on left, back lens (_10_) on right
        if '_00_' in os.path.basename(inp):
            left_in, right_in = '0:v', '1:v'   # inp=front, pair=back
        else:
            left_in, right_in = '1:v', '0:v'   # pair=front, inp=back

        fc_parts = [f'[{left_in}][{right_in}]hstack=inputs=2[s0]']
        prev = 's0'

        if params.get('insv_stitch', True):
            v360 = build_insv_v360_filter(params)
            fc_parts.append(f'[s0]{v360}[s1]')
            prev = 's1'

        if params.get('insv_denoise', False):
            fc_parts.append(f'[{prev}]hqdn3d=3:2:2:3[s2]')
            prev = 's2'

        if params.get('_stab_trf') and vidstab_transform_filter is not None:
            trf = params['_stab_trf']
            sm = params.get('stabilize_smoothing', 30)
            zoom = params.get('stabilize_zoom', 0.05)
            stab = vidstab_transform_filter(trf, smoothing=sm, zoom=zoom, crop=True)
            fc_parts.append(f'[{prev}]{stab}[s3]')
            prev = 's3'

        # Scale if v360 not used or resolution differs
        if not params.get('insv_stitch', True):
            res = params.get('resolution', '')
            if res and res != 'original':
                w, h = res.split('x')
                fc_parts.append(f'[{prev}]scale={w}:{h}:flags=lanczos[vout]')
            else:
                fc_parts.append(f'[{prev}]null[vout]')
        else:
            fc_parts.append(f'[{prev}]null[vout]')

        fc = ';'.join(fc_parts)
        cmd += ['-filter_complex', fc, '-map', '[vout]']
        if pass_num != 1:
            cmd += ['-map', '0:a?']
    elif is_insv_file(inp) and (params.get('insv_stitch', True) or params.get('insv_denoise', False)):
        # Insta360 single .insv (X4+): v360 dual-fisheye→equirect via -vf
        insv_filters = []
        if params.get('insv_stitch', True):
            insv_filters.append(build_insv_v360_filter(params))
        if params.get('insv_denoise', False):
            insv_filters.append('hqdn3d=3:2:2:3')
        # vidstab transform (Insta360 FlowState alternative)
        if params.get('_stab_trf') and vidstab_transform_filter is not None:
            trf = params['_stab_trf']
            sm = params.get('stabilize_smoothing', 30)
            zoom = params.get('stabilize_zoom', 0.05)
            insv_filters.append(vidstab_transform_filter(trf, smoothing=sm, zoom=zoom, crop=True))
        # Scale if resolution differs from v360 output
        if not params.get('insv_stitch', True):
            res = params.get('resolution', '')
            if res and res != 'original':
                w, h = res.split('x')
                insv_filters.append(f'scale={w}:{h}:flags=lanczos')
        if insv_filters:
            cmd += ['-vf', ','.join(insv_filters)]
    else:
        filters = []
        if params.get('_stab_trf') and vidstab_transform_filter is not None:
            trf = params['_stab_trf']
            sm = params.get('stabilize_smoothing', 30)
            zoom = params.get('stabilize_zoom', 0.05)
            filters.append(vidstab_transform_filter(trf, smoothing=sm, zoom=zoom, crop=True))
        res = params.get('resolution', '')
        if res and res != 'original':
            w, h = res.split('x')
            filters.append(f'scale={w}:{h}:flags=lanczos')
        if filters:
            cmd += ['-vf', ','.join(filters)]

    # Metadata: creation_time (if date extraction or manual date is enabled)
    creation_time = params.get('_effective_creation_time', '')
    if creation_time:
        cmd += ['-metadata', f'creation_time={creation_time}']

    # Metadata: location (ISO 6709 format: +lat-lon/) + location.name + comment (address)
    # FIX BUG: MP4 muxer stores location (©xyz atom) at FORMAT level only.
    # Using -metadata:s:v:0 silently drops the location tag. Must use -metadata.
    loc_lat = params.get('location_lat', '')
    loc_lon = params.get('location_lon', '')
    if params.get('set_location') and loc_lat and loc_lon:
        iso6709 = format_location_iso6709(loc_lat, loc_lon)
        if iso6709:
            cmd += ['-metadata', f'location={iso6709}']
        loc_name = params.get('location_name', '')
        if loc_name:
            cmd += ['-metadata', f'location.name={loc_name}']
        loc_addr = params.get('location_address', '')
        if loc_addr:
            cmd += ['-metadata', f'comment={loc_addr}']

    # ── copy 模式：跳过编码器与音频重编码，直接流复制后提前返回 ──
    # 元数据（上方）对 stream copy 同样有效，这正是 copy 模式的主要用途。
    if copy_mode:
        cmd += ['-map', '0', '-c', 'copy']
        if params.get('brand'):
            cmd += ['-brand', params['brand']]
        if params.get('faststart', True):
            cmd += ['-movflags', '+faststart']
        _td = params.get('test_duration', 0)
        if _td and _td > 0:
            cmd += ['-t', str(_td)]
        cmd.append(out)
        return cmd

    # Set encoder
    cmd += ['-c:v', cp['encoder']]

    # Tag for HEVC (hvc1 for QuickTime/Apple compatibility)
    if cp.get('tag'):
        cmd += ['-tag:v', cp['tag']]

    # Profile (if supported by this codec)
    if cp.get('has_profile') and params.get('profile'):
        cmd += ['-profile:v', params['profile']]

    # Level (software encoders only; hardware encoders auto-select)
    if codec in ('libx264', 'libx265') and params.get('level'):
        cmd += ['-level:v', str(params['level'])]

    # Universal color params
    cmd += [
        '-pix_fmt', params.get('pix_fmt', 'yuv420p'),
        '-color_range', params.get('color_range', 'tv'),
        '-colorspace', params.get('color_space', 'bt709'),
        '-color_primaries', params.get('color_primaries', 'bt709'),
        '-color_trc', params.get('color_trc', 'bt709'),
    ]

    # B-frames, refs, GOP (software + NVENC)
    if cp.get('has_bf_refs'):
        cmd += [
            '-bf', str(params.get('bf', 3)),
            '-g', str(params.get('gop', 48)),
        ]
        if codec in ('libx264', 'libx265'):
            cmd += ['-refs', str(params.get('refs', 5)),
                    '-keyint_min', str(params.get('gop', 48))]
        if cp.get('has_sc_threshold'):
            cmd += ['-sc_threshold', '0']

    # NVENC-specific quality features
    if cp['group'] == 'cuda':
        cmd += ['-spatial-aq', '1', '-temporal-aq', '1', '-rc-lookahead', '16']

    # Rate control
    mode = params.get('rate_mode', 'crf')
    group = cp['group']

    if group == 'cpu':
        if mode == 'crf':
            cmd += ['-crf', str(params.get('crf', cp['default_crf'])),
                    '-maxrate', params.get('maxrate', '40M'),
                    '-bufsize', params.get('bufsize', '20M')]
        elif mode == '2pass':
            cmd += ['-b:v', params.get('target_bitrate', '50000k'),
                    '-maxrate', params.get('maxrate', '80M'),
                    '-bufsize', params.get('bufsize', '40M')]
            if pass_num:
                cmd += ['-pass', str(pass_num)]
                if passlogfile:
                    cmd += ['-passlogfile', passlogfile]
    elif group == 'cuda':
        if mode == 'crf':
            cmd += ['-rc', 'vbr', '-cq', str(params.get('crf', cp['default_crf'])),
                    '-maxrate', params.get('maxrate', '40M'),
                    '-bufsize', params.get('bufsize', '20M'),
                    '-b:v', '0']
        else:
            cmd += ['-rc', 'vbr', '-b:v', params.get('target_bitrate', '50000k'),
                    '-maxrate', params.get('maxrate', '80M'),
                    '-bufsize', params.get('bufsize', '40M')]
    elif group == 'qsv':
        if mode == 'crf':
            cmd += ['-global_quality', str(params.get('crf', cp['default_crf'])),
                    '-look_ahead', '1']
        else:
            cmd += ['-b:v', params.get('target_bitrate', '50000k'),
                    '-maxrate', params.get('maxrate', '80M'),
                    '-bufsize', params.get('bufsize', '40M')]
    elif group == 'amf':
        if mode == 'crf':
            cmd += ['-rc', 'cqp', '-qp_i', str(params.get('crf', cp['default_crf'])),
                    '-qp_p', str(params.get('crf', cp['default_crf']))]
        else:
            cmd += ['-rc', 'vbr_peak', '-b:v', params.get('target_bitrate', '50000k'),
                    '-maxrate', params.get('maxrate', '80M'),
                    '-bufsize', params.get('bufsize', '40M')]

    # Preset
    preset_key = cp.get('preset_key', '-preset')
    cmd += [preset_key, params.get('preset', cp['default_preset'])]

    # Codec-specific params
    if codec == 'libx264' and params.get('x264_params'):
        cmd += ['-x264-params', params['x264_params']]
    elif codec == 'libx265' and params.get('x265_params'):
        cmd += ['-x265-params', params['x265_params']]

    # Audio
    if pass_num == 1:
        cmd += ['-an']
    else:
        cmd += [
            '-c:a', params.get('audio_codec', 'aac'),
            '-profile:a', params.get('audio_profile', 'aac_low'),
            '-b:a', params.get('audio_bitrate', '96k'),
            '-ar', str(params.get('audio_sample_rate', '48000')),
            '-ac', str(params.get('audio_channels', 2)),
        ]

    # Container
    if params.get('brand'):
        cmd += ['-brand', params['brand']]
    if params.get('faststart', True):
        cmd += ['-movflags', '+faststart']

    # Test encoding: limit output duration (applies to BOTH pass 1 and pass 2)
    test_dur = params.get('test_duration', 0)
    if test_dur and test_dur > 0:
        cmd += ['-t', str(test_dur)]

    # Pass 1 outputs to null
    if pass_num == 1:
        cmd += ['-f', 'mp4', os.devnull]
    else:
        cmd.append(out)

    return cmd


def format_location_iso6709(lat_str, lon_str):
    """Format latitude/longitude as ISO 6709 string: +34.0522-118.2437/"""
    try:
        lat = float(lat_str)
        lon = float(lon_str)
        lat_sign = '+' if lat >= 0 else '-'
        lon_sign = '+' if lon >= 0 else '-'
        return f'{lat_sign}{abs(lat):.4f}{lon_sign}{abs(lon):.4f}/'
    except (ValueError, TypeError):
        return None


PROGRESS_RE = re.compile(r'time=(\d+):(\d+):(\d+(?:\.\d+)?)')


def parse_progress(line, duration):
    """Extract progress percentage from ffmpeg stderr line."""
    m = PROGRESS_RE.search(line)
    if not m or duration <= 0:
        return None
    h, mi, s = m.groups()
    cur = int(h) * 3600 + int(mi) * 60 + float(s)
    return min(99.0, (cur / duration) * 100)


# ── Process Suspend/Resume (Windows) ──────────────────────────
def suspend_process(pid):
    """Suspend all threads of a process on Windows."""
    if os.name != 'nt':
        return
    try:
        PROCESS_SUSPEND_RESUME = 0x0800
        handle = ctypes.windll.kernel32.OpenProcess(PROCESS_SUSPEND_RESUME, False, pid)
        if handle:
            ctypes.windll.ntdll.NtSuspendProcess(handle)
            ctypes.windll.kernel32.CloseHandle(handle)
    except Exception:
        pass


def resume_process(pid):
    """Resume all threads of a process on Windows."""
    if os.name != 'nt':
        return
    try:
        PROCESS_SUSPEND_RESUME = 0x0800
        handle = ctypes.windll.kernel32.OpenProcess(PROCESS_SUSPEND_RESUME, False, pid)
        if handle:
            ctypes.windll.ntdll.NtResumeProcess(handle)
            ctypes.windll.kernel32.CloseHandle(handle)
    except Exception:
        pass


def check_pause(jid, proc):
    """Check if job is paused. If so, suspend process and wait until resumed."""
    with job_lock:
        j = jobs.get(jid)
        if not j:
            return False
        if not j['paused']:
            return True  # Not paused, continue

    # Suspend the ffmpeg process
    if proc and proc.pid:
        log_line(jid, '  Pausing ffmpeg process...', 'warn')
        suspend_process(proc.pid)

    # Wait until resumed or cancelled
    while True:
        with job_lock:
            j = jobs.get(jid)
            if not j or j['status'] == 'cancelled':
                if proc and proc.pid:
                    resume_process(proc.pid)
                return False
            if not j['paused']:
                break
        time.sleep(0.3)

    # Resume the ffmpeg process
    if proc and proc.pid:
        log_line(jid, '  Resuming ffmpeg process...', 'info')
        resume_process(proc.pid)
    return True


# ── Conversion Worker ──────────────────────────────────────────
def _read_ffmpeg_lines(stream):
    """Yield lines from ffmpeg stderr, splitting on both \\r and \\n.

    ffmpeg uses \\r (carriage return) for progress updates, overwriting the
    same line. Python's default line iteration only splits on \\n, so progress
    would never be yielded until a \\n appears (which may never happen).
    This generator reads in chunks and yields on either separator.
    """
    buf = ''
    while True:
        chunk = stream.read(256)
        if not chunk:
            if buf:
                yield buf
            break
        for ch in chunk:
            if ch in ('\r', '\n'):
                if buf:
                    yield buf
                    buf = ''
            else:
                buf += ch


def run_ffmpeg(cmd, jid, duration, pass_label=''):
    """Run ffmpeg subprocess, stream progress to job log.

    Stores the last 20 non-progress stderr lines in jobs[jid]['_ffmpeg_last_err']
    so callers can parse them for user-friendly error messages on failure.
    """
    with job_lock:
        jobs[jid]['proc'] = None

    # Track last N stderr lines for error parsing (v3.8.1)
    _last_err_lines = []

    # Extract ffmpeg path from cmd[0] to set correct environment (bundled vs system)
    ffmpeg_path = cmd[0] if cmd else FFMPEG_PATH
    try:
        proc = subprocess.Popen(
            cmd, stderr=subprocess.PIPE, stdout=subprocess.DEVNULL,
            text=True, bufsize=1, encoding='utf-8', errors='replace',
            env=_ffmpeg_env(ffmpeg_path),
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0,
        )
    except Exception as e:
        log_line(jid, f'Failed to start ffmpeg: {e}', 'error')
        return -1

    with job_lock:
        jobs[jid]['proc'] = proc

    try:
        for line in _read_ffmpeg_lines(proc.stderr):
            line = line.rstrip()
            if not line:
                continue
            # FIX (v3.3.5): Explicitly check cancelled status here.
            # check_pause() only detects cancelled when paused=True,
            # so without this check, run_ffmpeg would keep reading
            # ffmpeg output even after cancel set status='cancelled'.
            with job_lock:
                _j = jobs.get(jid)
                if not _j or _j['status'] == 'cancelled':
                    try: proc.kill()
                    except Exception: pass
                    try: proc.wait(timeout=5)
                    except Exception: pass
                    return -1
            # Check pause state
            if not check_pause(jid, proc):
                proc.kill()
                try: proc.wait(timeout=5)
                except Exception: pass
                return -1
            if 'frame=' in line or 'time=' in line:
                prog = parse_progress(line, duration)
                if prog is not None:
                    with job_lock:
                        j = jobs.get(jid)
                        if j:
                            j['file_progress'] = prog
                            if j['total'] > 0:
                                base = (j['current_index'] / j['total']) * 100
                                j['overall_progress'] = base + (prog / j['total'])
                            # Update merge progress tracking
                            ms = j.get('merge_status')
                            if ms and ms.get('phase') == 'merging':
                                m = PROGRESS_RE.search(line)
                                if m:
                                    h, mi, s = m.groups()
                                    cur_sec = int(h) * 3600 + int(mi) * 60 + float(s)
                                    ms['elapsed_time'] = round(cur_sec, 1)
                                    # Find which file we're currently in
                                    cum = ms.get('cumulative', [])
                                    for fi, (end_t, fname) in enumerate(cum):
                                        if cur_sec <= end_t + 0.5:
                                            ms['current_file_index'] = fi
                                            ms['current_file_name'] = fname
                                            break
            else:
                # Track non-progress lines for error parsing (keep last 20)
                _last_err_lines.append(line)
                if len(_last_err_lines) > 20:
                    _last_err_lines.pop(0)
                log_line(jid, f'{pass_label}{line}')
    except Exception as e:
        log_line(jid, f'ffmpeg output read error: {e}', 'error')
        try:
            proc.kill()
        except Exception:
            pass

    try: proc.wait(timeout=10)
    except Exception: pass

    # Store last stderr lines for error parsing by caller
    with job_lock:
        _j = jobs.get(jid)
        if _j:
            _j['_ffmpeg_last_err'] = _last_err_lines

    return proc.returncode


def merge_files(jid, input_files, output_path):
    """Merge multiple video files into one using ffmpeg concat demuxer.

    Returns (success, error_msg).

    v3.5.0 fixes:
    - Pre-validate file accessibility; skip inaccessible files with warning
    - Use .mkv intermediate container to avoid MP4's 32-bit DTS overflow
      (Assertion next_dts <= 0x7fffffff failed) for very long merges (>6h)
    - Add cancel checks during duration probing phase
    """
    if len(input_files) < 2:
        return True, None  # Nothing to merge

    # ── Pre-validate file accessibility ──────────────────────────
    # Network drives (\\server\share) may have intermittent access failures.
    # Check all files BEFORE creating the concat list to avoid mid-merge crashes.
    accessible_files = []
    skipped_files = []
    for fp in input_files:
        # Check cancel during file validation
        with job_lock:
            _j = jobs.get(jid)
            if not _j or _j['status'] == 'cancelled':
                return False, 'Cancelled by user'
        if os.path.isfile(fp) and os.access(fp, os.R_OK):
            accessible_files.append(fp)
        else:
            skipped_files.append(fp)
            log_line(jid, f'  [SKIP] 文件不可访问: {os.path.basename(fp)}', 'warn')
            log_line(jid, f'         路径: {fp}', 'warn')

    if skipped_files:
        log_line(jid, f'  ⚠ {len(skipped_files)} 个文件被跳过（不可访问）', 'warn')

    if len(accessible_files) < 2:
        return False, '合并失败：有效文件不足 2 个（其余不可访问）'
    if len(accessible_files) < len(input_files):
        log_line(jid, f'  将继续合并 {len(accessible_files)}/{len(input_files)} 个可访问文件', 'warn')

    input_files = accessible_files

    # ── Determine output container ───────────────────────────────
    # MP4/MOV muxer uses 32-bit signed integers for DTS internally.
    # For >6h videos (172 GoPro files ≈ 16.7h), DTS overflows causing
    # "Assertion next_dts <= 0x7fffffff failed" crash (rc=3221226505 = 0xC0000409).
    # FIX: Use Matroska (.mkv) container for the intermediate merged file,
    # which supports 64-bit timestamps. The subsequent encoding step creates
    # fresh timestamps in the final MP4 output.
    original_ext = os.path.splitext(output_path)[1].lower()
    if original_ext in ('.mp4', '.mov'):
        # Change intermediate to .mkv to avoid DTS overflow
        merge_output = output_path + '.merged.mkv'
    else:
        merge_output = output_path

    # Create concat list file
    list_fd, list_path = tempfile.mkstemp(suffix='.txt', prefix='ffconcat_')
    try:
        with os.fdopen(list_fd, 'w', encoding='utf-8') as f:
            for fp in input_files:
                # Escape single quotes in file paths for the concat format
                escaped = fp.replace("'", "'\\''")
                f.write(f"file '{escaped}'\n")
        log_line(jid, f'--- Merging {len(input_files)} files ---')
        for i, fp in enumerate(input_files):
            log_line(jid, f'  [{i+1}] {os.path.basename(fp)}')

        # Estimate total data size for user feedback
        total_bytes = 0
        for fp in input_files:
            try:
                total_bytes += os.path.getsize(fp)
            except OSError:
                pass
        total_gb = total_bytes / (1024**3)
        log_line(jid, f'  合并数据量约 {total_gb:.1f} GB, stream copy 模式 (无重编码)')

        # Get duration of each file to track merge progress
        file_durations = []
        cumulative = 0.0
        cumulative_list = []  # [(end_time, filename), ...]
        for i, fp in enumerate(input_files):
            # Check cancel during duration probing (can be slow on network drives)
            if i % 10 == 0:
                with job_lock:
                    _j = jobs.get(jid)
                    if not _j or _j['status'] == 'cancelled':
                        return False, 'Cancelled by user'
            d = get_duration(fp)
            file_durations.append(d)
            cumulative += d
            cumulative_list.append((cumulative, os.path.basename(fp)))
        total_duration = cumulative

        # Warn about DTS overflow risk for very long videos
        if total_duration > 23860 and original_ext in ('.mp4', '.mov'):
            log_line(jid, f'  ⚠ 总时长 {total_duration:.0f}s 超过 MP4 DTS 上限 (~23860s), 已自动切换为 MKV 中间容器', 'warn')

        if total_duration > 0:
            log_line(jid, f'  总时长 {total_duration:.1f}s, 将实时显示合并进度')
        else:
            log_line(jid, f'  无法获取时长信息, 此阶段不显示进度条, 请耐心等待...')

        # Final cancel check before starting ffmpeg
        with job_lock:
            _j = jobs.get(jid)
            if not _j or _j['status'] == 'cancelled':
                return False, 'Cancelled by user'

        # Set merge_status so frontend can show merge-specific progress
        with job_lock:
            j = jobs.get(jid)
            if j:
                j['merge_status'] = {
                    'phase': 'merging',
                    'total_files': len(input_files),
                    'total_duration': round(total_duration, 1),
                    'total_bytes': total_bytes,
                    'total_gb': round(total_gb, 2),
                    'file_names': [os.path.basename(fp) for fp in input_files],
                    'file_durations': [round(d, 1) for d in file_durations],
                    'cumulative': [(round(c, 1), os.path.basename(fp)) for c, fp in zip(
                        [sum(file_durations[:i+1]) for i in range(len(file_durations))],
                        input_files
                    )],
                    'current_file_index': 0,
                    'current_file_name': os.path.basename(input_files[0]) if input_files else '',
                    'elapsed_time': 0.0,
                    'start_time': time.time(),
                }

        # 容错参数（v3.3.3）：GoPro 源文件可能包含损坏的 NAL unit，
        # stream copy 模式下虽然会报告错误但通常仍能继续，添加显式容错避免
        # 因个别损坏帧导致整个合并阶段失败或产生不可恢复的临时文件。
        # FIX（v3.3.5）：移除 -max_errors -1，该选项不是 ffmpeg 标准选项，
        # 当前 ffmpeg 构建（N-125608）不支持，导致 "Unrecognized option" 错误，
        # 合并直接失败。-err_detect ignore_err + -fflags +discardcorrupt 已足够。
        # FIX（v3.5.0）：输出到 .mkv 容器避免 32-bit DTS 溢出崩溃。
        cmd = [
            FFMPEG_PATH, '-y',
            '-err_detect', 'ignore_err',
            '-fflags', '+discardcorrupt',
            '-f', 'concat',
            '-safe', '0',
            '-i', list_path,
            '-map', '0:v:0',        # Only copy first video stream
            '-map', '0:a:0?',       # First audio stream, OPTIONAL — FIX (v3.13.2 P0-1):
                                    # sources without an audio track made the whole merge
                                    # fail with "Stream map '' matches no streams"
            '-ignore_unknown',       # Skip unknown streams (GoPro tmcd etc.)
            '-c', 'copy',
            merge_output
        ]
        log_line(jid, f'  Running ffmpeg concat (stream copy → {os.path.basename(merge_output)})...')
        # Pass total_duration so parse_progress() can track merge progress
        rc = run_ffmpeg(cmd, jid, total_duration)

        # Check if cancelled during merge
        with job_lock:
            _j = jobs.get(jid)
            if not _j or _j['status'] == 'cancelled':
                try: os.remove(merge_output)
                except Exception: pass
                # Already inside job_lock — no need for nested acquisition
                j = jobs.get(jid)
                if j:
                    j['merge_status'] = None
                return False, 'Cancelled by user'

        if rc != 0:
            try: os.remove(merge_output)
            except Exception: pass
            # Clear merge_status on failure
            with job_lock:
                j = jobs.get(jid)
                if j:
                    j['merge_status'] = None
                    _el = j.pop('_ffmpeg_last_err', [])
            _fe = parse_ffmpeg_error(_el, rc)
            return False, _fe or f'Merge failed (rc={rc})'
        log_line(jid, '  Merge: OK', 'success')

        # If we used .mkv intermediate, update the output_path so convert_one
        # reads from the MKV file instead of the original (nonexistent) MP4 path
        if merge_output != output_path:
            # Rename the module-level variable — but we can't, so we update the
            # caller's reference. Instead, we write the path to the job dict.
            with job_lock:
                j = jobs.get(jid)
                if j:
                    j['_merged_tmp_path'] = merge_output

        # Clear merge_status — encoding phase will begin next
        with job_lock:
            j = jobs.get(jid)
            if j:
                j['merge_status'] = None
        return True, None
    finally:
        try: os.remove(list_path)
        except Exception: pass


def convert_one(jid, inp, out, params):
    """Convert a single file."""
    # Okaa dual-fisheye correction: force panoramic metadata and disable stabilization
    # (the correction already builds a filter_complex that conflicts with vidstab -vf)
    if params.get('okaa_correction'):
        params['inject_spherical'] = True
        params['pano_type'] = '360'
        params['stereo_mode'] = 'mono'
        if params.get('stabilize'):
            log_line(jid, 'Okaa 校正启用：禁用画面防抖（与双鱼眼滤镜链冲突）', 'warn')
            params['stabilize'] = False
            params.pop('_stab_trf', None)

    # Insta360 .insv processing (v3.9.0): auto-detect paired lens files,
    # enable v360 dual-fisheye→equirect conversion, force panoramic metadata
    if is_insv_file(inp):
        # Detect paired lens file for pre-X4 cameras (front _00_ + back _10_)
        pair = detect_insv_pair(inp)
        if pair:
            log_line(jid, f'  检测到 Insta360 双镜头文件配对: {os.path.basename(pair)}')
            log_line(jid, f'  自动合并双镜头 → v360 全景拼接')
            params['_insv_pair'] = pair
        else:
            log_line(jid, f'  Insta360 单文件模式 (X4+ 内置双鱼眼)')
            params.pop('_insv_pair', None)

        if params.get('insv_stitch', True):
            params['inject_spherical'] = True
            params['pano_type'] = '360'
            params['stereo_mode'] = 'mono'
            log_line(jid, '  Insta360 双鱼眼→全景转换: 已启用 (v360=dfisheye:equirect)')

        if params.get('insv_direction_lock', False):
            # Direction lock = vidstab stabilization for horizon leveling
            if not params.get('stabilize'):
                params['stabilize'] = True
                log_line(jid, '  方向锁定: 启用画面防抖进行地平线校正')

        if params.get('insv_stabilize', False):
            # Insta360 FlowState alternative = vidstab
            if not params.get('stabilize'):
                params['stabilize'] = True
                log_line(jid, '  Insta360 防抖 (FlowState 替代): 启用 vidstab')

    # Test encoding mode: modify output filename and use test duration
    test_dur = params.get('test_duration', 0)
    if test_dur and test_dur > 0:
        # Insert _test before extension
        base, ext = os.path.splitext(out)
        out = base + '_test' + ext
        log_line(jid, f'=== TEST MODE: encoding first {test_dur}s only ===')
        log_line(jid, f'Test output: {out}')

    # Pre-validate input file (v3.8.1): catch corrupted/incomplete files
    # before launching ffmpeg. This catches "moov atom not found" and similar
    # errors early, giving the user a clear message instead of a cryptic rc.
    valid, verr = validate_input_file(inp)
    if not valid:
        log_line(jid, f'  输入文件校验失败: {verr}', 'error')
        return False, verr, out

    duration = get_duration(inp)
    log_line(jid, f'Duration: {duration:.1f}s')

    # For progress calculation: use test_duration if in test mode
    progress_duration = min(duration, test_dur) if test_dur and test_dur > 0 else duration

    # FIX (v3.5.0): Cancel check at the start of convert_one.
    # Without this, if cancel happens between merge and encode, the
    # encoding still starts on the (possibly deleted) merged file.
    with job_lock:
        j = jobs.get(jid)
        if not j or j['status'] == 'cancelled':
            return False, 'Cancelled by user', out

    # ── Stabilization preprocessing (v3.0) ──
    stab_tmp = None
    if params.get('stabilize') and STAB_AVAILABLE:
        # Check if job was cancelled before starting stabilization
        with job_lock:
            j = jobs.get(jid)
            if not j or j['status'] == 'cancelled':
                return False, 'Cancelled by user', out
        vtype = detect_video_type(inp, params)
        if vtype == 'panoramic' and stabilize_panoramic is not None:
            # Strategy B: OpenCV spherical stabilization -> intermediate file
            stab_tmp = out + '.stab_tmp.mp4'
            log_line(jid, '--- 球面防抖 (全景视频) ---')
            _last_pct = [0]
            def _stab_progress(pct):
                p = int(pct)
                if p >= _last_pct[0] + 25 or p >= 100:
                    _last_pct[0] = p
                    log_line(jid, f'  防抖进度: {p}%')
            ok, serr = stabilize_panoramic(
                inp, stab_tmp, params,
                ffmpeg_path=FFMPEG_PATH, env=_ffmpeg_env(),
                log_fn=lambda m, lv='info': log_line(jid, m, lv),
                progress_fn=_stab_progress,
                creationflags=NO_WINDOW,
            )
            if ok:
                log_line(jid, '球面防抖完成', 'success')
                inp = stab_tmp
            else:
                log_line(jid, f'球面防抖失败: {serr}, 使用原始文件', 'warn')
                try: os.remove(stab_tmp)
                except Exception: pass
                stab_tmp = None
        else:
            # Strategy A: vidstab detect pass -> .trf file (transform inlined in -vf)
            trf_fd, trf_path = tempfile.mkstemp(suffix='.trf', prefix='vidstab_')
            os.close(trf_fd)
            log_line(jid, '--- 防抖分析 (标准视频 vidstab) ---')
            ok = vidstab_detect(
                FFMPEG_PATH, inp, trf_path,
                shakiness=params.get('stabilize_shakiness', 5),
                env=_ffmpeg_env(),
                log_fn=lambda m, lv='info': log_line(jid, m, lv),
                creationflags=NO_WINDOW,
            )
            if ok:
                params['_stab_trf'] = trf_path
                log_line(jid, 'vidstab 分析完成', 'success')
            else:
                log_line(jid, 'vidstab 分析失败, 跳过防抖', 'warn')
                try: os.remove(trf_path)
                except Exception: pass

    # Check if job was cancelled during stabilization preprocessing
    with job_lock:
        j = jobs.get(jid)
        if not j or j['status'] == 'cancelled':
            if stab_tmp:
                try: os.remove(stab_tmp)
                except Exception: pass
            trf = params.pop('_stab_trf', None)
            if trf:
                try: os.remove(trf)
                except Exception: pass
            return False, 'Cancelled by user', out

    # Determine effective creation_time from filename or manual override
    effective_ct = None
    effective_dt = None
    if params.get('date_from_filename') or params.get('manual_date'):
        if params.get('manual_date'):
            manual = params['manual_date'].strip()
            try:
                if 'T' in manual:
                    effective_dt = datetime.fromisoformat(manual)
                else:
                    effective_dt = datetime.fromisoformat(manual + 'T12:00:00')
                # FIX (v3.13.4 场景4): aware 输入（UTC Z）统一转本地 naive，见元数据链路
                if effective_dt.tzinfo is not None:
                    effective_dt = effective_dt.astimezone().replace(tzinfo=None)
                effective_ct = effective_dt.strftime('%Y-%m-%dT%H:%M:%S')
            except ValueError:
                log_line(jid, f'Invalid manual date format: {manual}', 'warn')
        if not effective_ct and params.get('date_from_filename'):
            ct_str, dt_obj = extract_date_from_filename(os.path.basename(inp))
            if ct_str:
                effective_ct = ct_str
                effective_dt = dt_obj
                log_line(jid, f'Extracted date from filename: {ct_str}')
            else:
                log_line(jid, 'No date found in filename', 'warn')

    # Set the effective creation_time for build_cmd
    if effective_ct:
        params['_effective_creation_time'] = effective_ct
    else:
        params.pop('_effective_creation_time', None)

    os.makedirs(os.path.dirname(out) or '.', exist_ok=True)
    temp_out = out + '.tmp.mp4' if params.get('inject_spherical') else out

    mode = params.get('rate_mode', 'crf')
    # High-res (6K/8K/custom) codec & level compatibility auto-adjust
    enforce_hires_compat(params, log=lambda m, lv='info': log_line(jid, m, lv))
    codec = params.get('codec', 'libx264')
    cp = CODEC_PROFILES.get(codec, CODEC_PROFILES['libx264'])
    log_line(jid, f'Codec: {cp["label"]}')

    # copy 模式没有码率控制，无需 2-pass（也避免把整段流复制白跑一遍）
    if mode == '2pass' and cp['group'] == 'cpu' and not params.get('copy_mode'):
        passlog = os.path.join(os.path.dirname(temp_out), f'.ffpass_{uuid_mod.uuid4().hex[:8]}')
        log_line(jid, '--- Pass 1/2 (analysis) ---')
        cmd1 = build_cmd(inp, temp_out, params, pass_num=1, passlogfile=passlog)
        rc = run_ffmpeg(cmd1, jid, progress_duration, '[P1] ')
        if rc != 0:
            _el = []
            with job_lock:
                _j = jobs.get(jid)
                if _j: _el = _j.pop('_ffmpeg_last_err', [])
            _fe = parse_ffmpeg_error(_el, rc)
            return False, _fe or f'Pass 1 failed (rc={rc})', out
        log_line(jid, '--- Pass 2/2 (encode) ---')
        cmd2 = build_cmd(inp, temp_out, params, pass_num=2, passlogfile=passlog)
        rc = run_ffmpeg(cmd2, jid, progress_duration, '[P2] ')
        for f in Path(os.path.dirname(temp_out)).glob(f'{os.path.basename(passlog)}*'):
            try: f.unlink()
            except Exception: pass
        if rc != 0:
            _el = []
            with job_lock:
                _j = jobs.get(jid)
                if _j: _el = _j.pop('_ffmpeg_last_err', [])
            _fe = parse_ffmpeg_error(_el, rc)
            return False, _fe or f'Pass 2 failed (rc={rc})', out
    else:
        log_line(jid, '--- Encoding ---')
        cmd = build_cmd(inp, temp_out, params)
        rc = run_ffmpeg(cmd, jid, progress_duration)
        if rc != 0:
            # NVENC 崩溃自动回退软件编码（v3.3.3）
            # 0xC0000005 = 3221225477 (unsigned) = -1073741819 (signed)
            # NVENC 硬件编码器对源文件中损坏的 NAL unit 极敏感，会触发访问
            # 违规崩溃；软件编码器（libx264/libx265）对损坏数据容忍度高，
            # 通常能跳过损坏帧继续编码。检测到该错误码时自动切换到对应
            # 软件编码器重试一次，避免批量任务因个别文件中断。
            if rc in (3221225477, -1073741819):
                codec = params.get('codec', '')
                fallback_map = {'hevc_nvenc': 'libx265', 'h264_nvenc': 'libx264'}
                fallback = fallback_map.get(codec)
                if fallback:
                    log_line(jid, f'NVENC 编码器崩溃 (rc={rc}, 0xC0000005 访问违规)', 'warn')
                    log_line(jid, f'自动回退到 {fallback} 软件编码（速度较慢但容忍损坏数据）', 'warn')
                    # 清理失败的临时输出文件
                    try: os.remove(temp_out)
                    except Exception: pass
                    # FIX (v3.5.1): NVENC preset (p1-p7) 不被 libx264/libx265 支持，
                    # 必须映射到软件编码器的 preset（ultrafast ~ slower）。
                    # 否则 libx265 报 "Error setting preset/tune p4" 直接失败。
                    nvenc_preset_map = {
                        'p1': 'ultrafast', 'p2': 'superfast', 'p3': 'veryfast',
                        'p4': 'fast', 'p5': 'medium', 'p6': 'slow', 'p7': 'slower',
                    }
                    old_preset = params.get('preset', 'p4')
                    new_preset = nvenc_preset_map.get(old_preset, 'fast')
                    params['preset'] = new_preset
                    log_line(jid, f'  preset 映射: {old_preset} → {new_preset}', 'info')
                    # 切换 codec 并重建命令
                    params['codec'] = fallback
                    cp_new = CODEC_PROFILES.get(fallback, CODEC_PROFILES['libx264'])
                    log_line(jid, f'Fallback codec: {cp_new["label"]}')
                    cmd = build_cmd(inp, temp_out, params)
                    rc = run_ffmpeg(cmd, jid, progress_duration)
                    if rc == 0:
                        log_line(jid, '软件编码回退成功', 'success')
            if rc != 0:
                # Parse ffmpeg stderr for user-friendly error message (v3.8.1)
                _err_lines = []
                with job_lock:
                    _j = jobs.get(jid)
                    if _j:
                        _err_lines = _j.pop('_ffmpeg_last_err', [])
                _friendly = parse_ffmpeg_error(_err_lines, rc)
                if _friendly:
                    return False, _friendly, out
                return False, f'ffmpeg failed (rc={rc})', out

    with job_lock:
        jobs[jid]['file_progress'] = 100.0

    # Inject spherical metadata
    if params.get('inject_spherical') and inject_uuid:
        pano_type = params.get('pano_type', '360')
        stereo_mode = params.get('stereo_mode', 'mono')
        log_line(jid, f'--- Injecting GSpherical metadata (pano={pano_type}, stereo={stereo_mode}) ---')
        try:
            ok = inject_uuid(temp_out, out, pano_type, stereo_mode)
            if ok:
                log_line(jid, 'Metadata injection: OK')
            else:
                log_line(jid, 'Metadata injection: FAILED (non-fatal)', 'warn')
                import shutil
                shutil.copy2(temp_out, out)
        except Exception as e:
            log_line(jid, f'Injection error: {e}', 'error')
            import shutil
            shutil.copy2(temp_out, out)
        finally:
            try: os.remove(temp_out)
            except Exception: pass
    elif temp_out != out:
        import shutil
        shutil.move(temp_out, out)

    # Post-conversion: set file dates
    if effective_dt:
        log_line(jid, f'--- Setting file dates to {effective_dt.strftime("%Y-%m-%d %H:%M:%S")} ---')
        date_results = set_file_dates(
            out, effective_dt,
            set_created=params.get('set_file_created', True),
            set_modified=params.get('set_file_modified', True),
        )
        if date_results.get('created'):
            log_line(jid, '  File creation date: updated')
        elif 'created_error' in date_results:
            log_line(jid, f'  File creation date error: {date_results["created_error"]}', 'warn')
        if date_results.get('modified'):
            log_line(jid, '  File modification date: updated')
        elif 'modified_error' in date_results:
            log_line(jid, f'  File modification date error: {date_results["modified_error"]}', 'warn')

    # Post-conversion: log location metadata status
    if params.get('set_location') and params.get('location_lat') and params.get('location_lon'):
        iso = format_location_iso6709(params['location_lat'], params['location_lon'])
        log_line(jid, f'  Location metadata: {params.get("location_name", "")} | {params.get("location_address", "")} ({iso})')

    # Cleanup stabilization temp files (v3.0)
    if stab_tmp:
        try: os.remove(stab_tmp)
        except Exception: pass
    trf = params.pop('_stab_trf', None)
    if trf:
        try: os.remove(trf)
        except Exception: pass

    return True, None, out


def conversion_worker(jid):
    """Worker thread: process all items in the job."""
    with job_lock:
        j = jobs.get(jid)
        if not j:
            return
        j['status'] = 'running'
        job_params = dict(j['params'])  # fallback defaults for items without their own params
        items = j['items']

    total = len(items)
    for idx, item in enumerate(items):
        with job_lock:
            j = jobs.get(jid)
            if not j or j['status'] == 'cancelled':
                return
            j['current_index'] = idx
            # Handle merge items that have 'inputs' instead of 'input'
            display_input = item.get('input', '')
            if not display_input and item.get('inputs'):
                display_input = item['inputs'][0] if item['inputs'] else ''
            j['current_input'] = display_input
            j['current_output'] = item['output']
            j['file_progress'] = 0.0

        # Check if item was skipped by user
        if item.get('skipped'):
            item['done'] = True
            item['ok'] = False
            item['error'] = 'Skipped by user'
            _skip_name = item.get('input', '') or (item['inputs'][0] if item.get('inputs') else '')
            log_line(jid, f'[{idx+1}/{total}] {os.path.basename(_skip_name)} -- SKIPPED', 'warn')
            with job_lock:
                j = jobs.get(jid)
                if j:
                    j['overall_progress'] = ((idx + 1) / total) * 100
            continue

        # Wait if paused (between files)
        while True:
            with job_lock:
                j = jobs.get(jid)
                if not j or j['status'] == 'cancelled':
                    return
                if not j['paused']:
                    break
            time.sleep(0.3)

        inp = item.get('input', '')
        out = item['output']
        item['start_time'] = time.time()
        # FIX: 任务已实际开始执行，清除 skipped 标记，确保后续状态以真实结果为准。
        # 场景：用户在 ffmpeg 运行中点"跳过" → skipped=True，但 ffmpeg 不会立即中断，
        # 继续跑完后 ok=False/error=... → 前端会按实际结果渲染，不会被 skipped 覆盖。
        if item.get('skipped'):
            item['skipped'] = False
            log_line(jid, f'  [Note] Item {idx+1} was skipped but already started executing, clearing skip flag', 'info')
        log_line(jid, f'[{idx+1}/{total}] {os.path.basename(inp) if inp else "合并任务"}')
        if inp:
            log_line(jid, f'  in:  {inp}')
        else:
            log_line(jid, f'  in:  合并 {len(item.get("inputs",[]))} 个文件')
        log_line(jid, f'  out: {out}')

        # Merge mode: merge multiple input files first
        merge_inputs = item.get('inputs')
        merged_tmp = None
        if merge_inputs and len(merge_inputs) > 1:
            # Check cancel before starting merge
            with job_lock:
                j = jobs.get(jid)
                if not j or j['status'] == 'cancelled':
                    return
            # FIX (v3.5.0): merge_files() now handles .mkv intermediate internally
            # to avoid MP4 32-bit DTS overflow. It sets _merged_tmp_path in job dict.
            merged_tmp = out + '.merged_tmp' + os.path.splitext(merge_inputs[0])[1]
            mok, merr = merge_files(jid, merge_inputs, merged_tmp)
            if not mok:
                item['done'] = True
                item['ok'] = False
                item['error'] = merr
                item['end_time'] = time.time()
                log_line(jid, f'  {merr}', 'error')
                # FIX (v3.3.5): Check cancelled after merge failure.
                # If user clicked stop during merge, exit the loop
                # instead of continuing to the next task.
                with job_lock:
                    _j = jobs.get(jid)
                    if not _j or _j['status'] == 'cancelled':
                        break
                continue
            # Check if merge_files used .mkv intermediate (DTS overflow protection)
            with job_lock:
                _j = jobs.get(jid)
                actual_merged = _j.pop('_merged_tmp_path', None) if _j else None
            if actual_merged and actual_merged != merged_tmp:
                merged_tmp = actual_merged
                log_line(jid, f'  merged input (mkv): {merged_tmp}')
            else:
                log_line(jid, f'  merged input: {merged_tmp}')
            inp = merged_tmp
            # Reset file_progress for encoding phase
            with job_lock:
                j = jobs.get(jid)
                if j:
                    j['file_progress'] = 0.0
                    if j['total'] > 0:
                        j['overall_progress'] = (j['current_index'] / j['total']) * 100

        # FIX (v3.5.0): Cancel check between merge and encode phases.
        # Without this, if user clicks stop during merge, the merge output
        # gets cleaned up but encoding starts anyway on the (deleted) file.
        with job_lock:
            j = jobs.get(jid)
            if not j or j['status'] == 'cancelled':
                if merged_tmp:
                    try: os.remove(merged_tmp)
                    except Exception: pass
                return

        # Each task may carry its own export parameters; fall back to job-level defaults
        # FIX (v3.13.3): per-item params used to REPLACE the global params entirely
        # (`dict(item.get('params') or job_params)`) — an item carrying a partial
        # params dict silently lost every global key. Merge per-key instead (item
        # wins); the frontend always sends complete snapshots, so its behavior is
        # unchanged, but API callers with partial params no longer drop globals.
        item_params = {**job_params, **(item.get('params') or {})}
        try:
            ok, err, actual_out = convert_one(jid, inp, out, item_params)
        except Exception as e:
            ok, err, actual_out = False, f'Internal error: {e}', out
            log_line(jid, f'  Unexpected exception in convert_one: {e}', 'error')
            # Try to kill any leftover ffmpeg process
            with job_lock:
                j = jobs.get(jid)
                proc = j.get('proc') if j else None
            if proc:
                try:
                    proc.kill()
                except Exception:
                    pass
        item['done'] = True
        item['ok'] = ok
        item['error'] = err
        item['end_time'] = time.time()
        # Write back the actual output path (reflects test-mode _test suffix)
        if actual_out:
            item['output'] = actual_out

        # Clean up merged temp file
        if merged_tmp:
            try: os.remove(merged_tmp)
            except Exception: pass

        if ok:
            log_line(jid, f'  Done', 'success')
        else:
            log_line(jid, f'  {err}', 'error')

        with job_lock:
            j = jobs.get(jid)
            if j:
                j['overall_progress'] = ((idx + 1) / total) * 100

    with job_lock:
        j = jobs.get(jid)
        if j:
            j['overall_progress'] = 100.0
            # Preserve 'cancelled' status — don't overwrite with 'failed'
            if j['status'] == 'cancelled':
                j['end_time'] = time.time()
            else:
                # Set status based on whether all items succeeded
                all_ok = all(item.get('ok', False) for item in items)
                if all_ok:
                    j['status'] = 'completed'
                else:
                    j['status'] = 'failed'
                    # Collect first error for the error field
                    first_err = next((item.get('error') for item in items if item.get('error')), None)
                    j['error'] = first_err
                j['end_time'] = time.time()
    log_line(jid, '=== All conversions complete ===', 'success')


# ── VR 3D 360° Synthesis Worker (v3.9.0) ──────────────────────

def vr3d_merge_one(jid, left_inp, right_inp, out, params):
    """Merge left and right eye videos into a single 3D 360° video.
    Uses vstack (Top-Bottom) or hstack (Side-by-Side), then injects GSpherical stereo metadata.
    Returns (ok: bool, error_msg: str|None, actual_out: str).
    """
    # Validate both input files
    for label, path in [('左眼', left_inp), ('右眼', right_inp)]:
        valid, verr = validate_input_file(path)
        if not valid:
            log_line(jid, f'  {label}文件校验失败: {verr}', 'error')
            return False, verr, out

    # Optional: alignment check
    if params.get('vr3d_check_alignment', True):
        aligned, warnings, info = check_vr3d_alignment(left_inp, right_inp)
        log_line(jid, f'  左眼: {info["left_resolution"]} / {info["left_duration"]:.1f}s')
        log_line(jid, f'  右眼: {info["right_resolution"]} / {info["right_duration"]:.1f}s')
        if warnings:
            for w in warnings:
                log_line(jid, f'  ⚠ {w}', 'warn')
            # If resolution mismatch, add scale filter to align
            if info.get('left_resolution') != info.get('right_resolution'):
                params['vr3d_auto_align'] = True
                log_line(jid, '  自动缩放对齐: 已启用')
        else:
            log_line(jid, '  ✅ 左右眼视频对齐良好')

    # Get duration for progress (use left eye as reference)
    duration = get_duration(left_inp)
    log_line(jid, f'  合成时长: {duration:.1f}s (基于左眼)')

    # Cancel check
    with job_lock:
        j = jobs.get(jid)
        if not j or j['status'] == 'cancelled':
            return False, 'Cancelled by user', out

    # Build command (with high-res codec/level auto-adjust)
    enforce_hires_compat(params, log=lambda m, lv='info': log_line(jid, m, lv))
    cmd = build_vr3d_cmd(left_inp, right_inp, out, params)
    log_line(jid, f'  命令: {" ".join(cmd[:6])}...')

    # Run ffmpeg
    with job_lock:
        j = jobs.get(jid)
        if j:
            j['file_progress'] = 0.0

    rc = run_ffmpeg(cmd, jid, duration, '[3D] ')

    if rc != 0:
        with job_lock:
            err_lines = jobs.get(jid, {}).get('_ffmpeg_last_err', [])
        err_msg = parse_ffmpeg_error(err_lines, rc)
        if not err_msg:
            err_msg = f'VR 3D 合成失败 (rc={rc})'
        return False, err_msg, out

    with job_lock:
        jobs[jid]['file_progress'] = 100.0

    # Inject GSpherical metadata with stereo mode
    stereo_mode = 'top-bottom' if params.get('vr3d_layout', 'top-bottom') == 'top-bottom' else 'left-right'
    pano_type = params.get('pano_type', '360')

    if params.get('inject_spherical', True) and inject_uuid:
        log_line(jid, f'--- Injecting GSpherical metadata (pano={pano_type}, stereo={stereo_mode}) ---')
        temp_out = out + '.pre_meta.mp4'
        try:
            import shutil
            shutil.move(out, temp_out)
            ok = inject_uuid(temp_out, out, pano_type, stereo_mode)
            if ok:
                log_line(jid, 'Metadata injection: OK')
            else:
                log_line(jid, 'Metadata injection: FAILED (non-fatal)', 'warn')
                shutil.copy2(temp_out, out)
            try:
                os.remove(temp_out)
            except Exception:
                pass
        except Exception as e:
            log_line(jid, f'Injection error: {e}', 'error')
            # Fallback: keep the pre-injection output
            try:
                import shutil
                shutil.move(temp_out, out)
            except Exception:
                pass

    log_line(jid, f'  ✅ VR 3D 合成完成: {out}', 'success')
    return True, None, out


def vr3d_worker(jid):
    """Worker thread for VR 3D 360° synthesis jobs."""
    with job_lock:
        j = jobs.get(jid)
        if not j:
            return
        j['status'] = 'running'
        params = dict(j['params'])
        items = list(j['items'])

    log_line(jid, '=== VR 3D 360° Synthesis Started ===')
    log_line(jid, f'  Items: {len(items)}')
    log_line(jid, f'  Layout: {params.get("vr3d_layout", "top-bottom")}')

    for idx, item in enumerate(items):
        left = item.get('left_input', '')
        right = item.get('right_input', '')
        out = item.get('output', '')

        with job_lock:
            j = jobs.get(jid)
            if not j or j['status'] == 'cancelled':
                return
            j['current_index'] = idx
            j['current_input'] = f'{os.path.basename(left)} + {os.path.basename(right)}'
            j['current_output'] = out
            j['file_progress'] = 0.0

        log_line(jid, f'--- [{idx + 1}/{len(items)}] VR 3D Merge ---')
        log_line(jid, f'  Left:  {left}')
        log_line(jid, f'  Right: {right}')
        log_line(jid, f'  Output: {out}')

        # Cancel check
        with job_lock:
            j = jobs.get(jid)
            if not j or j['status'] == 'cancelled':
                return

        try:
            ok, err, actual_out = vr3d_merge_one(jid, left, right, out, params)
            with job_lock:
                j = jobs.get(jid)
                if j:
                    item['ok'] = ok
                    item['error'] = err
                    item['output_path'] = actual_out
                    item['end_time'] = time.time()
                    if not ok:
                        j['error'] = err
        except Exception as e:
            import traceback
            log_line(jid, f'  Internal error: {e}', 'error')
            log_line(jid, traceback.format_exc(), 'error')
            with job_lock:
                j = jobs.get(jid)
                if j:
                    item['ok'] = False
                    item['error'] = str(e)
                    # Kill any lingering ffmpeg
                    proc = j.get('proc')
                    if proc:
                        try:
                            proc.kill()
                        except Exception:
                            pass

        with job_lock:
            j = jobs.get(jid)
            if j and len(items) > 0:
                j['overall_progress'] = ((idx + 1) / len(items)) * 100

    # Final status
    with job_lock:
        j = jobs.get(jid)
        if j:
            all_ok = all(item.get('ok', False) for item in items)
            if j['status'] != 'cancelled':
                j['status'] = 'completed' if all_ok else 'failed'
                if not all_ok:
                    first_err = next((item.get('error') for item in items if item.get('error')), None)
                    j['error'] = first_err
                j['end_time'] = time.time()
    log_line(jid, '=== VR 3D Synthesis Complete ===', 'success')


# ── Standalone Metadata Worker (no re-encoding) ──────────────
def apply_metadata_one(jid, inp, out, params):
    """Apply metadata to a video without re-encoding (ffmpeg -c copy)."""
    # Test mode: modify output filename and limit duration
    test_dur = params.get('test_duration', 0)
    if test_dur and test_dur > 0:
        base, ext = os.path.splitext(out)
        out = base + '_test' + ext
        log_line(jid, f'=== TEST MODE: processing first {test_dur}s only ===')
        log_line(jid, f'Test output: {out}')

    log_line(jid, f'  in:  {inp}')
    log_line(jid, f'  out: {out}')

    # Pre-validate input file (v3.8.1)
    valid, verr = validate_input_file(inp)
    if not valid:
        log_line(jid, f'  输入文件校验失败: {verr}', 'error')
        return False, verr, out

    apply_date = params.get('apply_date', False)
    apply_location = params.get('apply_location', False)
    apply_spherical = params.get('apply_spherical', False)

    # Determine effective date
    effective_ct = None
    effective_dt = None
    if apply_date:
        if params.get('manual_date'):
            manual = params['manual_date'].strip()
            try:
                if 'T' in manual:
                    effective_dt = datetime.fromisoformat(manual)
                else:
                    effective_dt = datetime.fromisoformat(manual + 'T12:00:00')
                # FIX (v3.13.4 场景4): probe 的 creation_time 是 UTC（带 Z）。aware 输入
                # 若不转换：FS 时间取绝对时刻（本地显示 +8h）、tag 把 UTC 墙钟当本地写
                # （-8h）。统一转为本地 naive，保证"设定值 = 产出墙钟"。
                if effective_dt.tzinfo is not None:
                    effective_dt = effective_dt.astimezone().replace(tzinfo=None)
                effective_ct = effective_dt.strftime('%Y-%m-%dT%H:%M:%S')
            except ValueError:
                log_line(jid, f'Invalid manual date: {manual}', 'warn')
        if not effective_ct and params.get('date_from_filename'):
            ct_str, dt_obj = extract_date_from_filename(os.path.basename(inp))
            if ct_str:
                effective_ct = ct_str
                effective_dt = dt_obj
                log_line(jid, f'  Extracted date: {ct_str}')
            else:
                log_line(jid, '  No date found in filename', 'warn')

    need_ffmpeg = (apply_date and (effective_ct or params.get('set_file_created') or params.get('set_file_modified'))) or \
                  (apply_location and params.get('location_lat') and params.get('location_lon'))
    need_spherical = apply_spherical and inject_uuid is not None

    os.makedirs(os.path.dirname(out) or '.', exist_ok=True)

    # If output == input, we need a temp file
    if os.path.abspath(inp) == os.path.abspath(out):
        temp_out = out + '.meta_tmp.mp4'
        replace_original = True
    else:
        temp_out = out
        replace_original = False

    if need_ffmpeg or need_spherical:
        # v3.13.10 统一单临时文件流水线
        # 旧行为（全景视频）：ffmpeg mux（含 +faststart，moov 前置）→ 注入器对
        # moov 前置文件插盒必须全量重写 → 产生第二个全量临时文件，磁盘全量 IO 3 遍。
        # 新流水线：
        #   第 1 遍  ffmpeg -c copy 写元数据（不带 +faststart，moov 留在尾部）
        #   第 2 步  注入器就地插 GSpherical（IO 仅 moov 尾区，mdat 与全部 chunk
        #            偏移位于插入点之前、不受影响）
        #   第 3 步  faststart 开启时一次全量重排（moov 移到头部，直达最终输出名）
        # 效果：全量临时文件 2 -> 1；全量 IO 3 -> 2（faststart 开）/ 2 -> 1（关）。
        cmd = [FFMPEG_PATH, '-y', '-i', inp]

        # Test mode: limit duration
        if test_dur and test_dur > 0:
            cmd += ['-t', str(test_dur)]

        cmd += ['-c', 'copy']

        # Metadata: creation_time
        if effective_ct and params.get('set_creation_time', True):
            cmd += ['-metadata', 'creation_time=' + effective_ct]
            log_line(jid, '  creation_time=' + effective_ct)

        # Metadata: location (ISO 6709) + 地名(description) + 地址(comment)
        if apply_location and params.get('location_lat') and params.get('location_lon'):
            iso6709 = format_location_iso6709(params['location_lat'], params['location_lon'])
            if iso6709:
                cmd += ['-metadata', 'location=' + iso6709]
            loc_name = params.get('location_name', '')
            if loc_name:
                cmd += ['-metadata', 'description=' + loc_name]
            loc_addr = params.get('location_address', '')
            if loc_addr:
                cmd += ['-metadata', 'comment=' + loc_addr]
            log_line(jid, '  location=%s name=%s addr=%s' % (iso6709, loc_name, loc_addr))

        # 不带 +faststart：moov 留在尾部供就地注入；faststart 由第 3 步重排实现。
        cmd.append(temp_out)
        log_line(jid, '  Running ffmpeg (stream copy, no re-encode)...')
        progress_dur = test_dur if test_dur and test_dur > 0 else 0
        rc = run_ffmpeg(cmd, jid, progress_dur)

        if rc != 0:
            try: os.remove(temp_out)
            except Exception: pass
            _el = []
            with job_lock:
                _j = jobs.get(jid)
                if _j: _el = _j.pop('_ffmpeg_last_err', [])
            _fe = parse_ffmpeg_error(_el, rc)
            return False, _fe or 'ffmpeg stream copy failed (rc=%d)' % rc, out

        # GSpherical 注入 —— 优先就地（无第二全量文件）
        if need_spherical:
            pano_type = params.get('pano_type', '360')
            stereo_mode = params.get('stereo_mode', 'mono')
            log_line(jid, '  Injecting GSpherical metadata (pano=%s, stereo=%s)...' % (pano_type, stereo_mode))
            ok = False
            try:
                ok = inject_uuid_inplace(temp_out, pano_type, stereo_mode)
                if ok:
                    log_line(jid, '  Spherical injection: OK (in-place, no extra temp file)')
            except Exception as e:
                log_line(jid, '  In-place injection error: ' + str(e), 'error')
                ok = False
            if not ok:
                # 兜底：moov 在前的形态 / 就地失败 -> 旧两文件注入路径
                log_line(jid, '  Falling back to two-file injection', 'warn')
                final_out = out + '.spherical_tmp.mp4'
                try:
                    ok = inject_uuid(temp_out, final_out, pano_type, stereo_mode)
                    if ok:
                        log_line(jid, '  Spherical injection: OK (two-file fallback)')
                    else:
                        log_line(jid, '  Spherical injection: FAILED (non-fatal)', 'warn')
                        import shutil
                        shutil.copy2(temp_out, final_out)
                except Exception as e:
                    log_line(jid, '  Injection error: ' + str(e), 'error')
                    import shutil
                    shutil.copy2(temp_out, final_out)
                if os.path.exists(final_out):
                    os.replace(final_out, temp_out)   # 内容归一回 temp_out

        # faststart 重排（moov 移到头部 —— 一次全量流式写，直达最终输出名）
        if params.get('faststart', True):
            fs_ok = False
            try:
                if replace_original:
                    # 覆盖源文件场景：relocate(meta_tmp → out)，meta_tmp 是全量保底
                    fs_ok = relocate_moov_front(temp_out, out)
                    if fs_ok:
                        log_line(jid, '  faststart relocation: OK (moov moved to front)')
                        # 重排产物是新建文件 —— 继承 mux 产物的 FS 时间（旧 os.replace 语义）
                        try:
                            st_t = os.stat(temp_out)
                            set_file_dates(out, datetime.fromtimestamp(st_t.st_ctime), set_created=True, set_modified=False)
                            set_file_dates(out, datetime.fromtimestamp(st_t.st_mtime), set_created=False, set_modified=True)
                        except Exception:
                            pass
                        try: os.remove(temp_out)
                        except Exception: pass
                else:
                    # temp_out == out（新目录）：重排结果落临时文件后用 'r+b' 截断
                    # 回写 out 自身 —— 文件对象不变，创建时间谱系与旧流水线（ffmpeg
                    # 'wb' 截断）完全一致；不用 os.replace（会换文件对象、重置创建时间）
                    fs_tmp = out + '.faststart_tmp.mp4'
                    fs_ok = relocate_moov_front(temp_out, fs_tmp)
                    if fs_ok:
                        log_line(jid, '  faststart relocation: OK (moov moved to front)')
                        with open(fs_tmp, 'rb') as rf, open(out, 'r+b') as wf:
                            wf.truncate(0)
                            while True:
                                chunk = rf.read(64 * 1024 * 1024)
                                if not chunk:
                                    break
                                wf.write(chunk)
                        try: os.remove(fs_tmp)
                        except Exception: pass
            except Exception as e:
                log_line(jid, '  faststart relocation error: ' + str(e), 'error')
                fs_ok = False
            if not fs_ok:
                log_line(jid, '  faststart relocation failed; keeping tail-moov output (non-fatal)', 'warn')
                if replace_original:
                    try: os.replace(temp_out, out)
                    except Exception as e:
                        log_line(jid, '  Failed to replace original: ' + str(e), 'error')
                        return False, str(e), out
        else:
            if replace_original:
                try: os.replace(temp_out, out)
                except Exception as e:
                    log_line(jid, '  Failed to replace original: ' + str(e), 'error')
                    return False, str(e), out
        # 新目录场景：temp_out == out，第 1 遍 ffmpeg 已直写目的地

    else:
        # FIX (v3.13.3): distinguish "nothing enabled at all" from "enabled but
        # ineffective" (e.g. an unparseable date, or location missing its lon) —
        # the old single message was misleading when the user HAD enabled a feature.
        if apply_date or apply_location or apply_spherical:
            msg = ('No actionable metadata: enabled feature(s) produced nothing to apply '
                   '(check the date value / location coordinates)')
        else:
            msg = 'No metadata features enabled'
        log_line(jid, f'  {msg}', 'warn')
        return False, msg, out

    # Set file dates
    if effective_dt and (params.get('set_file_created', True) or params.get('set_file_modified', True)):
        log_line(jid, f'  Setting file dates to {effective_dt.strftime("%Y-%m-%d %H:%M:%S")}...')
        date_results = set_file_dates(
            out, effective_dt,
            set_created=params.get('set_file_created', True),
            set_modified=params.get('set_file_modified', True),
        )
        if date_results.get('created'):
            log_line(jid, '    File creation date: updated')
        if date_results.get('modified'):
            log_line(jid, '    File modification date: updated')
        # FIX (v3.13.3 BUG-2): set_file_dates failures used to be silently swallowed
        # (only success branches were logged) — the FS creation time could never be
        # applied without the user ever knowing. Surface both error fields now.
        if date_results.get('created_error'):
            log_line(jid, f"    File creation date ERROR: {date_results['created_error']}", 'warn')
        if date_results.get('modified_error'):
            log_line(jid, f"    File modification date ERROR: {date_results['modified_error']}", 'warn')

    return True, None, out


def metadata_worker(jid):
    """Worker thread: apply metadata to all items without re-encoding."""
    with job_lock:
        j = jobs.get(jid)
        if not j:
            return
        j['status'] = 'running'
        job_params = dict(j['params'])
        items = j['items']

    total = len(items)
    for idx, item in enumerate(items):
        with job_lock:
            j = jobs.get(jid)
            if not j or j['status'] == 'cancelled':
                return
            j['current_index'] = idx
            j['current_input'] = item['input']
            j['current_output'] = item['output']
            j['file_progress'] = 0.0

        # Check if item was skipped by user
        if item.get('skipped'):
            item['done'] = True
            item['ok'] = False
            item['error'] = 'Skipped by user'
            log_line(jid, f'[{idx+1}/{total}] {os.path.basename(item["input"])} -- SKIPPED', 'warn')
            with job_lock:
                j = jobs.get(jid)
                if j:
                    j['overall_progress'] = ((idx + 1) / total) * 100
            continue

        # Wait if paused (between files)
        while True:
            with job_lock:
                j = jobs.get(jid)
                if not j or j['status'] == 'cancelled':
                    return
                if not j['paused']:
                    break
            time.sleep(0.3)

        inp = item['input']
        out = item['output']
        item['start_time'] = time.time()
        log_line(jid, f'[{idx+1}/{total}] {os.path.basename(inp)}')

        # FIX (v3.13.3): per-item params used to REPLACE the global params entirely
        # (`dict(item.get('params') or job_params)`) — an item carrying a partial
        # params dict silently lost every global key. Merge per-key instead (item
        # wins); the frontend always sends complete snapshots, so its behavior is
        # unchanged, but API callers with partial params no longer drop globals.
        item_params = {**job_params, **(item.get('params') or {})}
        try:
            ok, err, actual_out = apply_metadata_one(jid, inp, out, item_params)
        except Exception as e:
            ok, err, actual_out = False, f'Internal error: {e}', out
            log_line(jid, f'  Unexpected exception in apply_metadata_one: {e}', 'error')
        item['done'] = True
        item['ok'] = ok
        item['error'] = err
        item['end_time'] = time.time()
        if actual_out:
            item['output'] = actual_out

        if ok:
            log_line(jid, '  Done', 'success')
        else:
            log_line(jid, f'  {err}', 'error')

        with job_lock:
            j = jobs.get(jid)
            if j:
                j['overall_progress'] = ((idx + 1) / total) * 100

    with job_lock:
        j = jobs.get(jid)
        if j:
            j['overall_progress'] = 100.0
            # Preserve 'cancelled' status — don't overwrite with 'failed'
            if j['status'] == 'cancelled':
                j['end_time'] = time.time()
            else:
                # Set status based on whether all items succeeded
                all_ok = all(item.get('ok', False) for item in items)
                if all_ok:
                    j['status'] = 'completed'
                else:
                    j['status'] = 'failed'
                    first_err = next((item.get('error') for item in items if item.get('error')), None)
                    j['error'] = first_err
                j['end_time'] = time.time()
    log_line(jid, '=== All metadata operations complete ===', 'success')


# ── Preset Management ──────────────────────────────────────────
def list_presets():
    presets = []
    for f in sorted(Path(PRESETS_DIR).glob('*.json')):
        try:
            data = json.loads(f.read_text(encoding='utf-8'))
        except Exception:
            continue
        # Skip the internal app settings file and any malformed / nameless entries
        if not isinstance(data, dict) or not data.get('name'):
            continue
        presets.append(data)
    return presets


def save_preset(name, params, batch_formula, project_dir=''):
    path = Path(PRESETS_DIR) / f'{name}.json'
    data = {'name': name, 'params': params, 'batch_formula': batch_formula, 'project_dir': project_dir}
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding='utf-8')
    return data


def delete_preset(name):
    path = Path(PRESETS_DIR) / f'{name}.json'
    if path.exists():
        path.unlink()
        return True
    return False


# ── API Routes ─────────────────────────────────────────────────
@app.route('/')
def index():
    return send_from_directory('static', 'index.html')


@app.route('/api/drives')
def list_drives():
    """List available drive letters (Windows) or root (Unix)."""
    if os.name != 'nt':
        return jsonify({'drives': [{'name': '/', 'path': '/'}]})
    import string
    drives = []
    for c in string.ascii_uppercase:
        d = f'{c}:\\'
        if os.path.exists(d):
            drives.append({'name': f'{c}:', 'path': d})
    return jsonify({'drives': drives})


@app.route('/api/browse')
def browse():
    """List directories (and optionally files) at a given path."""
    req_path = request.args.get('path', '')
    is_dir_mode = request.args.get('isDir', 'true').lower() == 'true'
    file_filter = request.args.get('filter', '')  # 'video', 'exe', or '' for all
    if not req_path:
        if os.name == 'nt':
            import string
            drives = []
            for c in string.ascii_uppercase:
                d = f'{c}:\\'
                if os.path.exists(d):
                    drives.append({'name': f'{c}:', 'path': d, 'is_dir': True})
            return jsonify({'current': '', 'items': drives})
        else:
            req_path = '/'
    try:
        dirs = []
        files = []
        for entry in os.scandir(req_path):
            if entry.is_dir():
                dirs.append({'name': entry.name, 'path': entry.path, 'is_dir': True})
            elif not is_dir_mode:
                ext = Path(entry.name).suffix.lower()
                if file_filter == 'exe':
                    if ext == '.exe':
                        files.append({'name': entry.name, 'path': entry.path, 'is_dir': False, 'size': entry.stat().st_size})
                elif file_filter == 'video' or not file_filter:
                    if ext in VIDEO_EXTS:
                        files.append({'name': entry.name, 'path': entry.path, 'is_dir': False, 'size': entry.stat().st_size})
                else:
                    # Custom extension filter
                    if ext == '.' + file_filter.lower():
                        files.append({'name': entry.name, 'path': entry.path, 'is_dir': False, 'size': entry.stat().st_size})
        dirs.sort(key=lambda x: x['name'].lower())
        files.sort(key=lambda x: x['name'].lower())
        return jsonify({'current': req_path, 'items': dirs + files})
    except PermissionError:
        return jsonify({'error': 'Permission denied'}), 403
    except FileNotFoundError:
        return jsonify({'error': 'Path not found'}), 404


# ── Native Windows file dialogs via PowerShell ──────────────────
LAST_PATHS_FILE = os.path.join(BASE_DIR, 'last_paths.json')

def _load_last_paths():
    """Load last-used paths for open and save dialogs."""
    try:
        with open(LAST_PATHS_FILE, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return {'open': '', 'save': ''}

def _save_last_paths(paths):
    """Save last-used paths."""
    try:
        with open(LAST_PATHS_FILE, 'w', encoding='utf-8') as f:
            json.dump(paths, f, ensure_ascii=False)
    except Exception:
        pass

def _ps_escape(s):
    """Escape string for PowerShell single-quoted string."""
    return str(s).replace("'", "''").replace('\r', '').replace('\n', '')

def _run_ps_dialog(script, timeout=600):
    """Run a PowerShell dialog script and return the selected path."""
    # Force UTF-8 output encoding so Python can decode correctly
    ps_prefix = (
        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n"
        "$OutputEncoding = [System.Text.Encoding]::UTF8\n"
    )
    full_script = ps_prefix + script
    try:
        # Inherit the FULL parent environment so that network mapped drives
        # (S:\, Z:\, etc.) are visible in file dialogs. Windows mapped drives
        # are per-logon-session DOS device mappings; a subprocess with a
        # stripped-down env cannot see them in the Shell namespace, so the
        # OpenFileDialog / SaveFileDialog won't list network drives.
        #
        # CreateProcessW has a ~32K-character env block limit. If the parent's
        # environment is too large, fall back to a minimal set (network drives
        # may be invisible, but at least the dialog works).
        env = None  # None = inherit full parent environment (default)
        env_size = sum(len(k) + len(v) + 2 for k, v in os.environ.items())
        if env_size > 30000:
            env = {}
            for key in ('SystemRoot', 'PATH', 'TEMP', 'TMP', 'USERPROFILE',
                        'USERNAME', 'windir', 'PATHEXT', 'NUMBER_OF_PROCESSORS',
                        'PROCESSOR_ARCHITECTURE', 'PSModulePath', 'APPDATA',
                        'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH', 'COMPUTERNAME',
                        'OS', 'USERDOMAIN'):
                if key in os.environ:
                    env[key] = os.environ[key]
        result = subprocess.run(
            ['powershell', '-NoProfile', '-NonInteractive', '-STA', '-Command', full_script],
            capture_output=True, text=True, timeout=timeout,
            creationflags=NO_WINDOW, encoding='utf-8', env=env
        )
        path = result.stdout.strip() if result.stdout else ''
        return path
    except subprocess.TimeoutExpired:
        return ''
    except Exception:
        return ''

def _native_open_file(title, initial_dir, file_filter):
    """Show native Windows file open dialog."""
    if file_filter == 'video':
        ps_filter = '视频文件|*.mp4;*.mov;*.mkv;*.avi;*.webm;*.m4v;*.flv;*.insv;*.lrv;*.ts;*.m2ts|Insta360 视频|*.insv;*.lrv|所有文件|*.*'
    elif file_filter == 'exe':
        ps_filter = '可执行文件|*.exe|所有文件|*.*'
    else:
        ps_filter = '所有文件|*.*'
    script = (
        f"Add-Type -AssemblyName System.Windows.Forms\n"
        f"[System.Windows.Forms.Application]::EnableVisualStyles()\n"
        f"$dlg = New-Object System.Windows.Forms.OpenFileDialog\n"
        f"$dlg.Title = '{_ps_escape(title)}'\n"
        f"$dlg.InitialDirectory = '{_ps_escape(initial_dir)}'\n"
        f"$dlg.Filter = '{_ps_escape(ps_filter)}'\n"
        f"$dlg.Multiselect = $false\n"
        f"$owner = New-Object System.Windows.Forms.Form\n"
        f"$owner.TopMost = $true\n"
        f"$owner.WindowState = 'Minimized'\n"
        f"$owner.ShowInTaskbar = $false\n"
        f"$owner.Opacity = 0\n"
        f"$owner.Show()\n"
        f"$result = $dlg.ShowDialog($owner)\n"
        f"$owner.Close()\n"
        f"if ($result -eq 'OK') {{ Write-Output $dlg.FileName }}"
    )
    return _run_ps_dialog(script)

def _native_open_files_multi(title, initial_dir, file_filter):
    """Show native Windows file open dialog with multi-select enabled."""
    if file_filter == 'video':
        ps_filter = '视频文件|*.mp4;*.mov;*.mkv;*.avi;*.webm;*.m4v;*.flv;*.insv;*.lrv;*.ts;*.m2ts|Insta360 视频|*.insv;*.lrv|所有文件|*.*'
    else:
        ps_filter = '所有文件|*.*'
    script = (
        f"Add-Type -AssemblyName System.Windows.Forms\n"
        f"[System.Windows.Forms.Application]::EnableVisualStyles()\n"
        f"$dlg = New-Object System.Windows.Forms.OpenFileDialog\n"
        f"$dlg.Title = '{_ps_escape(title)}'\n"
        f"$dlg.InitialDirectory = '{_ps_escape(initial_dir)}'\n"
        f"$dlg.Filter = '{_ps_escape(ps_filter)}'\n"
        f"$dlg.Multiselect = $true\n"
        f"$owner = New-Object System.Windows.Forms.Form\n"
        f"$owner.TopMost = $true\n"
        f"$owner.WindowState = 'Minimized'\n"
        f"$owner.ShowInTaskbar = $false\n"
        f"$owner.Opacity = 0\n"
        f"$owner.Show()\n"
        f"$result = $dlg.ShowDialog($owner)\n"
        f"$owner.Close()\n"
        f"if ($result -eq 'OK') {{ foreach ($f in $dlg.FileNames) {{ Write-Output $f }} }}"
    )
    return _run_ps_dialog(script)

# ── Modern Vista-style folder picker (IFileOpenDialog + FOS_PICKFOLDERS) ──
# Provides a better UX than the old FolderBrowserDialog:
#   • Navigation pane with This PC, Network, Libraries, Quick Access
#   • Breadcrumb path bar where users can type or paste paths
#   • Full support for network mapped drives (Z:\) and UNC paths (\\server\share)
#   • Search box and modern folder tree
FOLDER_PICKER_CS = r'''using System;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;

public class ModernFolderPicker
{
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern int SHCreateItemFromParsingName(string pszPath, IntPtr pbc, ref Guid riid, out IntPtr ppv);

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern int SHGetKnownFolderPath([MarshalAs(UnmanagedType.LPStruct)] Guid rfid, uint dwFlags, IntPtr hToken, out IntPtr ppszPath);

    [DllImport("kernel32.dll")]
    private static extern void CoTaskMemFree(IntPtr pv);

    [ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IShellItem
    {
        void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
        void GetParent(out IShellItem ppsi);
        void GetDisplayName([MarshalAs(UnmanagedType.U4)] uint sigdnName, [MarshalAs(UnmanagedType.LPWStr)] out string pszName);
        void GetAttributes(out uint psfgaoAttribs);
        void Compare(IShellItem psi, uint hint, out int piOrder);
    }

    [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IFileDialog
    {
        [PreserveSig] uint Show(IntPtr hwndOwner);
        uint SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);
        uint SetFileTypeIndex(uint iFileType);
        uint GetFileTypeIndex(out uint piFileType);
        uint Advise(IntPtr pfde, out uint pdwCookie);
        uint Unadvise(uint dwCookie);
        uint SetOptions(uint fos);
        uint GetOptions(out uint pfos);
        uint SetDefaultFolder(IShellItem psi);
        uint SetFolder(IShellItem psi);
        uint GetFolder(out IShellItem ppsi);
        uint GetCurrentSelection(out IShellItem ppsi);
        uint SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
        uint GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);
        uint SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
        uint SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
        uint SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
        uint GetResult(out IShellItem ppsi);
        uint AddPlace(IShellItem psi, int fdap);
        uint SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string pszDefaultExtension);
        uint Close(int hr);
        uint SetClientGuid(ref Guid guid);
        uint ClearClientData();
        uint SetFilter(IntPtr pFilter);
    }

    [ComImport, Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")]
    public class FileOpenDialog {}

    // SIGDN values used below
    private const uint SIGDN_FILESYSPATH = 0x80058000;
    private const uint SIGDN_DESKTOPABSOLUTEPARSING = 0x80028000;

    private static string ResolveKnownFolderFromParsing(string parsing)
    {
        if (string.IsNullOrEmpty(parsing)) return null;
        Match m = Regex.Match(parsing,
            @"\{([0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12})\}");
        if (!m.Success) return null;
        try
        {
            Guid kf = new Guid(m.Groups[1].Value);
            IntPtr pPath;
            if (SHGetKnownFolderPath(kf, 0, IntPtr.Zero, out pPath) == 0 && pPath != IntPtr.Zero)
            {
                string real = Marshal.PtrToStringUni(pPath);
                CoTaskMemFree(pPath);
                return real;
            }
        }
        catch { }
        return null;
    }

    public static string Show(string title, string initialDir)
    {
        try
        {
            FileOpenDialog dialog = new FileOpenDialog();
            IFileDialog fd = (IFileDialog)dialog;
            // FOS_PICKFOLDERS=0x20 | FOS_FORCEFILESYSTEM=0x40 | FOS_NOCHANGEDIR=0x8
            fd.SetOptions(0x20 | 0x40 | 0x8);
            if (!string.IsNullOrEmpty(title)) fd.SetTitle(title);
            if (!string.IsNullOrEmpty(initialDir) && System.IO.Directory.Exists(initialDir))
            {
                Guid iid = typeof(IShellItem).GUID;
                IntPtr pItem;
                if (SHCreateItemFromParsingName(initialDir, IntPtr.Zero, ref iid, out pItem) == 0 && pItem != IntPtr.Zero)
                {
                    IShellItem item = (IShellItem)Marshal.GetObjectForIUnknown(pItem);
                    fd.SetFolder(item);
                }
            }
            if (fd.Show(IntPtr.Zero) == 0)
            {
                IShellItem result;
                fd.GetResult(out result);
                // 1) Real filesystem path. Covers normal folders AND the six user
                //    known folders (Desktop/Downloads/Documents/Pictures/Videos/Music).
                //    Using SIGDN_FILESYSPATH avoids the bug where
                //    SIGDN_DESKTOPABSOLUTEEDITING returns the *localized display name*
                //    (e.g. "视频") instead of the real path for known folders.
                try
                {
                    string fsPath;
                    result.GetDisplayName(SIGDN_FILESYSPATH, out fsPath);
                    if (!string.IsNullOrEmpty(fsPath) &&
                        (System.IO.Directory.Exists(fsPath) || System.IO.File.Exists(fsPath)))
                        return fsPath;
                }
                catch { }
                // 2) Parsing name (e.g. "::{GUID}") -> resolve known folder to its real
                //    path. Fallback for virtual shell items that have no filesystem path.
                try
                {
                    string parsing;
                    result.GetDisplayName(SIGDN_DESKTOPABSOLUTEPARSING, out parsing);
                    if (!string.IsNullOrEmpty(parsing))
                    {
                        string known = ResolveKnownFolderFromParsing(parsing);
                        if (!string.IsNullOrEmpty(known)) return known;
                        // Return the parsing name (::GUID / shell:...) so the Python
                        // layer's resolve_real_path can resolve it as a last resort.
                        return parsing;
                    }
                }
                catch { }
            }
            return "";
        }
        catch
        {
            return "";
        }
    }
}
'''

def _ensure_folder_picker_cs():
    """Write the ModernFolderPicker C# file and return its path.
    Tries BASE_DIR first, falls back to TEMP if not writable (e.g. Program Files).
    """
    temp_dir = os.environ.get('TEMP', os.environ.get('TMP', '.'))
    for d in [BASE_DIR, temp_dir]:
        cs_path = os.path.join(d, 'folder_picker.cs')
        try:
            with open(cs_path, 'w', encoding='utf-8') as f:
                f.write(FOLDER_PICKER_CS)
            return cs_path
        except Exception:
            continue
    return os.path.join(BASE_DIR, 'folder_picker.cs')


# ── Known-folder / shell-path resolution ──────────────────────
# Folder pickers (especially the FolderBrowserDialog fallback) may return shell
# namespace paths such as "::{GUID}" for Windows known folders (Desktop, Downloads,
# Documents, Pictures, Videos). ffmpeg / os.path cannot use these, so we resolve
# them to real filesystem paths via SHGetKnownFolderPath.

_SHELL_NAME_TO_GUID = {
    'desktop':   '{B4BFCC3A-DB2C-424C-B029-7FE99A87C641}',
    'downloads': '{374DE290-123F-4565-9164-39C4925E467B}',
    'documents': '{FDD39AD0-238F-46AF-ADB4-6C85480369C7}',
    'pictures':  '{33E28130-4E1E-4676-835A-98395C3BC3BB}',
    'videos':    '{18989B1D-99B5-455B-841C-AB7C74E4DDFC}',
    'music':     '{4BD8D571-6D19-48D3-BE97-422220080E43}',
}

# Some shell pickers return the *localized display name* of a known folder
# (e.g. "视频" on zh-CN, "Videos" on en-US) instead of a path or a GUID.
# Map the common names so resolve_real_path can still recover the real path.
_DISPLAY_NAME_TO_GUID = {
    'desktop':   '{B4BFCC3A-DB2C-424C-B029-7FE99A87C641}',
    'downloads': '{374DE290-123F-4565-9164-39C4925E467B}',
    'documents': '{FDD39AD0-238F-46AF-ADB4-6C85480369C7}',
    'pictures':  '{33E28130-4E1E-4676-835A-98395C3BC3BB}',
    'videos':    '{18989B1D-99B5-455B-841C-AB7C74E4DDFC}',
    'music':     '{4BD8D571-6D19-48D3-BE97-422220080E43}',
    # Chinese (zh-CN) localized names
    '桌面': '{B4BFCC3A-DB2C-424C-B029-7FE99A87C641}',
    '下载': '{374DE290-123F-4565-9164-39C4925E467B}',
    '文档': '{FDD39AD0-238F-46AF-ADB4-6C85480369C7}',
    '图片': '{33E28130-4E1E-4676-835A-98395C3BC3BB}',
    '视频': '{18989B1D-99B5-455B-841C-AB7C74E4DDFC}',
    '音乐': '{4BD8D571-6D19-48D3-BE97-422220080E43}',
}


class _KnownFolderGUID(ctypes.Structure):
    _fields_ = [
        ("Data1", ctypes.c_ulong),
        ("Data2", ctypes.c_ushort),
        ("Data3", ctypes.c_ushort),
        ("Data4", ctypes.c_ubyte * 8),
    ]


def _parse_guid(guid_str):
    """Parse '{XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX}' into a _KnownFolderGUID."""
    try:
        g = guid_str.strip().strip('{}')
        parts = g.split('-')
        if len(parts) != 5:
            return None
        d4 = parts[3] + parts[4]
        if len(d4) != 16:
            return None
        data4 = (ctypes.c_ubyte * 8)(*[int(d4[i:i+2], 16) for i in range(0, 16, 2)])
        return _KnownFolderGUID(int(parts[0], 16), int(parts[1], 16),
                                int(parts[2], 16), data4)
    except (ValueError, IndexError):
        return None


def _resolve_known_folder_guid(guid_str):
    """Resolve a known-folder GUID to its real filesystem path via SHGetKnownFolderPath."""
    guid = _parse_guid(guid_str)
    if guid is None:
        return None
    try:
        shell32 = ctypes.windll.shell32
        ole32 = ctypes.windll.ole32
        # COINIT_APARTMENTTHREADED = 0x2
        ole32.CoInitializeEx(None, 0x2)
        pp = ctypes.c_wchar_p()
        SHGetKnownFolderPath = shell32.SHGetKnownFolderPath
        SHGetKnownFolderPath.argtypes = [
            ctypes.POINTER(_KnownFolderGUID), ctypes.c_uint32, ctypes.c_void_p,
            ctypes.POINTER(ctypes.c_wchar_p),
        ]
        SHGetKnownFolderPath.restype = ctypes.c_int32
        rc = SHGetKnownFolderPath(ctypes.byref(guid), 0, None, ctypes.byref(pp))
        if rc == 0 and pp:
            result = pp.value
            # FIX BUG-S02: Free the COM-allocated string to prevent memory leak
            ctypes.windll.ole32.CoTaskMemFree(pp)
            return result
    except Exception:
        return None
    finally:
        try:
            ctypes.windll.ole32.CoUninitialize()
        except Exception:
            pass
    return None


def resolve_real_path(path):
    """Resolve a folder/file path from a native dialog to a real filesystem path.

    Handles shell-namespace paths ("::{GUID}", possibly with a trailing sub-path)
    and "shell:Name" shortcuts returned for known folders. If the path is already a
    valid filesystem path or cannot be resolved, it is returned unchanged (safe).
    """
    if not path or not isinstance(path, str):
        return path
    p = path.strip()
    if not p:
        return p
    # Already a normal absolute filesystem path -> return as-is.
    # NOTE: Don't require os.path.exists() — network mapped drives (S:\) or
    # UNC paths may not be stat-able by Python in all cases (UAC elevation,
    # session differences, intermittent network), but the path is still
    # valid for ffmpeg and other tools that run in the user's session.
    try:
        if os.path.isabs(p) and not p.startswith('::') and not p.lower().startswith('shell:'):
            return p
    except Exception:
        pass
    # shell:Downloads etc.
    if p.lower().startswith('shell:'):
        name = re.split(r'[/\\]', p[6:])[0].lower()
        guid = _SHELL_NAME_TO_GUID.get(name)
        if guid:
            resolved = _resolve_known_folder_guid(guid)
            if resolved:
                return resolved
        return p
    # ::{GUID} (possibly with extra sub-path after the shell item)
    if '::' in p:
        m = re.search(
            r'\{([0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12})\}',
            p,
        )
        if m:
            resolved = _resolve_known_folder_guid(m.group(1))
            if resolved:
                suffix = p[m.end():]
                if suffix:
                    resolved = os.path.join(resolved, suffix.lstrip('/\\'))
                return resolved
        return p
    # Bare display name of a known folder (e.g. "视频", "Videos") returned by some
    # shell pickers. Map common localized/English names to known-folder GUIDs.
    if (not os.path.isabs(p) and '\\' not in p and '/' not in p
            and not p.startswith('::') and not p.lower().startswith('shell:')):
        guid = _DISPLAY_NAME_TO_GUID.get(p.lower())
        if guid:
            resolved = _resolve_known_folder_guid(guid)
            if resolved:
                return resolved
    return p


def _native_open_dir(title, initial_dir):
    """Show native Windows folder browser dialog.

    Uses the modern Vista-style IFileOpenDialog with FOS_PICKFOLDERS for better UX:
    - Modern navigation pane with This PC, Network, libraries, Quick Access
    - Breadcrumb path bar where users can type or paste paths directly
    - Full support for network mapped drives (Z:\\) and UNC paths (\\\\server\\share)
    Falls back to FolderBrowserDialog if COM interop compilation fails.
    """
    cs_path = _ensure_folder_picker_cs()
    title_esc = _ps_escape(title)
    init_esc = _ps_escape(initial_dir)
    cs_path_esc = _ps_escape(cs_path)

    # Build PowerShell script via list-join to avoid f-string curly-brace conflicts
    parts = [
        '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
        '$OutputEncoding = [System.Text.Encoding]::UTF8',
        '',
        '# Try modern IFileOpenDialog (Vista-style folder picker)',
        'try {',
        "  Add-Type -Path '" + cs_path_esc + "' -ErrorAction Stop",
        "  $result = [ModernFolderPicker]::Show('" + title_esc + "', '" + init_esc + "')",
        '  if ($result) { Write-Output $result }',
        '} catch {',
        '  # Fallback: classic FolderBrowserDialog',
        '  Add-Type -AssemblyName System.Windows.Forms',
        '  [System.Windows.Forms.Application]::EnableVisualStyles()',
        '  $dlg = New-Object System.Windows.Forms.FolderBrowserDialog',
        "  $dlg.Description = '" + title_esc + "'",
        '  $dlg.ShowNewFolderButton = $true',
        "  if ('" + init_esc + "' -ne '') {",
        "    if (Test-Path '" + init_esc + "') { $dlg.SelectedPath = '" + init_esc + "' }",
        '  }',
        '  $owner = New-Object System.Windows.Forms.Form',
        '  $owner.TopMost = $true',
        "  $owner.WindowState = 'Minimized'",
        '  $owner.ShowInTaskbar = $false',
        '  $owner.Opacity = 0',
        '  $owner.Show()',
        '  $r = $dlg.ShowDialog($owner)',
        '  $owner.Close()',
        "  if ($r -eq 'OK') { Write-Output $dlg.SelectedPath }",
        '}',
    ]
    script = '\n'.join(parts)
    return _run_ps_dialog(script, timeout=120)

def _native_save_file(title, initial_dir, default_name, file_filter):
    """Show native Windows file save dialog."""
    if file_filter == 'txt':
        ps_filter = '文本文件|*.txt|所有文件|*.*'
        if default_name and not default_name.lower().endswith('.txt'):
            default_name += '.txt'
    elif file_filter == 'json':
        ps_filter = 'JSON 文件|*.json|所有文件|*.*'
        if default_name and not default_name.lower().endswith('.json'):
            default_name += '.json'
    elif file_filter == 'video':
        ps_filter = 'MP4 视频|*.mp4|MOV 视频|*.mov|MKV 视频|*.mkv|所有文件|*.*'
        # Ensure default_name has a video extension
        if default_name:
            ext = os.path.splitext(default_name)[1].lower()
            if ext not in ('.mp4', '.mov', '.mkv', '.avi', '.webm', '.m4v'):
                default_name += '.mp4'
    else:
        ps_filter = '所有文件|*.*'
    script = (
        f"Add-Type -AssemblyName System.Windows.Forms\n"
        f"[System.Windows.Forms.Application]::EnableVisualStyles()\n"
        f"$dlg = New-Object System.Windows.Forms.SaveFileDialog\n"
        f"$dlg.Title = '{_ps_escape(title)}'\n"
        f"$dlg.InitialDirectory = '{_ps_escape(initial_dir)}'\n"
        f"$dlg.FileName = '{_ps_escape(default_name)}'\n"
        f"$dlg.Filter = '{_ps_escape(ps_filter)}'\n"
        f"$dlg.OverwritePrompt = $true\n"
        f"$owner = New-Object System.Windows.Forms.Form\n"
        f"$owner.TopMost = $true\n"
        f"$owner.WindowState = 'Minimized'\n"
        f"$owner.ShowInTaskbar = $false\n"
        f"$owner.Opacity = 0\n"
        f"$owner.Show()\n"
        f"$result = $dlg.ShowDialog($owner)\n"
        f"$owner.Close()\n"
        f"if ($result -eq 'OK') {{ Write-Output $dlg.FileName }}"
    )
    return _run_ps_dialog(script)

@app.route('/api/native_dialog', methods=['POST'])
def native_dialog_api():
    """Show a native Windows file dialog via PowerShell.
    
    Body: {
        type: 'open_file' | 'open_files' | 'open_dir' | 'save_file',
        title: str,
        file_filter: 'video' | 'exe' | 'txt' | 'json' | '',
        default_name: str (for save_file),
        initial_dir: str (optional, overrides last saved path),
        path_type: 'open' | 'save' | 'merge' (for remembering last path)
    }
    Returns: {path: str} for single-select, {paths: [str]} for open_files
    """
    data = request.json or {}
    dialog_type = data.get('type', 'open_file')
    title = data.get('title', '')
    file_filter = data.get('file_filter', '')
    default_name = data.get('default_name', '')
    path_type = data.get('path_type', 'open')

    # Get last path for this dialog type
    last_paths = _load_last_paths()
    # Use initial_dir from request if provided (e.g. user typed a path), else last saved
    initial_dir = data.get('initial_dir', '') or last_paths.get(path_type, '')

    # Validate initial_dir — accept file paths too (extract parent dir)
    if initial_dir:
        if os.path.isfile(initial_dir):
            initial_dir = os.path.dirname(initial_dir)
        # NOTE: Don't clear initial_dir if os.path.isdir() returns False.
        # Network mapped drives (S:\) or UNC paths (\\server\share) may not
        # be stat-able by Python due to session/elevation differences, but the
        # file dialog (running in the same user session) can still navigate
        # to them. The dialog will silently fall back to its default location
        # if the path truly doesn't exist.

    if dialog_type == 'open_file':
        result = _native_open_file(title, initial_dir, file_filter)
    elif dialog_type == 'open_files':
        # Multi-select file dialog — returns list of paths
        result_str = _native_open_files_multi(title, initial_dir, file_filter)
        paths = [resolve_real_path(p.strip()) for p in result_str.split('\n') if p.strip()] if result_str else []
        if paths:
            dir_path = os.path.dirname(paths[0])
            if dir_path:
                last_paths[path_type] = dir_path
                _save_last_paths(last_paths)
        return jsonify({'paths': paths})
    elif dialog_type == 'open_dir':
        result = _native_open_dir(title, initial_dir)
    elif dialog_type == 'save_file':
        result = _native_save_file(title, initial_dir, default_name, file_filter)
    else:
        return jsonify({'error': f'Unknown dialog type: {dialog_type}'}), 400

    # Save last path
    if result:
        dir_path = result if dialog_type == 'open_dir' else os.path.dirname(result)
        if dir_path:
            last_paths[path_type] = dir_path
            _save_last_paths(last_paths)

    return jsonify({'path': resolve_real_path(result)})


@app.route('/api/scan', methods=['POST'])
def scan():
    """Recursively scan a directory for video files."""
    data = request.json or {}
    directory = (data.get('directory') or '').strip()
    directory = resolve_real_path(directory)
    recursive = data.get('recursive', True)

    if not directory:
        return jsonify({'files': [], 'count': 0, 'message': '未提供扫描目录'})
    if not os.path.isdir(directory):
        return jsonify({'files': [], 'count': 0,
                        'message': f'目录不存在或无法访问: {directory}'})

    results = []
    try:
        if recursive:
            walker = os.walk(directory)
        else:
            walker = [(directory, [], [f for f in os.listdir(directory)
                                       if os.path.isfile(os.path.join(directory, f))])]
        for root, dirs, files in walker:
            for f in files:
                if Path(f).suffix.lower() in VIDEO_EXTS:
                    fp = os.path.join(root, f)
                    try:
                        size = os.path.getsize(fp)
                    except Exception:
                        size = 0
                    # Extract date preview
                    date_str, _ = extract_date_from_filename(f)
                    results.append({
                        'path': fp,
                        'name': f,
                        'dir': root,
                        'size': size,
                        'size_mb': round(size / 1024 / 1024, 1),
                        'date_in_name': date_str,
                    })
    except Exception as e:
        return jsonify({'files': [], 'count': 0, 'message': f'扫描出错: {e}'})

    results.sort(key=lambda x: x['name'].lower())
    if results:
        msg = f'在 {directory} 中找到 {len(results)} 个视频文件'
    else:
        msg = (f'目录 {directory} 下未找到支持的视频文件'
               f'（支持格式: {", ".join(sorted(VIDEO_EXTS))}）')
    return jsonify({'files': results, 'count': len(results), 'message': msg})


@app.route('/api/preview_formula', methods=['POST'])
def preview_formula():
    """Preview formula expansion for a list of source files."""
    data = request.json
    formula = data.get('formula', DEFAULT_BATCH_FORMULA)
    params = data.get('params', DEFAULT_PARAMS)
    files = data.get('files', [])
    project_dir = data.get('project_dir', '')

    results = []
    for f in files:
        try:
            out = expand_formula(formula, f, params, project_dir)
            results.append({'input': f, 'output': out, 'error': None})
        except Exception as e:
            results.append({'input': f, 'output': '', 'error': str(e)})

    return jsonify({'results': results})


@app.route('/api/presets')
def get_presets():
    return jsonify({'presets': list_presets()})


@app.route('/api/presets', methods=['POST'])
def create_preset():
    data = request.json
    name = data.get('name', '').strip()
    if not name:
        return jsonify({'error': 'Preset name required'}), 400
    params = data.get('params', DEFAULT_PARAMS)
    batch_formula = data.get('batch_formula', DEFAULT_BATCH_FORMULA)
    project_dir = data.get('project_dir', '')
    saved = save_preset(name, params, batch_formula, project_dir)
    return jsonify(saved)


@app.route('/api/presets/<name>', methods=['DELETE'])
def remove_preset(name):
    if delete_preset(name):
        return jsonify({'ok': True})
    return jsonify({'error': 'Not found'}), 404


@app.route('/api/codecs')
def get_codecs():
    """Return available codec profiles."""
    result = {}
    for key, cp in CODEC_PROFILES.items():
        result[key] = {
            'label': cp['label'],
            'group': cp['group'],
            'encoder': cp['encoder'],
            'has_profile': cp.get('has_profile', False),
            'profiles': cp.get('profiles', []),
            'presets': cp.get('presets', []),
            'default_preset': cp.get('default_preset', ''),
            'default_crf': cp.get('default_crf', 23),
            'has_bf_refs': cp.get('has_bf_refs', False),
            'has_sc_threshold': cp.get('has_sc_threshold', False),
            'has_x264_params': cp.get('has_x264_params', False),
            'x265_params': cp.get('x265_params', False),
            'tag': cp.get('tag'),
        }
    return jsonify({'codecs': result})


@app.route('/api/version')
def version_info():
    """Return app version information."""
    return jsonify({
        'version': APP_VERSION,
        'author': '霜夜瞳',
        'github_url': 'https://github.com/warlocks365/360video-converter',
        'python': sys.version.split()[0],
        'platform': platform_module.platform(),
    })


@app.route('/api/open_external')
def open_external():
    """Open a URL in the system default browser (for pywebview embedded mode)."""
    import webbrowser
    url = request.args.get('url', '')
    # Only allow http/https URLs for safety
    if url and url.startswith(('http://', 'https://')):
        webbrowser.open(url)
        return jsonify({'ok': True})
    return jsonify({'ok': False, 'error': 'Invalid URL'}), 400


@app.route('/api/codec_check')
def codec_check():
    """Check which hardware encoders are available via test encode.
    
    Tests each hardware encoder by doing a minimal 0.1s encode.
    If the bundled ffmpeg doesn't support an encoder, falls back to
    system ffmpeg (if found in PATH).
    Returns availability + error details for diagnostics.
    """
    global _encoder_ffmpeg_map
    available = {}
    error_details = {}  # codec_name -> error message
    _encoder_ffmpeg_map = {}

    # Software encoders always use bundled ffmpeg
    for name in ('libx264', 'libx265'):
        available[name] = True
        error_details[name] = ''
        _encoder_ffmpeg_map[name] = FFMPEG_PATH

    # Hardware encoder groups — test one (h264 variant) per group for speed
    hw_groups = [
        ('cuda', [('h264_nvenc', 'h264_nvenc'), ('hevc_nvenc', 'hevc_nvenc')]),
        ('qsv',   [('h264_qsv', 'h264_qsv'),     ('hevc_qsv', 'hevc_qsv')]),
        ('amf',   [('h264_amf', 'h264_amf'),     ('hevc_amf', 'hevc_amf')]),
    ]

    system_ffmpeg = _find_system_ffmpeg()
    custom_ffmpeg = _get_custom_ffmpeg()

    # Build list of ffmpeg candidates to try (in priority order)
    ffmpeg_candidates = [FFMPEG_PATH]  # Bundled first
    if custom_ffmpeg:
        ffmpeg_candidates.append(custom_ffmpeg)
    if system_ffmpeg and system_ffmpeg not in ffmpeg_candidates:
        ffmpeg_candidates.append(system_ffmpeg)

    # Collect all error messages for each candidate
    all_errors = {}  # candidate -> {encoder: error}

    for group, encoders in hw_groups:
        test_name, test_enc = encoders[0]  # Test h264 variant

        ffmpeg_to_use = None
        first_error = ''  # Error from bundled ffmpeg (most relevant for user)
        for candidate in ffmpeg_candidates:
            ok, err = _test_encoder(candidate, test_enc)
            if ok:
                ffmpeg_to_use = candidate
                break
            else:
                if not first_error:
                    first_error = err  # Keep the first (bundled) error
                # Track which candidate produced which error
                cand_label = 'bundled' if candidate == FFMPEG_PATH else (
                    'custom' if custom_ffmpeg and candidate == custom_ffmpeg else 'system')
                all_errors.setdefault(cand_label, {})[test_enc] = err

        for name, enc in encoders:
            if ffmpeg_to_use:
                available[name] = True
                error_details[name] = ''
                _encoder_ffmpeg_map[name] = ffmpeg_to_use
            else:
                available[name] = False
                error_details[name] = first_error

    # Also get ffmpeg version info for diagnostics
    ffmpeg_info = {'bundled': FFMPEG_PATH, 'system': system_ffmpeg, 'custom': custom_ffmpeg}
    for label, fpath in [('bundled', FFMPEG_PATH), ('system', system_ffmpeg), ('custom', custom_ffmpeg)]:
        if not fpath:
            continue
        try:
            r = subprocess.run(
                [fpath, '-hide_banner', '-version'],
                capture_output=True, text=True, timeout=10,
                env=_ffmpeg_env(fpath), creationflags=NO_WINDOW
            )
            ffmpeg_info[f'{label}_version'] = r.stdout.split('\n')[0] if r.stdout else 'unknown'
        except Exception:
            ffmpeg_info[f'{label}_version'] = 'error'

    # Build fix hints based on runtime DLL status and error messages
    runtime_dlls = _check_hw_runtime_dlls()
    fix_hints = {}
    
    # NVIDIA NVENC hints
    nvenc_dlls_ok = all(runtime_dlls.get('cuda', {}).values())
    for name in ('h264_nvenc', 'hevc_nvenc'):
        if not available[name]:
            err = error_details[name].lower()
            if 'api version' in err or 'driver does not' in err:
                fix_hints[name] = (
                    'NVIDIA 驱动版本过低，内置 ffmpeg 需要较新的 NVENC API。\n'
                    '解决方案:\n'
                    '  1. 更新 NVIDIA 驱动到最新版本 (建议 610.00+)\n'
                    '     下载: https://www.nvidia.com/Download/index.aspx\n'
                    '  2. 或在设置中指定旧版 ffmpeg 路径'
                )
            elif 'frame dimension' in err or 'initializeencoder' in err:
                fix_hints[name] = '测试视频分辨率问题，已在新版本中修复，请更新应用'
            elif not nvenc_dlls_ok:
                fix_hints[name] = (
                    '未检测到 NVIDIA 编码驱动 DLL。\n'
                    '请安装或更新 NVIDIA 显卡驱动:\n'
                    '  https://www.nvidia.com/Download/index.aspx'
                )
    
    # Intel QSV hints
    qsv_dlls_missing = not any(runtime_dlls.get('qsv', {}).values())
    for name in ('h264_qsv', 'hevc_qsv'):
        if not available[name]:
            if qsv_dlls_missing:
                fix_hints[name] = (
                    'Intel oneVPL / Media SDK 运行时未安装 (libmfxhw64.dll 缺失)。\n'
                    '解决方案:\n'
                    '  1. 下载并安装完整版 Intel 显卡驱动 (包含 Media SDK 运行时):\n'
                    '     https://www.intel.com/content/www/us/en/download/726609/intel-arc-iris-xe-graphics-windows.html\n'
                    '  2. 安装时选择"完整安装"而非"自定义安装(最小化)"\n'
                    '  3. 安装完成后重启本程序\n'
                    '注意: 即便使用 NVIDIA 独立显卡，Intel 核显驱动仍需安装以启用 QSV 编码'
                )
            else:
                fix_hints[name] = 'Intel 显卡驱动可能版本过旧，请更新到最新版'
    
    # AMD AMF hints
    for name in ('h264_amf', 'hevc_amf'):
        if not available[name]:
            fix_hints[name] = '系统未检测到 AMD 显卡，AMF 编码器不可用 (正常现象)'

    return jsonify({
        'available': available,
        'error_details': error_details,
        'ffmpeg_info': ffmpeg_info,
        'test_errors': all_errors,
        'runtime_dlls': runtime_dlls,
        'fix_hints': fix_hints,
    })


@app.route('/api/test_ffmpeg', methods=['POST'])
def test_ffmpeg():
    """Test a specific ffmpeg path for hardware encoder support."""
    data = request.json or {}
    path = data.get('path', '')
    if not path or not os.path.isfile(path):
        return jsonify({'error': 'File not found'}), 404

    result = {'path': path, 'encoders': {}}

    # Get version
    try:
        r = subprocess.run(
            [path, '-hide_banner', '-version'],
            capture_output=True, text=True, timeout=10,
            env=_ffmpeg_env(path), creationflags=NO_WINDOW
        )
        result['version'] = r.stdout.split('\n')[0] if r.stdout else 'unknown'
        result['returncode'] = r.returncode
    except Exception as e:
        result['error'] = str(e)
        return jsonify(result)

    if r.returncode != 0:
        result['error'] = 'ffmpeg failed to start (missing DLLs?)'
        return jsonify(result)

    # Test each hardware encoder
    hw_encoders = [
        ('h264_nvenc', 'h264_nvenc'), ('hevc_nvenc', 'hevc_nvenc'),
        ('h264_qsv', 'h264_qsv'), ('hevc_qsv', 'hevc_qsv'),
        ('h264_amf', 'h264_amf'), ('hevc_amf', 'hevc_amf'),
    ]
    for name, enc in hw_encoders:
        ok, err = _test_encoder(path, enc)
        result['encoders'][name] = {'available': ok, 'error': err}

    return jsonify(result)


@app.route('/api/test_encoder_detail', methods=['POST'])
def test_encoder_detail():
    """Run a detailed encoder test and return full ffmpeg output.
    Used for diagnostics when an encoder fails."""
    data = request.json or {}
    encoder = data.get('encoder', '')
    ffmpeg_path = data.get('ffmpeg_path', FFMPEG_PATH)

    if not encoder:
        return jsonify({'error': 'Missing encoder name'}), 400
    if not os.path.isfile(ffmpeg_path):
        return jsonify({'error': f'ffmpeg not found: {ffmpeg_path}'}), 404

    try:
        r = subprocess.run(
            [ffmpeg_path, '-hide_banner', '-f', 'lavfi', '-i',
             'color=black:s=640x480:d=0.1', '-c:v', encoder,
             '-f', 'null', 'NUL' if os.name == 'nt' else '-'],
            capture_output=True, text=True, timeout=30,
            env=_ffmpeg_env(ffmpeg_path),
            creationflags=NO_WINDOW
        )
        return jsonify({
            'encoder': encoder,
            'ffmpeg_path': ffmpeg_path,
            'returncode': r.returncode,
            'success': r.returncode == 0,
            'stdout': r.stdout or '',
            'stderr': r.stderr or '',
        })
    except subprocess.TimeoutExpired:
        return jsonify({
            'encoder': encoder,
            'ffmpeg_path': ffmpeg_path,
            'success': False,
            'error': '测试超时 (30s) - 可能驱动响应缓慢或卡死',
        })
    except Exception as e:
        return jsonify({
            'encoder': encoder,
            'ffmpeg_path': ffmpeg_path,
            'success': False,
            'error': str(e),
        })


@app.route('/api/save_report', methods=['POST'])
def save_report():
    """Save a diagnostic report to a user-specified path."""
    data = request.json or {}
    save_path = data.get('path', '')
    content = data.get('content', '')
    if not save_path:
        return jsonify({'success': False, 'error': '未指定保存路径'}), 400
    if not content:
        return jsonify({'success': False, 'error': '报告内容为空'}), 400
    try:
        # Ensure .txt extension
        if not save_path.lower().endswith('.txt'):
            save_path += '.txt'
        # Create parent directory if it doesn't exist
        parent = os.path.dirname(save_path)
        if parent and not os.path.isdir(parent):
            os.makedirs(parent, exist_ok=True)
        with open(save_path, 'w', encoding='utf-8') as f:
            f.write(content)
        return jsonify({'success': True, 'path': save_path})
    except PermissionError:
        return jsonify({'success': False, 'error': '权限不足，无法写入该路径'}), 403
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/diagnostic_report')
def diagnostic_report():
    """Generate a comprehensive diagnostic report for troubleshooting.
    Returns a plain-text report with system info, ffmpeg info, encoder test
    results, runtime DLL status, and full ffmpeg output for each encoder."""
    import platform

    report_lines = []
    report_lines.append('=' * 70)
    report_lines.append('360 Video Converter - 诊断报告 (Diagnostic Report)')
    report_lines.append(f'生成时间: {datetime.now().strftime("%Y-%m-%d %H:%M:%S")}')
    report_lines.append('=' * 70)
    report_lines.append('')

    # ── System Information ──
    report_lines.append('[系统信息]')
    report_lines.append(f'  OS: {platform_module.platform()}')
    report_lines.append(f'  Machine: {platform.machine()}')
    report_lines.append(f'  Processor: {platform.processor()}')
    report_lines.append(f'  Python: {platform.python_version()}')

    # GPU info via Windows registry
    try:
        import winreg
        gpu_names = []
        for key_path in [
            r'SYSTEM\CurrentControlSet\Enum\PCI',
        ]:
            try:
                main_key = winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, key_path)
                i = 0
                while i < 200:
                    try:
                        subkey_name = winreg.EnumKey(main_key, i)
                        i += 1
                        # Only look for GPU vendors
                        if not any(v in subkey_name.upper() for v in ['VEN_10DE', 'VEN_8086', 'VEN_1002']):
                            continue
                        try:
                            sub_key = winreg.OpenKey(main_key, subkey_name)
                            j = 0
                            while j < 20:
                                try:
                                    device_name = winreg.EnumKey(sub_key, j)
                                    j += 1
                                    try:
                                        dev_key = winreg.OpenKey(sub_key, device_name)
                                        try:
                                            desc, _ = winreg.QueryValueEx(dev_key, 'DeviceDesc')
                                            desc_str = desc if isinstance(desc, str) else str(desc)
                                            # DeviceDesc format: "registrypath;Friendly Name"
                                            if ';' in desc_str:
                                                desc_str = desc_str.split(';')[-1]
                                            if desc_str not in gpu_names:
                                                gpu_names.append(desc_str)
                                        except FileNotFoundError:
                                            pass
                                        except Exception:
                                            pass
                                        winreg.CloseKey(dev_key)
                                    except FileNotFoundError:
                                        pass
                                except OSError:
                                    break
                            winreg.CloseKey(sub_key)
                        except FileNotFoundError:
                            pass
                    except OSError:
                        break
                winreg.CloseKey(main_key)
            except FileNotFoundError:
                pass
        if gpu_names:
            report_lines.append(f'  GPU: {", ".join(gpu_names)}')
        else:
            report_lines.append('  GPU: (无法检测)')
    except Exception as e:
        report_lines.append(f'  GPU: 检测失败 ({e})')

    # Windows version detail
    try:
        sysroot = os.environ.get('SystemRoot', r'C:\Windows')
        report_lines.append(f'  SystemRoot: {sysroot}')
    except Exception:
        pass
    report_lines.append('')

    # ── FFmpeg Information ──
    report_lines.append('[FFmpeg 信息]')
    system_ffmpeg = _find_system_ffmpeg()
    custom_ffmpeg = _get_custom_ffmpeg()

    for label, fpath in [('内置 (Bundled)', FFMPEG_PATH), ('系统 (System)', system_ffmpeg), ('自定义 (Custom)', custom_ffmpeg)]:
        if not fpath:
            report_lines.append(f'  {label}: 未找到')
            continue
        report_lines.append(f'  {label}: {fpath}')
        report_lines.append(f'    存在: {"是" if os.path.isfile(fpath) else "否"}')
        if os.path.isfile(fpath):
            try:
                r = subprocess.run(
                    [fpath, '-hide_banner', '-version'],
                    capture_output=True, text=True, timeout=10,
                    env=_ffmpeg_env(fpath), creationflags=NO_WINDOW
                )
                version_line = (r.stdout or '').split('\n')[0] if r.stdout else 'N/A'
                report_lines.append(f'    版本: {version_line}')
                report_lines.append(f'    退出码: {r.returncode}')
                # Get encoder list
                r2 = subprocess.run(
                    [fpath, '-hide_banner', '-encoders'],
                    capture_output=True, text=True, timeout=10,
                    env=_ffmpeg_env(fpath), creationflags=NO_WINDOW
                )
                enc_text = r2.stdout or ''
                for enc_name in ['h264_nvenc', 'hevc_nvenc', 'h264_qsv', 'hevc_qsv', 'h264_amf', 'hevc_amf']:
                    has_enc = f' {enc_name} ' in enc_text or enc_text.endswith(f' {enc_name}') or f'\n{enc_name} ' in enc_text
                    report_lines.append(f'    编译支持 {enc_name}: {"是" if has_enc else "否"}')
            except Exception as e:
                report_lines.append(f'    版本获取失败: {e}')
    report_lines.append('')

    # ── Runtime DLL Check ──
    report_lines.append('[运行时 DLL 检测]')
    runtime_dlls = _check_hw_runtime_dlls()
    dll_labels = {'cuda': 'NVIDIA CUDA', 'qsv': 'Intel QSV', 'amf': 'AMD AMF'}
    for group, dlls in runtime_dlls.items():
        label = dll_labels.get(group, group)
        report_lines.append(f'  {label}:')
        for dll_name, dll_path in dlls.items():
            status = f'找到: {dll_path}' if dll_path else '未找到'
            report_lines.append(f'    {dll_name}: {status}')
    report_lines.append('')

    # ── Encoder Test Results ──
    report_lines.append('[编码器测试结果]')
    hw_groups = [
        ('cuda', [('h264_nvenc', 'h264_nvenc'), ('hevc_nvenc', 'hevc_nvenc')]),
        ('qsv',   [('h264_qsv', 'h264_qsv'),     ('hevc_qsv', 'hevc_qsv')]),
        ('amf',   [('h264_amf', 'h264_amf'),     ('hevc_amf', 'hevc_amf')]),
    ]

    ffmpeg_candidates = [FFMPEG_PATH]
    if custom_ffmpeg:
        ffmpeg_candidates.append(custom_ffmpeg)
    if system_ffmpeg and system_ffmpeg not in ffmpeg_candidates:
        ffmpeg_candidates.append(system_ffmpeg)

    for group, encoders in hw_groups:
        report_lines.append(f'  [{dll_labels.get(group, group)}]')
        for name, enc in encoders:
            for candidate in ffmpeg_candidates:
                cand_label = '内置' if candidate == FFMPEG_PATH else (
                    '自定义' if custom_ffmpeg and candidate == custom_ffmpeg else '系统')
                ok, err = _test_encoder(candidate, enc)
                status = '✓ 可用' if ok else f'✗ 失败: {err}'
                report_lines.append(f'    {enc} ({cand_label} ffmpeg): {status}')
                if not ok:
                    # Run detailed test to capture full stderr
                    try:
                        r = subprocess.run(
                            [candidate, '-hide_banner', '-f', 'lavfi', '-i',
                             'color=black:s=640x480:d=0.1', '-c:v', enc,
                             '-f', 'null', 'NUL' if os.name == 'nt' else '-'],
                            capture_output=True, text=True, timeout=30,
                            env=_ffmpeg_env(candidate), creationflags=NO_WINDOW
                        )
                        if r.stderr:
                            report_lines.append(f'      ffmpeg 退出码: {r.returncode}')
                            stderr_lines = r.stderr.strip().split('\n')
                            for sl in stderr_lines[-20:]:
                                report_lines.append(f'      | {sl}')
                    except Exception as e:
                        report_lines.append(f'      详细测试失败: {e}')
                    break  # No need to test other candidates if one fails with details

    # Software encoders
    report_lines.append(f'  [软件编码]')
    for name in ('libx264', 'libx265'):
        ok, err = _test_encoder(FFMPEG_PATH, name)
        status = '✓ 可用' if ok else f'✗ 失败: {err}'
        report_lines.append(f'    {name}: {status}')
    report_lines.append('')

    # ── Fix Hints ──
    report_lines.append('[修复建议]')
    # Re-run encoder tests to build fix hints (matching codec_check logic)
    fix_hints_report = {}
    nvenc_dlls_ok = all(runtime_dlls.get('cuda', {}).values())
    qsv_dlls_missing = not any(runtime_dlls.get('qsv', {}).values())
    
    # Test NVENC
    nvenc_ok, nvenc_err = _test_encoder(FFMPEG_PATH, 'h264_nvenc')
    if not nvenc_ok:
        err_low = nvenc_err.lower()
        if 'api version' in err_low or 'driver does not' in err_low:
            fix_hints_report['nvenc'] = (
                'NVIDIA 驱动版本过低。请更新到最新版 NVIDIA 驱动:\n'
                '  https://www.nvidia.com/Download/index.aspx\n'
                '内置 ffmpeg 需要较新的 NVENC API 版本。'
            )
        elif 'frame dimension' in err_low or 'initializeencoder' in err_low:
            fix_hints_report['nvenc'] = '测试分辨率问题，已在应用更新中修复。'
        elif not nvenc_dlls_ok:
            fix_hints_report['nvenc'] = 'NVIDIA 编码驱动 DLL 缺失，请安装 NVIDIA 显卡驱动。'
        else:
            fix_hints_report['nvenc'] = f'NVENC 测试失败: {nvenc_err}'
    else:
        fix_hints_report['nvenc'] = 'NVENC 编码器可用。'

    # Test QSV
    qsv_ok, qsv_err = _test_encoder(FFMPEG_PATH, 'h264_qsv')
    if not qsv_ok:
        if qsv_dlls_missing:
            fix_hints_report['qsv'] = (
                'Intel oneVPL / Media SDK 运行时未安装。\n'
                '请下载并安装完整版 Intel 显卡驱动 (包含 Media SDK 运行时):\n'
                '  https://www.intel.com/content/www/us/en/download/726609/intel-arc-iris-xe-graphics-windows.html\n'
                '安装时请选择完整安装。即便使用 NVIDIA 独立显卡，Intel 核显驱动仍需安装。'
            )
        else:
            fix_hints_report['qsv'] = f'QSV 测试失败: {qsv_err}'
    else:
        fix_hints_report['qsv'] = 'QSV 编码器可用。'

    # AMF
    fix_hints_report['amf'] = '系统无 AMD 显卡，AMF 不可用属正常现象。'

    report_lines.append(f'  NVIDIA NVENC: {fix_hints_report["nvenc"]}')
    report_lines.append(f'  Intel QSV: {fix_hints_report["qsv"]}')
    report_lines.append(f'  AMD AMF: {fix_hints_report["amf"]}')
    report_lines.append('')

    # ── Summary ──
    report_lines.append('[通用排查]')
    report_lines.append('  如果硬件编码测试失败, 可能原因:')
    report_lines.append('    1. 显卡驱动版本过旧 — 请更新到最新版 NVIDIA/Intel/AMD 驱动')
    report_lines.append('    2. ffmpeg 与驱动版本不兼容 — 尝试使用系统安装的 ffmpeg')
    report_lines.append('    3. 显卡被其他程序占用 — 关闭其他使用 GPU 的程序后重试')
    report_lines.append('    4. 系统缺少 Visual C++ 运行库 — 安装 VC++ Redistributable')
    report_lines.append('    5. 权限问题 — 以管理员身份运行程序')
    report_lines.append('')
    report_lines.append('=' * 70)
    report_lines.append('报告结束')

    report_text = '\n'.join(report_lines)
    return jsonify({
        'report': report_text,
        'timestamp': datetime.now().isoformat(),
    })


@app.route('/api/extract_date', methods=['POST'])
def extract_date():
    """Extract date from a filename for preview."""
    data = request.json
    filename = data.get('filename', '')
    date_str, dt = extract_date_from_filename(filename)
    return jsonify({
        'filename': filename,
        'date_str': date_str,
        'datetime': dt.isoformat() if dt else None,
    })


@app.route('/api/geocode')
def geocode_proxy():
    """Proxy AMap REST API for location search & reverse geocoding (avoids CORS).

    Special query '__regeo__' triggers reverse geocoding via /v3/geocode/regeo,
    using the 'location' query param (lon,lat). All other queries use the
    /v3/place/text fuzzy POI search endpoint.
    """
    keywords = request.args.get('q', '')
    api_key = request.args.get('key', '')
    city = request.args.get('city', '')
    location = request.args.get('location', '')

    if not api_key:
        return jsonify({'error': 'Missing AMap API key. Please enter your key in the settings.'}), 400

    if keywords == '__regeo__':
        # Reverse geocoding: lon,lat → address
        if not location:
            return jsonify({'error': 'Missing location for reverse geocoding'}), 400
        params = {
            'key': api_key,
            'location': location,
            'extensions': 'all',
            'output': 'json',
        }
        url = 'https://restapi.amap.com/v3/geocode/regeo?' + urllib.parse.urlencode(params)
    else:
        # Forward POI search
        if not keywords:
            return jsonify({'error': 'Missing query'}), 400
        params = {
            'key': api_key,
            'keywords': keywords,
            'offset': 20,
            'page': 1,
            'extensions': 'all',
        }
        if city:
            params['city'] = city
        url = 'https://restapi.amap.com/v3/place/text?' + urllib.parse.urlencode(params)

    try:
        with _https_urlopen(url, timeout=10) as resp:
            data = json.loads(resp.read().decode('utf-8'))
        return jsonify(data)
    except Exception as e:
        err_str = str(e)
        # Friendlier message for SSL cert verification failures
        if ('CERTIFICATE VERIFY FAILED' in err_str or
                'certificate verify failed' in err_str or
                'unable to get local issuer certificate' in err_str):
            err_str = ('SSL 证书验证失败 — 目标电脑的 Windows 系统证书库可能过时。'
                       '错误详情: ' + err_str)
        return jsonify({'error': err_str}), 502


# ── Nominatim (OpenStreetMap) proxy for global geocoding ──────────
# Throttle: Nominatim usage policy requires max 1 req/s.
_nominatim_last_ts = 0.0

def _nominatim_request(url, timeout=10):
    """Fetch from Nominatim with a compliant User-Agent and 1 req/s throttle."""
    global _nominatim_last_ts
    now = time.time()
    wait = 1.0 - (now - _nominatim_last_ts)
    if wait > 0:
        time.sleep(wait)
    _nominatim_last_ts = time.time()
    # Nominatim policy requires a descriptive User-Agent with app name + version
    req = urllib.request.Request(url, headers={
        'User-Agent': '360VideoConverter/3.6.0 (desktop app; pywebview)',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    })
    try:
        with urllib.request.urlopen(req, timeout=timeout,
                                     context=_get_https_ssl_context()) as resp:
            return json.loads(resp.read().decode('utf-8'))
    except urllib.error.URLError as e:
        err_str = str(e)
        if ('CERTIFICATE VERIFY FAILED' in err_str or
                'certificate verify failed' in err_str or
                'unable to get local issuer certificate' in err_str):
            global _HTTPS_SSL_CONTEXT
            _HTTPS_SSL_CONTEXT = _ssl._create_unverified_context()
            req2 = urllib.request.Request(url, headers={
                'User-Agent': '360VideoConverter/3.6.0 (desktop app; pywebview)',
                'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
            })
            with urllib.request.urlopen(req2, timeout=timeout,
                                         context=_HTTPS_SSL_CONTEXT) as resp:
                return json.loads(resp.read().decode('utf-8'))
        raise


@app.route('/api/nominatim')
def nominatim_proxy():
    """Proxy Nominatim (OpenStreetMap) for global location search & reverse geocoding.

    Handles both forward search (q=place name) and reverse geocoding
    (reverse=1 with lat/lon). Returns normalized results compatible with
    the frontend's search-result rendering.
    """
    keywords = request.args.get('q', '')
    is_reverse = request.args.get('reverse', '') == '1'
    lat = request.args.get('lat', '')
    lon = request.args.get('lon', '')

    try:
        if is_reverse:
            if not lat or not lon:
                return jsonify({'error': 'Missing lat/lon for reverse geocoding'}), 400
            url = (f'https://nominatim.openstreetmap.org/reverse?'
                   f'lat={lat}&lon={lon}&format=json&addressdetails=1&accept-language=zh')
            data = _nominatim_request(url)
            return jsonify(data)
        else:
            if not keywords:
                return jsonify({'error': 'Missing query'}), 400
            url = (f'https://nominatim.openstreetmap.org/search?'
                   f'q={urllib.parse.quote(keywords)}&format=json&limit=20'
                   f'&addressdetails=1&accept-language=zh')
            data = _nominatim_request(url)
            return jsonify(data)
    except Exception as e:
        err_str = str(e)
        if ('CERTIFICATE VERIFY FAILED' in err_str or
                'certificate verify failed' in err_str or
                'unable to get local issuer certificate' in err_str):
            err_str = ('SSL 证书验证失败 — 目标电脑的 Windows 系统证书库可能过时。'
                       '错误详情: ' + err_str)
        return jsonify({'error': err_str}), 502


@app.route('/api/convert', methods=['POST'])
def start_convert():
    data = request.json
    mode = data.get('mode', 'single')
    params = data.get('params', DEFAULT_PARAMS)
    merged = {**DEFAULT_PARAMS, **params}
    # Clean up temp keys
    merged.pop('_effective_creation_time', None)
    items = data.get('items', [])

    if not items:
        return jsonify({'error': 'No files to convert'}), 400

    jid = new_job(mode, items, merged)
    if mode == 'merge':
        n_files = len(items[0].get('inputs', [])) if items else 0
        log_line(jid, f'Job started: mode=merge, merging {n_files} files into 1')
    else:
        log_line(jid, f'Job started: mode={mode}, files={len(items)}')
    log_line(jid, f'Codec: {merged.get("codec")}, Rate mode: {merged.get("rate_mode")}, CRF={merged.get("crf")}')

    if merged.get('date_from_filename'):
        log_line(jid, f'Date from filename: enabled (creation_time={merged.get("set_creation_time")}, file_created={merged.get("set_file_created")}, file_modified={merged.get("set_file_modified")})')

    if merged.get('set_location') and merged.get('location_lat'):
        log_line(jid, f'Location: {merged.get("location_name", "")} | {merged.get("location_address", "")} ({merged.get("location_lat")}, {merged.get("location_lon")})')

    t = threading.Thread(target=conversion_worker, args=(jid,), daemon=True)
    t.start()

    return jsonify({'job_id': jid})


# ── VR 3D 360° Synthesis API (v3.9.0) ────────────────────────

@app.route('/api/start_vr3d', methods=['POST'])
def start_vr3d():
    """Start a VR 3D 360° synthesis job.
    Expects: { params: {...}, items: [{left_input, right_input, output}] }
    """
    data = request.json
    params = data.get('params', DEFAULT_PARAMS)
    merged = {**DEFAULT_PARAMS, **params}
    merged.pop('_effective_creation_time', None)
    items = data.get('items', [])

    if not items:
        return jsonify({'error': 'No items provided'}), 400

    # Validate items have left_input and right_input
    for i, item in enumerate(items):
        if not item.get('left_input') or not item.get('right_input'):
            return jsonify({'error': f'Item {i}: missing left_input or right_input'}), 400

    jid = new_job('vr3d', items, merged)
    log_line(jid, f'VR 3D Job started: {len(items)} pair(s)')
    log_line(jid, f'Layout: {merged.get("vr3d_layout", "top-bottom")}')
    log_line(jid, f'Codec: {merged.get("codec")}, CRF={merged.get("crf")}')

    t = threading.Thread(target=vr3d_worker, args=(jid,), daemon=True)
    t.start()

    return jsonify({'job_id': jid})


@app.route('/api/vr3d/check_alignment', methods=['POST'])
def vr3d_check_alignment():
    """Check alignment between left and right eye videos.
    Expects: { left: path, right: path }
    Returns: { aligned, warnings, info }
    """
    data = request.json
    left = data.get('left', '')
    right = data.get('right', '')

    if not left or not right:
        return jsonify({'error': 'Missing left or right path'}), 400
    if not os.path.isfile(left):
        return jsonify({'error': f'File not found: {left}'}), 404
    if not os.path.isfile(right):
        return jsonify({'error': f'File not found: {right}'}), 404

    aligned, warnings, info = check_vr3d_alignment(left, right)
    return jsonify({
        'aligned': aligned,
        'warnings': warnings,
        'info': info,
    })


@app.route('/api/insta360/detect_pair', methods=['POST'])
def insta360_detect_pair():
    """Detect the paired .insv file for dual-lens Insta360 cameras.
    Expects: { path: filepath }
    Returns: { paired: path|null, is_insv: bool }
    """
    data = request.json
    path = data.get('path', '')

    if not path:
        return jsonify({'error': 'Missing path'}), 400

    is_insv = is_insv_file(path)
    pair = detect_insv_pair(path) if is_insv else None

    return jsonify({
        'is_insv': is_insv,
        'paired': pair,
    })


@app.route('/api/apply_metadata', methods=['POST'])
def start_apply_metadata():
    """Apply metadata to video file(s) without re-encoding."""
    data = request.json
    params = data.get('params', {})
    items = data.get('items', [])

    if not items:
        return jsonify({'error': 'No files specified'}), 400

    # Check at least one feature is enabled
    # v3.13.18: 判据须与前端 hasAnyFeature 同口径 —— 批量列队执行时，顶层 params 取的是
    # 界面设置（可能三项全关），而真正要执行的是**各项自己的 params**。旧判据只看顶层，
    # 会把「界面全关 + 列队项各自带功能」这种完全合法的批量提交误判为「未启用任何功能」
    # 并返回 400，用户只看到一句英文错误、批量流程根本跑不起来。
    # 因此改为：顶层开启 **或** 任一项的 per-item params 开启，即放行。
    # items 非空校验（上面已做）仍兜底空提交，放宽不改变本门的防护目的。
    _FEATURE_KEYS = ('apply_date', 'apply_location', 'apply_spherical')

    def _enabled(p):
        return bool(p) and any(p.get(k) for k in _FEATURE_KEYS)

    _top_enabled = _enabled(params)
    _any_item_enabled = any(_enabled(it.get('params') or {}) for it in items if isinstance(it, dict))
    if not (_top_enabled or _any_item_enabled):
        return jsonify({'error': 'No metadata features enabled'}), 400

    jid = new_job('metadata', items, params)
    log_line(jid, f'Metadata job started: files={len(items)}')
    if params.get('apply_date'):
        log_line(jid, '  Date metadata: enabled')
    if params.get('apply_location'):
        log_line(jid, '  Location metadata: enabled')
    if params.get('apply_spherical'):
        pano_type = params.get('pano_type', '360')
        stereo_mode = params.get('stereo_mode', 'mono')
        log_line(jid, f'  Spherical metadata: enabled (pano={pano_type}, stereo={stereo_mode})')

    t = threading.Thread(target=metadata_worker, args=(jid,), daemon=True)
    t.start()

    return jsonify({'job_id': jid})


@app.route('/api/status/<jid>')
def status(jid):
    # FIX BUG-L09: Periodically clean up old completed jobs (throttled to once/minute)
    global _last_job_cleanup
    _now = time.time()
    if _now - _last_job_cleanup > 60:
        _last_job_cleanup = _now
        try:
            cleanup_old_jobs()
        except Exception:
            pass
    with job_lock:
        j = jobs.get(jid)
        if not j:
            return jsonify({'error': 'Job not found'}), 404
        # Get sysmon from global instance
        sysmon_data = {}
        if _sysmon_available:
            try:
                sysmon_data = get_global_sysmon().snapshot()
            except Exception:
                pass
        return jsonify({
            'id': j['id'],
            'status': j['status'],
            'mode': j['mode'],
            'total': j['total'],
            'current_index': j['current_index'],
            'current_input': j['current_input'],
            'current_output': j['current_output'],
            'file_progress': round(j['file_progress'], 1),
            'overall_progress': round(j['overall_progress'], 1),
            'log': j['log'][-200:],
            'error': j['error'],
            'paused': j.get('paused', False),
            'start_time': j['start_time'],
            'end_time': j['end_time'],
            'items': [{k: v for k, v in item.items() if k != 'done'} for item in j['items']],
            'sysmon': sysmon_data,
            'merge_status': j.get('merge_status'),
        })


@app.route('/api/sysmon')
def sysmon_endpoint():
    """Standalone endpoint for system resource data (always available)."""
    data = {}
    if _sysmon_available:
        try:
            data = get_global_sysmon().snapshot()
        except Exception:
            pass
    return jsonify(data)


@app.route('/api/encode_log/<jid>')
def encode_log(jid):
    """Export the full encoding/conversion log for a job as plain text."""
    with job_lock:
        j = jobs.get(jid)
        if not j:
            return jsonify({'error': 'Job not found'}), 404
        params = dict(j.get('params', {}))
        items = list(j.get('items', []))
        log_entries = list(j.get('log', []))
        status = j.get('status', '')
        mode = j.get('mode', '')
        start_time = j.get('start_time')
        end_time = j.get('end_time')
        error = j.get('error')

    lines = []
    lines.append('=' * 70)
    lines.append('360 Video Converter - 编码日志 (Encoding Log)')
    lines.append(f'Job ID: {jid}')
    lines.append(f'Mode: {mode}')
    lines.append(f'Status: {status}')
    if error:
        lines.append(f'Error: {error}')
    if start_time:
        lines.append(f'Start: {datetime.fromtimestamp(start_time).strftime("%Y-%m-%d %H:%M:%S")}')
    if end_time:
        elapsed = end_time - start_time if start_time else 0
        lines.append(f'End: {datetime.fromtimestamp(end_time).strftime("%Y-%m-%d %H:%M:%S")} (elapsed {elapsed:.1f}s)')
    lines.append('=' * 70)
    lines.append('')

    # Parameters
    lines.append('--- Parameters ---')
    for k in sorted(params.keys()):
        if k.startswith('_'):
            continue
        v = params[k]
        lines.append(f'  {k}: {v}')
    lines.append('')

    # File items
    lines.append('--- Files ---')
    for i, item in enumerate(items):
        ok = item.get('ok')
        done = item.get('done')
        skipped = item.get('skipped')
        err = item.get('error')
        if skipped:
            status_str = 'SKIPPED'
        elif ok is True:
            status_str = 'OK'
        elif ok is False:
            status_str = 'FAILED'
        else:
            status_str = 'PENDING'
        err_str = f' [{err}]' if err else ''
        lines.append(f'  [{i+1}/{len(items)}] {item.get("input","")} -> {item.get("output","")} [{status_str}]{err_str}')
    lines.append('')

    # Full log
    lines.append('--- Log ---')
    for entry in log_entries:
        ts = entry.get('ts', '--:--:--')
        level = entry.get('level', 'info')
        msg = entry.get('msg', '')
        prefix = ''
        if level == 'error':
            prefix = '[ERROR] '
        elif level == 'warn':
            prefix = '[WARN]  '
        elif level == 'success':
            prefix = '[OK]    '
        lines.append(f'[{ts}] {prefix}{msg}')
    lines.append('')
    lines.append('=' * 70)
    lines.append(f'Generated: {datetime.now().strftime("%Y-%m-%d %H:%M:%S")}')
    return jsonify({'log': '\n'.join(lines)})


@app.route('/api/cancel/<jid>', methods=['POST'])
def cancel(jid):
    with job_lock:
        j = jobs.get(jid)
        if not j:
            return jsonify({'error': 'Job not found'}), 404
        j['status'] = 'cancelled'
        j['paused'] = False  # Clear pause so check_pause() loop can exit
        proc = j.get('proc')
    if proc:
        try:
            # On Windows, if the process was suspended by pause, we must resume
            # it first so that TerminateProcess can actually take effect.
            # NtSuspendProcess/NtResumeProcess are no-ops on non-Windows.
            resume_process(proc.pid)
            proc.kill()
            # FIX (v3.3.5): Reduced timeout from 10s to 5s to avoid long
            # blocking on the cancel endpoint, which causes the frontend
            # "停止中..." state to persist.
            proc.wait(timeout=5)
        except Exception:
            # FIX (v3.3.5): If proc.kill() / proc.wait() fails, try
            # taskkill /F /T to forcefully terminate the process tree.
            try:
                if os.name == 'nt':
                    subprocess.run(
                        ['taskkill', '/F', '/T', '/PID', str(proc.pid)],
                        capture_output=True, timeout=5,
                        creationflags=subprocess.CREATE_NO_WINDOW
                    )
            except Exception:
                pass
            try:
                proc.kill()
            except Exception:
                pass
    log_line(jid, 'Job cancelled by user', 'warn')
    return jsonify({'ok': True})


@app.route('/api/pause/<jid>', methods=['POST'])
def pause_job(jid):
    with job_lock:
        j = jobs.get(jid)
        if not j:
            return jsonify({'error': 'Job not found'}), 404
        if j['status'] != 'running':
            return jsonify({'error': 'Job is not running'}), 400
        j['paused'] = True
    log_line(jid, 'Job paused by user', 'warn')
    return jsonify({'ok': True})


@app.route('/api/resume/<jid>', methods=['POST'])
def resume_job(jid):
    with job_lock:
        j = jobs.get(jid)
        if not j:
            return jsonify({'error': 'Job not found'}), 404
        j['paused'] = False
    log_line(jid, 'Job resumed by user', 'info')
    return jsonify({'ok': True})


@app.route('/api/item/<jid>/<int:idx>/skip', methods=['POST'])
def skip_item(jid, idx):
    """Skip a specific item in the job queue."""
    with job_lock:
        j = jobs.get(jid)
        if not j:
            return jsonify({'error': 'Job not found'}), 404
        if idx < 0 or idx >= len(j['items']):
            return jsonify({'error': 'Invalid item index'}), 400
        # FIX (v3.13.3): skipping an item that has already started produced a
        # contradictory state (skipped=true while the item finished and wrote its
        # output). Only pending items may be skipped.
        if j['items'][idx].get('start_time'):
            return jsonify({'error': 'Item already started, cannot skip'}), 400
        j['items'][idx]['skipped'] = True
    # NOTE: log_line() re-acquires job_lock, so it MUST run OUTSIDE the lock block
    # to avoid unnecessary re-entrant acquisition (job_lock is an RLock, so re-entrant
    # acquisition won't deadlock, but keeping log_line outside the lock reduces
    # lock hold time and follows best practice).
    log_line(jid, f'Item {idx+1} skipped by user', 'warn')
    return jsonify({'ok': True})


@app.route('/api/add_items/<jid>', methods=['POST'])
def add_items(jid):
    """Add more items to an existing job queue."""
    data = request.json
    new_items = data.get('items', [])
    with job_lock:
        j = jobs.get(jid)
        if not j:
            return jsonify({'error': 'Job not found'}), 404
        j['items'].extend(new_items)
        j['total'] = len(j['items'])
    log_line(jid, f'Added {len(new_items)} items to queue (total: {len(jobs[jid]["items"])})', 'info')
    return jsonify({'ok': True, 'total': len(jobs[jid]['items'])})


@app.route('/api/probe')
def probe():
    """Get video info via ffprobe."""
    path = resolve_real_path(request.args.get('path', ''))
    if not path or not os.path.isfile(path):
        return jsonify({'error': 'File not found'}), 404
    try:
        # Explicit PIPE + utf-8 decode (capture_output=True misbehaves in frozen build)
        r = subprocess.run(
            [FFPROBE_PATH, '-v', 'quiet', '-print_format', 'json',
             '-show_format', '-show_streams', path],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding='utf-8', errors='replace', timeout=30,
            env=_ffmpeg_env(), creationflags=NO_WINDOW
        )
        out = r.stdout or ''
        if r.returncode != 0 or not out.strip():
            return jsonify({'error': f'ffprobe failed: {r.stderr or ""}'}), 500
        return jsonify(json.loads(out))
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/probe-source')
def probe_source():
    """Extract GPS location and creation_time from a source video file.

    Uses ffprobe to read format-level and stream-level metadata tags, then
    parses the ISO 6709 'location' tag into lat/lon and normalizes
    'creation_time'. Returns a clean JSON the frontend can display and
    offer reuse options for.
    """
    path = resolve_real_path(request.args.get('path', ''))
    if not path or not os.path.isfile(path):
        return jsonify({'error': 'File not found'}), 404
    try:
        r = subprocess.run(
            [FFPROBE_PATH, '-v', 'quiet', '-print_format', 'json',
             '-show_format', '-show_streams', path],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding='utf-8', errors='replace', timeout=30,
            env=_ffmpeg_env(), creationflags=NO_WINDOW
        )
        out = r.stdout or ''
        if r.returncode != 0 or not out.strip():
            return jsonify({'error': f'ffprobe failed: {r.stderr or ""}'}), 500

        data = json.loads(out)
        fmt_tags = (data.get('format') or {}).get('tags') or {}
        streams = data.get('streams') or []
        # creation_time can be at format level or stream level (prefer stream)
        creation_time = fmt_tags.get('creation_time', '')
        location_raw = fmt_tags.get('location', '')
        # FIX (v3.13.7): 地名/地址读取与本工具的写入映射对齐——v3.13.3 起地名写
        # description、地址写 comment，旧读取链只认 location.name/location_name，
        # 导致本工具自己处理过的文件在「复用」时读不到地名/地址文本。
        location_name = (fmt_tags.get('location.name', '') or fmt_tags.get('location_name', '')
                         or fmt_tags.get('description', ''))
        location_address = fmt_tags.get('comment', '')
        for s in streams:
            if not isinstance(s, dict):
                continue
            st_tags = s.get('tags') or {}
            if not creation_time and st_tags.get('creation_time'):
                creation_time = st_tags['creation_time']
            if not location_raw and st_tags.get('location'):
                location_raw = st_tags['location']
            if not location_name and (st_tags.get('location.name') or st_tags.get('location_name') or st_tags.get('description')):
                location_name = st_tags.get('location.name') or st_tags.get('location_name') or st_tags.get('description')
            if not location_address and st_tags.get('comment'):
                location_address = st_tags['comment']

        # Parse ISO 6709 location: +34.0522-118.2437/ or +34.0522-118.2437
        gps = None
        if location_raw:
            import re as _re
            m = _re.match(r'^([+-]\d+\.?\d*)\s*([+-]\d+\.?\d*)', location_raw.strip())
            if m:
                try:
                    lat = float(m.group(1))
                    lon = float(m.group(2))
                    gps = {'lat': lat, 'lon': lon, 'raw': location_raw.strip()}
                except ValueError:
                    pass

        return jsonify({
            'has_gps': gps is not None,
            'gps': gps,
            'has_time': bool(creation_time),
            'creation_time': creation_time,
            'has_location_name': bool(location_name),
            'location_name': location_name,
            # FIX (v3.13.7): 响应补充详细地址，供「复用 GPS」完整回填
            'location_address': location_address,
            'filename': os.path.basename(path),
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# ── 文件系统时间读取（只读）────────────────────────────────────
# 与 set_file_dates（app.py:509）严格分工：
#   set_file_dates = 写路径，Windows 需 ctypes CreateFileW + SetFileTime
#   本路由        = 读路径，一次 os.stat 即可，绝不复用 ctypes 句柄管理
# 同类先例见 faststart 重排处（本文件 :2930 调用 relocate_moov_front）：
# 读用 os.stat(...).st_ctime/st_mtime，只在写的时候才调 set_file_dates（:2936）。
@app.route('/api/file_fs_time')
def file_fs_time():
    """Read a file's filesystem timestamps (creation + modification).

    Backs the "browse..." button next to every manual-date input: the user
    picks a reference file and its **filesystem** creation time is filled into
    the date box. Deliberately does NOT read the video `creation_time` metadata
    tag -- that is /api/probe-source's job, and it spawns an ffprobe subprocess
    (up to 30s) where a single stat() suffices.

    Returns::
        {
          path: str,             # echo of the resolved path
          ctime: str,            # local naive 'YYYY-MM-DDTHH:MM:SS' (NO 'Z')
          ctime_ts: float,       # raw Unix timestamp (for debug/re-processing)
          mtime: str,            # local naive, same format
          source: 'filesystem',  # constant; distinguishes from metadata tags
          is_creation_time: bool # False on POSIX, where st_ctime is inode ctime
        }

    Timezone contract (load-bearing):
        `ctime`/`mtime` are **local naive** strings, formatted with the same
        '%Y-%m-%dT%H:%M:%S' pattern used elsewhere in this file (see
        extract_date_from_filename and apply_metadata_one). The frontend feeds
        them straight into a `manual_date` box, which the metadata writer parses
        via datetime.fromisoformat() and then treats as **local** wall-clock.
        Emitting a 'Z' suffix or an aware datetime here would reintroduce the
        +/-8h skew that v3.13.7 fixed (see utcToLocalNaive in 50-meta.js).
        => do NOT add .astimezone() and do NOT append 'Z' here.

    Errors: 400 missing path / path is a directory, 404 not found, 500 stat failed.
    """
    raw_path = (request.args.get('path') or '').strip()
    if not raw_path:
        return jsonify({'error': '缺少 path 参数'}), 400

    path = resolve_real_path(raw_path)
    if not os.path.exists(path):
        return jsonify({'error': '文件不存在'}), 404
    if not os.path.isfile(path):
        return jsonify({'error': '路径是目录，不是文件'}), 400

    try:
        st = os.stat(path)
    except OSError as e:
        return jsonify({'error': f'读取文件时间失败: {e}'}), 500

    # Naive local wall-clock. Matches the manual_date input contract exactly.
    ctime = datetime.fromtimestamp(st.st_ctime).strftime('%Y-%m-%dT%H:%M:%S')
    mtime = datetime.fromtimestamp(st.st_mtime).strftime('%Y-%m-%dT%H:%M:%S')

    return jsonify({
        'path': path,
        'ctime': ctime,
        'ctime_ts': st.st_ctime,
        'mtime': mtime,
        'source': 'filesystem',
        # On Windows CPython maps st_ctime to ftCreationTime, so it really is the
        # creation time. On POSIX it is inode-change time -- say so honestly
        # rather than presenting it as a creation time.
        'is_creation_time': os.name == 'nt',
    })


@app.route('/api/probe_metadata')
def probe_metadata():
    """Probe a video file for ALL existing metadata: spherical, date, GPS.

    Combines ffprobe (GPS, creation_time, location) with read_gspherical
    (GSpherical UUID box) to return a complete picture of what metadata the
    file already has. Used by the batch list to auto-enable toggles and
    pre-fill values per file.

    Returns::
        {
          has_spherical, spherical{pano_type, stereo_mode, projection},
          has_date, creation_time,
          has_gps, gps{lat, lon, raw},
          location_name, location_address,
          file_size_mb, date_in_name
        }
    """
    path = resolve_real_path(request.args.get('path', ''))
    if not path or not os.path.isfile(path):
        return jsonify({'error': 'File not found'}), 404
    try:
        # 1) ffprobe for format/stream tags
        r = subprocess.run(
            [FFPROBE_PATH, '-v', 'quiet', '-print_format', 'json',
             '-show_format', '-show_streams', path],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding='utf-8', errors='replace', timeout=30,
            env=_ffmpeg_env(), creationflags=NO_WINDOW,
        )
        out = r.stdout or ''
        creation_time = ''
        location_raw = ''
        location_name = ''
        location_address = ''
        file_size_mb = 0.0
        if r.returncode == 0 and out.strip():
            data = json.loads(out)
            fmt_tags = (data.get('format') or {}).get('tags') or {}
            streams = data.get('streams') or []
            creation_time = fmt_tags.get('creation_time', '')
            location_raw = fmt_tags.get('location', '')
            # FIX (v3.13.7): 地名读取对齐写入映射（v3.13.3 起地名写 description）
            location_name = (fmt_tags.get('location.name', '') or fmt_tags.get('location_name', '')
                             or fmt_tags.get('description', ''))
            # comment field sometimes holds the address
            location_address = fmt_tags.get('comment', '')
            for s in streams:
                if not isinstance(s, dict):
                    continue
                st_tags = s.get('tags') or {}
                if not creation_time and st_tags.get('creation_time'):
                    creation_time = st_tags['creation_time']
                if not location_raw and st_tags.get('location'):
                    location_raw = st_tags['location']
                if not location_name and (st_tags.get('location.name') or st_tags.get('location_name') or st_tags.get('description')):
                    location_name = st_tags.get('location.name') or st_tags.get('location_name') or st_tags.get('description')
            # file size
            try:
                file_size_mb = round(os.path.getsize(path) / (1024 * 1024), 1)
            except Exception:
                pass
        else:
            location_address = ''

        # 2) Parse ISO 6709 location
        gps = None
        if location_raw:
            import re as _re
            m = _re.match(r'^([+-]\d+\.?\d*)\s*([+-]\d+\.?\d*)', location_raw.strip())
            if m:
                try:
                    lat = float(m.group(1))
                    lon = float(m.group(2))
                    gps = {'lat': lat, 'lon': lon, 'raw': location_raw.strip()}
                except ValueError:
                    pass

        # 3) read_gspherical for spherical metadata
        spherical = {'has': False, 'pano_type': None, 'stereo_mode': None, 'projection': None}
        if read_gspherical:
            try:
                gsph = read_gspherical(path)
                if gsph and gsph.get('spherical'):
                    spherical = {
                        'has': True,
                        'pano_type': gsph.get('pano_type'),
                        'stereo_mode': gsph.get('stereo_mode'),
                        'projection': gsph.get('projection'),
                    }
            except Exception:
                pass

        # 4) Extract date from filename
        date_in_name = ''
        ct_from_name, _ = extract_date_from_filename(os.path.basename(path))
        if ct_from_name:
            date_in_name = ct_from_name.split('T')[0] if 'T' in ct_from_name else ct_from_name

        return jsonify({
            'has_spherical': spherical['has'],
            'spherical': spherical,
            'has_date': bool(creation_time),
            'creation_time': creation_time,
            'has_gps': gps is not None,
            'gps': gps,
            'location_name': location_name,
            'location_address': location_address,
            'file_size_mb': file_size_mb,
            'date_in_name': date_in_name,
            'filename': os.path.basename(path),
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500


def probe_moov_atom(path):
    """遍历 MP4 顶层 box，返回 {'has_moov': bool, 'moov_position': 'front'|'end'|'-'}

    MP4 box 结构：前 4 字节大端 size，接着 4 字节 type；size==1 表示后跟 8 字节
    largesize；size==0 表示延伸到文件尾。moov 在 mdat 之前 = 'front'（faststart），
    在 mdat 之后 = 'end'。文件不可读/非 MP4 → has_moov=False。

    纯 Python 实现，不依赖 ffprobe：只读每个 box 的 8/16 字节头并 seek 跳过内容，
    绝不把整个文件读进内存（视频文件可能几十 GB）。对恶意/损坏文件（size<8 且非
    0/1）立即终止遍历，防止死循环或越界。
    """
    result = {'has_moov': False, 'moov_position': '-'}
    try:
        f = open(path, 'rb')
    except OSError:
        return result
    with f:
        try:
            # 头 12 字节不足以确认是 MP4：MP4 容器必须以 ftyp box 开头
            # （偏移 4-8 字节为 'ftyp'），MKV/AVI/FLV 等直接排除
            sig = f.read(12)
            if len(sig) < 12 or sig[4:8] != b'ftyp':
                return result
            f.seek(0)
            seen_mdat = False
            while True:
                header = f.read(8)
                if len(header) < 8:
                    break  # 文件尾或截断
                size = int.from_bytes(header[0:4], 'big')
                btype = header[4:8]
                hdr = 8
                if size == 1:
                    # 64 位 largesize：完整头共 16 字节
                    large = f.read(8)
                    if len(large) < 8:
                        break
                    size = int.from_bytes(large, 'big')
                    hdr = 16
                elif size == 0:
                    # 延伸到文件尾：moov/mdat 判定后即到末尾
                    if btype == b'moov':
                        result['has_moov'] = True
                        result['moov_position'] = 'end' if seen_mdat else 'front'
                    break
                if size < hdr:
                    break  # 损坏/恶意 size（<8 或 largesize<16），终止防死循环
                if btype == b'moov':
                    result['has_moov'] = True
                    result['moov_position'] = 'end' if seen_mdat else 'front'
                    break
                if btype == b'mdat':
                    seen_mdat = True
                try:
                    f.seek(size - hdr, 1)  # 只 seek 不读，跳过 box 内容
                except OSError:
                    break
        except (OSError, ValueError):
            pass
    return result


@app.route('/api/report', methods=['POST'])
def start_report():
    """Generate a metadata report for one or more video files using a job-based
    pipeline (consistent with conversion: live log + exportable log)."""
    data = request.json or {}
    paths = data.get('paths') or []
    if not paths:
        # Allow passing a directory + recursive flag (backend scans)
        directory = resolve_real_path((data.get('directory') or '').strip())
        recursive = data.get('recursive', True)
        if directory and os.path.isdir(directory):
            try:
                if recursive:
                    walker = os.walk(directory)
                else:
                    walker = [(directory, [], [f for f in os.listdir(directory)
                                               if os.path.isfile(os.path.join(directory, f))])]
                scanned = []
                for root, _dirs, files in walker:
                    for f in files:
                        if Path(f).suffix.lower() in VIDEO_EXTS:
                            scanned.append(os.path.join(root, f))
                paths = scanned
            except Exception:
                pass
    if not paths:
        return jsonify({'error': 'No files specified'}), 400

    items = []
    for p in paths:
        rp = resolve_real_path(p)
        try:
            size = os.path.getsize(rp) if os.path.isfile(rp) else 0
        except Exception:
            size = 0
        items.append({'input': rp, 'name': os.path.basename(rp),
                      'size': round(size / 1024 / 1024, 1)})

    jid = new_job('report', items, data.get('params', {}))
    log_line(jid, f'元数据报告任务启动: 文件数={len(items)}')
    t = threading.Thread(target=report_worker, args=(jid,), daemon=True)
    t.start()
    return jsonify({'job_id': jid})


def report_worker(jid):
    """Worker: probe each file with ffprobe, log progress, store results."""
    with job_lock:
        j = jobs.get(jid)
        if not j:
            return
        j['status'] = 'running'
        j['start_time'] = time.time()
        items = j['items']
    total = len(items)
    ok_count = 0
    for idx, item in enumerate(items):
        with job_lock:
            j = jobs.get(jid)
            if not j or j['status'] == 'cancelled':
                return
            j['current_index'] = idx
            j['current_input'] = item['input']
            j['file_progress'] = 0.0
        path = item['input']
        log_line(jid, f'[{idx+1}/{total}] 正在读取: {path}')
        try:
            if not os.path.isfile(path):
                item['error'] = '文件不存在 (File not found)'
                item['ok'] = False
                log_line(jid, '  错误: 文件不存在', 'error')
            else:
                # Explicit PIPE + utf-8 decode. NOTE: in the PyInstaller frozen
                # build, capture_output=True fails to wire stdout (r.stdout ends
                # up None while stderr is captured fine), so we request PIPE
                # explicitly and decode with errors='replace' to guarantee a str.
                r = subprocess.run(
                    [FFPROBE_PATH, '-v', 'quiet', '-print_format', 'json',
                     '-show_format', '-show_streams', path],
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                    text=True, encoding='utf-8', errors='replace', timeout=30,
                    env=_ffmpeg_env(), creationflags=NO_WINDOW,
                )
                out = r.stdout or ''
                err = r.stderr or ''
                if r.returncode != 0 or not out.strip():
                    err_txt = err.strip()[:400] or 'ffprobe 无输出'
                    item['error'] = f'ffprobe 失败: {err_txt}'
                    item['ok'] = False
                    log_line(jid, f'  ffprobe 失败: {err_txt}', 'error')
                else:
                    probe_data = json.loads(out)
                    # Enrich: parse the raw GSpherical XML UUID box so the
                    # report can show the real projection type (360°/180° +
                    # stereo mode).  ffprobe's side_data cannot distinguish
                    # 360 vs 180 (no bound/crop fields exposed).
                    if read_gspherical:
                        try:
                            probe_data['gspherical'] = read_gspherical(path)
                        except Exception:
                            pass
                    item['probe'] = probe_data
                    # moov atom 位置（faststart 检测）：纯 Python 头部字节扫描，
                    # 与 ffprobe 结果并列返回；失败不影响主探测结果
                    try:
                        item['moov'] = probe_moov_atom(path)
                    except Exception:
                        item['moov'] = None
                    item['ok'] = True
                    ok_count += 1
                    log_line(jid, '  读取成功', 'success')
        except Exception as e:
            item['error'] = f'读取异常: {e}'
            item['ok'] = False
            log_line(jid, f'  异常: {e}', 'error')
        item['done'] = True
        with job_lock:
            j = jobs.get(jid)
            if j:
                j['overall_progress'] = (idx + 1) / total * 100
    # NOTE: log_line() re-acquires job_lock, so it MUST run OUTSIDE the lock block
    # to avoid unnecessary re-entrant acquisition (job_lock is an RLock, so re-entrant
    # acquisition won't deadlock, but keeping log_line outside the lock reduces
    # lock hold time and follows best practice).
    with job_lock:
        j = jobs.get(jid)
        if j:
            j['status'] = 'completed'
            j['end_time'] = time.time()
    log_line(jid, f'报告读取完成: 成功 {ok_count}/{total}', 'success')


@app.route('/api/config')
def get_config():
    return jsonify({
        'ffmpeg_path': FFMPEG_PATH,
        'ffprobe_path': FFPROBE_PATH,
        'injection_available': inject_uuid is not None,
        'presets_dir': PRESETS_DIR,
        'mingw_bin': MINGW_BIN,
        'is_frozen': getattr(sys, 'frozen', False),
    })


# ── Task Save/Load ─────────────────────────────────────────────
@app.route('/api/tasks/save', methods=['POST'])
def save_tasks():
    """Save current task list and params to file.

    v3.5.0: Supports custom file path via 'path' field. If not provided,
    falls back to the default TASKS_FILE (auto-save behavior).
    """
    data = request.json
    task_data = {
        'mode': data.get('mode', 'batch'),
        'items': data.get('items', []),
        'params': data.get('params', {}),
        'batch_formula': data.get('batch_formula', ''),
        'batch_out_dir': data.get('batch_out_dir', ''),
        'project_dir': data.get('project_dir', ''),
        'saved_at': datetime.now().isoformat(),
    }
    # v3.5.0: Use custom path if provided (from file save dialog)
    save_path = data.get('path') or TASKS_FILE
    try:
        Path(save_path).write_text(json.dumps(task_data, indent=2, ensure_ascii=False), encoding='utf-8')
        return jsonify({'ok': True, 'saved_at': task_data['saved_at'], 'path': save_path})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/tasks/load')
def load_tasks():
    """Load saved task list from default file."""
    if not os.path.exists(TASKS_FILE):
        return jsonify({'error': 'No saved tasks'}), 404
    try:
        data = json.loads(Path(TASKS_FILE).read_text(encoding='utf-8'))
        return jsonify(data)
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/tasks/load_file', methods=['POST'])
def load_tasks_file():
    """Load task list from a specific file path (v3.5.0).

    Body: {path: str}
    """
    data = request.json or {}
    file_path = data.get('path', '')
    if not file_path:
        return jsonify({'error': 'No file path provided'}), 400
    if not os.path.exists(file_path):
        return jsonify({'error': f'File not found: {file_path}'}), 404
    try:
        data = json.loads(Path(file_path).read_text(encoding='utf-8'))
        return jsonify(data)
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# ── App Settings ───────────────────────────────────────────────
@app.route('/api/settings', methods=['GET'])
def get_settings():
    # Built-in default AMap key — works out of the box; users can override in Settings
    _BUILTIN_KEY = '9a6182171cfb3a1207fa97b75755cefd'
    _BUILTIN_SEC = '167425ffdd39f516cb6383a9207ba317'
    defaults = {
        'auto_load_tasks': False,
        'amap_api_key':     _BUILTIN_KEY,
        'amap_security':    _BUILTIN_SEC,
        'custom_ffmpeg_path': '',
        # ── AI 助手（v3.14.0，page-agent 集成）默认值 ──
        'agent_enabled':   False,
        'agent_base_url':  '',
        'agent_api_key':   '',        # 出参时会被掩码替换（见下）
        'agent_model':     '',
        'agent_thinking':  'default',
        'agent_reasoning_effort': 'auto',
        'agent_temperature': '',
        'agent_max_steps': 40,
        'agent_step_delay': 0.4,
        'agent_permission': 'standard',
    }
    if os.path.exists(SETTINGS_FILE):
        try:
            saved = json.loads(Path(SETTINGS_FILE).read_text(encoding='utf-8'))
            defaults.update(saved)
        except Exception:
            pass
    # Fall back to built-in defaults if saved value is empty
    if not defaults.get('amap_api_key'):
        defaults['amap_api_key'] = _BUILTIN_KEY
    if not defaults.get('amap_security'):
        defaults['amap_security'] = _BUILTIN_SEC
    # v3.14.0: agent_api_key 明文永不出前端——前端从不使用其明文（LLM 请求经
    # /api/agent_relay 由后端注入 Authorization）。这里只回掩码，防止 GET 响应
    # 把密钥送进前端 DOM / devtools / 任何日志。amap_api_key 保持明文是因其
    # 运行期被 20-map.js 直接拼进 /api/geocode 请求，改造面超出本次范围。
    real_agent_key = defaults.get('agent_api_key') or ''
    defaults['agent_api_key_set'] = bool(real_agent_key)
    defaults['agent_api_key'] = ('__KEEP__' if real_agent_key else '')
    return jsonify(defaults)


@app.route('/api/settings', methods=['POST'])
def save_settings():
    data = request.json
    # Merge with existing settings so unspecified keys are preserved
    existing = {}
    if os.path.exists(SETTINGS_FILE):
        try:
            existing = json.loads(Path(SETTINGS_FILE).read_text(encoding='utf-8'))
        except Exception:
            pass
    # v3.14.0: agent_api_key 密钥纪律——GET 只回掩码哨兵，前端原样回传哨兵即
    # "保持原值不变"；弹出计算字段不持久化。明文 key 只存在于本文件与进程内。
    if isinstance(data, dict):
        if data.get('agent_api_key') == '__KEEP__':
            data.pop('agent_api_key')
        data.pop('agent_api_key_set', None)
    merged = {**existing, **data}
    try:
        Path(SETTINGS_FILE).write_text(json.dumps(merged, indent=2, ensure_ascii=False), encoding='utf-8')
        return jsonify({'ok': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/agent_relay', methods=['POST'])
def agent_relay():
    """AI 助手 LLM 请求中继（v3.14.0）。

    存在理由（按权重）：
    1. 密钥不出后端——前端 customFetch 不发 Authorization，真实 key 只在本进程
       注入，前端 DOM/devtools/日志永远看不到明文（与门禁 10 凭据纪律同线）；
    2. WebView2 fetch 到 http:// 局域网端点属混合内容，且跨 origin 需要 CORS——
       中继后浏览器永远只与 127.0.0.1:8765 同源通信，D4 "外网 API 一律经 Flask
       代理" 先例的 AI 版；
    3. 直连绕过环境代理——本机若挂 http_proxy，urllib 默认会走代理，
       局域网 llama.cpp 端点会被代理劫持成错误响应（实测）。ProxyHandler({})
       强制直连。

    安全边界：只允许转发到 _settings.json 中用户已保存的 agent_base_url 之下、
    且路径以白名单开头的请求——请求体里**不接收**任何 URL，前端无法把它当
    开放代理用（SSRF 面=用户自己配置的那一台服务器）。
    """
    try:
        settings = json.loads(Path(SETTINGS_FILE).read_text(encoding='utf-8')) if os.path.exists(SETTINGS_FILE) else {}
    except Exception:
        settings = {}
    base = (settings.get('agent_base_url') or '').strip()
    if not base:
        return jsonify({'error': 'AI 助手未配置模型端点，请在设置 → AI 助手中填写 Base URL'}), 400
    if not base.startswith(('http://', 'https://')):
        return jsonify({'error': 'agent_base_url 协议非法（仅 http/https）'}), 400

    try:
        payload = request.get_json(force=True, silent=False)
    except Exception:
        return jsonify({'error': '请求体不是合法 JSON'}), 400
    path = payload.get('path') or '/chat/completions'
    body = payload.get('body')
    # 路径白名单：只放行 OpenAI 兼容的聊天补全（page-agent 运行期唯一用到的端点）。
    # v3.14.0 对抗复测教训：startswith 前缀匹配可被 `/chat/completions/../settings`
    # 穿透——urllib 会把 .. 归一化后转发到同 origin 的任意路径（实测 405/GET-only
    # 端点被命中）。收紧为：归一化后必须与白名单路径完全相等。
    import posixpath as _pp
    norm = _pp.normpath(path) if isinstance(path, str) else ''
    if norm != '/chat/completions':
        return jsonify({'error': '中继仅允许 /chat/completions 路径'}), 400
    if not isinstance(body, dict) or 'messages' not in body:
        return jsonify({'error': 'body.messages 缺失'}), 400

    # v3.14.1 B1 修复：转发必须用**归一化后**的路径——校验用 norm、拼接用原串
    # 会让 `/chat//completions` 一类松散变体以非规范形态打到上游（实测 echo 靶
    # 收到 /v1/chat//completions）。安全后果有限（同 origin 同端点），但契约要求
    # "校验放行的语义 == 实际转发的语义"。
    url = base.rstrip('/') + norm
    headers = {'Content-Type': 'application/json'}
    key = settings.get('agent_api_key') or ''
    if key:
        # v3.14.1 A3 修复：Authorization 头只接受可打印 ASCII（latin-1 编码域），
        # 含非 ASCII 时 urllib 抛 'latin-1' codec 内部异常并 502 回显原文。
        # 入口校验 + 错误脱敏，不透出 Python 异常细节。
        if any(ord(c) > 126 or ord(c) < 32 for c in key):
            return jsonify({'error': 'API Key 含非法字符（仅支持可打印 ASCII），请在设置中重新输入'}), 400
        headers['Authorization'] = 'Bearer ' + key

    data_bytes = json.dumps(body, ensure_ascii=False).encode('utf-8')
    https = url.startswith('https://')

    def _do(ctx):
        req = urllib.request.Request(url, data=data_bytes, headers=headers, method='POST')
        opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({}),
            urllib.request.HTTPSHandler(context=ctx) if https else urllib.request.BaseHandler(),
        )
        return opener.open(req, timeout=180)

    # SSL 降级重试与 _https_urlopen 同法（证书库过时的用户机场景）
    try:
        resp = _do(_get_https_ssl_context())
    except urllib.error.URLError as e:
        err = str(e).lower()
        if https and ('certificate verify failed' in err or 'unable to get local issuer' in err):
            try:
                resp = _do(_ssl._create_unverified_context())
            except urllib.error.HTTPError as he:
                resp = he
            except Exception as e2:
                return jsonify({'error': f'模型端点连接失败：{e2}'}), 502
        elif isinstance(e, urllib.error.HTTPError):
            resp = e   # 上游 4xx/5xx：透传状态与 body，让前端展示真实原因
        else:
            return jsonify({'error': f'模型端点连接失败：{e}'}), 502
    except urllib.error.HTTPError as e:
        resp = e
    except Exception as e:
        return jsonify({'error': f'中继内部错误：{e}'}), 502

    raw = resp.read()
    try:
        return jsonify(json.loads(raw.decode('utf-8'))), resp.status or 200
    except Exception:
        return app.response_class(raw, status=resp.status or 200, mimetype='application/json')


@app.route('/api/debug')
def debug_env():
    """Debug endpoint: verify ffmpeg/ffprobe can run."""
    import subprocess
    env = _ffmpeg_env()
    result = {'env_path_head': env['PATH'][:300], 'mingw_bin': MINGW_BIN}
    try:
        r = subprocess.run(
            [FFPROBE_PATH, '-version'],
            capture_output=True, text=True, timeout=10, env=env,
            creationflags=NO_WINDOW
        )
        result['ffprobe_rc'] = r.returncode
        result['ffprobe_output'] = r.stdout[:200] if r.stdout else '(empty)'
        result['ffprobe_stderr'] = r.stderr[:200] if r.stderr else '(empty)'
    except Exception as e:
        result['ffprobe_error'] = str(e)
    try:
        r = subprocess.run(
            [FFMPEG_PATH, '-version'],
            capture_output=True, text=True, timeout=10, env=env,
            creationflags=NO_WINDOW
        )
        result['ffmpeg_rc'] = r.returncode
        result['ffmpeg_output'] = r.stdout[:200] if r.stdout else '(empty)'
    except Exception as e:
        result['ffmpeg_error'] = str(e)
    return jsonify(result)


# ── Default Presets ────────────────────────────────────────────
def ensure_default_preset():
    """Create default presets on first run."""
    default_path = Path(PRESETS_DIR) / '5G Optimized.json'
    if not default_path.exists():
        save_preset('5G Optimized', DEFAULT_PARAMS, DEFAULT_BATCH_FORMULA)

    match_path = Path(PRESETS_DIR) / 'Match Original.json'
    if not match_path.exists():
        match_params = {**DEFAULT_PARAMS,
            'rate_mode': '2pass',
            'target_bitrate': '50724k',
            'maxrate': '80M',
            'bufsize': '40M',
            'bf': 2,
            'gop': 12,
            'crf': 20,
            'audio_bitrate': '125k',
            'preset': 'medium',
        }
        save_preset('Match Original', match_params, DEFAULT_BATCH_FORMULA)

    nvenc_path = Path(PRESETS_DIR) / 'NVENC H.265.json'
    if not nvenc_path.exists():
        nvenc_params = {**DEFAULT_PARAMS,
            'codec': 'hevc_nvenc',
            'crf': 28,
            'preset': 'p4',
            'rate_mode': 'crf',
        }
        save_preset('NVENC H.265', nvenc_params, DEFAULT_BATCH_FORMULA)


# ── Single-instance guard ──────────────────────────────────────
# Only one instance may run at a time. Implemented with a named
# Windows mutex (system-wide). If another instance already holds it,
# we show a native message box and exit. The mutex is released
# automatically when this process terminates.
_INSTANCE_MUTEX_NAME = "Global\\360VideoConverter_InstanceMutex_V1"


def _is_single_instance():
    """Return True if this is the only running instance.

    Uses a named kernel mutex. Non-Windows platforms always return
    True (no guard). If the mutex cannot be created for any reason we
    also return True to avoid blocking legitimate launches.
    """
    if sys.platform != 'win32':
        return True
    try:
        kernel32 = ctypes.windll.kernel32
        handle = kernel32.CreateMutexW(ctypes.c_void_p(0), 0, _INSTANCE_MUTEX_NAME)
        if not handle:
            return True
        # ERROR_ALREADY_EXISTS = 183
        if kernel32.GetLastError() == 183:
            kernel32.CloseHandle(handle)
            return False
        # Keep the handle alive for the whole process lifetime so the
        # mutex is not released until we exit.
        _is_single_instance._handle = handle
        return True
    except Exception:
        return True


def _show_already_running_dialog():
    """Show a native 'instance already running' dialog and block."""
    try:
        user32 = ctypes.windll.user32
        MB_OK = 0x00000000
        MB_ICONINFORMATION = 0x00000040
        user32.MessageBoxW(
            0,
            "已有实例正在运行，请勿重复启动。",
            "360° Video Converter",
            MB_OK | MB_ICONINFORMATION,
        )
    except Exception:
        pass


# ── Main ────────────────────────────────────────────────────────
if __name__ == '__main__':
    # Single-instance check BEFORE doing any heavy startup work.
    if not _is_single_instance():
        _show_already_running_dialog()
        os._exit(0)

    ensure_default_preset()

    # Start global system resource monitor
    if _sysmon_available:
        try:
            get_global_sysmon(interval=2.0)
            print('  sysmon:  active (system-wide)')
        except Exception as e:
            print(f'  sysmon:  failed ({e})')

    print(f'[360 Video Converter]')
    print(f'  ffmpeg:  {FFMPEG_PATH}')
    print(f'  ffprobe: {FFPROBE_PATH}')
    print(f'  presets: {PRESETS_DIR}')

    PORT = 8765

    # Start Flask in background thread
    def run_flask():
        app.run(host='127.0.0.1', port=PORT, debug=False, threaded=True)

    flask_thread = threading.Thread(target=run_flask, daemon=True)
    flask_thread.start()

    # Wait for Flask to start
    import urllib.request as _urllib
    for _ in range(30):
        try:
            _urllib.urlopen(f'http://127.0.0.1:{PORT}/', timeout=1)
            break
        except Exception:
            time.sleep(0.3)

    # Try pywebview for embedded window
    try:
        # ⚠️ WebView2 渲染参数（闪烁修复）。
        # 现象：v3.12.2 的三栏工作台引入了两处 position:sticky + box-shadow 的合成层，
        # 在无 GPU 直通的环境（VMware / RDP / 远程桌面）里，Chromium 的 DirectComposition
        # 合成路径会让画面出现整块区域频繁闪烁，用户描述为「频繁弹出未知窗口的闪烁」。
        # 取证：用 Win32 EnumWindows 以 200ms 间隔采样主窗口出现后的 20 秒，本进程
        # **零新窗口** → 排除真实弹窗，确认是渲染层问题。
        # 修复：默认禁用 GPU 加速，改走 CPU 合成。本应用是表单/表格型界面，无视频
        # 预览等重绘负载，CPU 渲染绰绰有余。如需恢复 GPU 加速，设环境变量 360VC_ENABLE_GPU=1。
        # 说明：WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS 是 WebView2 运行时自带的环境变量，
        # pywebview 不经手，因此在 import webview 之前设置即可生效。
        # FIX (v3.13.10): 不再整体覆盖该环境变量——用户附加的参数此前会被静默丢弃；
        # GPU 开关仍由 360VC_ENABLE_GPU 独立控制，其余参数追加保留。
        if os.environ.get('360VC_ENABLE_GPU') != '1':
            user_args = os.environ.get('WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS', '')
            if '--disable-gpu' not in user_args:
                os.environ['WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS'] = (
                    '--disable-gpu' + (' ' + user_args if user_args else '')).strip()

        import webview
        # FIX (v3.13.10): 诊断开关 —— 设置 360VC_REMOTE_DEBUGGING_PORT 即开启 WebView2
        # CDP 远程调试（Runtime.exceptionThrown 可捕获前端未捕获异常，即"JS错误"弹窗的
        # 根源定位通道）。注意必须经 webview.settings 传入：pywebview 6 会以自身 options
        # 覆盖 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS 环境变量，环境变量路径不可靠。
        if os.environ.get('360VC_REMOTE_DEBUGGING_PORT'):
            try:
                webview.settings['REMOTE_DEBUGGING_PORT'] = int(os.environ['360VC_REMOTE_DEBUGGING_PORT'])
            except (ValueError, KeyError, TypeError):
                pass
        webview.create_window(
            '360° Video Converter',
            f'http://127.0.0.1:{PORT}',
            # ⚠️ 窗口宽度必须大于 app.css 中 .workspace 的单列回落断点（当前 1180px），
            # 否则三栏工作台在启动瞬间就被自身断点压回单列，表现为"新版 UI 毫无变化"。
            # 该约束由 scripts/frontend-gate/09-layout-breakpoint.js 自动校验。
            width=1440, height=900,
            min_size=(1024, 640),
        )
        webview.start()
        # When window closes, exit
        os._exit(0)
    except ImportError:
        # Fallback: open in default browser
        import webbrowser
        webbrowser.open(f'http://127.0.0.1:{PORT}')
        print(f'  Server running on http://127.0.0.1:{PORT}')
        print(f'  Press Ctrl+C to stop')
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            pass

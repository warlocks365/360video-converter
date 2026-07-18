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
from pathlib import Path, PurePath
from datetime import datetime
from flask import Flask, request, jsonify, send_from_directory

# ── Windows: suppress console window for all subprocess calls ──
NO_WINDOW = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0

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
    from inject_spherical_metadata import inject_uuid, read_gspherical
except ImportError:
    inject_uuid = None
    read_gspherical = None
    print('[WARN] inject_spherical_metadata not found -- injection disabled')

# Import the system resource monitor
try:
    from sysmon import SysMon
except ImportError:
    SysMon = None
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

VIDEO_EXTS = {'.mp4', '.mov', '.mkv', '.avi', '.insv', '.ts', '.m2ts', '.flv', '.wmv'}

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
    'location_lat':     '',
    'location_lon':     '',
    'amap_api_key':     '',
    # Video stabilization (v3.0)
    'stabilize':            False,   # master switch
    'stabilize_smoothing':  30,      # smoothing window (frames)
    'stabilize_shakiness':  5,       # vidstab shakiness estimate (1-10)
    'stabilize_zoom':       0.05,    # zoom/border fill ratio (0-0.2)
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
    if set_created and os.name == 'nt':
        try:
            # Convert Unix timestamp to Windows FILETIME (100-nanosecond intervals since 1601-01-01)
            win_epoch_diff = 11644473600  # seconds between 1601 and 1970
            win_ts = int((ts + win_epoch_diff) * 10000000)

            handle = ctypes.windll.kernel32.CreateFileW(
                filepath,
                0x10000000,  # GENERIC_WRITE
                0x00000007,   # FILE_SHARE_READ|WRITE|DELETE
                None,
                3,            # OPEN_EXISTING
                0x00000080,   # FILE_ATTRIBUTE_NORMAL
                None
            )
            if handle != -1 and handle != 0:
                class FILETIME(ctypes.Structure):
                    _fields_ = [("dwLowDateTime", ctypes.c_uint32),
                                ("dwHighDateTime", ctypes.c_uint32)]
                ft = FILETIME()
                ft.dwLowDateTime = win_ts & 0xFFFFFFFF
                ft.dwHighDateTime = (win_ts >> 32) & 0xFFFFFFFF

                # SetFileTime(handle, creation_time, access_time, modification_time)
                # We only want to set creation time here (modification set via os.utime)
                ok = ctypes.windll.kernel32.SetFileTime(
                    handle, ctypes.byref(ft), None, None
                )
                ctypes.windll.kernel32.CloseHandle(handle)
                if ok:
                    results['created'] = True
                else:
                    results['created_error'] = f'SetFileTime returned {ok}'
            else:
                results['created_error'] = f'CreateFileW returned handle {handle}'
        except Exception as e:
            results['created_error'] = str(e)

    return results


# ── Job State ──────────────────────────────────────────────────
jobs = {}
job_lock = threading.Lock()


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
        'sysmon': {},
        '_sysmon': None,
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
    except:
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


def build_cmd(inp, out, params, pass_num=0, passlogfile=None):
    """Build ffmpeg command list, supporting multiple codecs."""
    codec = params.get('codec', 'libx264')
    # Use the ffmpeg path determined by codec_check (may be system ffmpeg for hw encoders)
    ffmpeg = _encoder_ffmpeg_map.get(codec, FFMPEG_PATH)
    cmd = [ffmpeg, '-y', '-i', inp]

    codec = params.get('codec', 'libx264')
    cp = CODEC_PROFILES.get(codec, CODEC_PROFILES['libx264'])

    # Video filter chain: vidstab transform (if enabled) + scale
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

    # Set encoder
    cmd += ['-c:v', cp['encoder']]

    # Tag for HEVC (hvc1 for QuickTime/Apple compatibility)
    if cp.get('tag'):
        cmd += ['-tag:v', cp['tag']]

    # Profile (if supported by this codec)
    if cp.get('has_profile') and params.get('profile'):
        cmd += ['-profile:v', params['profile']]

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

    # Metadata: creation_time (if date extraction or manual date is enabled)
    creation_time = params.get('_effective_creation_time', '')
    if creation_time:
        cmd += ['-metadata', f'creation_time={creation_time}']

    # Metadata: location (ISO 6709 format: +lat-lon/)
    loc_lat = params.get('location_lat', '')
    loc_lon = params.get('location_lon', '')
    if params.get('set_location') and loc_lat and loc_lon:
        iso6709 = format_location_iso6709(loc_lat, loc_lon)
        if iso6709:
            cmd += ['-metadata:s:v:0', f'location={iso6709}']

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
    """Run ffmpeg subprocess, stream progress to job log."""
    with job_lock:
        jobs[jid]['proc'] = None

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

    # Start system resource monitor for this ffmpeg run
    sm = None
    if SysMon is not None:
        try:
            sm = SysMon(pid=proc.pid, interval=1.0)
            sm.start()
            with job_lock:
                j = jobs.get(jid)
                if j:
                    j['_sysmon'] = sm
        except Exception:
            sm = None

    try:
        for line in _read_ffmpeg_lines(proc.stderr):
            line = line.rstrip()
            if not line:
                continue
            # Check pause state
            if not check_pause(jid, proc):
                proc.kill()
                proc.wait()
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
            else:
                log_line(jid, f'{pass_label}{line}')
    except Exception as e:
        log_line(jid, f'ffmpeg output read error: {e}', 'error')
        try:
            proc.kill()
        except Exception:
            pass

    proc.wait()

    # Stop resource monitor and keep final snapshot
    if sm is not None:
        sm.stop()
        final_snap = sm.snapshot()
        with job_lock:
            j = jobs.get(jid)
            if j:
                j['sysmon'] = final_snap
                j['_sysmon'] = None

    return proc.returncode


def merge_files(jid, input_files, output_path):
    """Merge multiple video files into one using ffmpeg concat demuxer.

    Returns (success, error_msg).
    """
    if len(input_files) < 2:
        return True, None  # Nothing to merge

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
        log_line(jid, f'  此阶段不显示进度条, 请耐心等待...')

        cmd = [
            FFMPEG_PATH, '-y',
            '-f', 'concat',
            '-safe', '0',
            '-i', list_path,
            '-map', '0:v:0',        # Only copy first video stream
            '-map', '0:a:0',        # Only copy first audio stream
            '-ignore_unknown',       # Skip unknown streams (GoPro tmcd etc.)
            '-c', 'copy',
            output_path
        ]
        log_line(jid, '  Running ffmpeg concat (stream copy, no re-encode)...')
        rc = run_ffmpeg(cmd, jid, 0)  # No progress tracking for merge
        if rc != 0:
            try: os.remove(output_path)
            except: pass
            return False, f'Merge failed (rc={rc})'
        log_line(jid, '  Merge: OK', 'success')
        return True, None
    finally:
        try: os.remove(list_path)
        except: pass


def convert_one(jid, inp, out, params):
    """Convert a single file."""
    # Test encoding mode: modify output filename and use test duration
    test_dur = params.get('test_duration', 0)
    if test_dur and test_dur > 0:
        # Insert _test before extension
        base, ext = os.path.splitext(out)
        out = base + '_test' + ext
        log_line(jid, f'=== TEST MODE: encoding first {test_dur}s only ===')
        log_line(jid, f'Test output: {out}')

    duration = get_duration(inp)
    log_line(jid, f'Duration: {duration:.1f}s')

    # For progress calculation: use test_duration if in test mode
    progress_duration = min(duration, test_dur) if test_dur and test_dur > 0 else duration

    # ── Stabilization preprocessing (v3.0) ──
    stab_tmp = None
    if params.get('stabilize') and STAB_AVAILABLE:
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
                except: pass
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
                except: pass

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
    codec = params.get('codec', 'libx264')
    cp = CODEC_PROFILES.get(codec, CODEC_PROFILES['libx264'])
    log_line(jid, f'Codec: {cp["label"]}')

    if mode == '2pass' and cp['group'] == 'cpu':
        passlog = os.path.join(os.path.dirname(temp_out), f'.ffpass_{uuid_mod.uuid4().hex[:8]}')
        log_line(jid, '--- Pass 1/2 (analysis) ---')
        cmd1 = build_cmd(inp, temp_out, params, pass_num=1, passlogfile=passlog)
        rc = run_ffmpeg(cmd1, jid, progress_duration, '[P1] ')
        if rc != 0:
            return False, f'Pass 1 failed (rc={rc})', out
        log_line(jid, '--- Pass 2/2 (encode) ---')
        cmd2 = build_cmd(inp, temp_out, params, pass_num=2, passlogfile=passlog)
        rc = run_ffmpeg(cmd2, jid, progress_duration, '[P2] ')
        for f in Path(os.path.dirname(temp_out)).glob(f'{os.path.basename(passlog)}*'):
            try: f.unlink()
            except: pass
        if rc != 0:
            return False, f'Pass 2 failed (rc={rc})', out
    else:
        log_line(jid, '--- Encoding ---')
        cmd = build_cmd(inp, temp_out, params)
        rc = run_ffmpeg(cmd, jid, progress_duration)
        if rc != 0:
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
            except: pass
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
        log_line(jid, f'  Location metadata: {params.get("location_name", "")} ({iso})')

    # Cleanup stabilization temp files (v3.0)
    if stab_tmp:
        try: os.remove(stab_tmp)
        except: pass
    trf = params.pop('_stab_trf', None)
    if trf:
        try: os.remove(trf)
        except: pass

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
            merged_tmp = out + '.merged_tmp' + os.path.splitext(merge_inputs[0])[1]
            mok, merr = merge_files(jid, merge_inputs, merged_tmp)
            if not mok:
                item['done'] = True
                item['ok'] = False
                item['error'] = merr
                item['end_time'] = time.time()
                log_line(jid, f'  {merr}', 'error')
                continue
            inp = merged_tmp
            log_line(jid, f'  merged input: {merged_tmp}')

        # Each task may carry its own export parameters; fall back to job-level defaults
        item_params = dict(item.get('params') or job_params)
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
            except: pass

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

    if need_ffmpeg:
        # Use ffmpeg -c copy to add metadata without re-encoding
        cmd = [FFMPEG_PATH, '-y', '-i', inp]

        # Test mode: limit duration
        if test_dur and test_dur > 0:
            cmd += ['-t', str(test_dur)]

        cmd += ['-c', 'copy']

        # Metadata: creation_time
        if effective_ct and params.get('set_creation_time', True):
            cmd += ['-metadata', f'creation_time={effective_ct}']
            log_line(jid, f'  creation_time={effective_ct}')

        # Metadata: location (ISO 6709)
        if apply_location and params.get('location_lat') and params.get('location_lon'):
            iso6709 = format_location_iso6709(params['location_lat'], params['location_lon'])
            if iso6709:
                cmd += ['-metadata:s:v:0', f'location={iso6709}']
                log_line(jid, f'  location={iso6709} ({params.get("location_name", "")})')

        if params.get('faststart', True):
            cmd += ['-movflags', '+faststart']

        cmd.append(temp_out)
        log_line(jid, '  Running ffmpeg (stream copy, no re-encode)...')
        # Use test_duration for progress if in test mode, otherwise 0 (no progress tracking)
        progress_dur = test_dur if test_dur and test_dur > 0 else 0
        rc = run_ffmpeg(cmd, jid, progress_dur)

        if rc != 0:
            try: os.remove(temp_out)
            except: pass
            return False, f'ffmpeg stream copy failed (rc={rc})', out

        # Inject spherical metadata if needed
        if need_spherical:
            pano_type = params.get('pano_type', '360')
            stereo_mode = params.get('stereo_mode', 'mono')
            log_line(jid, f'  Injecting GSpherical metadata (pano={pano_type}, stereo={stereo_mode})...')
            final_out = temp_out if not replace_original else out + '.spherical_tmp.mp4'
            try:
                ok = inject_uuid(temp_out, final_out, pano_type, stereo_mode)
                if ok:
                    log_line(jid, '  Spherical injection: OK')
                else:
                    log_line(jid, '  Spherical injection: FAILED (non-fatal)', 'warn')
                    import shutil
                    shutil.copy2(temp_out, final_out)
            except Exception as e:
                log_line(jid, f'  Injection error: {e}', 'error')
                import shutil
                shutil.copy2(temp_out, final_out)
            finally:
                if temp_out != final_out:
                    try: os.remove(temp_out)
                    except: pass
        else:
            final_out = temp_out

        # Replace original if needed
        if replace_original:
            try:
                os.replace(final_out, out)
            except Exception as e:
                log_line(jid, f'  Failed to replace original: {e}', 'error')
                return False, str(e), out

    elif need_spherical:
        # Only spherical metadata requested: mirror the single-file conversion
        # container by (re)muxing with ffmpeg stream copy + faststart, then
        # injecting GSpherical — so the output container structure matches exactly.
        pano_type = params.get('pano_type', '360')
        stereo_mode = params.get('stereo_mode', 'mono')
        log_line(jid, f'  Injecting GSpherical metadata (pano={pano_type}, stereo={stereo_mode})...')
        cmd = [FFMPEG_PATH, '-y', '-i', inp, '-c', 'copy']
        if params.get('faststart', True):
            cmd += ['-movflags', '+faststart']
        cmd.append(temp_out)
        log_line(jid, '  Running ffmpeg (stream copy, no re-encode)...')
        rc = run_ffmpeg(cmd, jid, 0)
        if rc != 0:
            try: os.remove(temp_out)
            except Exception: pass
            return False, f'ffmpeg stream copy failed (rc={rc})', out
        final_out = temp_out if not replace_original else out + '.spherical_tmp.mp4'
        try:
            ok = inject_uuid(temp_out, final_out, pano_type, stereo_mode)
            if ok:
                log_line(jid, '  Spherical injection: OK')
            else:
                log_line(jid, '  Spherical injection: FAILED (non-fatal)', 'warn')
                import shutil
                shutil.copy2(temp_out, final_out)
        except Exception as e:
            log_line(jid, f'  Injection error: {e}', 'error')
            import shutil
            shutil.copy2(temp_out, final_out)
        finally:
            if temp_out != final_out:
                try: os.remove(temp_out)
                except Exception: pass
        # Replace original if needed
        if replace_original:
            try:
                os.replace(final_out, out)
            except Exception as e:
                log_line(jid, f'  Failed to replace original: {e}', 'error')
                return False, str(e), out
    else:
        log_line(jid, '  No metadata features enabled', 'warn')
        return False, 'No metadata features enabled', out

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

        item_params = dict(item.get('params') or job_params)
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
        # Build a minimal environment to avoid Windows 64KB env block limit
        # (some environments have 300KB+ of env vars, exceeding the process creation limit)
        env = {}
        for key in ('SystemRoot', 'PATH', 'TEMP', 'TMP', 'USERPROFILE', 'USERNAME',
                     'windir', 'PATHEXT', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE',
                     'PSModulePath', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH',
                     'COMPUTERNAME', 'OS', 'USERDOMAIN'):
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
        ps_filter = '视频文件|*.mp4;*.mov;*.mkv;*.avi;*.webm;*.m4v;*.flv|所有文件|*.*'
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
        ps_filter = '视频文件|*.mp4;*.mov;*.mkv;*.avi;*.webm;*.m4v;*.flv;*.insv;*.ts;*.m2ts|所有文件|*.*'
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
            return pp.value
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
    # Already a normal absolute filesystem path -> verify it resolves
    try:
        if os.path.isabs(p) and not p.startswith('::') and not p.lower().startswith('shell:'):
            if os.path.isdir(p) or os.path.isfile(p) or os.path.exists(p):
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
        elif not os.path.isdir(initial_dir):
            initial_dir = ''

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
        'python': sys.version.split()[0],
        'platform': platform_module.platform(),
    })


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
    """Proxy AMap REST API for fuzzy location search (avoids CORS)."""
    keywords = request.args.get('q', '')
    api_key = request.args.get('key', '')
    city = request.args.get('city', '')

    if not keywords:
        return jsonify({'error': 'Missing query'}), 400
    if not api_key:
        return jsonify({'error': 'Missing AMap API key. Please enter your key in the settings.'}), 400

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
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode('utf-8'))
        return jsonify(data)
    except Exception as e:
        return jsonify({'error': str(e)}), 502


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
        log_line(jid, f'Location: {merged.get("location_name", "")} ({merged.get("location_lat")}, {merged.get("location_lon")})')

    t = threading.Thread(target=conversion_worker, args=(jid,), daemon=True)
    t.start()

    return jsonify({'job_id': jid})


@app.route('/api/apply_metadata', methods=['POST'])
def start_apply_metadata():
    """Apply metadata to video file(s) without re-encoding."""
    data = request.json
    params = data.get('params', {})
    items = data.get('items', [])

    if not items:
        return jsonify({'error': 'No files specified'}), 400

    # Check at least one feature is enabled
    if not (params.get('apply_date') or params.get('apply_location') or params.get('apply_spherical')):
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
    with job_lock:
        j = jobs.get(jid)
        if not j:
            return jsonify({'error': 'Job not found'}), 404
        # Get live sysmon snapshot (from running SysMon object) or final snapshot
        sm_obj = j.get('_sysmon')
        if sm_obj:
            sysmon_data = sm_obj.snapshot()
        else:
            sysmon_data = j.get('sysmon', {})
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
        })


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
        proc = j.get('proc')
    if proc:
        try:
            proc.kill()
        except:
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
        j['items'][idx]['skipped'] = True
    # NOTE: log_line() re-acquires job_lock, so it MUST run OUTSIDE the lock block
    # to avoid a re-entrant deadlock (job_lock is a non-reentrant threading.Lock).
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
    # to avoid a re-entrant deadlock (job_lock is a non-reentrant threading.Lock).
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
    """Save current task list and params to file."""
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
    try:
        Path(TASKS_FILE).write_text(json.dumps(task_data, indent=2, ensure_ascii=False), encoding='utf-8')
        return jsonify({'ok': True, 'saved_at': task_data['saved_at']})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/tasks/load')
def load_tasks():
    """Load saved task list."""
    if not os.path.exists(TASKS_FILE):
        return jsonify({'error': 'No saved tasks'}), 404
    try:
        data = json.loads(Path(TASKS_FILE).read_text(encoding='utf-8'))
        return jsonify(data)
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# ── App Settings ───────────────────────────────────────────────
@app.route('/api/settings', methods=['GET'])
def get_settings():
    defaults = {'auto_load_tasks': False}
    if os.path.exists(SETTINGS_FILE):
        try:
            saved = json.loads(Path(SETTINGS_FILE).read_text(encoding='utf-8'))
            defaults.update(saved)
        except:
            pass
    return jsonify(defaults)


@app.route('/api/settings', methods=['POST'])
def save_settings():
    data = request.json
    try:
        Path(SETTINGS_FILE).write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding='utf-8')
        return jsonify({'ok': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


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
        except:
            time.sleep(0.3)

    # Try pywebview for embedded window
    try:
        import webview
        webview.create_window(
            '360° Video Converter',
            f'http://127.0.0.1:{PORT}',
            width=1280, height=860,
            min_size=(900, 600),
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

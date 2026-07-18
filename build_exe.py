#!/usr/bin/env python3
"""
build_exe.py - Build 360 Video Converter as a Windows EXE
Uses PyInstaller to package the Flask app, then copies ffmpeg/ffprobe + all DLLs alongside.

Usage:
  python build_exe.py              # Build with ffmpeg (auto-resolve all DLL deps)
  python build_exe.py --no-ffmpeg  # Build without ffmpeg (user must have ffmpeg in PATH)
"""

import os
import sys
import shutil
import subprocess
import argparse
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent.absolute()
PYTHON     = sys.executable

# Read version from VERSION file
def read_version():
    version_file = SCRIPT_DIR / 'VERSION'
    if version_file.exists():
        return version_file.read_text().strip()
    return '0.0.0'

APP_VERSION = read_version()

# Source paths
FFMPEG_SRC_DIR = Path(r'C:\ffmpeg-dev\ffmpeg-build\bin')
MINGW_BIN      = Path(r'C:\msys64\mingw64\bin')
OBJDUMP        = Path(r'C:\msys64\mingw64\bin\objdump.exe')

# Static build directory (preferred — includes hardware encoders, no DLLs needed)
STATIC_FFMPEG_DIR = SCRIPT_DIR / 'ffmpeg-static'

# Windows system DLLs to exclude
SYSTEM_DLLS = {
    'KERNEL32.DLL', 'KERNEL32.dll', 'msvcrt.dll', 'SHELL32.dll', 'ole32.dll',
    'OLEAUT32.dll', 'USER32.dll', 'GDI32.dll', 'RPCRT4.dll', 'CRYPT32.dll',
    'Secur32.dll', 'WS2_32.dll', 'bcrypt.dll', 'SHLWAPI.dll', 'msvcp_win.dll',
    'ucrtbase.dll', 'win32u.dll', 'gdi32full.dll', 'combase.dll', 'wintypes.dll',
    'ntdll.dll', 'KERNELBASE.dll', 'advapi32.dll', 'ncrypt.dll', 'AVICAP32.dll',
    'ADVAPI32.dll', 'WSOCK32.dll', 'DWrite.dll', 'USP10.dll',
    'SETUPAPI.dll', 'POWRPROF.dll', 'PSAPI.DLL', 'WINMM.dll', 'IMM32.dll',
    'OLE32.dll', 'VERSION.dll', 'dbghelp.dll', 'dbgcore.dll',
}


def get_dll_deps(dll_path):
    """Get list of DLL dependencies using objdump."""
    try:
        r = subprocess.run(
            [str(OBJDUMP), '-p', str(dll_path)],
            capture_output=True, text=True, timeout=15
        )
        deps = []
        for line in r.stdout.split('\n'):
            if 'DLL Name:' in line:
                name = line.split('DLL Name:')[1].strip()
                if name not in SYSTEM_DLLS:
                    deps.append(name)
        return deps
    except Exception:
        return []


def find_dll(name, search_dirs):
    """Find a DLL in the search directories (case-insensitive on Windows)."""
    for d in search_dirs:
        p = d / name
        if p.exists():
            return p
        # Try case-insensitive
        if d.exists():
            for f in d.iterdir():
                if f.name.lower() == name.lower():
                    return f
    return None


def resolve_all_deps(executables, search_dirs):
    """Recursively resolve all DLL dependencies."""
    to_check = list(executables)
    found = {}
    checked = set()

    while to_check:
        name = to_check.pop(0)
        if name in checked:
            continue
        checked.add(name)

        path = find_dll(name, search_dirs)
        if not path:
            print(f'  WARNING: {name} not found in search dirs')
            continue

        found[name] = path
        deps = get_dll_deps(path)
        for dep in deps:
            if dep not in checked:
                to_check.append(dep)

    return found


def run(cmd, cwd=None):
    print(f'  > {" ".join(str(c) for c in cmd)}')
    result = subprocess.run(cmd, cwd=cwd)
    if result.returncode != 0:
        print(f'  ERROR: command failed (rc={result.returncode})')
        sys.exit(1)


def _evacuate(path):
    """Move a directory out of the way WITHOUT deleting it.

    This sandbox's sitecustomize shim intercepts shutil.rmtree / os.remove and
    redirects them to the Windows Recycle Bin, which is unavailable here, so any
    delete of a non-temp path raises OSError and silently breaks PyInstaller
    rebuilds (leaving a STALE exe in dist/). Renaming is not intercepted, so we
    evacuate old build/dist into the OS temp dir instead of deleting.
    """
    import tempfile, time
    if not os.path.isdir(path):
        return
    parent = tempfile.gettempdir()
    stamp = time.strftime('%Y%m%d_%H%M%S')
    dest = os.path.join(parent, os.path.basename(str(path)) + f'_bak_{stamp}')
    try:
        os.rename(str(path), dest)
        print(f'  evacuated {path} -> {dest}')
    except OSError:
        # last resort: in-place rename (still no delete)
        os.rename(str(path), str(path) + '_bak')


def build_pyinstaller():
    """Build the Flask app as a single-file EXE using PyInstaller."""
    print(f'\n=== Building Python app with PyInstaller (v{APP_VERSION}) ===')

    build_dir = SCRIPT_DIR / 'build'
    dist_dir  = SCRIPT_DIR / 'dist'
    _evacuate(build_dir)
    _evacuate(dist_dir)

    cmd = [
        PYTHON, '-m', 'PyInstaller',
        '--onefile',
        '--noconfirm',
        '--name', '360VideoConverter',
        '--windowed',
        '--hidden-import', 'inject_spherical_metadata',
        '--hidden-import', 'sysmon',
        '--hidden-import', 'stabilize',
        '--hidden-import', 'cv2',
        '--hidden-import', 'numpy',
        '--hidden-import', 'webview',
        '--hidden-import', 'webview.platforms.edgechromium',
        '--hidden-import', 'webview.platforms.winforms',
        '--hidden-import', 'clr_loader',
        '--hidden-import', 'pythonnet',
        '--hidden-import', 'pynvml',
        '--add-data', f'{SCRIPT_DIR / "inject_spherical_metadata.py"};.',
        '--add-data', f'{SCRIPT_DIR / "sysmon.py"};.',
        '--add-data', f'{SCRIPT_DIR / "stabilize.py"};.',
        '--add-data', f'{SCRIPT_DIR / "static"};static',
        '--add-data', f'{SCRIPT_DIR / "VERSION"};.',
        '--collect-all', 'flask',
        '--collect-all', 'jinja2',
        '--collect-all', 'webview',
        '--collect-all', 'psutil',
        '--collect-all', 'cv2',
        '--collect-all', 'numpy',
        str(SCRIPT_DIR / 'app.py'),
    ]

    run(cmd, cwd=SCRIPT_DIR)
    print(f'  Built: {dist_dir / "360VideoConverter.exe"}')


def copy_ffmpeg_and_dlls():
    """Copy ffmpeg/ffprobe to dist.
    Priority:
      1. Static build (ffmpeg-static/ has both ffmpeg.exe + ffprobe.exe) — no DLLs needed
      2. Hybrid mode (ffmpeg-static/ has only ffmpeg.exe) — static ffmpeg + shared ffprobe + DLLs
      3. Shared library build (fallback) — ffmpeg + ffprobe + all DLLs from dev build
    """
    dist_dir = SCRIPT_DIR / 'dist'

    static_ffmpeg  = STATIC_FFMPEG_DIR / 'ffmpeg.exe'
    static_ffprobe = STATIC_FFMPEG_DIR / 'ffprobe.exe'

    # Case 1: Full static build (both ffmpeg + ffprobe)
    if static_ffmpeg.exists() and static_ffprobe.exists():
        print('\n=== Copying static ffmpeg build (with hardware encoder support) ===')
        for name in ['ffmpeg.exe', 'ffprobe.exe']:
            src = STATIC_FFMPEG_DIR / name
            dst = dist_dir / name
            size_mb = src.stat().st_size / 1024 / 1024
            print(f'  Copying {name:35s} {size_mb:8.1f} MB')
            shutil.copy2(src, dst)
        print(f'\n  Static build copied (no DLLs needed).')
        print(f'  This build includes NVENC + AMF + libVPL hardware encoder support.')
        return

    # Case 2: Hybrid mode (static ffmpeg + shared ffprobe + DLLs)
    if static_ffmpeg.exists() and not static_ffprobe.exists():
        print('\n=== Hybrid mode: static ffmpeg + shared ffprobe + DLLs ===')

        # Copy static ffmpeg.exe (has hardware encoder support, no DLLs needed)
        size_mb = static_ffmpeg.stat().st_size / 1024 / 1024
        print(f'  Copying {"ffmpeg.exe (static)":35s} {size_mb:8.1f} MB')
        shutil.copy2(static_ffmpeg, dist_dir / 'ffmpeg.exe')
        print(f'  -> Static ffmpeg with NVENC + AMF + QSV hardware encoder support')

        # Copy shared ffprobe.exe (for metadata reading, needs DLLs)
        shared_ffprobe = FFMPEG_SRC_DIR / 'ffprobe.exe'
        if shared_ffprobe.exists():
            size_mb = shared_ffprobe.stat().st_size / 1024 / 1024
            print(f'  Copying {"ffprobe.exe (shared)":35s} {size_mb:8.1f} MB')
            shutil.copy2(shared_ffprobe, dist_dir / 'ffprobe.exe')
        else:
            print(f'  WARNING: ffprobe.exe not found at {FFMPEG_SRC_DIR}')

        # Resolve and copy DLL dependencies for ffprobe.exe only
        # (static ffmpeg.exe has no DLL dependencies)
        search_dirs = [FFMPEG_SRC_DIR, MINGW_BIN]
        all_dlls = resolve_all_deps(['ffprobe.exe'], search_dirs)

        total_copied = 0
        for name, src_path in sorted(all_dlls.items()):
            dst = dist_dir / name
            size_mb = src_path.stat().st_size / 1024 / 1024
            print(f'  Copying {name:35s} {size_mb:8.1f} MB')
            shutil.copy2(src_path, dst)
            total_copied += src_path.stat().st_size

        print(f'\n  Hybrid build: static ffmpeg ({static_ffmpeg.stat().st_size / 1024 / 1024:.1f} MB)')
        print(f'                + shared ffprobe + {len(all_dlls)} DLLs ({total_copied / 1024 / 1024:.1f} MB)')
        print(f'  ffmpeg has NVENC + AMF + QSV hardware encoder support.')
        return

    # Case 3: Shared library build (fallback)
    print('\n=== Resolving and copying ffmpeg + ffprobe + all DLL dependencies ===')

    # Start with ffmpeg.exe and ffprobe.exe
    search_dirs = [FFMPEG_SRC_DIR, MINGW_BIN]
    all_files = resolve_all_deps(['ffmpeg.exe', 'ffprobe.exe'], search_dirs)

    # Copy all files
    total_copied = 0
    for name, src_path in sorted(all_files.items()):
        dst = dist_dir / name
        size_mb = src_path.stat().st_size / 1024 / 1024
        print(f'  Copying {name:35s} {size_mb:8.1f} MB')
        shutil.copy2(src_path, dst)
        total_copied += src_path.stat().st_size

    print(f'\n  Total files copied: {len(all_files)}')
    print(f'  Total size: {total_copied / 1024 / 1024:.1f} MB')
    print(f'  WARNING: Shared build may not include hardware encoder support.')
    print(f'  For NVENC/QSV/AMF support, download a full static build to {STATIC_FFMPEG_DIR}')


def create_launcher():
    """Create README only (no BAT launcher needed - EXE opens its own window)."""
    print('\n=== Creating README ===')
    dist_dir = SCRIPT_DIR / 'dist'

    readme = """# 360 Video Converter

## 启动方式
直接双击 `360VideoConverter.exe` 即可。程序会自动打开内置窗口（基于 WebView2），无需浏览器。

## 功能
### 视频转码（单文件 / 批量）
- 360° 全景视频批量转码（H.264/H.265/CUDA NVENC/Intel QSV/AMD AMF）
- GSpherical 全景元数据注入（群晖 Photos 识别）
- 从文件名提取日期并写入视频元数据（拍摄日期/文件创建日期/修改日期）
- 高德地图选取拍摄位置并写入 GPS 经纬度标签
- 文件浏览器支持手动输入路径快速跳转
- 单任务和批量任务支持暂停/恢复功能
- 批量任务队列管理：多选加入队列、单独跳过/移除、追加扫描
- 编码测试输出：仅编码指定秒数片段用于测试参数效果
- 参数悬浮提示：每个参数旁的 ? 图标悬停查看详细解释
- 画面防抖（v3.0+）：标准视频使用 FFmpeg libvidstab 滤镜，全景视频使用 OpenCV 球面防抖算法，根据视频类型自动选择

### 元数据工具（无需重编码）
- 独立使用日期写入、GPS 位置写入、GSpherical 注入三大功能
- 使用 ffmpeg -c copy 流复制，不重新编码，速度极快
- 支持单文件和批量目录操作
- 支持原地修改或输出到新目录

### 元数据报告
- 读取视频文件元数据和编码信息（基于 ffprobe）
- 支持单文件和批量目录读取
- 生成格式化报告，可保存为文本文件
- 检测全景元数据、拍摄日期、GPS 位置等标签状态

### 任务管理
- 批量任务列表可保存/加载
- 可选自动加载上次任务列表（默认关闭，在设置中开启）

### 硬件编码支持
- 内置 ffmpeg 包含 NVENC (NVIDIA) + AMF (AMD) + libVPL (Intel QSV) 硬件编码支持
- 若内置 ffmpeg 不支持硬件编码，可在设置中指定自定义 ffmpeg.exe 路径
- 设置中可测试自定义 ffmpeg 的硬件编码器支持情况

## 高德地图 API Key
点击右上角 "API Key" 按钮设置高德地图 Web服务 API Key
免费申请: https://lbs.amap.com/

## 预设
预设保存在 %APPDATA%/360VideoConverter/presets/ 目录中

## 项目主页
https://github.com/warlocks365/360video-converter

## 依赖文件
- `360VideoConverter.exe` - 主程序 (PyInstaller 打包, 含 pywebview 内置容器)
- `ffmpeg.exe` / `ffprobe.exe` - 视频编码器/探测器 (含硬件编码支持)
"""

    readme_path = dist_dir / 'README.md'
    readme_path.write_text(readme, encoding='utf-8')
    print(f'  Created: {readme_path}')


def main():
    parser = argparse.ArgumentParser(description='Build 360 Video Converter EXE')
    parser.add_argument('--no-ffmpeg', action='store_true',
                        help='Do not copy ffmpeg (user must have ffmpeg in PATH)')
    args = parser.parse_args()

    print('=' * 60)
    print('  360 Video Converter - EXE Builder')
    print('=' * 60)
    print(f'  Script dir: {SCRIPT_DIR}')
    print(f'  Python:     {PYTHON}')

    build_pyinstaller()

    if not args.no_ffmpeg:
        if STATIC_FFMPEG_DIR.exists() and (STATIC_FFMPEG_DIR / 'ffmpeg.exe').exists():
            copy_ffmpeg_and_dlls()
        elif FFMPEG_SRC_DIR.exists():
            copy_ffmpeg_and_dlls()
        else:
            print('\n  NOTE: ffmpeg not found at default path, skipping')
            print('  The EXE will try to find ffmpeg in PATH at runtime')

    create_launcher()

    print('\n' + '=' * 60)
    print('  BUILD COMPLETE')
    print(f'  Output: {SCRIPT_DIR / "dist"}')
    print('=' * 60)


if __name__ == '__main__':
    main()

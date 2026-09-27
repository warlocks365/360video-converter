"""直接观测 v2：等主窗口出现后再高速采样，捕获任何新弹出的窗口。

修正上一版的问题：
  - proc_name 每个窗口都跑一次 tasklist → 采样太慢（25s 只采了 4 次）
  - 程序 onefile 解包 + WebView2 初始化约需 20s，上一版在主窗口出现前就把观测时间耗完了

本版：
  1. 先启动程序，轮询等待主窗口出现（最长 60s）
  2. 缓存 pid→进程名（只在遇到新 pid 时查一次 tasklist）
  3. 主窗口出现后，以 200ms 间隔高速采样 20s
  4. 只报告【主窗口出现之后】新出现的窗口，并区分"是否属于本进程"
"""
import ctypes
import os
import subprocess
import sys
import time
from collections import OrderedDict

user32 = ctypes.windll.user32

EXE = r'C:\Program Files\360video-converter\360VideoConverter.exe'
if not os.path.exists(EXE):
    EXE = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'dist', '360VideoConverter.exe'))
if not os.path.exists(EXE):
    print('未找到 360VideoConverter.exe'); sys.exit(1)

OBSERVE_SEC = 20
SAMPLE_MS = 200

subprocess.run(['taskkill', '/F', '/IM', '360VideoConverter.exe', '/T'], capture_output=True)
time.sleep(1.0)

proc = subprocess.Popen([EXE], creationflags=subprocess.CREATE_NO_WINDOW)
print(f'已启动 {EXE} (pid={proc.pid})')

_pid_name_cache = {}
def proc_name(pid):
    if pid in _pid_name_cache:
        return _pid_name_cache[pid]
    name = '?'
    try:
        out = subprocess.run(['tasklist', '/FI', f'PID eq {pid}', '/FO', 'CSV', '/NH'],
                             capture_output=True, text=True, timeout=4).stdout
        for line in out.splitlines():
            parts = [p.strip('"') for p in line.split('","')]
            if parts and parts[0]:
                name = parts[0]; break
    except Exception:
        pass
    _pid_name_cache[pid] = name
    return name


def enumerate_visible():
    result = OrderedDict()
    proto = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)
    def cb(hwnd, _):
        if user32.IsWindowVisible(hwnd):
            n = user32.GetWindowTextLengthW(hwnd)
            buf = ctypes.create_unicode_buffer(n + 1)
            user32.GetWindowTextW(hwnd, buf, n + 1)
            cls = ctypes.create_unicode_buffer(256)
            user32.GetClassNameW(hwnd, cls, 256)
            pid = ctypes.c_ulong()
            user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
            result[hwnd] = (buf.value.strip(), cls.value, proc_name(pid.value))
        return True
    user32.EnumWindows(proto(cb), None)
    return result


# ── 阶段 1：等主窗口出现 ──
print('等待主窗口出现（最长 60s）…')
t0 = time.time()
main_hwnd = None
while time.time() - t0 < 60:
    for hwnd, (title, cls, pn) in enumerate_visible().items():
        if pn == '360VideoConverter.exe' and '360' in title:
            main_hwnd = hwnd
            break
    if main_hwnd:
        break
    time.sleep(0.5)

if not main_hwnd:
    print('✗ 60s 内主窗口未出现'); proc.kill(); sys.exit(1)
print(f'✓ 主窗口已出现（{time.time()-t0:.1f}s，hwnd={main_hwnd:#x}）\n')

# ── 阶段 2：高速采样 ──
print(f'开始观测 {OBSERVE_SEC}s，每 {SAMPLE_MS}ms 采样一次…')
t1 = time.time()
prev = enumerate_visible()
new_events = []          # (t, title, cls, pname, hwnd)
samples = 0
while time.time() - t1 < OBSERVE_SEC:
    cur = enumerate_visible()
    samples += 1
    for hwnd, info in cur.items():
        if hwnd not in prev:
            new_events.append((round(time.time() - t1, 2), *info, hwnd))
    prev = cur
    time.sleep(SAMPLE_MS / 1000.0)

print(f'采样 {samples} 次\n')
own = [e for e in new_events if e[3] == '360VideoConverter.exe']
other = [e for e in new_events if e[3] != '360VideoConverter.exe']

print('=== 本进程新出现的窗口（可能是闪现的子窗口/弹窗）===')
if not own:
    print('  （无）')
seen = set()
for t, title, cls, pn, hwnd in own:
    key = (title, cls)
    tag = '(重复出现)' if key in seen else '首次'
    seen.add(key)
    print(f"  [{t:>6}s] {tag}  标题='{title[:44]}'  类名={cls}")

print()
print('=== 其他进程新出现的窗口（可能是系统噪音）===')
if not other:
    print('  （无）')
seen2 = set()
for t, title, cls, pn, hwnd in other:
    key = (title, cls, pn)
    tag = '(重复出现)' if key in seen2 else '首次'
    seen2.add(key)
    print(f"  [{t:>6}s] {tag}  标题='{title[:40]}'  类名={cls}  进程={pn}")

print()
print('=== 结论 ===')
if own:
    freq = len(own) / OBSERVE_SEC
    print(f'  ✗ 观测到本进程新窗口 {len(own)} 次（{freq:.1f} 次/秒）—— 与"频繁弹出"吻合')
    print('    类名分布:', sorted({c for (_, _, c, _, _) in own}))
else:
    print('  ✓ 主窗口出现后 20s 内，本进程未弹出任何新窗口')
    print('    → "闪烁"不是真实窗口，应转向渲染层（CSS/重绘）排查')
try:
    proc.kill()
except Exception:
    pass

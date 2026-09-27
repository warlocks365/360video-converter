"""探测 sysmon 子进程窗口闪烁的触发条件（只读检查，不启动任何外部程序）。

判定逻辑：
  sysmon.py 的 GPU 采样有两条路径：
    A. pynvml（库调用，无子进程，不会弹窗）
    B. nvidia-smi 子进程（**缺 CREATE_NO_WINDOW**，节流 1s/次 → 若启用则每秒闪一个控制台窗口）
  只有当 A 不可用且 B 可用时，才会走上 B 路径。
  因此只需确认：本机 pynvml 是否可用、nvidia-smi.exe 是否存在。
"""
import os
import sys

print('=== nvidia-smi.exe 是否存在（sysmon 的探测候选路径）===')
windir = os.getenv('WINDIR', r'C:\Windows')
progfiles = os.getenv('ProgramFiles', r'C:\Program Files')
cands = [
    os.path.join(windir, 'System32', 'nvidia-smi.exe'),
    os.path.join(progfiles, 'NVIDIA Corporation', 'NVSMI', 'nvidia-smi.exe'),
    r'C:\Windows\SysWOW64\nvidia-smi.exe',
]
found = None
for c in cands:
    e = os.path.exists(c)
    print(f"  {'存在 ✗' if e else '无   '}  {c}")
    if e and not found:
        found = c

print()
print('=== PATH 中是否有 nvidia-smi ===')
hits = []
for d in os.getenv('PATH', '').split(os.pathsep):
    if not d:
        continue
    p = os.path.join(d, 'nvidia-smi.exe')
    if os.path.exists(p):
        hits.append(p)
print('  找到: ' + ('; '.join(hits) if hits else '无'))
if hits and not found:
    found = hits[0]

print()
print('=== pynvml 可用性（决定是否走子进程路径）===')
try:
    import pynvml  # noqa
    pynvml.nvmlInit()
    n = pynvml.nvmlDeviceGetCount()
    print(f'  pynvml 可用，设备数 = {n}')
    pynvml_ok = True
except Exception as e:  # noqa
    print(f'  pynvml 不可用: {type(e).__name__}: {str(e)[:140]}')
    pynvml_ok = False

print()
print('=== 结论 ===')
if pynvml_ok:
    print('  pynvml 可用 → GPU 采样走库调用，**不会**启动子进程 → sysmon 不是闪烁来源')
elif found:
    print(f'  pynvml 不可用 且 nvidia-smi 存在（{found}）')
    print('  → sysmon 每 1 秒经 subprocess 采样一次，且该调用【缺 CREATE_NO_WINDOW】')
    print('  → **每秒弹出一个控制台窗口**，与「频繁弹出未知窗口的闪烁」完全吻合 ✗')
else:
    print('  pynvml 不可用 且 nvidia-smi 不存在 → GPU 采样两条路径都不可用')
    print('  → sysmon 不会频繁启动子进程 → 需另找闪烁来源')

"""sysmon GPU 采样解析冒烟测试：模拟 nvidia-smi 的各种输出（含 GeForce 的 [N/A]）。

背景：nvidia-smi 的 `utilization.memory` 仅在 Quadro/Tesla 上支持，GeForce 返回
"[N/A]"；旧实现用裸 int() 解析全部字段，一个 "[N/A]" 就让整个采样抛异常，
导致 RTX 3090 等消费卡的 GPU 利用率永远显示 N/A。

本测试通过 monkeypatch subprocess.run 模拟 nvidia-smi 输出，验证：
  1. GeForce 典型输出（encoder 字段为 [N/A]）→ 其余字段正常解析，显存占用率由
     used/total 计算
  2. 全字段 [N/A] → 不崩、不写脏数据
  3. 正常输出 → 全字段解析
  4. 非零返回码 → 走缓存回退
"""
import sys
import types

sys.path.insert(0, '.')
import sysmon  # noqa: E402

# 找到 SysMon 类（不执行 __init__，避免启动监控线程）
CLS = next(getattr(sysmon, n) for n in dir(sysmon)
           if isinstance(getattr(sysmon, n), type) and hasattr(getattr(sysmon, n), '_sample_gpu_nvidia_smi'))


def make_sm():
    sm = CLS.__new__(CLS)                 # 跳过 __init__（不启动线程）
    sm._nvidia_smi_path = 'fake-smi'
    sm._smi_cache = None
    sm._smi_last_ts = 0
    return sm


def run_case(stdout, returncode=0):
    sm = make_sm()
    fake = types.SimpleNamespace(returncode=returncode, stdout=stdout, stderr='')
    orig = sysmon.subprocess.run
    sysmon.subprocess.run = lambda *a, **k: fake
    try:
        data = {}
        sm._sample_gpu_nvidia_smi(data)
        return data, sm._smi_cache
    finally:
        sysmon.subprocess.run = orig


results = []
def check(name, cond, detail=''):
    results.append((name, bool(cond), detail))


# ── 用例 1：GeForce RTX 3090 典型输出（encoder 为 [N/A]）──
data, cache = run_case('35, 24576, 10240, 45, [N/A]\n')
check('GeForce 输出：gpu_percent 正常解析', data.get('gpu_percent') == 35, str(data))
check('GeForce 输出：显存占用率由 used/total 计算 ≈42%',
      data.get('gpu_mem_percent') == 42, f"got {data.get('gpu_mem_percent')}")
check('GeForce 输出：温度正常', data.get('gpu_temp') == 45)
check('GeForce 输出：encoder 为 [N/A] 时跳过且不崩', 'gpu_enc_percent' not in data)
check('GeForce 输出：不再包含已废弃的 gpu_mem_percent 旧来源错误', data.get('gpu_mem_total_mb') == 24576)

# ── 用例 2：全字段 [N/A]（极端情况）──
data2, cache2 = run_case('[N/A], [N/A], [N/A], [N/A], [N/A]\n')
check('全 [N/A]：不崩且不写脏数据', data2 == {} and cache2 in (None, {}), f'data={data2}')

# ── 用例 3：正常输出（含 encoder）──
data3, _ = run_case('80, 24576, 20000, 70, 65\n')
check('正常输出：全字段解析', data3.get('gpu_percent') == 80 and data3.get('gpu_enc_percent') == 65
      and data3.get('gpu_mem_percent') == 81, str(data3))   # 20000/24576=81.38% → 81

# ── 用例 4：非零返回码 → 缓存回退 ──
sm4 = make_sm()
sm4._smi_cache = {'gpu_percent': 50}
fake4 = types.SimpleNamespace(returncode=1, stdout='', stderr='err')
orig = sysmon.subprocess.run
sysmon.subprocess.run = lambda *a, **k: fake4
try:
    d4 = {}
    sm4._sample_gpu_nvidia_smi(d4)
finally:
    sysmon.subprocess.run = orig
check('非零返回码：回退到上次缓存', d4.get('gpu_percent') == 50, str(d4))

# ── 用例 5：截断输出（字段不足）──
data5, _ = run_case('35\n')
check('字段不足：只解析存在的字段且不崩', data5.get('gpu_percent') == 35
      and 'gpu_temp' not in data5, str(data5))

failed = [r for r in results if not r[1]]
print('sysmon GPU 采样解析冒烟测试')
print('=' * 50)
for name, ok, detail in results:
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f'   → {detail}' if detail else ''))
print('=' * 50)
print(f"全部通过: {len(results) - len(failed)}/{len(results)}")
sys.exit(1 if failed else 0)

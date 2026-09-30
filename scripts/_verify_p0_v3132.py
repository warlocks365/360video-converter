# -*- coding: utf-8 -*-
"""v3.13.2 P0 修复动态验证（对应 CODE_REVIEW_v3.13.1 P0-1/P0-2/P0-3）。

验证方式均为"真实产物"级：
  P0-1  无音轨源 concat 合并（修复后的 -map 0:a:0?）真实 ffmpeg 运行 + 旧写法对照
  P0-2  build_vr3d_cmd 非 original 分辨率产物真实 ffmpeg 运行（双布局）
  P0-3  apply_metadata_one 球面注入 + 输出新目录（原 P0 场景）+ 原地覆盖回归
用法：python scripts/_verify_p0_v3132.py   （退出码 0 = 全过）
"""
import os, sys, subprocess, shutil, tempfile, glob

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(BASE)
sys.path.insert(0, BASE)

import app  # __main__ 守卫：import 不启动 Flask/窗口

RESULTS = []
def check(name, cond, detail=''):
    RESULTS.append((name, bool(cond), detail))
    print(('OK  ' if cond else 'FAIL') + ' ' + name + (('  -> ' + str(detail)) if detail else ''))

FF = app.FFMPEG_PATH
# 样本优先取仓库内 test_videos/，回退工作区根的 test_videos/（迁移后实际所在位置）
TV = os.path.join(BASE, 'test_videos')
vids = sorted(glob.glob(os.path.join(TV, '*.mp4')))
if not vids:
    TV = os.path.dirname(BASE)
    vids = sorted(glob.glob(os.path.join(TV, 'test_videos', '*.mp4')))
if not vids:
    print('FAIL: test_videos 下没有样本'); sys.exit(1)
src = vids[0]
tmp = tempfile.mkdtemp(prefix='p0v3132_')
app.jobs['jt'] = {'log': [], 'status': 'running', 'paused': False, 'proc': None}  # 供 log_line/check_pause 使用

# 造一个确定的"无音轨"0.5s 样本（不依赖审查样本的音轨状态）
noaudio = os.path.join(tmp, 'noaudio.mp4')
r = subprocess.run([FF, '-y', '-i', src, '-t', '0.5', '-an',
                    '-c:v', 'libx264', '-preset', 'ultrafast', noaudio],
                   capture_output=True, text=True)
check('准备：无音轨样本生成', r.returncode == 0 and os.path.isfile(noaudio),
      (r.stderr or '')[-160:] if r.returncode != 0 else 'ok')

# ── P0-1 ─────────────────────────────────────────────
list_path = os.path.join(tmp, 'list.txt')
with open(list_path, 'w', encoding='utf-8') as f:
    f.write(f"file '{noaudio.replace(os.sep, '/')}'\n")
    f.write(f"file '{noaudio.replace(os.sep, '/')}'\n")
merge_out = os.path.join(tmp, 'merged.mkv')
cmd = [FF, '-y', '-err_detect', 'ignore_err', '-fflags', '+discardcorrupt',
       '-f', 'concat', '-safe', '0', '-i', list_path,
       '-map', '0:v:0', '-map', '0:a:0?', '-ignore_unknown', '-c', 'copy', merge_out]
rc = subprocess.run(cmd, capture_output=True, text=True).returncode
check('P0-1: 无音轨源合并（-map 0:a:0?）成功', rc == 0 and os.path.isfile(merge_out), f'rc={rc}')

merge_out_bad = os.path.join(tmp, 'merged_bad.mkv')
cmd_bad = [c if c != '0:a:0?' else '0:a:0' for c in cmd[:-1]] + [merge_out_bad]
r_bad = subprocess.run(cmd_bad, capture_output=True, text=True)
check('P0-1: 旧写法（无 ?）确实失败（对照，证明测试有效）', r_bad.returncode != 0,
      f"rc={r_bad.returncode}")

# ── P0-2 ─────────────────────────────────────────────
for layout in ('top-bottom', 'side-by-side'):
    params = {'codec': 'libx264', 'resolution': '4096x2048', 'vr3d_layout': layout}
    c = app.build_vr3d_cmd(src, src, os.path.join(tmp, f'vr3d_{layout}.mp4'), params)
    fc = c[c.index('-filter_complex') + 1]
    expect = f'[0:v][1:v]{"vstack" if layout == "top-bottom" else "hstack"}=inputs=2[stk];[stk]scale=4096:2048:flags=lanczos,setsar=1[v]'
    check(f'P0-2: {layout} filter_complex 结构', fc == expect, fc)
    out_p = c[-1]
    r = subprocess.run(c[:-1] + ['-t', '0.3', out_p], capture_output=True, text=True)
    check(f'P0-2: {layout} 真实 ffmpeg 运行成功（0.3s）', r.returncode == 0 and os.path.isfile(out_p),
          (r.stderr or '')[-200:] if r.returncode != 0 else 'ok')

# ── P0-3 ─────────────────────────────────────────────
new_dir = os.path.join(tmp, 'newdir')
params = {'apply_date': False, 'apply_location': False, 'apply_spherical': True,
          'pano_type': '360', 'stereo_mode': 'mono', 'faststart': True,
          'test_duration': 0}
out_new = os.path.join(new_dir, 'meta_spherical.mp4')
ok, err, actual = app.apply_metadata_one('jt', src, out_new, params)
has_box = False
if ok and os.path.isfile(out_new):
    with open(out_new, 'rb') as f:
        has_box = b'GSpherical' in f.read(2 * 1024 * 1024)
check('P0-3: 元数据+球面注入+输出到新目录（原 P0 场景）成功',
      ok is True and os.path.isfile(out_new), f'ok={ok} err={err}')
check('P0-3: 产物含 GSpherical 球面盒子', has_box)
check('P0-3: 无 .spherical_tmp.mp4 残留', not os.path.exists(out_new + '.spherical_tmp.mp4'))

inplace = os.path.join(tmp, 'inplace.mp4')
shutil.copy(src, inplace)
ok2, err2, _ = app.apply_metadata_one('jt', inplace, inplace, params)
check('P0-3: 原地覆盖 + 球面注入（回归不劣化）', ok2 is True and os.path.isfile(inplace),
      f'ok={ok2} err={err2}')

shutil.rmtree(tmp, ignore_errors=True)
failed = [r for r in RESULTS if not r[1]]
print(f"\n合计 {len(RESULTS)} 项，通过 {len(RESULTS) - len(failed)}，失败 {len(failed)}")
sys.exit(1 if failed else 0)

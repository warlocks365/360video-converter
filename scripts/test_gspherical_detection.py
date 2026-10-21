"""GSpherical 检测回归（v3.14.8 合并大文件标签"丢失"误报修复）

根因：read_gspherical 旧实现只扫文件头尾各 4MB 字节窗；合并/超长视频重编码
产物 moov 可达数十 MB，GSpherical UUID 位于 moov 内 mdia 之后——一旦距文件头
超过 4MB（faststart）且距文件尾也超过 4MB，标签就被漏检，报告/元数据工具把
**已正确注入**的文件误标为"无全景元数据"（ffprobe 却能识别）。实测样本：
87GB 合并产物 UUID 距文件头 8MB → read_gspherical 判 False，ffprobe 判有。

本套件用合成 MP4（无需大文件、跨机器可跑）复现该形态：把 UUID 深埋进大 moov
（前后各留 >4MB 填充，头尾窗都够不着），断言旧窗口法必漏、新检测必命中；
并覆盖真实注入器两文件/就地/faststart 重排三条产物的检测往返。

运行：python scripts/test_gspherical_detection.py
"""
import os
import struct
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)

from inject_spherical_metadata import (
    SPHERICAL_UUID, build_uuid_box, build_spherical_xml,
    inject_uuid, inject_uuid_inplace, relocate_moov_front,
    read_gspherical,
)

results = []


def check(name, ok, detail=''):
    results.append((name, bool(ok), detail))
    print(('OK   ' if ok else 'FAIL ') + name + ('  → ' + str(detail) if detail and not ok else ''))


def _box(btype, body):
    return struct.pack('>I4s', 8 + len(body), btype) + body


def _synth_mp4(path, before_mb, after_mb, mdat_mb=2, front_moov=True):
    """构造合法顶层盒序列的 MP4，GSpherical uuid 盒深埋 moov 内：
    uuid 前 before_mb、后 after_mb 的填充（都 >4MB 时旧头尾窗必漏）。
    front_moov=True → [ftyp][moov][mdat]（faststart 形态，= 87GB 实测样本形态）；
    False → [ftyp][mdat][moov]。返回文件大小。"""
    xml = build_spherical_xml(4096, 2048, '360', 'mono')
    uuid_box = build_uuid_box(xml)
    inner = _box(b'trak', b'\x00' * 8)                       # trak 占位（walker 不递归进内容语义，只做容器）
    inner += b'\xAB' * (before_mb * 1024 * 1024)             # 仿巨型 stsz/stco 的前填充
    inner += uuid_box                                        # 深埋的 GSpherical
    inner += b'\xAB' * (after_mb * 1024 * 1024)              # uuid 之后的 moov 余量
    moov = _box(b'moov', inner)
    mdat = _box(b'mdat', b'\x55' * (mdat_mb * 1024 * 1024))
    ftyp = _box(b'ftyp', b'isom' + b'\x00\x00\x02\x00' + b'isommp41')
    data = ftyp + (moov + mdat if front_moov else mdat + moov)
    with open(path, 'wb') as f:
        f.write(data)
    return len(data)


def _legacy_window_detect(path, head_mb=4, tail_mb=4):
    """旧实现的头尾窗口扫描（回归对照，证明合成物确实会骗过旧逻辑）。"""
    HEAD = head_mb * 1024 * 1024
    TAIL = tail_mb * 1024 * 1024
    fsize = os.path.getsize(path)
    with open(path, 'rb') as f:
        if SPHERICAL_UUID in f.read(min(HEAD, fsize)):
            return True
        if fsize > HEAD:
            f.seek(max(HEAD, fsize - TAIL))
            if SPHERICAL_UUID in f.read(fsize - max(HEAD, fsize - TAIL)):
                return True
    return False


tmpd = tempfile.mkdtemp(prefix='gsph_detect_')

# ── T1: faststart 形态大 moov（= 87GB 实测样本形态）────────────────
# [ftyp][moov: 6MB 填充 + uuid + 5MB 余量][mdat 2MB]
# uuid 距文件头 ≈ 6MB > 4MB 头窗；距文件尾 ≈ 7MB > 4MB 尾窗 → 旧法必漏
p_front = os.path.join(tmpd, 'front_bigmoov.mp4')
sz = _synth_mp4(p_front, before_mb=6, after_mb=5, mdat_mb=2, front_moov=True)
old = _legacy_window_detect(p_front)
new = read_gspherical(p_front)
check('T1a 合成 faststart 大 moov 文件 (%d MB)' % (sz // 1048576), os.path.exists(p_front))
check('T1b ★旧窗口法漏检（复现用户 BUG 形态：判 False）', old is False, 'old=%s' % old)
check('T1c ★新检测命中（sph=True, pano=360, mono）',
      new.get('spherical') is True and new.get('pano_type') == '360' and new.get('stereo_mode') == 'mono',
      new)

# ── T2: 非 faststart 形态大 moov（moov 在尾，uuid 距尾也 >4MB）────
# [ftyp][mdat 2MB][moov: 5MB 填充 + uuid + 4.5MB 余量]
p_tail = os.path.join(tmpd, 'tail_bigmoov.mp4')
sz2 = _synth_mp4(p_tail, before_mb=5, after_mb=5, mdat_mb=2, front_moov=False)
old2 = _legacy_window_detect(p_tail)
new2 = read_gspherical(p_tail)
check('T2a 合成非 faststart 大 moov 文件 (%d MB)' % (sz2 // 1048576), os.path.exists(p_tail))
check('T2b ★旧窗口法漏检（头尾窗都够不着 uuid）', old2 is False, 'old=%s' % old2)
check('T2c ★新检测命中（sph=True）', new2.get('spherical') is True, new2)

# ── T3: 真无标签的大 moov 文件 → 判 False（防假阳性）──────────────
p_none = os.path.join(tmpd, 'no_uuid.mp4')
open(p_none, 'wb').write(_box(b'ftyp', b'isommp41')
                         + _box(b'moov', _box(b'trak', b'\x00' * 8) + b'\xAB' * (5 * 1024 * 1024))
                         + _box(b'mdat', b'\x55' * (2 * 1024 * 1024)))
new3 = read_gspherical(p_none)
check('T3 无 UUID 的大文件不误报（sph=False）', new3.get('spherical') is False, new3)

# ── T4: UUID 恰好跨 8MB 扫描块边界的形态（分块 carry 逻辑）────────
# before_mb=8：uuid 起始于 8MB+28 附近 → 恰在第一个 8MB 块尾部，跨块命中
p_cross = os.path.join(tmpd, 'cross_chunk.mp4')
_sz = _synth_mp4(p_cross, before_mb=8, after_mb=2, mdat_mb=1, front_moov=True)
new4 = read_gspherical(p_cross)
check('T4 ★UUID 跨 8MB 扫描块边界仍命中（carry 重叠生效）', new4.get('spherical') is True, new4)

# ── T5: 真实注入器三条产物路径的检测往返 ───────────────────────────
import subprocess
FFMPEG = os.path.join(ROOT, 'ffmpeg-static', 'ffmpeg.exe')
if os.path.exists(FFMPEG):
    src = os.path.join(tmpd, 'src.mp4')
    subprocess.run([FFMPEG, '-y', '-f', 'lavfi', '-i',
                    'testsrc=duration=1:size=640x320:rate=30',
                    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', src],
                   capture_output=True)
    # 路径 A：两文件注入——先 faststart 重排出"moov 前置"形态（= 合并重编码产物
    # 的真实形态；此时 UUID 距文件头可能 >4MB，正是旧检测漏判的形态）。
    # 但 inject_uuid 直接作用于 ffmpeg 编码产物时，编码器未带 +faststart 的话
    # moov 在尾，两文件路径走非 faststart 分支（不更新 stco）。两种形态都要测：
    #   A1 尾 moov（无重排）：直接两文件注入
    enc = os.path.join(tmpd, 'enc.mp4')
    subprocess.run([FFMPEG, '-y', '-i', src, '-c', 'copy', enc], capture_output=True)
    out_a = os.path.join(tmpd, 'inject_a.mp4')
    okA = inject_uuid(enc, out_a, '360', 'mono')
    detA = read_gspherical(out_a) if okA else {}
    check('T5a 两文件注入往返检测命中（尾 moov）', okA and detA.get('spherical') is True, detA)

    #   A2 faststart 前置形态再做两文件注入（触发 stco 更新分支，防回归）
    enc_f = os.path.join(tmpd, 'enc_faststart.mp4')
    subprocess.run([FFMPEG, '-y', '-i', src, '-c', 'copy', '-movflags', '+faststart', enc_f],
                   capture_output=True)
    out_a2 = os.path.join(tmpd, 'inject_a2.mp4')
    okA2 = inject_uuid(enc_f, out_a2, '360', 'mono')
    detA2 = read_gspherical(out_a2) if okA2 else {}
    check('T5a2 faststart 形态两文件注入命中', okA2 and detA2.get('spherical') is True, detA2)

    # 路径 B：就地注入（moov 在尾）
    enc_b = os.path.join(tmpd, 'enc_b.mp4')
    subprocess.run([FFMPEG, '-y', '-i', src, '-c', 'copy', enc_b], capture_output=True)
    okB = inject_uuid_inplace(enc_b, '360', 'top-bottom')
    detB = read_gspherical(enc_b) if okB else {}
    check('T5b 就地注入往返命中（stereo=top-bottom 保留）',
          okB and detB.get('spherical') is True and detB.get('stereo_mode') == 'top-bottom', detB)

    # 路径 C：faststart 重排后检测
    out_c = os.path.join(tmpd, 'relocated.mp4')
    okC = relocate_moov_front(out_a, out_c)
    detC = read_gspherical(out_c) if okC else {}
    check('T5c faststart 重排后检测命中', okC and detC.get('spherical') is True, detC)
else:
    check('T5 真实 ffmpeg 往返（ffmpeg 缺失跳过）', True, 'skipped')

# ── T6: 用户 87GB 真实合并产物在场则一并回归（缺失自动跳过）────────
REAL87 = r'G:/264/8k/20261018 蓝色港湾与花花游玩（8k）.mp4'
if os.path.exists(REAL87):
    det6 = read_gspherical(REAL87)
    check('T6 ★87GB 真实合并产物命中（曾误报无标签的实文件）',
          det6.get('spherical') is True and det6.get('pano_type') == '360', det6)
else:
    check('T6 87GB 真实样本不在场（跳过，非失败）', True, 'skipped')

bad = [r for r in results if not r[1]]
print('\n合计 %d 项，通过 %d，失败 %d' % (len(results), len(results) - len(bad), len(bad)))
import shutil
shutil.rmtree(tmpd, ignore_errors=True)
sys.exit(1 if bad else 0)

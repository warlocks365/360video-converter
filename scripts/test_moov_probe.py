# -*- coding: utf-8 -*-
"""probe_moov_atom 独立冒烟测试

手工构造最小 MP4 box 结构字节串，验证 app.probe_moov_atom 的各分支：
  1. ftyp + mdat + moov            → has_moov=True,  position='end'
  2. ftyp + moov + mdat            → has_moov=True,  position='front'（faststart）
  3. ftyp + mdat（无 moov）        → has_moov=False, position='-'
  4. size==0（box 延伸到文件尾）   → 两种位置均正确终止
  5. size==1 + 64 位 largesize     → 正确解析并跳过
  6. 恶意 size（<8 且非 0/1）      → 终止不死循环
  7. 非 MP4 文件 / 不存在的文件    → has_moov=False

运行：python scripts/test_moov_probe.py
"""
import os
import sys
import tempfile

# 让测试脚本能 import 项目根目录下的 app.py
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import app  # noqa: E402


# ── 最小 box 构造辅助 ──────────────────────────────────────────

def mk_box(btype, payload=b''):
    """标准 32 位 size 的 box"""
    size = 8 + len(payload)
    return size.to_bytes(4, 'big') + btype + payload


def mk_box64(btype, payload=b''):
    """size==1 + 8 字节 largesize 的 box（64 位长度）"""
    size = 16 + len(payload)
    return (1).to_bytes(4, 'big') + btype + size.to_bytes(8, 'big') + payload


def mk_box_to_eof(btype, payload=b''):
    """size==0：box 延伸到文件尾"""
    return (0).to_bytes(4, 'big') + btype + payload


def mk_ftyp():
    return mk_box(b'ftyp', b'isom' + b'\x00\x00\x02\x00' + b'isomiso2mp41')


FTYP = mk_ftyp()
MDAT = mk_box(b'mdat', b'\x00' * 64)
MOOV = mk_box(b'moov', b'\x00' * 32)


def write_tmp(data):
    fd, path = tempfile.mkstemp(suffix='.mp4')
    with os.fdopen(fd, 'wb') as f:
        f.write(data)
    return path


passed = 0


def check(name, cond, got):
    global passed
    if cond:
        passed += 1
        print(f'  PASS  {name}')
    else:
        print(f'  FAIL  {name}  got={got}')
        sys.exit(1)


print('probe_moov_atom 冒烟测试')
print('=' * 60)

# 1. moov 在尾部：ftyp + mdat + moov
p = write_tmp(FTYP + MDAT + MOOV)
r = app.probe_moov_atom(p)
check('moov 在 mdat 之后 → end', r == {'has_moov': True, 'moov_position': 'end'}, r)
os.remove(p)

# 2. moov 在头部（faststart）：ftyp + moov + mdat
p = write_tmp(FTYP + MOOV + MDAT)
r = app.probe_moov_atom(p)
check('moov 在 mdat 之前 → front', r == {'has_moov': True, 'moov_position': 'front'}, r)
os.remove(p)

# 3. moov 缺失：只有 ftyp + mdat
p = write_tmp(FTYP + MDAT)
r = app.probe_moov_atom(p)
check('无 moov → has_moov=False', r == {'has_moov': False, 'moov_position': '-'}, r)
os.remove(p)

# 4a. size==0 延伸到文件尾的 moov（faststart 场景：moov 顶到 EOF）
p = write_tmp(FTYP + mk_box_to_eof(b'moov', b'\x00' * 32))
r = app.probe_moov_atom(p)
check('size==0 的 moov → front 并终止', r == {'has_moov': True, 'moov_position': 'front'}, r)
os.remove(p)

# 4b. size==0 延伸到文件尾的 mdat（无 moov）
p = write_tmp(FTYP + mk_box_to_eof(b'mdat', b'\x00' * 32))
r = app.probe_moov_atom(p)
check('size==0 的 mdat → has_moov=False 并终止', r == {'has_moov': False, 'moov_position': '-'}, r)
os.remove(p)

# 5a. 64 位 largesize 的 moov
p = write_tmp(FTYP + mk_box64(b'moov', b'\x00' * 32) + MDAT)
r = app.probe_moov_atom(p)
check('size==1 largesize 的 moov → front', r == {'has_moov': True, 'moov_position': 'front'}, r)
os.remove(p)

# 5b. 64 位 largesize 的 mdat 之后跟 moov
p = write_tmp(FTYP + mk_box64(b'mdat', b'\x00' * 64) + MOOV)
r = app.probe_moov_atom(p)
check('largesize mdat 之后的 moov → end', r == {'has_moov': True, 'moov_position': 'end'}, r)
os.remove(p)

# 6. 恶意/损坏 size（<8 且非 0/1）：必须终止且不死循环
p = write_tmp(FTYP + (4).to_bytes(4, 'big') + b'free')
r = app.probe_moov_atom(p)
check('恶意 size=4 → 终止, has_moov=False', r == {'has_moov': False, 'moov_position': '-'}, r)
os.remove(p)

# 6b. largesize < 16（size==1 但 largesize 非法）
p = write_tmp(FTYP + (1).to_bytes(4, 'big') + b'mdat' + (8).to_bytes(8, 'big'))
r = app.probe_moov_atom(p)
check('largesize=8 (<16) → 终止, has_moov=False', r == {'has_moov': False, 'moov_position': '-'}, r)
os.remove(p)

# 7a. 非 MP4 文件（头部无 ftyp）
p = write_tmp(b'\x1a\x45\xdf\xa3' + b'\x00' * 64)  # EBML (MKV) 魔数
r = app.probe_moov_atom(p)
check('MKV/EBML 头 → has_moov=False', r == {'has_moov': False, 'moov_position': '-'}, r)
os.remove(p)

# 7b. 不存在的文件
r = app.probe_moov_atom(os.path.join(tempfile.gettempdir(), '__no_such_file__.mp4'))
check('文件不存在 → has_moov=False', r == {'has_moov': False, 'moov_position': '-'}, r)

# 7c. 截断文件（头不足 12 字节）
p = write_tmp(b'\x00\x00\x00')
r = app.probe_moov_atom(p)
check('截断文件 → has_moov=False', r == {'has_moov': False, 'moov_position': '-'}, r)
os.remove(p)

print('=' * 60)
print(f'全部通过: {passed}/{passed}')

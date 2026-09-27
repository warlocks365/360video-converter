"""为 build_cmd 增加 copy 模式（流复制）分支 —— 内容/位置断言，任一不符即中止。

设计说明：
  copy 模式 = `-c copy`（视频+音频直接复制，不重编码），用途是
  「只改封装/元数据（GSpherical、faststart、creation_time、location）而不想要
  转码损耗」，速度接近磁盘拷贝。

  实现要点：
  - `-c copy` 不能与任何视频滤镜共存（滤镜必须重编码），因此在滤镜链之前就把
    okaa / insv / vidstab / scale 全部中和（前端已互斥禁用，这里兜底）。
  - 元数据块从编码器段之后**前移**到滤镜链之后：ffmpeg 的输出选项
    （-metadata / -c / -movflags）之间顺序无关，前移安全；这样 copy 分支可以在
    元数据之后提前 return，避免把 93 行编码器参数包进 if/else 大幅重排。
"""
import ast
import sys

FILE = 'app.py'
src = open(FILE, encoding='utf-8').read()
n_orig = len(src.split('\n'))


def once(s, needle, label):
    n = s.count(needle)
    if n != 1:
        print(f'断言失败 [{label}]：出现 {n} 次（期望 1）'); sys.exit(1)


# ── 片段定义 ──
ANCHOR_CP = ("    codec = params.get('codec', 'libx264')\n"
             "    cp = CODEC_PROFILES.get(codec, CODEC_PROFILES['libx264'])\n")

NEUTRAL = """
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
"""

META_BLOCK = """    # Metadata: creation_time (if date extraction or manual date is enabled)
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

"""

ANCHOR_ENC = "    # Set encoder\n    cmd += ['-c:v', cp['encoder']]\n"

META_AND_COPY = (META_BLOCK
                 + "    # ── copy 模式：跳过编码器与音频重编码，直接流复制后提前返回 ──\n"
                 + "    # 元数据（上方）对 stream copy 同样有效，这正是 copy 模式的主要用途。\n"
                 + "    if copy_mode:\n"
                 + "        cmd += ['-map', '0', '-c', 'copy']\n"
                 + "        if params.get('brand'):\n"
                 + "            cmd += ['-brand', params['brand']]\n"
                 + "        if params.get('faststart', True):\n"
                 + "            cmd += ['-movflags', '+faststart']\n"
                 + "        _td = params.get('test_duration', 0)\n"
                 + "        if _td and _td > 0:\n"
                 + "            cmd += ['-t', str(_td)]\n"
                 + "        cmd.append(out)\n"
                 + "        return cmd\n\n")

OLD_2PASS = "    if mode == '2pass' and cp['group'] == 'cpu':"
NEW_2PASS = ("    # copy 模式没有码率控制，无需 2-pass（也避免把整段流复制白跑一遍）\n"
             "    if mode == '2pass' and cp['group'] == 'cpu' and not params.get('copy_mode'):")

# ── 断言 ──
once(src, META_BLOCK, 'META_BLOCK')
once(src, ANCHOR_ENC, 'ANCHOR_ENC')
once(src, OLD_2PASS, '2PASS')

idx_cp = src.find(ANCHOR_CP)
b_cmd = src.find('def build_cmd')
e_cmd = src.find('def format_location_iso6709')
if idx_cp < 0 or not (b_cmd < idx_cp < e_cmd):
    print(f'断言失败 [ANCHOR_CP]：首次出现不在 build_cmd 内（idx={idx_cp}, 范围 {b_cmd}~{e_cmd}）')
    sys.exit(1)
if src.count(ANCHOR_CP) < 2:
    print(f'断言失败：ANCHOR_CP 出现 {src.count(ANCHOR_CP)} 次（预期 ≥2）')
    sys.exit(1)

# ── 应用 ──
src = src.replace(META_BLOCK, '', 1)                                  # ① 摘除元数据块
src = src.replace(ANCHOR_ENC, META_AND_COPY + ANCHOR_ENC, 1)          # ② 元数据+copy 分支落到滤镜链之后
src = src[:idx_cp] + NEUTRAL + src[idx_cp:]                           # ③ 中和块（位于 insv_pair 赋值之后）
src = src.replace(OLD_2PASS, NEW_2PASS, 1)                            # ④ 2-pass 排除 copy

# ── 校验 ──
try:
    ast.parse(src)
except SyntaxError as e:
    print(f'语法校验失败: {e}'); sys.exit(1)
assert src.count('copy_mode') >= 4, 'copy_mode 未正确写入'

open(FILE, 'w', encoding='utf-8').write(src)
print(f'OK  app.py: {n_orig} 行 → {len(src.split(chr(10)))} 行')
print('  ① copy_mode 中和块（关滤镜/防抖/缩放/insv）')
print('  ② 元数据块前移到滤镜链之后、编码器段之前')
print('  ③ copy 分支：-map 0 -c copy + brand/faststart/test 后提前 return')
print('  ④ convert_one 的 2-pass 决策排除 copy 模式')

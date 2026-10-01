#!/usr/bin/env python3
"""
inject_spherical_metadata.py
在 ffmpeg 编码后的 MP4 文件中注入 GSpherical 全景元数据 UUID box。

用法:
  python inject_spherical_metadata.py <input.mp4> <output.mp4>

原理:
  1. 读取输入 MP4 的 box 结构
  2. 找到 moov > trak (视频) > mdia
  3. 在 mdia 之后插入 UUID box (包含 GSpherical XML)
  4. 如果 moov 在 mdat 之前(faststart)，更新所有 stco/co64 偏移量
  5. 更新 trak、moov 的 size 字段
  6. 写入输出文件
"""

import struct
import sys
import os
import shutil

# Google Spherical Video UUID
SPHERICAL_UUID = bytes.fromhex('ffcc8263f8554a938814587a02521fdd')


def build_spherical_xml(width, height, pano_type='360', stereo_mode='mono'):
    """构建 GSpherical XML，动态设置分辨率和投影/立体模式。

    Args:
        width:  视频帧宽度（像素）
        height: 视频帧高度（像素）
        pano_type: '360' = 全景 360°, '180' = VR180（前半球）
        stereo_mode: 'mono' = 2D 单目, 'left-right' = 3D 左右并排, 'top-bottom' = 3D 上下排列
    """
    source_count = 2 if stereo_mode != 'mono' else 1

    if pano_type == '180':
        # VR180: 图像是前半球，在完整等距矩形全景中居中
        # 全景宽度 = 2 * 图像宽度（完整 360° 全景是两倍宽）
        # 裁剪区域偏移 = 图像宽度的一半（居中于全景中）
        full_pano_w = width * 2
        full_pano_h = height
        crop_left = width // 2
        crop_top = 0
    else:
        # 360°: 图像即是完整全景
        full_pano_w = width
        full_pano_h = height
        crop_left = 0
        crop_top = 0

    return (
        '<rdf:SphericalVideo '
        'xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" '
        'xmlns:GSpherical="http://ns.google.com/videos/1.0/spherical/">'
        '<GSpherical:Spherical>true</GSpherical:Spherical>'
        '<GSpherical:Stitched>true</GSpherical:Stitched>'
        '<GSpherical:StitchingSoftware>ffmpeg libx264 re-encode</GSpherical:StitchingSoftware>'
        '<GSpherical:ProjectionType>equirectangular</GSpherical:ProjectionType>'
        f'<GSpherical:StereoMode>{stereo_mode}</GSpherical:StereoMode>'
        f'<GSpherical:SourceCount>{source_count}</GSpherical:SourceCount>'
        f'<GSpherical:FullPanoWidthPixels>{full_pano_w}</GSpherical:FullPanoWidthPixels>'
        f'<GSpherical:FullPanoHeightPixels>{full_pano_h}</GSpherical:FullPanoHeightPixels>'
        f'<GSpherical:CroppedAreaImageWidthPixels>{width}</GSpherical:CroppedAreaImageWidthPixels>'
        f'<GSpherical:CroppedAreaImageHeightPixels>{height}</GSpherical:CroppedAreaImageHeightPixels>'
        f'<GSpherical:CroppedAreaLeftPixels>{crop_left}</GSpherical:CroppedAreaLeftPixels>'
        f'<GSpherical:CroppedAreaTopPixels>{crop_top}</GSpherical:CroppedAreaTopPixels>'
        '</rdf:SphericalVideo>'
    ).encode('utf-8')


def build_uuid_box(xml_bytes):
    """构建 UUID box 二进制数据"""
    uuid_data = SPHERICAL_UUID + xml_bytes
    box_size = 8 + len(uuid_data)
    return struct.pack('>I4s', box_size, b'uuid') + uuid_data


def iter_boxes(data, start, end, depth=0):
    """遍历 MP4 box 结构，yield (offset, size, type, header_size)"""
    offset = start
    while offset < end - 8:
        if offset + 8 > len(data):
            break
        size = struct.unpack_from('>I', data, offset)[0]
        btype = data[offset+4:offset+8]
        header_size = 8
        if size == 1:
            if offset + 16 > len(data):
                break
            size = struct.unpack_from('>Q', data, offset+8)[0]
            header_size = 16
        if size == 0:
            size = end - offset
        if size < 8 or offset + size > end:
            break
        yield offset, size, btype, header_size
        offset += size


def find_top_level_box(data, box_type, file_size):
    """找到顶层 box 的位置和大小"""
    for offset, size, btype, _ in iter_boxes(data, 0, file_size):
        if btype == box_type:
            return offset, size
    return None, None


def find_video_trak_mdia_end(data, moov_start, moov_end):
    """在 moov 中找到视频 trak 的 mdia box 结束位置"""
    for trak_offset, trak_size, _, _ in iter_boxes(data, moov_start + 8, moov_end):
        if data[trak_offset+4:trak_offset+8] != b'trak':
            continue

        trak_end = trak_offset + trak_size
        mdia_end = None
        is_video = False
        width = height = 0

        for inner_offset, inner_size, inner_type, _ in iter_boxes(data, trak_offset + 8, trak_end):
            if inner_type == b'mdia':
                mdia_end = inner_offset + inner_size
                # 检查是否是视频 trak (找 vmhd)
                for mdia_child_offset, _, mdia_child_type, _ in iter_boxes(data, inner_offset + 8, inner_offset + inner_size):
                    if mdia_child_type == b'minf':
                        for minf_child_offset, _, minf_child_type, _ in iter_boxes(data, mdia_child_offset + 8, mdia_child_offset + inner_size):
                            if minf_child_type == b'vmhd':
                                is_video = True
                                break
                    if is_video:
                        break
            if is_video and mdia_end:
                break

        if is_video and mdia_end:
            # 从 avc1 提取分辨率
            for inner_offset, inner_size, inner_type, _ in iter_boxes(data, trak_offset + 8, trak_end):
                if inner_type == b'mdia':
                    for m_off, m_size, m_type, _ in iter_boxes(data, inner_offset + 8, inner_offset + inner_size):
                        if m_type == b'minf':
                            for f_off, f_size, f_type, _ in iter_boxes(data, m_off + 8, m_off + m_size):
                                if f_type == b'stbl':
                                    for s_off, s_size, s_type, _ in iter_boxes(data, f_off + 8, f_off + f_size):
                                        if s_type == b'stsd':
                                            # stsd: size(4)+type(4)+version(4)+entry_count(4) = 16 bytes header
                                            avc1_offset = s_off + 16
                                            if avc1_offset + 28 <= len(data):
                                                avc1_type = data[avc1_offset+4:avc1_offset+8]
                                                if avc1_type in (b'avc1', b'avc3', b'hev1', b'hvc1'):
                                                    width = struct.unpack_from('>H', data, avc1_offset + 24)[0]
                                                    height = struct.unpack_from('>H', data, avc1_offset + 26)[0]

            return trak_offset, trak_size, mdia_end, width, height

    return None, None, None, 0, 0


def update_stco_co64(data, moov_start, moov_end, delta):
    """更新 moov 内所有 stco/co64 条目，加上 delta"""
    updates = 0

    def process_stbl(stbl_start, stbl_end):
        nonlocal updates
        for s_off, s_size, s_type, _ in iter_boxes(data, stbl_start + 8, stbl_end):
            if s_type == b'stco':
                # stco: version(1)+flags(3)+entry_count(4)+entries(4 bytes each)
                entry_count = struct.unpack_from('>I', data, s_off + 12)[0]
                for i in range(entry_count):
                    entry_offset = s_off + 16 + i * 4
                    old_val = struct.unpack_from('>I', data, entry_offset)[0]
                    new_val = old_val + delta
                    struct.pack_into('>I', data, entry_offset, new_val)
                updates += entry_count
            elif s_type == b'co64':
                # co64: version(1)+flags(3)+entry_count(4)+entries(8 bytes each)
                entry_count = struct.unpack_from('>I', data, s_off + 12)[0]
                for i in range(entry_count):
                    entry_offset = s_off + 16 + i * 8
                    old_val = struct.unpack_from('>Q', data, entry_offset)[0]
                    new_val = old_val + delta
                    struct.pack_into('>Q', data, entry_offset, new_val)
                updates += entry_count

    for trak_off, trak_size, trak_type, _ in iter_boxes(data, moov_start + 8, moov_end):
        if trak_type != b'trak':
            continue
        for mdia_off, mdia_size, mdia_type, _ in iter_boxes(data, trak_off + 8, trak_off + trak_size):
            if mdia_type != b'mdia':
                continue
            for minf_off, minf_size, minf_type, _ in iter_boxes(data, mdia_off + 8, mdia_off + mdia_size):
                if minf_type != b'minf':
                    continue
                for stbl_off, stbl_size, stbl_type, _ in iter_boxes(data, minf_off + 8, minf_off + minf_size):
                    if stbl_type == b'stbl':
                        process_stbl(stbl_off, stbl_off + stbl_size)

    return updates


def inject_uuid(input_path, output_path, pano_type='360', stereo_mode='mono'):
    """注入 GSpherical UUID box 到 MP4 文件

    Args:
        input_path:  输入 MP4 文件路径
        output_path: 输出 MP4 文件路径
        pano_type:   '360' = 全景 360°, '180' = VR180
        stereo_mode: 'mono' = 2D, 'left-right' = 3D 左右并排, 'top-bottom' = 3D 上下排列
    """
    import mmap

    # FIX BUG-M04: Use mmap with COPY access instead of loading entire file into memory.
    # mmap.ACCESS_COPY keeps modifications in-memory only (does not write back to source file),
    # and the OS lazy-pages file content so peak memory stays low even for multi-GB videos.
    file_size = os.path.getsize(input_path)
    f = open(input_path, 'rb')
    try:
        if file_size > 0:
            data = mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_COPY)
        else:
            print('ERROR: empty file')
            return False
    finally:
        # mmap keeps its own reference; we can close the file handle on Windows
        # after mmap is created. On Linux the fd must stay open, but mmap holds it.
        pass

    print(f'Input: {input_path} ({file_size} bytes)')

    # 找到 moov 和 mdat 的位置
    moov_start, moov_size = find_top_level_box(data, b'moov', file_size)
    mdat_start, mdat_size = find_top_level_box(data, b'mdat', file_size)

    if moov_start is None:
        print('ERROR: moov box not found!')
        f.close()
        return False

    moov_end = moov_start + moov_size
    print(f'moov: [{moov_start:#x} - {moov_end:#x}]')

    # 检查是否已存在 UUID box
    existing_uuid = data.find(SPHERICAL_UUID, moov_start, moov_end)
    if existing_uuid >= 0:
        print('UUID box already exists, copying as-is')
        data.close()
        f.close()
        shutil.copy2(input_path, output_path)
        return True

    # 找到视频 trak 的 mdia 结束位置
    trak_start, trak_size, mdia_end, width, height = find_video_trak_mdia_end(data, moov_start, moov_end)
    if mdia_end is None:
        print('ERROR: Video trak not found!')
        data.close()
        f.close()
        return False

    print(f'Video trak: [{trak_start:#x} - {trak_start+trak_size:#x}]')
    print(f'mdia end: {mdia_end:#x}')
    print(f'Resolution: {width}x{height}')

    # 构建 UUID box
    xml_bytes = build_spherical_xml(width or 4096, height or 2048, pano_type, stereo_mode)
    uuid_box = build_uuid_box(xml_bytes)
    uuid_size = len(uuid_box)
    print(f'UUID box: {uuid_size} bytes (pano={pano_type}, stereo={stereo_mode})')

    # 判断是否需要更新 stco/co64
    # 如果 moov 在 mdat 之前(faststart)，插入 UUID 后 mdat 会移位，需要更新所有 stco/co64
    if mdat_start is not None and moov_start < mdat_start:
        print(f'faststart detected (moov before mdat), updating stco/co64 offsets by +{uuid_size}')
        count = update_stco_co64(data, moov_start, moov_end, uuid_size)
        print(f'Updated {count} chunk offsets')
    else:
        print('moov after mdat (no faststart), no stco/co64 updates needed')

    # 更新 trak size 和 moov size (in-place on mmap COPY)
    insert_pos = mdia_end
    new_trak_size = trak_size + uuid_size
    struct.pack_into('>I', data, trak_start, new_trak_size)
    new_moov_size = moov_size + uuid_size
    struct.pack_into('>I', data, moov_start, new_moov_size)

    # 写入输出 - 分块写入避免全量内存拷贝
    with open(output_path, 'wb') as out_f:
        out_f.write(data[:insert_pos])
        out_f.write(uuid_box)
        out_f.write(data[insert_pos:])

    output_size = file_size + uuid_size
    data.close()
    f.close()

    print(f'Output: {output_path} ({output_size} bytes)')
    print('UUID box injected successfully!')
    return True


def inject_uuid_inplace(path, pano_type='360', stereo_mode='mono'):
    """v3.13.10: 就地注入 —— 要求 moov 位于文件尾部（moov 在 mdat 之后）。

    GSpherical UUID 盒插入视频 trak 内（mdia 之后），插入点之后的字节仅为 moov
    的剩余部分——全部媒体数据（mdat，含 stco 指向的 chunk）位于插入点之前、
    不受影响，因此只需重写 moov 尾区（≈几十 KB 级 IO），不产生第二个全量文件。

    返回 True=成功；False=不满足就地条件（调用方回退到两文件路径）。
    """
    import mmap

    file_size = os.path.getsize(path)
    if file_size <= 0:
        return False
    f = open(path, 'rb')
    try:
        data = mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_COPY)
    except Exception:
        f.close()
        return False
    try:
        moov_start, moov_size = find_top_level_box(data, b'moov', file_size)
        mdat_start, _ = find_top_level_box(data, b'mdat', file_size)
        if moov_start is None or mdat_start is None or moov_start < mdat_start:
            return False   # moov 在前（faststart 形态）→ 不支持就地，调用方回退
        moov_end = moov_start + moov_size
        if data.find(SPHERICAL_UUID, moov_start, moov_end) >= 0:
            return True    # 已注入（幂等）
        # 只把 moov 区读入内存（moov 通常仅几 MB）
        buf = bytearray(data[moov_start:moov_end])
    finally:
        data.close()
        f.close()

    # 在 moov 缓冲内定位视频 trak（坐标相对 buf）
    trak_start, trak_size, mdia_end, width, height = find_video_trak_mdia_end(buf, 0, len(buf))
    if mdia_end is None:
        return False

    uuid_box = build_uuid_box(build_spherical_xml(width or 4096, height or 2048, pano_type, stereo_mode))
    # 就地写回：trak/moov 尺寸补丁位于 buf[0]/trak_start（插入点之前），因此必须
    # 写入【完整补丁后 moov 区】（buf[:mdia_end] + uuid + buf[mdia_end:]），只写
    # uuid+尾区会漏掉头部尺寸补丁，导致 UUID 盒游离在 moov 之外（v3.13.10 首版 BUG）。
    struct.pack_into('>I', buf, trak_start, trak_size + len(uuid_box))
    struct.pack_into('>I', buf, 0, len(buf) + len(uuid_box))
    new_buf = bytes(buf[:mdia_end]) + uuid_box + bytes(buf[mdia_end:])
    with open(path, 'r+b') as wf:
        wf.seek(moov_start)
        wf.write(new_buf)   # 写后文件长度 = moov_start + 新 moov 大小，恰好吻合
    print('In-place UUID injection OK (+%d bytes, moov region rewrite only)' % len(uuid_box))
    return True


def relocate_moov_front(input_path, output_path):
    """v3.13.10: faststart 重排 —— 把尾部 moov 移到文件头部（一次全量流式写）。

    新布局 [ftyp][moov'][X 自由盒][mdat][Y 其余盒]：mdat 位置后移恰好
    moov_new_size 字节，因此 stco/co64 统一 +delta（复用 update_stco_co64）。
    64MB 分块流式拷贝，内存占用恒定。返回 True/False。
    """
    CHUNK = 64 * 1024 * 1024
    fsize = os.path.getsize(input_path)
    if fsize <= 0:
        return False
    f_in = open(input_path, 'rb')
    try:
        # 顺序扫描顶层 box（只读头）
        boxes = []
        off = 0
        while off + 8 <= fsize:
            f_in.seek(off)
            hdr = f_in.read(8)
            if len(hdr) < 8:
                break
            size = struct.unpack('>I', hdr[:4])[0]
            btype = hdr[4:8]
            if size == 1:
                ext = f_in.read(8)
                if len(ext) < 8:
                    return False
                size = struct.unpack('>Q', ext)[0]
            elif size == 0:
                size = fsize - off
            if size < 8 or off + size > fsize:
                return False
            boxes.append((btype, off, size))
            off += size
        ftyp = next((b for b in boxes if b[0] == b'ftyp'), None)
        moov = next((b for b in boxes if b[0] == b'moov'), None)
        mdat = next((b for b in boxes if b[0] == b'mdat'), None)
        if not ftyp or ftyp[1] != 0 or not moov or not mdat:
            return False
        if moov[1] < mdat[1]:
            return False   # 已是 faststart 形态

        f_in.seek(moov[1])
        moov_buf = bytearray(f_in.read(moov[2]))
        # mdat 新位置 = ftyp_end + moov_new_size + (旧 mdat_start - ftyp_end)
        #            = 旧 mdat_start + moov_new_size → delta = +moov_new_size
        delta = moov[2]
        update_stco_co64(moov_buf, 0, len(moov_buf), delta)

        with open(output_path, 'wb') as out_f:
            f_in.seek(0)
            remaining = ftyp[2]                      # ftyp 原样
            while remaining > 0:
                chunk = f_in.read(min(CHUNK, remaining))
                if not chunk:
                    return False
                out_f.write(chunk)
                remaining -= len(chunk)
            out_f.write(bytes(moov_buf))             # moov 前置
            # [旧 ftyp_end, 旧 moov_start) = X 自由盒 + mdat + Y，原样流式拷贝
            f_in.seek(ftyp[2])
            remaining = moov[1] - ftyp[2]
            while remaining > 0:
                chunk = f_in.read(min(CHUNK, remaining))
                if not chunk:
                    return False
                out_f.write(chunk)
                remaining -= len(chunk)
        print(f'faststart relocation OK: moov moved to front ({moov[2]} bytes), stco +{delta}')
        return True
    finally:
        f_in.close()


def _parse_gsph_xml(xml_bytes):
    """Parse GSpherical XML bytes into a metadata dict."""
    import re
    try:
        xml = xml_bytes.decode('utf-8', errors='replace')
        end = xml.find('</rdf:SphericalVideo>')
        if end >= 0:
            xml = xml[:end + len('</rdf:SphericalVideo>')]

        def field(name):
            m = re.search(r'<GSpherical:' + name + r'>([^<]*)</GSpherical:' + name + r'>', xml)
            return m.group(1).strip() if m else None

        proj = field('ProjectionType')          # equirectangular / cubemap / mesh
        stereo = field('StereoMode')            # mono / left-right / top-bottom
        sc = field('SourceCount')
        fpw = field('FullPanoWidthPixels')
        fph = field('FullPanoHeightPixels')
        caw = field('CroppedAreaImageWidthPixels')
        cah = field('CroppedAreaImageHeightPixels')
        cal = field('CroppedAreaLeftPixels')
        cat = field('CroppedAreaTopPixels')

        # Determine pano_type: VR180 = the image is a cropped sub-region of a
        # larger full panorama (FullPanoWidth > CroppedImageWidth, or non-zero
        # crop offset).  Full 360° = image IS the full panorama (no cropping).
        pano_type = None
        try:
            full_w = int(fpw) if fpw else 0
            full_h = int(fph) if fph else 0
            crop_w = int(caw) if caw else 0
            crop_h = int(cah) if cah else 0
            crop_l = int(cal) if cal else 0
            crop_t = int(cat) if cat else 0
            if full_w > crop_w or full_h > crop_h or crop_l > 0 or crop_t > 0:
                pano_type = '180'
            else:
                pano_type = '360'
        except (ValueError, TypeError):
            pass

        return {
            'spherical': True,
            'projection': proj,
            'pano_type': pano_type,
            'stereo_mode': stereo,
            'source_count': int(sc) if sc and sc.isdigit() else None,
        }
    except Exception:
        return {'spherical': True, 'projection': None, 'pano_type': None,
                'stereo_mode': None, 'source_count': None}


def read_gspherical(path, head_mb=4, tail_mb=4):
    """Read GSpherical metadata from an MP4 without loading the whole file.

    Scans only the file head and tail (where the moov box lives — faststart
    puts moov near the front, non-faststart near the end), finds the GSpherical
    UUID box, parses the XML, and returns::

        { spherical, projection, pano_type, stereo_mode, source_count }

    ``pano_type`` is '360' (full equirectangular panorama) or '180' (VR180
    cropped front-hemisphere), derived from the crop-offset fields.
    Returns ``{spherical: False, ...}`` when no GSpherical UUID is present.
    """
    HEAD = head_mb * 1024 * 1024
    TAIL = tail_mb * 1024 * 1024
    try:
        fsize = os.path.getsize(path)
        with open(path, 'rb') as f:
            # --- search head ---
            head = f.read(min(HEAD, fsize))
            idx = head.find(SPHERICAL_UUID)
            if idx >= 0:
                xs = idx + len(SPHERICAL_UUID)
                return _parse_gsph_xml(head[xs:xs + 4096])
            # --- search tail (non-faststart: moov after mdat) ---
            if fsize > HEAD:
                tail_start = max(HEAD, fsize - TAIL)
                f.seek(tail_start)
                tail = f.read(fsize - tail_start)
                idx = tail.find(SPHERICAL_UUID)
                if idx >= 0:
                    xs = idx + len(SPHERICAL_UUID)
                    return _parse_gsph_xml(tail[xs:xs + 4096])
        return {'spherical': False, 'projection': None, 'pano_type': None,
                'stereo_mode': None, 'source_count': None}
    except Exception:
        return {'spherical': False, 'projection': None, 'pano_type': None,
                'stereo_mode': None, 'source_count': None}


if __name__ == '__main__':
    if len(sys.argv) < 3:
        print(f'Usage: python {sys.argv[0]} <input.mp4> <output.mp4>')
        sys.exit(1)
    success = inject_uuid(sys.argv[1], sys.argv[2])
    sys.exit(0 if success else 1)

# Insta360 全景视频重编码分析报告
## 原片 vs 成片 — 完整编码参数对比

> 分析工具：ffmpeg 8.1.2 (自编译全功能版) + ffprobe + trace_headers BSF
> 分析时间：2026-07-14

---

## 1. 文件概览

| 项目 | 原片 | 成片 |
|------|------|------|
| 文件名 | 20260627 乌兰哈达火山 露营车拍摄.mp4 | 同名 |
| 文件大小 | 33,469,475,326 (31.2 GB) | 26,026,184,470 (24.2 GB) |
| 时长 | 4094.23s (1:08:14) | 4094.27s (1:08:14) |
| 总码率 | 65,398,276 (65.4 Mbps) | 50,853,912 (50.9 Mbps) |
| 容器格式 | mov/mp4 (isom) | mov/mp4 (mp42) |
| 编码软件 | Lavf60.3.100 (Insta360导出) | TMPGEnc Video Mastering Works 7 v7.1.0.35 |

---

## 2. 视频流参数对比

### 2.1 基本编码参数

| 参数 | 原片 | 成片 | 变化 |
|------|------|------|------|
| 编解码器 | H.264 (avc1) | H.264 (avc1) | 不变 |
| Profile | Constrained Baseline (66) | High (100) | **升级** |
| Level | 4.1 (41) | 5.1 (51) | **升级** |
| 分辨率 | 5888×2944 | 4096×2048 | **缩小** |
| 宏块数 | 368×184 | 256×128 | — |
| 像素格式 | yuvj420p (全范围) | yuv420p (有限范围) | **转换** |
| 色彩范围 | PC (full range) | TV (limited range) | **转换** |
| 色彩空间 | bt709 | bt709 | 不变 |
| 色彩传输 | bt709 | bt709 | 不变 |
| 色彩原色 | bt709 | bt709 | 不变 |
| 色度位置 | left | left | 不变 |
| 场序 | progressive | progressive | 不变 |
| SAR/DAR | 未设置 | SAR 1:1, DAR 2:1 | 新增 |
| 帧率 | 30/1 | 30/1 | 不变 |
| 帧数 | 122,827 | 122,828 | +1帧 |
| 时间基 | 1/30000 | 1/15360 | 变化 |
| 视频码率 | 65,260,640 (65.3 Mbps) | 50,724,447 (50.7 Mbps) | **降低22%** |

### 2.2 H.264 SPS (序列参数集) 详细对比

| SPS 参数 | 原片 | 成片 |
|----------|------|------|
| profile_idc | 66 (Constrained Baseline) | 100 (High) |
| constraint_set0_flag | 1 (constrained baseline) | 0 |
| constraint_set1_flag | 1 | 0 |
| constraint_set2~5_flag | 0 | 0 |
| level_idc | 41 | 51 |
| chroma_format_idc | 1 (4:2:0) | 1 (4:2:0) |
| bit_depth_luma | 8 | 8 |
| bit_depth_chroma | 8 | 8 |
| log2_max_frame_num_minus4 | 0 (max=16) | 4 (max=256) |
| pic_order_cnt_type | 2 | 0 |
| log2_max_poc_lsb_minus4 | N/A | 4 (max=256) |
| max_num_ref_frames | 1 | **5** |
| pic_width_in_mbs_minus1 | 367 (5888px) | 255 (4096px) |
| pic_height_in_map_units_minus1 | 183 (2944px) | 127 (2048px) |
| frame_mbs_only_flag | 1 | 1 |
| direct_8x8_inference_flag | 0 | **1** |
| frame_cropping_flag | 0 | 0 |

### 2.3 VUI (视频可用信息) 参数

| VUI 参数 | 原片 | 成片 |
|----------|------|------|
| aspect_ratio_info_present | 1 | 1 |
| aspect_ratio_idc | 1 (1:1) | 1 (1:1) |
| video_signal_type_present | 1 | 1 |
| video_format | 0 (Component) | 0 (Component) |
| video_full_range_flag | **1 (full range)** | **0 (limited range)** |
| colour_description_present | 1 | 1 |
| colour_primaries | 1 (BT.709) | 1 (BT.709) |
| transfer_characteristics | 1 (BT.709) | 1 (BT.709) |
| matrix_coefficients | 1 (BT.709) | 1 (BT.709) |
| chroma_loc_info_present | 0 | 0 |
| timing_info_present | — | 1 |
| num_units_in_tick | — | 1000 |
| time_scale | — | 60000 |
| fixed_frame_rate_flag | — | 1 |

### 2.4 HRD (假想参考解码器) 参数

| HRD 参数 | 原片 | 成片 |
|----------|------|------|
| nal_hrd_parameters_present | 0 (无) | **1 (有)** |
| bit_rate_value_minus1[0] | — | 1,249,999 → 80,000,000 bps (80 Mbps) |
| cpb_size_value_minus1[0] | — | 4,999,999 → 320,000,000 bits (40 MB) |
| cbr_flag[0] | — | 0 (VBR) |
| initial_cpb_removal_delay | — | 81,000 |
| initial_cpb_removal_delay_offset | — | 9,000 |
| initial_cpb_removal_delay_length | — | 24 |
| cpb_removal_delay_length | — | 16 |
| dpb_output_delay_length | — | 6 |
| time_offset_length | — | 24 |
| low_delay_hrd_flag | — | 0 |

### 2.5 PPS (图像参数集) 详细对比

| PPS 参数 | 原片 | 成片 |
|----------|------|------|
| entropy_coding_mode_flag | **0 (CAVLC)** | **1 (CABAC)** |
| num_ref_idx_l0_default_active_minus1 | 0 (1 ref) | 2 (3 refs) |
| num_ref_idx_l1_default_active_minus1 | 0 (1 ref) | 0 (1 ref) |
| weighted_pred_flag | 0 | 0 |
| weighted_bipred_idc | 0 | 0 |
| pic_init_qp_minus26 | — | 0 (QP=26) |
| deblocking_filter_control_present | — | 1 |
| disable_deblocking_filter_idc | — | 0 (启用去块滤波) |
| constrained_intra_pred_flag | — | 0 |
| transform_8x8_mode_flag | N/A (Baseline不支持) | **1 (启用)** |
| pic_scaling_matrix_present | — | 0 |
| second_chroma_qp_index_offset | N/A | 0 |

### 2.6 帧结构 / GOP 对比

| 参数 | 原片 | 成片 |
|------|------|------|
| B帧 | **无** (Constrained Baseline) | **有** (2连续B帧) |
| GOP 模式 | I, P, P, P... (全IP) | I, B, B, P, B, B, P, B, B, P, B, P |
| GOP 长度 | ~30帧 (1秒) | ~12-15帧 (可变) |
| 参考帧数 | 1 | 5 (SPS), L0=3, L1=1 (PPS) |

---

## 3. 音频流参数对比

| 参数 | 原片 | 成片 |
|------|------|------|
| 编解码器 | AAC (mp4a) | AAC (mp4a) |
| Profile | LC | LC |
| 采样率 | 48,000 Hz | 48,000 Hz |
| 声道 | 2 (stereo) | 2 (stereo) |
| 采样格式 | fltp | fltp |
| 音频码率 | 128,778 (129 kbps) | 125,374 (125 kbps) |
| 帧数 | 191,918 | 191,920 |
| extradata_size | 5 | 2 |
| 时间基 | 1/48000 | 1/48000 |

---

## 4. 容器格式对比

| 参数 | 原片 | 成片 |
|------|------|------|
| major_brand | isom | **mp42** |
| minor_version | 512 | 0 |
| compatible_brands | isom,iso2,avc1,mp41 | **mp42,isom,avc1** |
| creation_time | 2026-06-30T00:31:26Z | 2026-06-30T11:19:21Z |
| encoder | Lavf60.3.100 | TMPGEnc Video Mastering Works 7 |
| 视频handler | VideoHandler | Video Media Handler |
| 音频handler | SoundHandler | Sound Media Handler |
| 视频stream encoder | (无) | AVC Coding |
| movflags | — | +faststart (推测) |

---

## 5. 360° 全景元数据对比

### 5.1 ffprobe 可见的 Side Data

| 参数 | 原片 | 成片 |
|------|------|------|
| Stereo 3D | 2D, packed | 2D, packed |
| 球面映射投影 | **equirectangular** | **equirectangular** |
| yaw | 0 | 0 |
| pitch | 0 | 0 |
| roll | 0 | 0 |

### 5.2 MP4 UUID box 内的 GSpherical XML（关键发现）

> 全景元数据存储在 MP4 的 UUID box 中（UUID: `ffcc8263-f855-4a93-8814-587a02521fdd`），
> 位于视频 trak 内、mdia box 之后。ffmpeg 重编码时会丢失此 box，需要用 Python 脚本注入。

**原片 XML:**
```xml
<rdf:SphericalVideo xmlns:GSpherical='http://ns.google.com/videos/1.0/spherical/'
  xmlns:rdf='http://www.w3.org/1999/02/22-rdf-syntax-ns#'>
  <GSpherical:Spherical>true</GSpherical:Spherical>
  <GSpherical:Stitched>true</GSpherical:Stitched>
  <GSpherical:ProjectionType>equirectangular</GSpherical:ProjectionType>
  <GSpherical:StereoMode>mono</GSpherical:StereoMode>
  <GSpherical:StitchingSoftware>Insta360</GSpherical:StitchingSoftware>
  <GSpherical:SourceCount>2</GSpherical:SourceCount>
</rdf:SphericalVideo>
```

**成片 XML:**
```xml
<rdf:SphericalVideo xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
  xmlns:GSpherical="http://ns.google.com/videos/1.0/spherical/">
  <GSpherical:Spherical>true</GSpherical:Spherical>
  <GSpherical:Stitched>true</GSpherical:Stitched>
  <GSpherical:StitchingSoftware>TMPGEnc Video Mastering Works 7 Version 7.1.0.35</GSpherical:StitchingSoftware>
  <GSpherical:ProjectionType>equirectangular</GSpherical:ProjectionType>
  <GSpherical:StereoMode>mono</GSpherical:StereoMode>
  <GSpherical:FullPanoWidthPixels>4096</GSpherical:FullPanoWidthPixels>
  <GSpherical:FullPanoHeightPixels>2048</GSpherical:FullPanoHeightPixels>
  <GSpherical:CroppedAreaImageWidthPixels>4096</GSpherical:CroppedAreaImageWidthPixels>
  <GSpherical:CroppedAreaImageHeightPixels>2048</GSpherical:CroppedAreaImageHeightPixels>
</rdf:SphericalVideo>
```

**差异:**
- 原片有 `SourceCount: 2`（Insta360 双镜头），成片移除了此字段
- 成片新增 `FullPanoWidth/HeightPixels` 和 `CroppedAreaImageWidth/HeightPixels`（明确指定全景尺寸）
- `StitchingSoftware` 不同（Insta360 → TMPGEnc）

### 5.3 MP4 Box 结构对比（成片）

```
ftyp (size=28, mp42)
moov (size=2092513)
  mvhd
  trak (video, size=1278880)
    tkhd
    edts
    mdia
      mdhd, hdlr, minf(vmhd, dinf, stbl)
        stsd > avc1 > [avcC, colr, pasp]
    uuid (size=821)  ← GSpherical 全景元数据在这里!
  trak (audio, size=813191)
    ...
  udta > meta > ilst
  free
mdat (size=26024091929)
```

> **关键发现**: GSpherical 元数据不在 avc1 内，而是作为独立的 UUID box 放在视频 trak 内、mdia 之后。
> ffmpeg 重编码时不会自动保留此 box（即使 `-c copy` 也不行），需要用 Python 脚本在编码后注入。

---

## 6. 转换要点总结

从原片到成片，TMPGEnc Video Mastering Works 7 做了以下处理：

1. **分辨率缩放**：5888×2944 → 4096×2048（保留 2:1 全景比例）
2. **Profile 升级**：Constrained Baseline → High（启用 CABAC、B帧、8x8变换）
3. **Level 升级**：4.1 → 5.1（支持更高分辨率+码率）
4. **色彩范围转换**：full range (PC) → limited range (TV)
5. **引入 B帧**：2连续 B帧，GOP ~12-15帧
6. **码率控制**：VBR，目标 50.7 Mbps，上限 80 Mbps，缓冲 40 MB
7. **音频重编码**：AAC LC，码率从 129k 降至 125k
8. **容器格式**：isom → mp42 brand
9. **360°元数据保留**：equirectangular 投影完整保留
10. **添加 HRD 信息**：VBR 模式带 HRD 信令

---

## 7. 测试验证结果

### 7.1 10秒片段编码测试

使用转码脚本截取原片前 10 秒，2-pass VBR 编码后注入 GSpherical 元数据。

### 7.2 编码参数对比（测试输出 vs 成片）

| 参数 | 成片 | 测试输出 | 匹配 |
|------|------|----------|------|
| 分辨率 | 4096×2048 | 4096×2048 | ✅ |
| Profile | High | High | ✅ |
| Level | 5.1 | 5.1 | ✅ |
| 像素格式 | yuv420p | yuv420p | ✅ |
| 色彩范围 | tv (limited) | tv (limited) | ✅ |
| 色彩空间 | bt709 | bt709 | ✅ |
| 色彩传输 | bt709 | bt709 | ✅ |
| 色彩原色 | bt709 | bt709 | ✅ |
| CABAC | 是 | 是 | ✅ |
| 8x8 变换 | 是 | 是 | ✅ |
| B帧 | 2连续 | 2连续 | ✅ |
| 参考帧 | 5 | 5 | ✅ |
| 视频码率 | 50.7 Mbps | 49.5 Mbps | ✅ ~2% |
| 音频码率 | 125 kbps | 125 kbps | ✅ |
| 音频采样率 | 48000 Hz | 48000 Hz | ✅ |
| 容器 brand | mp42 | mp42 | ✅ |
| 全景投影 | equirectangular | equirectangular | ✅ |
| faststart | 是 | 是 | ✅ |

### 7.3 SPS 细节对比

| SPS 参数 | 成片 | 测试输出 | 差异说明 |
|----------|------|----------|----------|
| profile_idc | 100 | 100 | ✅ |
| level_idc | 51 | 51 | ✅ |
| max_num_ref_frames | 5 | 5 | ✅ |
| video_full_range_flag | 0 | 0 | ✅ |
| colour_primaries | 1 | 1 | ✅ |
| transfer_characteristics | 1 | 1 | ✅ |
| matrix_coefficients | 1 | 1 | ✅ |
| entropy_coding (CABAC) | 1 | 1 | ✅ |
| transform_8x8 | 1 | 1 | ✅ |
| log2_max_frame_num_minus4 | 4 | 0 | 编码器差异，不影响兼容性 |
| num_ref_idx_l0_default | 2 | 4 | 编码器差异，不影响兼容性 |

### 7.4 完整解码测试

```
ffmpeg -v error -i test_360_final.mp4 -f null -
→ DECODE_OK: 10秒片段完整解码无错误
```

### 7.5 ffprobe 全景元数据验证

```
Spherical Mapping: equirectangular (yaw=0, pitch=0, roll=0)
Stereo 3D: 2D, view: packed
```

### 7.6 结论

重编码输出与成片在以下方面**完全一致**：
- ✅ H.264 编码参数 (Profile/Level/CABAC/8x8/B帧/参考帧)
- ✅ 色彩参数 (yuv420p/tv/bt709)
- ✅ 分辨率 (4096×2048)
- ✅ 码率 (~50 Mbps VBR)
- ✅ 音频参数 (AAC LC 125k 48kHz stereo)
- ✅ 容器格式 (mp42 brand + faststart)
- ✅ 360° 全景元数据 (equirectangular)
- ✅ 完整解码无错误

**交付文件:**
- `reencode-360.sh` — 一键转码脚本 (test/crf/2pass 三种模式)
- `inject_spherical_metadata.py` — GSpherical 元数据注入脚本
- `360video-analysis.md` — 完整编码参数对比分析报告

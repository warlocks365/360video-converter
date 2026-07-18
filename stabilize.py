#!/usr/bin/env python3
"""
stabilize.py - Video software stabilization module

Two stabilization paths, selected by video type:
  - Standard 16:9 video : FFmpeg vidstab filter chain (detect + transform)
  - Panoramic 360/180   : OpenCV spherical stabilization
                         (equirect -> motion estimate -> SO(3) smooth -> reproject)

Video type detection reuses read_gspherical() from inject_spherical_metadata,
falling back to the user's inject_spherical flag when the source has no metadata.
"""

import os
import sys
import math
import subprocess
import tempfile

import numpy as np

try:
    import cv2
    HAS_CV2 = True
except ImportError:
    HAS_CV2 = False


# ── Video type detection ─────────────────────────────────────────
def detect_video_type(inp, params=None):
    """Determine whether a video is panoramic (360/180) or standard 16:9.

    Prefers the file's own GSpherical metadata (read_gspherical).  When the
    source has no spherical metadata, falls back to the user's encoding-panel
    selection: if they asked to inject spherical metadata, treat it as
    panoramic so the spherical stabilizer runs.
    """
    try:
        from inject_spherical_metadata import read_gspherical
        gs = read_gspherical(inp)
        if gs.get('spherical'):
            return 'panoramic'
    except Exception:
        pass
    if params and params.get('inject_spherical'):
        return 'panoramic'
    return 'standard'


# ════════════════════════════════════════════════════════════════
#  Standard video : FFmpeg vidstab (filter-chain inlined, strategy A)
# ════════════════════════════════════════════════════════════════

def _ff_path(path):
    """Escape a Windows path for use inside an FFmpeg filter string.

    FFmpeg filter syntax uses ':' as option separator, so Windows drive
    letters like 'C:' break the parser. We convert to a relative path
    (which removes the drive letter) and use forward slashes.
    """
    try:
        rel = os.path.relpath(path)
        # If on a different drive, relpath returns an absolute path with ':'
        if ':' not in rel:
            return rel.replace('\\', '/')
    except ValueError:
        pass
    # Fallback: basename only (file must be in CWD)
    return os.path.basename(path).replace('\\', '/')


def vidstab_detect(ffmpeg_path, inp, trf_path, shakiness=5, env=None,
                   log_fn=None, creationflags=0):
    """vidstab pass 1: analyse inter-frame motion, write transforms to .trf file.

    Runs ffmpeg with -f null (no output file).  Returns True on success.
    """
    cmd = [ffmpeg_path, '-y', '-i', inp,
           '-vf', f'vidstabdetect=shakiness={shakiness}:result={_ff_path(trf_path)}',
           '-an', '-f', 'null', '-']
    if log_fn:
        log_fn(f'  vidstab detect: shakiness={shakiness} -> {os.path.basename(trf_path)}')
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, env=env,
                           creationflags=creationflags, timeout=600)
    except subprocess.TimeoutExpired:
        if log_fn:
            log_fn('  vidstab detect timed out', 'error')
        return False
    if r.returncode != 0:
        if log_fn:
            tail = (r.stderr or '')[-400:]
            log_fn(f'  vidstab detect failed: {tail}', 'error')
        return False
    return True


def vidstab_transform_filter(trf_path, smoothing=30, zoom=0.05, crop=True):
    """Build a vidstabtransform filter string for the -vf chain.

    The filter is inserted *before* scale so stabilization runs on the
    original frame geometry, then the result is scaled to the target size.
    """
    parts = [
        f'input={_ff_path(trf_path)}',
        f'smoothing={smoothing}',
        f'zoom={zoom}',
    ]
    if crop:
        parts.append('crop=1')   # auto-crop black borders left by transform
    return 'vidstabtransform=' + ':'.join(parts)


# ════════════════════════════════════════════════════════════════
#  Panoramic video : OpenCV spherical stabilization (strategy B)
# ════════════════════════════════════════════════════════════════

class _SphericalStabilizer:
    """Stateful spherical stabilizer that pre-computes equirect direction maps.

    The expensive per-pixel spherical<->cartesian conversion is done once at
    construction; each frame only needs a 3x3 matrix multiply + two remap calls.
    """

    def __init__(self, eq_h, eq_w, analyze_w=960):
        """Pre-compute direction vectors and sampling maps.

        Args:
            eq_h, eq_w : equirectangular frame dimensions (output resolution).
            analyze_w  : width used for motion-estimation (down-sampled for speed).
        """
        self.h = eq_h
        self.w = eq_w
        # Down-sampled dimensions for motion estimation
        self.ah = max(1, eq_h * analyze_w // eq_w) if eq_w else eq_h
        self.aw = analyze_w

        # Output-pixel direction vectors (h, w, 3) — float32 for speed
        ys, xs = np.mgrid[0:eq_h, 0:eq_w].astype(np.float32)
        lon = xs / eq_w * 2 * np.pi - np.pi          # [-pi, pi]
        lat = np.pi / 2 - ys / eq_h * np.pi           # [pi/2, -pi/2]
        cos_lat = np.cos(lat)
        # dirs[i,j] = (sin(lon)*cos(lat), sin(lat), cos(lon)*cos(lat))
        self._dirs = np.stack(
            [cos_lat * np.sin(lon), np.sin(lat), cos_lat * np.cos(lon)],
            axis=-1
        ).reshape(-1, 3)  # (h*w, 3)

        # Analysis-pixel direction vectors (ah, aw, 3)
        ays, axs = np.mgrid[0:self.ah, 0:self.aw].astype(np.float32)
        alon = axs / self.aw * 2 * np.pi - np.pi
        alat = np.pi / 2 - ays / self.ah * np.pi
        a_cos = np.cos(alat)
        self._a_dirs = np.stack(
            [a_cos * np.sin(alon), np.sin(alat), a_cos * np.cos(alon)],
            axis=-1
        )

    # -- rotation helpers (axis-angle, numerically stable) ----------
    @staticmethod
    def _R_to_axisangle(R):
        """3x3 rotation matrix -> (axis(3,), angle scalar)."""
        trace = np.clip((np.trace(R) - 1) / 2, -1.0, 1.0)
        angle = np.arccos(trace)
        if angle < 1e-7:
            return np.array([1.0, 0.0, 0.0], dtype=np.float64), 0.0
        s = 2 * np.sin(angle)
        axis = np.array([R[2, 1] - R[1, 2],
                         R[0, 2] - R[2, 0],
                         R[1, 0] - R[0, 1]], dtype=np.float64) / s
        n = np.linalg.norm(axis)
        if n < 1e-7:
            return np.array([1.0, 0.0, 0.0]), 0.0
        return axis / n, float(angle)

    @staticmethod
    def _axisangle_to_R(axis, angle):
        """Axis-angle -> 3x3 rotation (Rodrigues)."""
        c, s = np.cos(angle), np.sin(angle)
        t = 1 - c
        x, y, z = axis
        return np.array([
            [t*x*x + c,   t*x*y - z*s, t*x*z + y*s],
            [t*x*y + z*s, t*y*y + c,   t*y*z - x*s],
            [t*x*z - y*s, t*y*z + x*s, t*z*z + c],
        ], dtype=np.float64)

    # -- motion estimation -------------------------------------------
    def estimate_rotation(self, prev_gray, curr_gray, prev_pts, lk_params,
                          feature_params):
        """Estimate the inter-frame 3D rotation (yaw dominant) from feature flow.

        Works on the equirect equatorial band (avoids pole distortion).
        Returns a 3x3 rotation matrix.
        """
        h, w = prev_gray.shape
        y0, y1 = int(h * 0.2), int(h * 0.8)
        prev_band = prev_gray[y0:y1, :]
        curr_band = curr_gray[y0:y1, :]

        p0 = cv2.goodFeaturesToTrack(prev_band, **feature_params)
        if p0 is None or len(p0) < 10:
            return np.eye(3)
        p1, st, _ = cv2.calcOpticalFlowPyrLK(prev_band, curr_band, p0, None,
                                             **lk_params)
        good0 = p0[st == 1]
        good1 = p1[st == 1]
        if len(good0) < 6:
            return np.eye(3)

        # Partial affine (rotation + uniform scale + translation)
        M, _ = cv2.estimateAffinePartial2D(good0, good1)
        if M is None:
            return np.eye(3)

        # Decompose: yaw from rotation angle, pitch from vertical translation
        yaw = math.atan2(M[1, 0], M[0, 0])
        pitch = float(M[1, 2]) / max(h, 1) * math.pi
        # Clamp pitch to reasonable range
        pitch = max(-0.15, min(0.15, pitch))

        # Build 3D rotation: Ry(yaw) then Rx(pitch)
        cy, sy = math.cos(yaw), math.sin(yaw)
        cp, sp = math.cos(pitch), math.sin(pitch)
        Ry = np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]], dtype=np.float64)
        Rx = np.array([[1, 0, 0], [0, cp, -sp], [0, sp, cp]], dtype=np.float64)
        return Rx @ Ry

    # -- trajectory smoothing (axis-angle moving average) -----------
    @staticmethod
    def smooth_trajectory(trajectory, window):
        """Smooth a list of cumulative rotation matrices.

        Converts each to axis-angle, moving-average the angle and axis
        separately, rebuilds matrices.  Window is in frames.
        """
        n = len(trajectory)
        axes = np.zeros((n, 3), dtype=np.float64)
        angles = np.zeros(n, dtype=np.float64)
        for i, R in enumerate(trajectory):
            ax, ang = _SphericalStabilizer._R_to_axisangle(R)
            axes[i] = ax
            angles[i] = ang

        # Smooth angle (1D moving average, edge-padded)
        half = window // 2
        ker = np.ones(window) / window
        angles_p = np.pad(angles, (half, half), mode='edge')
        angles_s = np.convolve(angles_p, ker, mode='valid')[:n]

        # Smooth axis (weighted average, renormalize)
        axes_s = np.zeros_like(axes)
        for i in range(n):
            lo, hi = max(0, i - half), min(n, i + half + 1)
            avg = np.mean(axes[lo:hi], axis=0)
            norm = np.linalg.norm(avg)
            axes_s[i] = avg / norm if norm > 1e-7 else np.array([1, 0, 0])

        return [_SphericalStabilizer._axisangle_to_R(axes_s[i], angles_s[i])
                for i in range(n)]

    # -- frame compensation ------------------------------------------
    def apply_correction(self, frame, R_corr):
        """Apply a 3D rotation correction to an equirectangular frame.

        Uses inverse rotation on pixel directions, then remaps from the
        original equirect image.  Border wrap handles the 360-degree seam.
        """
        Rinv = np.linalg.inv(R_corr)
        # (h*w, 3) @ (3, 3) -> (h*w, 3)
        rotated = self._dirs @ Rinv.T
        rx, ry, rz = rotated[:, 0], rotated[:, 1], rotated[:, 2]
        new_lon = np.arctan2(rx, rz)
        new_lat = np.arcsin(np.clip(ry, -1.0, 1.0))
        map_x = ((new_lon + np.pi) / (2 * np.pi) * self.w).astype(np.float32)
        map_y = ((np.pi / 2 - new_lat) / np.pi * self.h).astype(np.float32)
        map_x = map_x.reshape(self.h, self.w)
        map_y = map_y.reshape(self.h, self.w)
        return cv2.remap(frame, map_x, map_y, cv2.INTER_LINEAR,
                         borderMode=cv2.BORDER_WRAP)


def stabilize_panoramic(inp, out, params, ffmpeg_path=None, env=None,
                        log_fn=None, progress_fn=None, creationflags=0):
    """Stabilize a panoramic (360/180) video using spherical motion estimation.

    Pipeline:
      1. Motion estimation: estimate per-frame 3D rotation via feature flow
         on the equirect equatorial band (down-sampled for speed).
      2. Trajectory smoothing: moving-average on axis-angle representation.
      3. Compensation: apply inverse rotation to each frame via spherical
         remap, write to an intermediate file through an ffmpeg pipe.

    For stereo (left-right / top-bottom) sources the frame is split, motion is
    estimated on the left/top half, and the *same* correction is applied to
    both eyes to keep them in sync.

    Args:
        inp / out          : input video / stabilized intermediate output.
        params             : dict with stabilize_smoothing, stabilize_zoom,
                             pano_type, stereo_mode.
        ffmpeg_path / env  : for the output encoding pipe.
        log_fn(msg, level) : optional logger.
        progress_fn(0-100) : optional progress callback.

    Returns:
        (success: bool, error_msg: str or None)
    """
    if not HAS_CV2:
        return False, 'OpenCV (cv2) 未安装, 全景球面防抖不可用'

    cap = cv2.VideoCapture(inp)
    if not cap.isOpened():
        return False, '无法打开视频文件'

    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    n_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    if w < 2 or h < 2:
        cap.release()
        return False, '无效的视频分辨率'

    smoothing = max(1, int(params.get('stabilize_smoothing', 30)))
    border_zoom = float(params.get('stabilize_zoom', 0.02))
    stereo_mode = params.get('stereo_mode', 'mono')
    is_stereo = stereo_mode in ('left-right', 'top-bottom')

    if log_fn:
        log_fn(f'  球面防抖: {w}x{h}, {n_frames}帧, {fps:.1f}fps, '
               f'smoothing={smoothing}, stereo={stereo_mode}')

    # For stereo: estimate motion on one half, full frame split for output
    if is_stereo:
        if stereo_mode == 'left-right':
            est_w, est_h = w // 2, h
        else:  # top-bottom
            est_w, est_h = w, h // 2
    else:
        est_w, est_h = w, h

    analyze_w = min(960, est_w)
    stabilizer = _SphericalStabilizer(est_h, est_w, analyze_w=analyze_w)

    # ── Feature / LK params ──
    feature_params = dict(maxCorners=200, qualityLevel=0.01,
                          minDistance=7, blockSize=7)
    lk_params = dict(winSize=(15, 15), maxLevel=2,
                     criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT,
                               10, 0.03))

    # ── Phase 1: motion estimation ──
    if log_fn:
        log_fn('  Phase 1/3: 球面运动估计...')

    rotations = []
    ret, first = cap.read()
    if not ret:
        cap.release()
        return False, '无法读取视频帧'

    def _to_est_gray(frame):
        if is_stereo:
            if stereo_mode == 'left-right':
                frame = frame[:, :est_w]
            else:
                frame = frame[:est_h, :]
        small = cv2.resize(frame, (stabilizer.aw, stabilizer.ah))
        return cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)

    prev_gray = _to_est_gray(first)
    rotations.append(np.eye(3))

    for i in range(1, n_frames):
        ret, curr = cap.read()
        if not ret:
            break
        curr_gray = _to_est_gray(curr)
        R = stabilizer.estimate_rotation(prev_gray, curr_gray,
                                         None, lk_params, feature_params)
        rotations.append(R)
        prev_gray = curr_gray
        if progress_fn and i % 20 == 0:
            progress_fn((i / max(n_frames, 1)) * 40)

    cap.release()
    n_est = len(rotations)
    if progress_fn:
        progress_fn(40)

    # ── Phase 2: trajectory smoothing ──
    if log_fn:
        log_fn(f'  Phase 2/3: 轨迹平滑 (window={smoothing}, {n_est}帧)...')

    trajectory = [np.eye(3)]
    for R in rotations[1:]:
        trajectory.append(trajectory[-1] @ R)

    smoothed = _SphericalStabilizer.smooth_trajectory(trajectory, smoothing)
    # correction[i] = smoothed[i] @ inv(trajectory[i])
    corrections = []
    for i in range(n_est):
        try:
            inv_t = np.linalg.inv(trajectory[i])
        except np.linalg.LinAlgError:
            inv_t = np.eye(3)
        corrections.append(smoothed[i] @ inv_t)

    if progress_fn:
        progress_fn(50)

    # ── Phase 3: apply correction + write via ffmpeg pipe ──
    if log_fn:
        log_fn('  Phase 3/3: 应用球面旋转补偿...')

    # Output through ffmpeg pipe for quality control (CRF 16, near-lossless)
    out_ffmpeg = ffmpeg_path or 'ffmpeg'
    pipe_cmd = [
        out_ffmpeg, '-y',
        '-f', 'rawvideo', '-pix_fmt', 'bgr24',
        '-s', f'{w}x{h}', '-r', f'{fps}',
        '-i', '-',
        '-c:v', 'libx264', '-crf', '16', '-preset', 'fast',
        '-pix_fmt', 'yuv420p',
    ]
    if env and 'PATH' in env:
        pass
    pipe_cmd.append(out)

    try:
        proc = subprocess.Popen(
            pipe_cmd, stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
            env=env, creationflags=creationflags,
        )
    except Exception as e:
        return False, f'无法启动 ffmpeg 输出管道: {e}'

    cap = cv2.VideoCapture(inp)
    written = 0
    for i in range(n_frames):
        ret, frame = cap.read()
        if not ret:
            break

        R = corrections[i] if i < len(corrections) else np.eye(3)

        if is_stereo:
            # Split, stabilize each half with the SAME correction, recombine
            if stereo_mode == 'left-right':
                left = frame[:, :est_w]
                right = frame[:, est_w:]
                left_s = stabilizer.apply_correction(left, R)
                right_s = stabilizer.apply_correction(right, R)
                out_frame = np.hstack([left_s, right_s])
            else:  # top-bottom
                top = frame[:est_h, :]
                bot = frame[est_h:, :]
                top_s = stabilizer.apply_correction(top, R)
                bot_s = stabilizer.apply_correction(bot, R)
                out_frame = np.vstack([top_s, bot_s])
        else:
            out_frame = stabilizer.apply_correction(frame, R)

        # Edge fill: slight zoom to absorb compensation seams (wrap border)
        if border_zoom > 0:
            scale = 1.0 + border_zoom
            M = np.array([[scale, 0, w * (1 - scale) / 2],
                          [0, scale, h * (1 - scale) / 2]], dtype=np.float32)
            out_frame = cv2.warpAffine(out_frame, M, (w, h),
                                       borderMode=cv2.BORDER_WRAP)

        try:
            proc.stdin.write(out_frame.tobytes())
        except (BrokenPipeError, OSError):
            break
        written += 1

        if progress_fn and i % 20 == 0:
            progress_fn(50 + (i / max(n_frames, 1)) * 50)

    cap.release()
    try:
        proc.stdin.close()
    except Exception:
        pass
    _, stderr = proc.communicate(timeout=120)
    if proc.returncode != 0:
        tail = (stderr or b'').decode('utf-8', errors='replace')[-400:]
        return False, f'ffmpeg 输出失败: {tail}'

    if log_fn:
        log_fn(f'  球面防抖完成: {written}帧已稳定', 'success')
    if progress_fn:
        progress_fn(100)
    return True, None

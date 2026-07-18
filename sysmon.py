"""
sysmon.py - Global system resource monitor.

Samples CPU, GPU, memory, disk I/O, and network I/O at regular intervals
in a background thread. Runs continuously from app startup — NOT tied to
any specific process.

Designed as a singleton: call get_global_sysmon() to get the instance.

Graceful fallback:
  - psutil missing → empty data
  - pynvml missing / no NVIDIA GPU → GPU shows name (via WMI) but no utilization
  - All other metrics are system-wide via psutil
"""

import os
import platform
import subprocess
import threading
import time
import warnings

# Suppress pynvml deprecation FutureWarning (nvidia-ml-py provides same API)
warnings.filterwarnings("ignore", category=FutureWarning, module="pynvml")

# Global singleton instance
_global_sysmon = None
_global_lock = threading.Lock()


def get_global_sysmon(interval=2.0):
    """Get or create the global SysMon singleton."""
    global _global_sysmon
    if _global_sysmon is None:
        with _global_lock:
            if _global_sysmon is None:
                _global_sysmon = SysMon(interval=interval)
                _global_sysmon.start()
    return _global_sysmon


def shutdown_global_sysmon():
    """Stop the global SysMon if running (called at app exit)."""
    global _global_sysmon
    if _global_sysmon is not None:
        _global_sysmon.stop()
        _global_sysmon = None


class SysMon:
    """Background thread that samples system-wide resources every `interval` seconds."""

    def __init__(self, interval=2.0):
        self.interval = interval
        self._stop = threading.Event()
        self._thread = None
        self._data = {}

        # psutil state
        self._psutil_ok = False
        self._prev_disk = None
        self._prev_net = None
        self._prev_ts = 0.0

        # NVML state
        self._nvml_ok = False
        self._nvml_handle = None
        self._pynvml = None

        # GPU name (detected once)
        self._gpu_name = None
        self._gpu_name_checked = False

    # ── Lifecycle ──────────────────────────────────────────────

    def start(self):
        """Initialize counters and launch background thread."""
        # psutil
        try:
            import psutil
            psutil.cpu_percent(interval=None)          # prime baseline
            psutil.cpu_percent(interval=None, percpu=True)
            self._prev_disk = psutil.disk_io_counters()
            self._prev_net = psutil.net_io_counters()
            self._prev_ts = time.time()
            self._psutil_ok = True
        except ImportError:
            pass

        # pynvml (NVIDIA GPU)
        try:
            import pynvml
            pynvml.nvmlInit()
            self._nvml_handle = pynvml.nvmlDeviceGetHandleByIndex(0)
            self._pynvml = pynvml
            self._nvml_ok = True
            # Get GPU name from pynvml
            try:
                self._gpu_name = pynvml.nvmlDeviceGetName(self._nvml_handle)
                if isinstance(self._gpu_name, bytes):
                    self._gpu_name = self._gpu_name.decode('utf-8', errors='replace')
            except Exception:
                pass
        except Exception:
            self._nvml_ok = False

        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=2)
        if self._nvml_ok:
            try:
                self._pynvml.nvmlShutdown()
            except Exception:
                pass

    def snapshot(self):
        """Return a copy of the latest sample."""
        return dict(self._data)

    # ── Internal ───────────────────────────────────────────────

    def _run(self):
        while not self._stop.is_set():
            try:
                self._sample()
            except Exception:
                pass
            self._stop.wait(self.interval)

    def _detect_gpu_name(self):
        """Detect GPU name via WMI (Windows) or /proc (Linux)."""
        if self._gpu_name_checked:
            return
        self._gpu_name_checked = True
        try:
            if platform.system() == 'Windows':
                r = subprocess.run(
                    ['wmic', 'path', 'win32_VideoController', 'get', 'Name'],
                    capture_output=True, text=True, timeout=5
                )
                lines = [l.strip() for l in r.stdout.splitlines() if l.strip()]
                # First line is "Name" header
                gpus = [l for l in lines[1:] if l and not l.lower().startswith('name')]
                if gpus:
                    # Filter out virtual display adapters, prefer real GPUs
                    real = [g for g in gpus if 'virtual' not in g.lower()
                            and 'todesk' not in g.lower()
                            and 'remote' not in g.lower()
                            and 'basic' not in g.lower()
                            and 'microsoft' not in g.lower()]
                    self._gpu_name = (real[0] if real else gpus[0]) if gpus else None
            elif platform.system() == 'Linux':
                try:
                    with open('/proc/driver/nvidia/version') as f:
                        self._gpu_name = 'NVIDIA ' + f.read().splitlines()[0][:40]
                except Exception:
                    pass
        except Exception:
            pass

    def _sample(self):
        # Detect GPU name once (lazy)
        if self._gpu_name is None and not self._gpu_name_checked:
            self._detect_gpu_name()

        if not self._psutil_ok:
            # Even without psutil, try GPU
            data = {}
            if self._gpu_name:
                data['gpu_name'] = self._gpu_name
            if self._nvml_ok:
                self._sample_gpu(data)
            self._data = data
            return

        import psutil
        t = time.time()
        dt = t - self._prev_ts
        if dt <= 0:
            return

        data = {}

        # ── System CPU ──────────────────────────────────────────
        data['cpu_percent'] = round(psutil.cpu_percent(interval=None), 1)
        per_core = psutil.cpu_percent(interval=None, percpu=True)
        data['cpu_cores'] = [round(c, 1) for c in per_core]
        data['cpu_count'] = len(per_core)

        # ── System memory ──────────────────────────────────────
        vm = psutil.virtual_memory()
        data['mem_total_gb'] = round(vm.total / (1024**3), 1)
        data['mem_used_gb'] = round(vm.used / (1024**3), 1)
        data['mem_percent'] = round(vm.percent, 1)

        # ── Disk I/O rate ──────────────────────────────────────
        disk = psutil.disk_io_counters()
        if disk and self._prev_disk:
            data['disk_read_mbs'] = round(
                max(0, disk.read_bytes - self._prev_disk.read_bytes) / (1024**2) / dt, 1
            )
            data['disk_write_mbs'] = round(
                max(0, disk.write_bytes - self._prev_disk.write_bytes) / (1024**2) / dt, 1
            )
        self._prev_disk = disk

        # ── Network I/O rate ────────────────────────────────────
        net = psutil.net_io_counters()
        if net and self._prev_net:
            data['net_up_mbs'] = round(
                max(0, net.bytes_sent - self._prev_net.bytes_sent) / (1024**2) / dt, 3
            )
            data['net_down_mbs'] = round(
                max(0, net.bytes_recv - self._prev_net.bytes_recv) / (1024**2) / dt, 3
            )
        self._prev_net = net

        self._prev_ts = t

        # ── GPU ────────────────────────────────────────────────
        if self._gpu_name:
            data['gpu_name'] = self._gpu_name
        if self._nvml_ok:
            self._sample_gpu(data)

        self._data = data

    def _sample_gpu(self, data):
        """Sample NVIDIA GPU metrics into `data`."""
        try:
            pynvml = self._pynvml
            handle = self._nvml_handle
            util = pynvml.nvmlDeviceGetUtilizationRates(handle)
            data['gpu_percent'] = util.gpu
            data['gpu_mem_percent'] = util.memory

            mem_info = pynvml.nvmlDeviceGetMemoryInfo(handle)
            data['gpu_mem_total_mb'] = round(mem_info.total / (1024 * 1024), 0)
            data['gpu_mem_used_mb'] = round(mem_info.used / (1024 * 1024), 0)

            temp = pynvml.nvmlDeviceGetTemperature(
                handle, pynvml.NVML_TEMPERATURE_GPU
            )
            data['gpu_temp'] = temp

            # Encoder / Decoder utilization
            try:
                enc = pynvml.nvmlDeviceGetEncoderUtilization(handle, 0)
                data['gpu_enc_percent'] = enc[0]
            except Exception:
                pass
            try:
                dec = pynvml.nvmlDeviceGetDecoderUtilization(handle, 0)
                data['gpu_dec_percent'] = dec[0]
            except Exception:
                pass
        except Exception:
            pass

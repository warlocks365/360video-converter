"""
sysmon.py - System resource monitor for running ffmpeg jobs.

Samples CPU, GPU, memory, disk I/O, and network I/O at regular intervals
in a background thread. Designed to be attached to a running ffmpeg subprocess
(via its PID) to also report process-level resource usage.

Graceful fallback:
  - psutil missing → only GPU (if available) reported
  - pynvml missing → CPU/Mem/Disk/Net still reported, GPU shows N/A
  - No NVIDIA GPU → same as above
"""

import threading
import time
import warnings

# Suppress pynvml deprecation FutureWarning (nvidia-ml-py provides same API)
warnings.filterwarnings("ignore", category=FutureWarning, module="pynvml")


class SysMon:
    """Background thread that samples system resources every `interval` seconds."""

    def __init__(self, pid=None, interval=1.0):
        self.pid = pid
        self.interval = interval
        self._stop = threading.Event()
        self._thread = None
        self._data = {}

        # psutil state
        self._psutil_ok = False
        self._prev_disk = None
        self._prev_net = None
        self._prev_ts = 0.0
        self._proc_cache = []  # cached psutil.Process objects

        # NVML state
        self._nvml_ok = False
        self._nvml_handle = None
        self._pynvml = None

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

    def _sample(self):
        if not self._psutil_ok:
            # Even without psutil, try GPU
            if self._nvml_ok:
                self._sample_gpu()
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

        # ── Process CPU & memory (ffmpeg + children) ───────────
        if self.pid:
            try:
                parent = psutil.Process(self.pid)
                children = parent.children(recursive=True)
                all_procs = [parent] + children
                proc_cpu = 0.0
                proc_mem = 0
                for p in all_procs:
                    try:
                        proc_cpu += p.cpu_percent(interval=None)
                        proc_mem += p.memory_info().rss
                    except (psutil.NoSuchProcess, psutil.AccessDenied):
                        pass
                data['proc_cpu_percent'] = round(proc_cpu, 1)
                data['proc_mem_mb'] = round(proc_mem / (1024 * 1024), 1)
                data['proc_count'] = len(all_procs)
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                pass

        # ── System memory ──────────────────────────────────────
        vm = psutil.virtual_memory()
        data['mem_total_gb'] = round(vm.total / (1024**3), 1)
        data['mem_used_gb'] = round(vm.used / (1024**3), 1)
        data['mem_percent'] = round(vm.percent, 1)

        # ── Disk I/O rate ──────────────────────────────────────
        disk = psutil.disk_io_counters()
        if self._prev_disk:
            data['disk_read_mbs'] = round(
                (disk.read_bytes - self._prev_disk.read_bytes) / (1024**2) / dt, 1
            )
            data['disk_write_mbs'] = round(
                (disk.write_bytes - self._prev_disk.write_bytes) / (1024**2) / dt, 1
            )
        self._prev_disk = disk

        # ── Network I/O rate ────────────────────────────────────
        net = psutil.net_io_counters()
        if self._prev_net:
            data['net_up_mbs'] = round(
                (net.bytes_sent - self._prev_net.bytes_sent) / (1024**2) / dt, 3
            )
            data['net_down_mbs'] = round(
                (net.bytes_recv - self._prev_net.bytes_recv) / (1024**2) / dt, 3
            )
        self._prev_net = net

        self._prev_ts = t

        # ── GPU ────────────────────────────────────────────────
        if self._nvml_ok:
            self._sample_gpu(data)

        self._data = data

    def _sample_gpu(self, data=None):
        """Sample NVIDIA GPU metrics into `data` (or self._data)."""
        if data is None:
            data = self._data
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

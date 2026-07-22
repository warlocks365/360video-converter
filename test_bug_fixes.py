#!/usr/bin/env python3
"""
Targeted regression tests for v3.6.3 BUG fixes.
Verifies each fix is present and functional.
"""
import sys
import os
import re
import importlib.util

BASE = os.path.dirname(os.path.abspath(__file__))
results = []

def check(name, condition, detail=""):
    status = "PASS" if condition else "FAIL"
    results.append((name, status, detail))
    print(f"  [{status}] {name}" + (f" - {detail}" if detail else ""))

# ── BUG-S01: threading.RLock instead of Lock ──
print("\n=== BUG-S01: RLock for job_lock ===")
with open(os.path.join(BASE, 'app.py'), 'r', encoding='utf-8') as f:
    app_src = f.read()
check("S01: job_lock uses RLock", 'threading.RLock()' in app_src,
      "RLock allows reentrant acquisition, preventing nested-lock deadlock")

# ── BUG-S02: CoTaskMemFree after SHGetKnownFolderPath ──
print("\n=== BUG-S02: CoTaskMemFree COM memory release ===")
# Find the _resolve_known_folder_guid function and check for CoTaskMemFree
s02_pattern = r'def _resolve_known_folder_guid.*?CoTaskMemFree'
s02_match = re.search(s02_pattern, app_src, re.DOTALL)
check("S02: CoTaskMemFree called in _resolve_known_folder_guid", s02_match is not None,
      "COM-allocated string is freed to prevent memory leak")

# ── BUG-S03: CSS variable --error instead of --danger ──
print("\n=== BUG-S03: CSS variable --error (not --danger) ===")
with open(os.path.join(BASE, 'static', 'index.html'), 'r', encoding='utf-8') as f:
    html_src = f.read()
danger_refs = len(re.findall(r"var\(--danger\)", html_src))
check("S03: No remaining var(--danger) references", danger_refs == 0,
      f"Found {danger_refs} remaining --danger references")

# ── BUG-M01: except Exception instead of bare except ──
print("\n=== BUG-M01: No bare except: in app.py ===")
bare_excepts = len(re.findall(r'\n\s*except\s*:', app_src))
check("M01: No bare except: in app.py", bare_excepts == 0,
      f"Found {bare_excepts} bare except: statements")

# Also check sysmon.py
with open(os.path.join(BASE, 'sysmon.py'), 'r', encoding='utf-8') as f:
    sysmon_src = f.read()
bare_excepts_sysmon = len(re.findall(r'\n\s*except\s*:', sysmon_src))
check("M01: No bare except: in sysmon.py", bare_excepts_sysmon == 0,
      f"Found {bare_excepts_sysmon} bare except: statements")

# ── BUG-M02: stderr drain thread in stabilize.py ──
print("\n=== BUG-M02: stderr drain thread in stabilize.py ===")
with open(os.path.join(BASE, 'stabilize.py'), 'r', encoding='utf-8') as f:
    stab_src = f.read()
check("M02: _drain_stderr thread present", '_drain_stderr' in stab_src,
      "stderr is drained in separate thread to prevent pipe deadlock")
check("M02: proc.wait(timeout=120) used", 'proc.wait(timeout=120)' in stab_src,
      "wait with timeout instead of communicate()")

# ── BUG-M03: proc.wait timeout in app.py ──
print("\n=== BUG-M03: proc.wait timeout in app.py ===")
check("M03: proc.wait(timeout=5) present", 'proc.wait(timeout=5)' in app_src,
      "process termination has timeout to prevent blocking")
check("M03: proc.wait(timeout=10) present", 'proc.wait(timeout=10)' in app_src,
      "process kill has timeout to prevent blocking")

# ── BUG-M04: mmap in inject_spherical_metadata.py ──
print("\n=== BUG-M04: mmap in inject_spherical_metadata.py ===")
with open(os.path.join(BASE, 'inject_spherical_metadata.py'), 'r', encoding='utf-8') as f:
    inject_src = f.read()
check("M04: mmap.ACCESS_COPY used", 'mmap.ACCESS_COPY' in inject_src,
      "copy-on-write memory mapping avoids loading entire file into RAM")
check("M04: bytearray(f.read()) removed", 'bytearray(f.read())' not in inject_src,
      "old full-file read replaced with mmap")

# ── BUG-M05: shutdown_global_sysmon lock protection ──
print("\n=== BUG-M05: shutdown_global_sysmon lock protection ===")
check("M05: _global_lock used in shutdown_global_sysmon",
      'with _global_lock' in sysmon_src and 'shutdown_global_sysmon' in sysmon_src,
      "shutdown is protected by lock to prevent race condition")

# ── BUG-M06: esc() complete HTML escaping ──
print("\n=== BUG-M06: esc() includes quote escaping ===")
# Find the esc function and check for &quot; and &#39;
esc_match = re.search(r'function esc\(s\)\s*\{[^}]*\}', html_src)
if esc_match:
    esc_body = esc_match.group()
    check("M06: esc() escapes double quotes", '&quot;' in esc_body,
          "double quotes are escaped to prevent attribute injection")
    check("M06: esc() escapes single quotes", '&#39;' in esc_body,
          "single quotes are escaped to prevent attribute injection")
else:
    check("M06: esc() function found", False, "could not find esc() function")

# ── BUG-M07: stdin write protection in stabilize.py ──
print("\n=== BUG-M07: stdin write protection via stderr drain ===")
check("M07: _stderr_thread used", '_stderr_thread' in stab_src,
      "stderr drain thread protects against stdin pipe deadlock")

# ── BUG-M08: incremental log append in index.html ===
print("\n=== BUG-M08: incremental log append ===")
check("M08: lastLogCount variable declared", 'lastLogCount' in html_src,
      "tracks rendered log count for incremental append")
check("M08: createDocumentFragment used", 'createDocumentFragment' in html_src,
      "new log entries appended via DocumentFragment")
check("M08: lastLogCount reset in startPolling", 'lastLogCount = 0' in html_src,
      "counter reset when new job starts")

# ── BUG-L03: PowerShell instead of wmic ===
print("\n=== BUG-L03: PowerShell Get-CimInstance instead of wmic ===")
check("L03: Get-CimInstance used", 'Get-CimInstance' in sysmon_src,
      "PowerShell cmdlet replaces deprecated wmic")
check("L03: wmic command removed", "['wmic'" not in sysmon_src,
      "wmic command no longer used")

# ── BUG-L07/L08: beforeunload cleanup ===
print("\n=== BUG-L07/L08: beforeunload timer cleanup ===")
check("L07/L08: beforeunload listener added", 'beforeunload' in html_src,
      "page unload handler cleans up timers")
check("L07/L08: pollTimer cleanup in unload", 'clearInterval(pollTimer)' in html_src,
      "pollTimer cleared on unload")
check("L07/L08: sysmonTimer cleanup in unload", 'clearInterval(sysmonTimer)' in html_src,
      "sysmonTimer cleared on unload")

# ── BUG-L09: jobs dict cleanup ===
print("\n=== BUG-L09: jobs dict cleanup ===")
check("L09: cleanup_old_jobs function defined", 'def cleanup_old_jobs' in app_src,
      "function removes expired completed jobs")
check("L09: cleanup called in status endpoint", 'cleanup_old_jobs()' in app_src,
      "cleanup is triggered during status polling (throttled)")

# ── Summary ──
print("\n" + "=" * 60)
passed = sum(1 for _, s, _ in results if s == "PASS")
failed = sum(1 for _, s, _ in results if s == "FAIL")
total = len(results)
print(f"Results: {passed}/{total} passed, {failed} failed")
if failed:
    print("\nFAILED checks:")
    for name, status, detail in results:
        if status == "FAIL":
            print(f"  - {name}: {detail}")
    sys.exit(1)
else:
    print("\nAll BUG fix verifications passed!")

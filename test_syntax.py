#!/usr/bin/env python3
"""Syntax validation for all modified Python files."""
import py_compile
import sys

files = ['app.py', 'sysmon.py', 'stabilize.py', 'inject_spherical_metadata.py']
errors = 0
for f in files:
    try:
        py_compile.compile(f, doraise=True)
        print(f"  OK: {f}")
    except py_compile.PyCompileError as e:
        print(f"  FAIL: {f} - {e}")
        errors += 1

if errors:
    print(f"\n{errors} file(s) failed syntax check")
    sys.exit(1)
else:
    print("\nAll Python files passed syntax check")

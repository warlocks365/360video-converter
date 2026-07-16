@echo off
chcp 65001 >nul 2>&1
title 360° Video Converter

echo ╔══════════════════════════════════════════╗
echo ║     360° Video Converter                 ║
echo ║     ffmpeg + GSpherical 全景视频转换器    ║
echo ╚══════════════════════════════════════════╝
echo.

set PYTHON=C:\Users\warlocks\.workbuddy\binaries\python\envs\default\Scripts\python.exe
set APP_DIR=C:\Users\warlocks\WorkBuddy\2026-07-14-13-37-44\360video-converter

echo [启动] Python: %PYTHON%
echo [启动] App:    %APP_DIR%
echo.

start "" "http://localhost:8765"
"%PYTHON%" "%APP_DIR%\app.py"

pause

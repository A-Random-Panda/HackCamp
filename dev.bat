@echo off
rem Start the image API, ideas API and GUI together.
rem Ctrl+C or closing this window stops all three.
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\dev.ps1"
endlocal

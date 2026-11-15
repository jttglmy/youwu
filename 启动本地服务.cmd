@echo off
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0serve.ps1"
echo.
echo Server stopped. Press any key to close.
pause >nul

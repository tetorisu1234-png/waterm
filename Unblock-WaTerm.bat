@echo off
rem WaTerm installer: remove Mark-of-the-Web so SmartScreen does not warn.
rem Double-click this file. It runs Unblock-WaTerm.ps1 (auto-finds the latest WaTerm-Setup in Downloads).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Unblock-WaTerm.ps1" %*
echo.
pause

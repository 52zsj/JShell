@echo off
rem Double-click launcher for diagnose-startmenu.ps1
rem Keeps the window open so the report can be read / copied.
chcp 65001 >nul
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0diagnose-startmenu.ps1"
echo.
echo ============================================================
echo  Report above. Copy it all and send it back for analysis.
echo ============================================================
pause
endlocal

@echo off
rem Double-click launcher for fix-startmenu.ps1
rem
rem   double-click            -> preview only (nothing is deleted)
rem   run-fix-startmenu.cmd apply -> delete the leftovers and refresh icon cache
chcp 65001 >nul
setlocal
set "APPLY="
if /i "%~1"=="apply" set "APPLY=-Apply"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0fix-startmenu.ps1" %APPLY%
echo.
echo ============================================================
echo  To actually delete the listed items, run:
echo    "%~nx0" apply
echo  (or pass -Apply when calling the .ps1 directly)
echo ============================================================
pause
endlocal

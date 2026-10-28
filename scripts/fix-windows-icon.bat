@echo off
REM 清除 Windows 图标缓存，解决快捷方式/任务栏显示旧图标的问题
REM 以管理员身份运行此脚本

echo [1/4] 停止资源管理器...
taskkill /f /im explorer.exe >nul 2>&1

echo [2/4] 清除图标缓存...
del /f /s /q "%LocalAppData%\IconCache.db" >nul 2>&1
del /f /s /q "%LocalAppData%\Microsoft\Windows\Explorer\iconcache_*.db" >nul 2>&1
del /f /s /q "%LocalAppData%\Microsoft\Windows\Explorer\thumbcache_*.db" >nul 2>&1

echo [3/4] 注册表刷新图标...
reg add "HKEY_CLASSES_ROOT\exefile\shell\open\command" /ve /t REG_SZ /d "\"%%1\" %%*" /f >nul 2>&1

echo [4/4] 重启资源管理器...
start explorer.exe

echo.
echo 完成！如果图标仍不对，请重启电脑。
pause

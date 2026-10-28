; JShell 安装器自定义片段（由 electron-builder 的 nsis.include 引入）
;
; 背景：0.10.x 及更早的构建没有改 exe 的图标与产品名，那时安装出来的是
; 「Electron」快捷方式。用户覆盖安装新版本后，旧快捷方式不会自动消失，
; 开始菜单里就会出现「Electron」和「JShell 终端」两个条目（或只剩旧的那个）。
;
; 这里在安装时顺手清掉遗留项。只删文件名精确等于 Electron.lnk 的快捷方式，
; 不动其它任何东西 —— 正常软件不会叫这个名字，它是我们早期产物的特征。

!macro customInstall
  DetailPrint "清理旧版本快捷方式…"

  ; 用户级开始菜单（perMachine=false 时安装位置）
  Delete "$APPDATA\Microsoft\Windows\Start Menu\Programs\Electron.lnk"
  ; 全局开始菜单（早期用管理员安装时会落在这里）
  Delete "$COMMONPROGRAMS\Electron.lnk"
  ; 桌面
  Delete "$DESKTOP\Electron.lnk"
!macroend

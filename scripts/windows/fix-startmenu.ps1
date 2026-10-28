<#
.SYNOPSIS
  清理 JShell 旧版本残留的 Electron 快捷方式，并刷新 Windows 图标缓存。

.DESCRIPTION
  默认只「列出将要删除什么」，不实际删除。确认无误后加 -Apply 才执行。

  只处理满足以下任一条件的快捷方式（不会碰其它软件的快捷方式）：
    · 文件名是 Electron.lnk / Electron <版本>.lnk
    · 指向的 exe 已经不存在，且路径里含 JShell 或 Electron
    · 指向的 exe 的 ProductName 是 Electron（未改名的旧构建）

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\windows\fix-startmenu.ps1
  powershell -ExecutionPolicy Bypass -File scripts\windows\fix-startmenu.ps1 -Apply
#>

[CmdletBinding()]
param(
  [switch]$Apply
)

$ErrorActionPreference = 'Continue'

if ($env:OS -ne 'Windows_NT') {
  Write-Host '此脚本仅用于 Windows（未在 Windows 上运行时直接退出）。' -ForegroundColor Yellow
  exit 0
}


function Get-LnkInfo($path) {
  $shell = New-Object -ComObject WScript.Shell
  $lnk = $shell.CreateShortcut($path)
  $target = $lnk.TargetPath
  $product = ''
  if ($target -and (Test-Path -LiteralPath $target)) {
    try { $product = (Get-Item -LiteralPath $target).VersionInfo.ProductName } catch { }
  }
  [pscustomobject]@{
    Name     = [System.IO.Path]::GetFileNameWithoutExtension($path)
    Path     = $path
    Target   = $target
    TargetOk = [bool]($target -and (Test-Path -LiteralPath $target))
    Product  = $product
  }
}

$roots = @(
  (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'),
  (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs'),
  (Join-Path $env:USERPROFILE 'Desktop'),
  [Environment]::GetFolderPath('Desktop')
) | Select-Object -Unique | Where-Object { $_ -and (Test-Path -LiteralPath $_) }

$stale = @()
foreach ($root in $roots) {
  Get-ChildItem -LiteralPath $root -Recurse -Filter *.lnk -ErrorAction SilentlyContinue | ForEach-Object {
    $info = Get-LnkInfo $_.FullName
    $isElectronName = $info.Name -match '^Electron$|^Electron\s'
    $isDeadJshell = (-not $info.TargetOk) -and ($info.Target -match 'JShell|Electron')
    $isElectronProduct = $info.Product -eq 'Electron'
    if ($isElectronName -or $isDeadJshell -or $isElectronProduct) {
      $stale += $info
    }
  }
}

if ($stale.Count -eq 0) {
  Write-Host '没有发现需要清理的残留快捷方式。' -ForegroundColor Green
  Write-Host '若开始菜单仍显示旧图标，通常只是图标缓存，执行：' -ForegroundColor DarkGray
  Write-Host '  ie4uinit.exe -show   然后重启 explorer.exe' -ForegroundColor DarkGray
  exit 0
}

Write-Host '将清理以下快捷方式：' -ForegroundColor Yellow
foreach ($s in $stale) {
  Write-Host ("  - {0}" -f $s.Path) -ForegroundColor Yellow
  Write-Host ("      指向: {0}  （存在: {1} / 产品名: {2}）" -f $s.Target, $s.TargetOk, $s.Product) -ForegroundColor DarkGray
}

if (-not $Apply) {
  Write-Host ''
  Write-Host '以上为预览。确认后重新执行并加 -Apply 才会真正删除：' -ForegroundColor Cyan
  Write-Host '  powershell -ExecutionPolicy Bypass -File scripts\windows\fix-startmenu.ps1 -Apply' -ForegroundColor Cyan
  exit 0
}

foreach ($s in $stale) {
  try {
    Remove-Item -LiteralPath $s.Path -Force -ErrorAction Stop
    Write-Host ("  已删除 {0}" -f $s.Path) -ForegroundColor Green
  } catch {
    Write-Host ("  删除失败 {0}：{1}" -f $s.Path, $_.Exception.Message) -ForegroundColor Red
  }
}

Write-Host ''
Write-Host '刷新图标缓存…' -ForegroundColor Gray
try {
  # 让资源管理器重新读取图标，不改注册表、不重启系统
  Start-Process -FilePath 'ie4uinit.exe' -ArgumentList '-show' -NoNewWindow -Wait -ErrorAction Stop
  Write-Host '  已触发 ie4uinit -show' -ForegroundColor Green
} catch {
  Write-Host '  ie4uinit 调用失败，可手动重启资源管理器（任务管理器 → 重新启动 Windows 资源管理器）' -ForegroundColor Yellow
}
Write-Host ''
Write-Host '完成。若开始菜单仍是旧样子，请注销后重新登录。' -ForegroundColor Gray

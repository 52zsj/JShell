<#
.SYNOPSIS
  JShell 开始菜单 / 桌面快捷方式诊断（只读，不改任何东西）。

.DESCRIPTION
  排查「开始菜单里显示 Electron 图标和文字」这类问题。会把以下信息打印出来，
  方便判断到底是「新快捷方式没创建」还是「旧版本残留」还是「图标缓存」：

    1. 用户级与全局开始菜单里所有 .lnk 的名称、指向、图标位置
    2. 每个快捷方式指向的 exe 是否还存在、其产品名（ProductName）与文件描述
    3. 桌面上的 JShell / Electron 快捷方式
    4. 已安装的 JShell 版本（注册表卸载项）
    5. 便携版解压目录（便携版不会创建快捷方式，容易和安装版混淆）

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\windows\diagnose-startmenu.ps1
#>

$ErrorActionPreference = 'Continue'

if ($env:OS -ne 'Windows_NT') {
  Write-Host '此脚本仅用于 Windows（未在 Windows 上运行时直接退出）。' -ForegroundColor Yellow
  exit 0
}

$OutputEncoding = [System.Text.Encoding]::UTF8

function Write-Section($title) {
  Write-Host ''
  Write-Host ("== " + $title + " " + ('=' * [Math]::Max(0, 58 - $title.Length))) -ForegroundColor Cyan
}

function Get-LnkInfo($path) {
  $shell = New-Object -ComObject WScript.Shell
  $lnk = $shell.CreateShortcut($path)
  $target = $lnk.TargetPath
  $exists = $false
  $product = ''
  $desc = ''
  if ($target -and (Test-Path -LiteralPath $target)) {
    $exists = $true
    try {
      $vi = (Get-Item -LiteralPath $target).VersionInfo
      $product = $vi.ProductName
      $desc = $vi.FileDescription
    } catch { }
  }
  [pscustomobject]@{
    Name     = [System.IO.Path]::GetFileNameWithoutExtension($path)
    Path     = $path
    Target   = $target
    Icon     = $lnk.IconLocation
    TargetOk = $exists
    Product  = $product
    Desc     = $desc
    Modified = (Get-Item -LiteralPath $path).LastWriteTime
  }
}

function Show-LnkTable($items, $label) {
  if (-not $items -or $items.Count -eq 0) {
    Write-Host "  （$label 下没有快捷方式）" -ForegroundColor DarkGray
    return
  }
  foreach ($i in $items) {
    $flag = ''
    if (-not $i.TargetOk) { $flag = '  [目标已不存在]' }
    elseif ($i.Product -eq 'Electron') { $flag = '  [指向未改名的 Electron.exe]' }
    Write-Host ("  - {0}{1}" -f $i.Name, $flag) -ForegroundColor ($(if ($flag) { 'Yellow' } else { 'Gray' }))
    Write-Host ("      路径  : {0}" -f $i.Path) -ForegroundColor DarkGray
    Write-Host ("      指向  : {0}" -f $i.Target) -ForegroundColor DarkGray
    Write-Host ("      图标  : {0}" -f $i.Icon) -ForegroundColor DarkGray
    Write-Host ("      产品名: {0} / 描述: {1}" -f $i.Product, $i.Desc) -ForegroundColor DarkGray
    Write-Host ("      修改  : {0}" -f $i.Modified) -ForegroundColor DarkGray
  }
}

Write-Section '开始菜单（当前用户）'
$userStart = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
$allUserStart = Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs'

$userLnk = @()
if (Test-Path -LiteralPath $userStart) {
  $userLnk = Get-ChildItem -LiteralPath $userStart -Recurse -Filter *.lnk -ErrorAction SilentlyContinue |
    ForEach-Object { Get-LnkInfo $_.FullName }
}
Write-Host "  目录：$userStart" -ForegroundColor DarkGray
Show-LnkTable ($userLnk | Where-Object { $_.Name -match 'JShell|Electron|Electron' }) 'JShell/Electron 相关'

Write-Section '开始菜单（所有用户）'
$allLnk = @()
if (Test-Path -LiteralPath $allUserStart) {
  $allLnk = Get-ChildItem -LiteralPath $allUserStart -Recurse -Filter *.lnk -ErrorAction SilentlyContinue |
    ForEach-Object { Get-LnkInfo $_.FullName }
}
Write-Host "  目录：$allUserStart" -ForegroundColor DarkGray
Show-LnkTable ($allLnk | Where-Object { $_.Name -match 'JShell|Electron' }) 'JShell/Electron 相关'

Write-Section '桌面快捷方式'
$deskItems = @()
foreach ($desk in @(Join-Path $env:USERPROFILE 'Desktop', [Environment]::GetFolderPath('Desktop'))) {
  if (-not $desk -or -not (Test-Path -LiteralPath $desk)) { continue }
  Get-ChildItem -LiteralPath $desk -Filter *.lnk -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match 'JShell|Electron' } |
    ForEach-Object { $deskItems += Get-LnkInfo $_.FullName }
}
Show-LnkTable $deskItems '桌面'

Write-Section '已安装版本（注册表卸载项）'
$roots = @(
  'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
)
$found = $false
foreach ($r in $roots) {
  Get-ItemProperty $r -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -match 'JShell|Electron' } |
    ForEach-Object {
      $found = $true
      Write-Host ("  - {0}  v{1}" -f $_.DisplayName, $_.DisplayVersion) -ForegroundColor Gray
      Write-Host ("      安装位置: {0}" -f $_.InstallLocation) -ForegroundColor DarkGray
      Write-Host ("      卸载命令: {0}" -f $_.UninstallString) -ForegroundColor DarkGray
    }
}
if (-not $found) { Write-Host '  （没有找到 JShell / Electron 的卸载项）' -ForegroundColor DarkGray }

Write-Section '安装目录与便携版'
foreach ($base in @((Join-Path $env:LOCALAPPDATA 'Programs'), $env:ProgramFiles, ${env:ProgramFiles(x86)})) {
  if (-not $base -or -not (Test-Path -LiteralPath $base)) { continue }
  Get-ChildItem -LiteralPath $base -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match 'JShell|Electron' } |
    ForEach-Object {
      $exe = Get-ChildItem -LiteralPath $_.FullName -Filter *.exe -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match 'JShell|Electron' } | Select-Object -First 1
      $pn = if ($exe) { $exe.VersionInfo.ProductName } else { '' }
      Write-Host ("  - {0}  (exe: {1} / 产品名: {2})" -f $_.FullName, $(if ($exe) { $exe.Name } else { '无' }), $pn) -ForegroundColor Gray
    }
}

Write-Section '结论提示'
$electronLnk = @($userLnk + $allLnk + $deskItems) | Where-Object { $_.Name -eq 'Electron' -or $_.Product -eq 'Electron' }
$jshellLnk = @($userLnk + $allLnk) | Where-Object { $_.Name -like 'JShell*' }

if ($electronLnk.Count -gt 0) {
  Write-Host '  发现指向 Electron 的快捷方式（旧版本残留）：' -ForegroundColor Yellow
  $electronLnk | ForEach-Object { Write-Host ("    " + $_.Path) -ForegroundColor Yellow }
}
if ($jshellLnk.Count -eq 0) {
  Write-Host '  开始菜单里没有 JShell 快捷方式 —— 说明这次没有走安装版，或安装时未创建快捷方式。' -ForegroundColor Yellow
  Write-Host '  （便携版 exe 不会创建任何快捷方式；请确认运行的是 *-setup.exe）' -ForegroundColor Yellow
} else {
  Write-Host '  已存在 JShell 开始菜单快捷方式：' -ForegroundColor Green
  $jshellLnk | ForEach-Object { Write-Host ("    {0} → {1}" -f $_.Name, $_.Target) -ForegroundColor Green }
}
Write-Host ''
Write-Host '  如果 JShell 快捷方式已正确、但开始菜单仍显示旧图标/旧名字，那就是图标缓存：' -ForegroundColor DarkGray
Write-Host '    ie4uinit.exe -show      然后重启 explorer.exe' -ForegroundColor DarkGray
Write-Host ''

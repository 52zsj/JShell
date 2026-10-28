# Windows 本地打包手册

> 适用场景：macOS 交叉打包无法正确写入 exe 元数据（图标/名称），需要在 Windows 上原生构建。

## 一、环境准备

### 1. 安装 Node.js
- 下载 LTS 版本（22.x）：https://nodejs.org
- 安装时勾选 "Add to PATH"
- 验证：`node --version` 应输出 `v22.x.x`

### 2. 安装 Git（可选）
- https://git-scm.com/download/win
- 用于拉取代码

### 3. 获取代码
```powershell
# 方式 A：Git 拉取
git clone <仓库地址>
cd JShell

# 方式 B：从 Mac 拷贝
# 将项目目录打包传到 Windows，解压
```

### 4. 安装依赖
```powershell
npm install
```
> 如果 Electron 二进制下载慢，先设置镜像：
> ```powershell
> $env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
> $env:ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
> npm install
> ```

## 二、构建与打包

### 1. 构建
```powershell
npm run build
```

### 2. 打包 Windows
```powershell
$env:CSC_IDENTITY_AUTO_DISCOVERY="false"
node scripts/build-all.mjs --win --arch x64 --skip-build
```

> **不要在 Windows 上加 `--no-sign-edit`**：该参数会跳过 rcedit，exe 的图标与版本信息会退回
> Electron 默认值——这正是之前「任务栏显示 Electron 图标、开始菜单显示 Electron 名称」的原因。

> 产出目录：`release/<版本>/`
> - `JShell-<版本>-x64-setup.exe`（NSIS 安装版）
> - `JShell-<版本>-x64-portable.exe`（便携版）
> - `安装说明.txt` + `SHA256SUMS.txt`

### 3. 验证 exe 元数据
```powershell
# 右键 JShell.exe → 属性 → 详细信息，确认：
#   文件描述：JShell 终端
#   产品名称：JShell
#   文件版本：0.10.x

# 或用 PowerShell 查看：
(Get-Item "release\<版本>\win-unpacked\JShell.exe").VersionInfo | Format-List
```

### 4. 验证图标
安装后检查：
- 桌面快捷方式图标
- 开始菜单名称（应为"JShell 终端"）
- 任务栏图标

如果图标仍不对，运行 `fix-windows-icon.bat`（安装目录下，管理员权限）。

## 三、排错

### npm install 报错
- 检查 Node.js 版本：`node --version`（需 22.x）
- 清理重装：`rm -r node_modules package-lock.json; npm install`

### 打包报 "Invalid configuration"
- 检查 `electron-builder.yml` 是否有非法字段
- 运行 `npx electron-builder --help` 查看版本

### exe 元数据不对
- 确认 `electron-builder.yml` 顶层有 `executableName: JShell`
- 确认 `win` 段有 `executableName: JShell`
- 重新打包前先 `rm -r release/<旧版本>`

### 图标仍显示 Electron
- Windows 图标缓存顽固，运行 `fix-windows-icon.bat`
- 或手动删除 `%LocalAppData%\IconCache.db` 后重启

## 四、与 Mac 的差异

| 项目 | macOS 打包 | Windows 打包 |
| --- | --- | --- |
| exe 元数据 | 不完整（交叉编译限制） | 完整 |
| 图标 | 可能回退 Electron | 正确 |
| NSIS 安装器 | 需 wine/docker | 原生 |
| 速度 | 快 | 快 |

## 五、CI 打包（替代方案）

如果不想配本地环境，用 GitHub Actions：
1. 推代码到 GitHub
2. 打 tag：`git tag v0.10.1 && git push --tags`
3. CI 自动在 macOS/Windows/Ubuntu 三平台构建
4. 产物在 GitHub Releases 页面下载

详见 `.github/workflows/release.yml`。

## 开始菜单显示 Electron 的排查

桌面快捷方式正常、但开始菜单还是 Electron 图标和文字时，按顺序查：

**方式一（最简单）：双击 .cmd**

- `scripts\windows\run-diagnose-startmenu.cmd` —— 只读诊断，窗口不会自动关
- `scripts\windows\run-fix-startmenu.cmd` —— 预览要清理的项
- 预览确认后，在 cmd 窗口里再执行 `run-fix-startmenu.cmd apply` 才会真正删除

> 直接双击 `.ps1` 会「一闪就没了」：脚本执行完窗口就关闭，且默认执行策略可能直接拒绝。
> 用上面的 `.cmd` 会带 `chcp 65001` 并 `pause`，中文不会乱码、报表能停下来看。

**方式二：在已有终端里执行**

```powershell
# 1. 只读诊断：列出开始菜单/桌面所有相关快捷方式、指向、产品名、已安装版本
powershell -ExecutionPolicy Bypass -File scripts\windows\diagnose-startmenu.ps1

# 2. 预览要清理的残留项（不加 -Apply 只打印，不删除）
powershell -ExecutionPolicy Bypass -File scripts\windows\fix-startmenu.ps1

# 3. 确认后真正清理，并刷新图标缓存
powershell -ExecutionPolicy Bypass -File scripts\windows\fix-startmenu.ps1 -Apply
```

**方式三：仓库不在手边时的一行命令**

```powershell
Get-ChildItem "$env:APPDATA\Microsoft\Windows\Start Menu\Programs" -Recurse -Filter *.lnk |
  ForEach-Object {
    $l = (New-Object -ComObject WScript.Shell).CreateShortcut($_.FullName)
    "{0}  ->  {1}" -f $_.Name, $l.TargetPath
  }
```

只打印开始菜单里每个快捷方式的名字和指向，足以判断有没有遗留的 `Electron.lnk`。

三种典型结论：

| 诊断结果 | 含义 | 处理 |
| --- | --- | --- |
| 只有 `Electron.lnk`，没有 `JShell 终端.lnk` | 装的是**便携版**（便携版不创建任何快捷方式），或安装器没跑完 | 用 `*-setup.exe` 重新安装 |
| 同时有 `Electron.lnk` 和 `JShell 终端.lnk` | 旧版本残留 | `fix-startmenu.ps1 -Apply` 删旧的 |
| 只有 `JShell 终端.lnk`，图标却是旧的 | Windows 图标缓存 | `ie4uinit.exe -show`，或重启资源管理器 |

新版安装器已经内置清理（`build/installer.nsh` 的 `customInstall`），
覆盖安装时会自动删掉遗留的 `Electron.lnk`，不需要每台机器手工处理。

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
node scripts/build-all.mjs --win --arch x64 --skip-build --no-sign-edit
```

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

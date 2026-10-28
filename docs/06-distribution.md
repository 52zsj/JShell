# 分发与发布说明（内部渠道优先，预留公开下载）

> 定位：当前以**内网 / 内部工具分发**为主，产物未签名；将来开放公测下载时，只需配置凭据与更新地址，
> **不需要改动代码结构或打包命令**。

## 1. 产物清单

版本号来自 `package.json`（当前 `0.11.1`），所有文件名统一为 `JShell-<版本>-<架构>[-类型].<扩展名>`。

| 平台 | 产物 | 用途 | 说明 |
| --- | --- | --- | --- |
| macOS（Apple Silicon） | `JShell-0.11.1-arm64.dmg` | 安装版 | 拖入「应用程序」 |
| macOS（Apple Silicon） | `JShell-0.11.1-arm64.zip` | 安装版备份 | 适合脚本分发 |
| macOS（Apple Silicon） | `JShell-0.11.1-arm64-portable.zip` | **便携版** | 解压即用，数据写在 `JShell-Data` |
| macOS（Intel） | `JShell-0.11.1-x64.dmg` / `.zip` / `-portable.zip` | 同上 | 同一套配置产出 |
| Windows x64 | `JShell-0.11.1-x64-setup.exe` | 安装版 | NSIS 向导，**仅简体中文** |
| Windows x64 | `JShell-0.11.1-x64-portable.exe` | **便携版** | 单文件，双击即用，数据写在 exe 同级 `JShell-Data` |
| Linux（可选） | `JShell-0.11.1-x64.AppImage` / `.deb` | 非重点平台 | 保留能力，未做重点验证 |

产物目录还会生成两份中文文件：

- `安装说明.txt`：产物清单、macOS / Windows 安装与便携版用法、首次打开提示处理、数据与隐私说明；
- `SHA256SUMS.txt`：逐文件校验值，内网分发时可直接附在下载页。

每个安装包都内嵌：

- `release-meta.json`：版本、构建时间、分发渠道、更新地址（内部渠道为空）；
- `docs/manual.md`、`docs/privacy.md`、`docs/license.md`、`docs/CHANGELOG.md`：设置 → 关于 可直接打开；
- `tray/`：平台对应的托盘图标。

## 2. 一键构建

```bash
# 当前平台（安装版 + 便携版）
npm run dist:all

# 指定平台 / 架构
node scripts/build-all.mjs --mac --arch arm64,x64
node scripts/build-all.mjs --win --arch x64

# macOS 上没有 wine 时交叉构建 Windows 包（跳过 exe 图标/版本资源写入）
node scripts/build-all.mjs --win --no-sign-edit

# 有 Docker 时（推荐，产物元信息完整）
node scripts/build-all.mjs --win --docker
```

产物在 `release/<版本>/`，脚本结束时会打印中文清单与体积。

> **Windows 交叉构建的已知差异**：`--no-sign-edit` 会跳过 rcedit，因此 `JShell.exe` 使用 Electron 默认图标、
> 不含版本资源；安装包与功能不受影响。正式对外发布请走 CI 的 `windows-latest`（自带完整工具链），
> 或本地安装 wine 后使用 `--docker`。

## 3. 内部渠道：未签名 / 自签名

### 3.1 直接分发未签名包

- macOS：首次打开会提示「无法验证开发者」。用户可右键 → 打开，或执行：
  ```bash
  xattr -dr com.apple.quarantine /Applications/JShell.app
  ```
- Windows：SmartScreen 提示时点击「更多信息」→「仍要运行」。
- 建议在内网分发页附上 SHA-256 校验值：
  ```bash
  shasum -a 256 release/0.11.1/*
  ```

### 3.2 macOS 自签名（ad-hoc）

适合内网小范围分发，减少「已损坏」提示，但不等于公证：

```bash
codesign --force --deep --sign - /path/to/JShell.app
# 便携版需在加标记文件后重新签一次
```

### 3.3 Windows 自签名

用企业内 CA 或 PowerShell 生成自签名证书，再用 `signtool` 签名：

```powershell
$cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject "CN=JShell Internal" `
  -CertStoreLocation Cert:\CurrentUser\My
signtool sign /sha1 $cert.Thumbprint /fd SHA256 JShell-0.11.1-x64-setup.exe
```

自签名证书需要导入到目标机器的「受信任的根证书颁发机构」，否则仍会提示未知发布者。

## 4. 公开下载：代码签名与公证（已预留）

### 4.1 macOS

```bash
export CSC_LINK=/path/to/DeveloperID.p12
export CSC_KEY_PASSWORD=***
export APPLE_ID=dev@example.com
export APPLE_APP_SPECIFIC_PASSWORD=xxxx-xxxx-xxxx-xxxx
export APPLE_TEAM_ID=ABCDE12345
npm run dist:all -- --mac
```

- `CSC_LINK` 存在时 electron-builder 自动签名；
- `build/notarize.cjs` 在签名后自动调用 `xcrun notarytool submit --wait` 并 `stapler staple`；
- 未配置 `APPLE_*` 时钩子直接跳过，不会中断打包。

### 4.2 Windows

```bash
export CSC_LINK=/path/to/cert.pfx
export CSC_KEY_PASSWORD=***
npm run dist:all -- --win
```

或使用云签名服务（electron-builder 支持自定义 `sign` 钩子），替换 `win.sign` 配置即可，打包命令不变。

> 便携版 zip 在 macOS 上是在 electron-builder 产出后二次打包的，签名流程需要「先解压 → 加标记 → 重新签 → 再压缩」。
> 当前内部渠道不签名，因此未实现这段；公开下载时若需要签名便携版，建议改为在 `afterPack` 阶段写入标记文件。

## 5. 更新通道（已预留）

内部渠道默认：

```json
{ "channel": "internal", "updateUrl": "" }
```

应用启动与点击「检查更新」都不会发起任何网络请求，返回「当前为内部渠道，未配置更新检查地址」。

开放公测时：

```bash
JSHELL_CHANNEL=public \
JSHELL_UPDATE_URL=https://dl.example.com/jshell \
node scripts/build-all.mjs --mac --win
```

更新服务器只需提供一个静态文件 `https://dl.example.com/jshell/latest.json`：

```json
{
  "version": "0.11.1",
  "notes": "修复 SFTP 大文件传输偶发中断；新增端口转发面板。",
  "url": "https://dl.example.com/jshell/JShell-0.11.1-arm64.dmg",
  "publishedAt": "2026-11-01T10:00:00Z"
}
```

约束与安全：

- 只接受 `https` 地址（`shared/version.ts` 的 `isSafeReleaseUrl`）；
- 只在用户主动点击「检查更新」时请求，带 `Accept: application/json`，不带设备标识；
- 版本比较用内置实现（支持 `1.2.3` / `1.2.3-beta.1` / `v` 前缀），不引入 semver；
- 检查结果缓存 10 分钟，避免重复请求；
- 当前**不做静默下载与自动安装**；将来需要时替换 `services/update.ts` 的 Provider 实现即可，接口已抽象。

## 6. 许可与隐私

- `docs/license.md`：MIT 许可中文说明 + 英文原文 + 第三方组件清单；
- `docs/privacy.md`：数据清单、网络行为、删除方式、权限说明；
- 两份文档随包分发，设置 → 关于 与「帮助」菜单均可打开；
- 公开下载前请把隐私说明中的数据删除方式、联系方式补全为真实信息。

## 7. 无对外上报（可核查）

- 代码中没有任何统计 SDK、埋点、崩溃上报；
- 全应用只有两处出站网络：SSH/SFTP（用户发起）、公开渠道更新检查（用户点击）；
- 日志只写本地文件，可用「设置 → 关于 → 打开日志目录」查看内容；
- 可用 `grep -rn "fetch\\|https://" src/main` 复核网络调用点。

## 8. 发布检查清单

- [ ] `package.json` 版本号与 `CHANGELOG.md` 一致；
- [ ] `npm test` 全绿；
- [ ] macOS：dmg 可安装、zip 可解压、portable.zip 解压后 `portable: true`；
- [ ] Windows：setup.exe 安装向导为简体中文、portable.exe 可启动并生成 `JShell-Data`；
- [ ] 托盘图标、通知、开机自启在两个平台手动各验证一次；
- [ ] 计算并公布 SHA-256；
- [ ] 更新说明（`CHANGELOG.md`）随包与发布页同步；
- [ ] 若对外公开：完成签名与公证、更新地址可用、隐私说明已补全。

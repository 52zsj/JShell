# 跨平台一致性说明（macOS / Windows）

> 目标：Windows 与 macOS 不是「能跑就行」，而是同一套行为、同一套中文文案。
> 运行时：Electron 45 / Node 24；建议 macOS 12+、Windows 10 1809+。
> 本文记录每个能力在两个平台的实现方式、差异与验证方式，便于后续维护时不踩坑。

## 1. 能力矩阵

| 能力 | macOS | Windows | 一致性处理 |
| --- | --- | --- | --- |
| 本地终端 | `node-pty` + 登录 shell（`-l`） | `node-pty` + ConPTY，PowerShell 追加 `-NoLogo` | `services/shells.ts` 统一探测与启动参数 |
| 用户主目录 | `/Users/<name>` | `C:\Users\<name>` | 数据目录一律走 `app.getPath('userData')`，不拼字符串 |
| 私钥路径 | `~/.ssh/id_ed25519` | `%USERPROFILE%\.ssh\id_ed25519`、`~/` 也可 | `shared/paths.ts` 的 `expandUserPath()` 统一展开 |
| 路径分隔符 | POSIX `/` | `\`（同时接受 `/`） | 本地路径用 `node:path`；远端路径固定 POSIX（SFTP 协议要求） |
| 文件权限 | `0600`（配置与密钥文件） | Node 的 `mode` 参数被忽略，由 NTFS ACL 控制 | 写入时仍传 `0o600`，两个平台代码一致 |
| 数据目录可写性 | 检查并写探针文件 | 同左 | `app-env.ts` 的 `ensureWritableDir()`，不可写自动回退 |
| 托盘 | 菜单栏 Template Image（随深浅色反色） | 任务栏 `.ico`（多尺寸） | `services/tray.ts` 按平台选图标并 `setTemplateImage` |
| 系统通知 | Notification Center | 操作中心（依赖 AppUserModelId） | `services/notifications.ts` 统一去重与焦点判断 |
| 开机自启 | 登录项（是否隐藏启动由「启动后仅驻留托盘」控制） | 当前用户启动项 + `--hidden` | `services/login-item.ts` |
| 关闭窗口 | 默认隐藏到托盘 | 默认隐藏到托盘 | 同一设置项 `closeToTray`，主进程 `close` 事件拦截 |
| 便携版 | zip 解压 + 标记文件 | 单文件 portable exe（`PORTABLE_EXECUTABLE_DIR`） | 数据目录都落在程序目录的 `JShell-Data` |
| 安装包 | dmg（拖入应用程序） | NSIS 安装向导（简体中文） | electron-builder 一份配置 |
| 日志 | `logs/jshell-YYYY-MM-DD.log` | 同左 | 路径由 `app.getPath('userData')` 决定 |

## 2. 路径规则

```text
macOS    ~/.ssh/id_ed25519          → /Users/jay/.ssh/id_ed25519
Windows  ~/.ssh/id_ed25519          → C:\Users\Jay\.ssh\id_ed25519
Windows  %USERPROFILE%\.ssh\id_ed25519 → C:\Users\Jay\.ssh\id_ed25519
Windows  C:/Users/Jay/keys/a.pem    → C:\Users\Jay\keys\a.pem
```

- 只对 Windows 做 `/` → `\` 的归一化；POSIX 下的反斜杠是**合法文件名字符**，不能转换；
- 空路径不会被当成主目录（避免误操作把文件写到 `~`）；
- 远端路径始终使用 POSIX 语义，不做平台转换。

## 3. 权限与安全

| 项 | 实现 |
| --- | --- |
| 渲染进程权限 | `contextIsolation` + `sandbox` + `nodeIntegration: false`，只暴露白名单 API |
| 系统权限 | 只放行剪贴板；摄像头 / 麦克风 / 定位等一律拒绝 |
| 打开本地文件 | IPC 侧校验必须位于数据目录或资源目录内 |
| 打开链接 | 只允许 `https` |
| 凭据 | `safeStorage`（macOS 钥匙串 / Windows DPAPI）加密后单独存 `secrets.json` |
| 传输原子性 | 先写 `*.jshell-part`，成功后替换；失败只清理临时文件 |
| 日志脱敏 | 只记录状态与错误，不记录口令、私钥内容与终端输出 |

## 4. 托盘与通知

**托盘菜单**（两个平台完全一致，全中文）：

```text
显示主窗口
──────────
新建本地终端
新建 SSH 主机
──────────
设置…
检查更新
打开日志目录
──────────
退出 JShell
```

- macOS 使用 16pt Template Image（`build/tray/trayTemplate.png` + `@2x`），系统自动适配深浅色菜单栏；
- Windows 使用 `build/tray/tray-win.ico`（16–64 多尺寸），单击 / 双击图标恢复窗口；
- 托盘命令通过 `evt:app-command` 投递给渲染进程，与界面内操作复用同一套 store 动作。

**通知规则**：

- 只在窗口不处于焦点时发送；
- 相同内容 8 秒内去重；
- 用户关闭「系统通知」后完全不发送；
- 已知限制：未签名的 macOS 包在部分系统版本上不会出现在通知中心；Windows 便携版没有开始菜单快捷方式时，
  个别系统版本可能不显示通知（安装版正常）。这两点属于系统策略，不影响功能。

## 5. 开机自启与关闭行为

| 场景 | 行为 |
| --- | --- |
| 开启「开机自动启动」 | macOS 写入登录项；Windows 写 `HKCU\...\Run`（经 Electron 封装），命令行带 `--hidden`。需要隐藏启动时同时开启「启动后仅驻留托盘」（macOS 13+ 不再支持登录时隐藏） |
| 开启「启动后仅驻留托盘」 | 启动时不 `show()` 主窗口，只创建托盘 |
| 开启「关闭窗口时最小化到托盘」 | `close` 事件 `preventDefault()` + `hide()`，SSH 会话继续运行 |
| 托盘「退出 JShell」 | 设置退出标志 → 关闭 SSH / 端口转发 → 落盘布局 → 退出 |
| `⌘Q` / 系统退出 | 同上（`before-quit` 统一处理） |

> 便携版移动目录后，系统里登记的仍是旧路径：重新开关一次「开机自动启动」即可刷新。

## 6. 便携版判定顺序

```text
1. 环境变量 JSHELL_PORTABLE=1        （调试/特殊分发）
2. 环境变量 PORTABLE_EXECUTABLE_DIR   （Windows portable exe 自带）
3. 标记文件 jshell-portable.marker
   - macOS：与 JShell.app 同级
   - Windows：与 exe 同级
4. 都没有 → 安装版，使用系统用户目录
```

便携目录不可写（只读共享盘、光盘）时自动回退系统目录，并在日志中记录原因。

## 7. 验证记录

> 主进程行为（关闭到托盘、第二实例）无法从渲染层触发，项目中保留了 `JSHELL_E2E=1` 时才挂载的
> `globalThis.__jshellE2E` 测试钩子（不通过 IPC 暴露，正常运行不存在），配合 `--inspect` 驱动验证。

| 项 | 方式 | 结果 |
| --- | --- | --- |
| 设置页系统集成 / 关于 | CDP 驱动真实应用，读取 DOM 文本 | 6 个分区、4 个开关、7 个操作按钮均正确渲染 |
| 内部渠道更新检查 | 调用 `update.check()` | 返回 `disabled`，主进程日志无网络请求 |
| 托盘创建 | 主进程日志 | `托盘图标已创建` |
| 便携版数据目录 | 解压 portable zip 启动，读取 `app.info()` | `portable: true`，`userDataPath` 指向 `JShell-Data`，本地终端输出 `PORT_OK_arm64` |
| 开机自启 | 打包版调用 `settings.update({launchAtLogin})` | 开启后 `info.launchAtLogin === true`，关闭后回到 false |
| 关闭窗口到托盘 | 主进程 `win.close()`（`JSHELL_E2E=1` 时暴露的测试钩子触发） | 窗口数保持 1、`isVisible=false`、页面仍存活，日志写入「窗口已隐藏到托盘」 |
| 第二实例唤醒 | 隐藏后再次启动同一应用 | 第二实例退出码 0，主窗口重新显示（`isVisible=true`） |
| 菜单快捷键不抢占 | 检查「窗口 → 关闭窗口」 | 不使用 `role: 'close'`（其默认 Cmd+W 会抢掉应用内「关闭标签页」） |
| Windows 安装包 | 本机交叉构建（无 wine，跳过 rcedit） | 产出 `-setup.exe` 113.3 MB 与 `-portable.exe` 113.1 MB，PE 结构正确；exe 图标为 Electron 默认（CI 原生构建可补全） |

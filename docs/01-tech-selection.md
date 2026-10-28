# 技术选型对比与结论

> 目标：从零复刻一款类似 XTerminal 的跨平台 SSH / 终端管理工具。
> 约束：纯本地运行、无账号体系、依赖可商用、三平台安装包、一条命令打包。

## 1. 候选方案

| 编号 | 技术栈 | 典型代表 |
| --- | --- | --- |
| A | Rust + Tauri 2（系统 WebView） | Warp 的部分基础设施、Spacedrive |
| B | Go + Wails v2（系统 WebView） | 各类轻量桌面工具 |
| C | TypeScript + Electron（内置 Chromium） | VS Code、Tabby、Termius Desktop、XTerminal |
| D | C# / .NET 8 + Avalonia（自绘 UI） | 传统 .NET 桌面应用 |

## 2. 六维度对比

| 维度 | A. Rust + Tauri | B. Go + Wails | C. TS + Electron | D. C# + Avalonia |
| --- | --- | --- | --- | --- |
| **跨平台支持** | macOS/Windows/Linux 官方支持；但**渲染层依赖系统 WebView**：Linux 需 webkit2gtk（不同发行版版本差异大，Ubuntu 20.04/22.04/24.04 表现不一致），Windows 依赖 WebView2 Runtime（Win10 早期版本需引导安装）。终端场景对字体渲染、输入法、剪贴板要求高，WebView 差异是长期成本。 | 同 A（同样走系统 WebView），WebView 差异问题一致。 | **三平台一等公民**：自带 Chromium，字体/渲染/输入法/剪贴板行为完全一致，无需处理系统 WebView 版本碎片化。代价是包体与内存。 | macOS/Windows/Linux 均支持，**自绘渲染**，无 WebView 依赖，渲染一致性最好；但 Linux 下字体与 HiDPI 需要额外调校。 |
| **终端与 SSH 生态** | SSH：`russh`（纯 Rust）、`ssh2-rs`（libssh2 绑定）均可用，`russh-sftp` 提供 SFTP；终端仿真：`alacritty_terminal` 质量高但 API 面向 Alacritty 本体，需要自己写 VT 解析→网格→渲染的胶水层（含宽字符、真彩色、滚动缓冲、resize 重排）。**集成工作量最大**。 | SSH：`golang.org/x/crypto/ssh` 是事实标准，稳定且文档齐全；`github.com/pkg/sftp` 成熟。终端仿真：`vt10x` 一类库功能有限（256 色/真彩色/宽字符/滚动区支持不全），**需要自研大量 VT 逻辑**，这是 Go 方案最大短板。 | **生态最强**：`@xterm/xterm`（xterm.js）是 VS Code 同款终端内核，宽字符、真彩色、滚动缓冲、resize 重排、链接识别、搜索全部现成；`ssh2` 为纯 JS 实现（含 SFTP、端口转发、keyboard-interactive），无原生编译依赖；`node-pty` 可用于本地 shell。**零 VT 自研**。 | SSH：`SSH.NET`（Renci.SshNet，MIT）成熟，含 SFTP。终端仿真：`VtNetCore` 等库维护活跃度低，需要自行补 VM 与渲染；**风险偏高**。 |
| **性能 / 内存** | 最优：空载 RSS 约 80–150 MB，启动 < 1 s，二进制原生执行，适合超大输出（`cat` 大文件、`yes`）高频刷新。 | 优：空载 RSS 约 100–180 MB，GC 停顿对 60fps 终端刷新影响可控。 | 一般：单窗口 + 1 个终端 RSS 约 250–400 MB，冷启动 1–2 s。**但 SSH 场景瓶颈在渲染而非 JS 计算**，xterm.js 使用 canvas/WebGL 渲染器时，10w 行输出仍可流畅滚动。 | 良：空载 RSS 约 150–250 MB，启动较快；自绘渲染的滚动性能取决于实现质量。 |
| **打包体积** | 极优：8–18 MB（含 WebView 占位）。 | 优：10–20 MB。 | 差：**90–140 MB**（Electron 运行时 + Chromium）。本项目实测（macOS arm64，未压缩 DMG）约 100 MB 量级。 | 中：self-contained 约 60–90 MB；framework-dependent 约 15 MB 但要求用户装 .NET 运行时。 |
| **一键打包能力** | `tauri build` + `tauri-apps/tauri-action`，CI 成熟；但**不支持有意义的交叉编译**，需三平台 runner 各自构建。Linux 侧还需处理 AppImage/deb 依赖。 | `wails build` 三平台均需在对应系统构建；打包（dmg/NSIS/AppImage）需要自行准备脚本，生态弱于 electron-builder。 | **最强**：`electron-builder` 单条命令产出 dmg/zip、NSIS exe、AppImage/deb，一条 `--publish never` 即完成；GitHub Actions 矩阵是业界标准模板，签名/公证/自动更新链路完整。 | `dotnet publish` + 打包插件可完成，但三平台仍需各自 runner，安装器定制（NSIS/dmg）资料较少。 |
| **长期维护成本** | 高：Rust 学习曲线 + WebView 差异 + 终端 VT 胶水层自研，核心开发者门槛高，招聘面窄。 | 中：Go 上手快，但终端仿真能力需要长期补课（这恰恰是本产品的核心体验）。 | **低**：主进程/渲染进程同一语言（TS），IPC 契约用共享类型约束；xterm.js / ssh2 / electron-builder 均为长周期维护项目（VS Code、Tabby 等在用），升级路径清晰。风险主要是 Electron 大版本升级（约每年 1 次，需回归测试）。 | 中：C# 生态稳定，但 Avalonia + 终端控件组合的社区样本少，遇到渲染/输入法问题可参考的资料有限。 |

> 说明：体积与内存为同类产品的经验区间（依据 VS Code/Tabby 等公开数据与本地实测），不是本项目的精确基准测试；终端体验类指标（宽字符、真彩色、resize 重排）则以库能力为准，这部分差距是确定性的。

## 3. 评分汇总（1–5 分，越高越好）

| 维度 | 权重 | A. Rust+Tauri | B. Go+Wails | C. TS+Electron | D. C#+Avalonia |
| --- | --- | --- | --- | --- | --- |
| 跨平台一致性 | 20% | 3 | 3 | **5** | 4 |
| 终端 / SSH 生态 | 30% | 3 | 2 | **5** | 3 |
| 性能 / 内存 | 15% | **5** | 4 | 2 | 3 |
| 包体体积 | 10% | **5** | 4 | 1 | 3 |
| 一键打包 | 10% | 4 | 2 | **5** | 3 |
| 维护成本（越低越高分） | 15% | 2 | 4 | **5** | 3 |
| **加权总分** | 100% | **3.30** | **3.10** | **4.40** | **3.15** |

## 4. 结论：选 **C. TypeScript + Electron + React + xterm.js + ssh2**

### 为什么

1. **终端体验无法妥协，而 xterm.js 是唯一"开箱即用"的高质量 VT 实现。**
   本产品的差异化在终端本身：中文宽字符对齐、256/真彩色、`vim`/`htop`/`tmux` 的备用屏幕、resize 时重排、滚动缓冲、链接识别。这些在 xterm.js 里是成熟能力，在 Go/Rust/C# 方案里都需要自研或长期打磨——把最难的 30% 交给最成熟的库，是最划算的工程决策。

2. **打包链路的确定性仍然成立（即使引入本地终端）。**
   SSH 走纯 JS 的 `ssh2`；本地终端用 `node-pty`，而 node-pty 1.1 起提供 **N-API 预编译产物**（macOS arm64/x64、Windows x64/arm64），与 Electron ABI 解耦，**不需要 electron-rebuild**。
   Linux 在 `npm install` 时会源码编译（CI 的 ubuntu-latest 自带 gcc/make/python3），因此三平台矩阵仍是 `npm ci && npm run build && electron-builder`，不会出现 `NODE_MODULE_VERSION` 这类经典事故。
   需要注意的只有两点：`.node` 与 `spawn-helper` 必须 `asarUnpack`，且 spawn-helper 要保留可执行位（项目用 postinstall 脚本兜底）。

3. **一套语言、一份类型契约。**
   `src/shared` 里的 TS 类型同时被 main / preload / renderer 引用，IPC 参数与返回值编译期即校验，新增功能时三端同步改造成本最低——这正是"便于后续迭代"的直接体现。

4. **一键三平台打包是硬需求，electron-builder 是当前最省事的选择。**
   dmg/zip、NSIS、AppImage/deb 全部由同一份 `electron-builder.yml` 描述，Windows 的 NSIS 安装器定制（安装目录选择、桌面快捷方式）开箱可用。

### 代价与对策

| 代价 | 本项目采取的对策 |
| --- | --- |
| 安装包 ~100 MB | 只用 `electron-builder` 的 `files` 白名单打包 `out/`；渲染层依赖（react/xterm/zustand）作为 devDependencies 由 Vite 打进 bundle，不进 `node_modules`；已设置 `npmRebuild: false`；locale 资源裁剪（`electronLanguages`）尚未做，属待优化项。 |
| 内存占用偏高 | 单窗口 + 多标签复用同一渲染进程；SSH 数据在渲染进程内做 8ms 聚合批量写入，避免高频 IPC 与重渲染；终端实例常驻但隐藏标签不重绘（CSS display 切换 + `fit()` 校正）。 |
| 冷启动 1–2 s | 主进程不做同步 IO 阻塞（配置读取在 `whenReady` 之前完成且体积极小）；窗口 `show:false` + `ready-to-show` 避免白屏闪烁。 |
| Electron 大版本升级 | 主进程只使用 `app/BrowserWindow/dialog/safeStorage/ipcMain` 等稳定 API，未使用任何实验性接口，升级面小。 |

### 何时应该改选 A（Rust + Tauri）

若后续出现以下任一诉求，建议保留前端（React + xterm.js，可复用 ~90% UI 代码），把 SSH/SFTP/PTY 层替换为 Rust 侧实现（`russh` + `russh-sftp`），壳换成 Tauri：

- 安装包必须 < 20 MB，或需要绿色单文件分发；
- 内存预算必须 < 150 MB（低配机器 / 多开场景）；
- 需要内置本地 shell 且要求极低输入延迟（Rust PTY 直连）。

本项目的代码分层（`main/services` 全部通过 IPC 契约对外）已经为这次替换预留了边界：只要保持 `src/shared/api.ts` 的方法签名不变，替换后端不影响渲染层。

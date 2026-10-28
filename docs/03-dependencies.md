# 依赖清单与许可

> 平台能力（托盘 / 通知 / 开机自启 / 便携版 / 更新检查）未引入任何新依赖：
> 全部使用 Electron 内置 API 与 Node 自带 `fetch`，签名公证调用系统 `xcrun`。
>
> 原则：只引入**必需**依赖；所有运行时依赖必须为 MIT / ISC / Apache-2.0 / BSD 等可商用许可。
> 无 GPL / AGPL / SSPL 依赖。原生模块仅有 node-pty，其 N-API 预编译产物与 Electron ABI 解耦（无需 rebuild）。

## 运行时依赖（随安装包分发）

| 包 | 版本 | 许可 | 用途 | 说明 |
| --- | --- | --- | --- | --- |
| `ssh2` | 1.17.0 | **MIT** | SSH2 客户端：认证、PTY、SFTP、端口转发 | 纯 JS 实现（`cpu-features` / `sshcrypto` 为可选加速，未安装也不影响功能）；含 `ssh2-streams` 等子依赖，均为 MIT |
| `node-pty` | 1.1.0 | **MIT** | 本地终端：forkpty / ConPTY | Microsoft 维护（VS Code 同款）。1.1 起内置 **N-API 预编译产物**（darwin-arm64/x64、win32-x64/arm64），无需 electron-rebuild；Linux 在 install 时源码编译 |

> 这两个包是本项目**仅有的**运行时依赖，会随安装包分发。node-pty 的 `.node` 与 `spawn-helper` 必须通过 `asarUnpack` 解包到 `app.asar.unpacked`，且 spawn-helper 需保留可执行位（`scripts/fix-native-perms.mjs` 在 postinstall 兜底）。
> 渲染层用到的 `react` / `@xterm/*` / `zustand` 全部列在 `devDependencies`：它们由 Vite 打包进 `out/renderer`，运行时不需要 `node_modules`，可省下约 15 MB 体积。

## 前端依赖（构建期打包进 renderer）

| 包 | 版本 | 许可 | 用途 |
| --- | --- | --- | --- |
| `@xterm/xterm` | 5.5.0 | **MIT** | 终端内核（VT 解析、渲染、滚动缓冲、选区、真彩色） |
| `@xterm/addon-fit` | 0.10.0 | **MIT** | 根据容器尺寸自动计算行列数 |
| `@xterm/addon-web-links` | 0.11.0 | **MIT** | 终端内 URL 识别与点击 |
| `react` / `react-dom` | 18.3.1 | **MIT** | UI 框架 |
| `zustand` | 5.0.16 | **MIT** | 轻量全局状态（约 1 KB） |

> `@xterm/addon-search` 已引入用于终端内搜索，MIT 许可；其余 `@xterm/addon-*` 同许可。

## 构建 / 打包工具链（不随产物分发）

| 包 | 版本 | 许可 | 用途 |
| --- | --- | --- | --- |
| `electron` | 33.4.11 | MIT | 桌面运行时（Chromium + Node） |
| `electron-vite` | 2.3.0 | MIT | main / preload / renderer 三段式构建 |
| `vite` | 5.4.21 | MIT | 打包器 |
| `@vitejs/plugin-react` | 4.7.0 | MIT | React JSX 转换 + Fast Refresh |
| `electron-builder` | 25.1.8 | MIT | 三平台安装包（dmg / NSIS / AppImage / deb） |
| `typescript` | 5.9.3 | Apache-2.0 | 类型系统 |
| `@types/*` | — | MIT | 类型声明（`@types/ssh2`、`@types/react`、`@types/node`） |

## 刻意未引入的依赖

| 候选 | 不用的原因 |
| --- | --- |
| `electron-store` | v10 起为 ESM-only，与主进程 CJS 输出冲突；自研 JSON 存储仅 200 行，且能精确控制原子写入与字段加密 |
| `ssh2-sftp-client` | 只是 `ssh2` 的薄封装，直接使用 `ssh2` 的 SFTP API 可少一层依赖与错误转换 |
| `react-icons` / `lucide-react` | 图标用 20 个手写 SVG（`src/renderer/src/icons.tsx`）即可覆盖，省一个依赖 |
| `xterm-addon-attach` | 需要 WebSocket 后端；本项目主进程直连 SSH，走 IPC 更直接 |

## 许可合规

- 本项目自身：MIT
- 全部依赖：MIT / Apache-2.0，允许商用、闭源分发、修改后再分发
- Electron 内置 Chromium 的第三方许可文件由 electron-builder 自动打入安装包（`LICENSES.chromium.html`）
- 若要二次分发，请在「关于」页保留 Electron / Chromium 许可声明（`electron-builder` 默认已包含），本项目 `LICENSE` 中保留原版权声明即可

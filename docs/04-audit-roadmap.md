# JShell 代码审计与迭代路线

> 历史快照：本文件记录的是 v0.1.0 时点的审计（35 个 TS/TSX 文件、约 5.5k 行、23 个用例）；
> 当前实现与用例数以 README / CHANGELOG 为准。
> 结论只针对**现有架构**（撰写时为 Electron 33 + React 18 + xterm.js + ssh2 + node-pty；引擎现已升级到 45，其余栈不变），不引入替代框架。

## 0. 第一批（0. 地基）已落地

已按本文第六节"第一批"实施并验证，**没有改动任何既有 IPC 签名或交互语义**：

| 项 | 落地内容 | 验证方式 |
| --- | --- | --- |
| Q2 传输原子性 | 下载/上传都先写 `*.jshell-part` 再原子替换（下载用 `rename`，Windows 下失败退化；上传优先 `ext_openssh_rename`），失败只清理临时文件 | `tests/sftp-atomic.test.mjs` 5 个用例：成功/失败 × 上传/下载 + 名称校验，**23/23 通过** |
| Q3 导航/权限加固 | 新增 `will-navigate` 全拦截（仅 http(s) 交给系统浏览器）+ `setPermissionRequestHandler` 白名单（只放行剪贴板） | CDP 实测 `location.href = 'file:///etc/hosts'` 被拦截，页面不变 |
| Q7 名称校验 | 渲染层即时提示 + 主进程 `assertSafeName()`（拒绝空名、`.`/`..`、`/`、`\`、`\0`、>255 字符），用于 mkdir / rename | 单测覆盖 8 种输入 |
| Q6 快捷键边界 | 弹窗打开或焦点在表单控件（xterm 的 helper textarea 除外）时不吃全局快捷键 | CDP 实测 8 步：弹窗内 ⌘N/⌘T 无效、终端内 ⌘D/⌘T 正常、输入框内 ⌘T 无效 |
| Q9 传输进度 | 完成/失败沿用最后一次字节数，不再闪回 0 B；`total` 由进度回调补全 | 代码审查 |
| Q10 死代码 | 删除 `writeTerminal`/`hasPassword`/`activePaneOf`/未用导入/只写字段；`sync.ts` 保留为文档化的预留接口 | `tsc` 零告警 |
| Q11 文案重复 | 抽 `SESSION_STATUS_TEXT` 到 `shared/types.ts` | `tsc` |
| Q14 裸 F 键 | 绑定必须含修饰键，避免吞掉终端 F5 | 单测 `specFromEvent` 用例 |
| Q1 测试骨架 | `tests/` 4 个文件 23 个用例，`npm test` 走 Node 内置 runner + `--experimental-strip-types`，**零新增依赖**；CI 已加 `npm test` 步骤 | `npm test` 23/23 |

顺带开启 `noUnusedLocals` / `noUnusedParameters` / `noFallthroughCasesInSwitch`，防止死代码回流。

## 0.1 第二批（用户可感知）已落地

| 项 | 落地内容 | 验证 |
| --- | --- | --- |
| P1 设置写入节流 | 新增 `previewSettings`（本地即时生效）+ 180ms 节流落盘；拖字号/改字体不再每次 IPC + 写盘 | CDP 操作 + 代码审查 |
| F3 右键菜单 | 复制/粘贴/全选/搜索/清屏/向右分屏/向下分屏/关闭分屏，坐标自动收进视口 | CDP：菜单 8 项，点击分屏后 panes 3→4 |
| F2 终端搜索 | `@xterm/addon-search`，⌘F 打开，增量匹配 + `当前/总数` + Enter/⇧Enter | CDP：搜索条出现、计数渲染 |
| F4/Q4/Q5 指纹 | 键改为 `host:port:算法`（从公钥 blob 解析）；不匹配抛事件弹窗；「信任并重连」写新指纹；删除主机清理该端点指纹；v1→v2 一次性迁移 | 假 sshd + 错误指纹：弹窗显示两枚指纹，信任后 state.json 被覆盖 |
| F1 布局持久化 | `layout.json` 只存结构，400ms 合并写；启动恢复为 `closed` 不自动重连 | CDP：重启后 1 标签 4 分屏全部恢复并显示「点击重新连接」 |
| **B 拖拽吸附** | 标签/分屏拖到左/右/上/下边缘即并排；整标签并入后原标签消失；同标签内可重排 | 9 个单测 + CDP：3 标签 → 1 标签 3 分屏（含嵌套） |

## 一、分析范围与方法

### 1.1 覆盖的模块

| 层 | 文件 | 关注点 |
| --- | --- | --- |
| 共享契约 | `src/shared/{types,ipc,api}.ts` | 类型是否与实现一致、新增能力的扩展成本 |
| 主进程 | `src/main/index.ts`、`ipc.ts`、`services/*`（store / session-manager / ssh-session / local-session / shells / sftp / tunnels / sync / clipboard / output-buffer） | 资源生命周期、错误处理、原生模块打包、数据落盘 |
| 预加载 | `src/preload/index.ts` | 白名单边界、事件订阅泄漏 |
| 渲染层 | `App.tsx`、`store.ts`、`pane-tree.ts`、`terminal-registry.ts`、`shortcuts.ts`、`components/*`、`styles.css` | 重渲染粒度、状态一致性、键盘边界、DOM 生命周期 |
| 构建与发布 | `electron.vite.config.ts`、`electron-builder.yml`、`scripts/*`、`.github/workflows/release.yml`、`package.json` | 产物体积、原生模块、CI 可复现性 |
| 文档 | `docs/01~03` | 与实现是否仍然一致（已核对，第二阶段改动已同步） |

### 1.2 方法

1. **全量通读**上述文件（不是抽样），记录状态机与资源所有权。
2. **静态诊断**：`tsc --noEmit --noUnusedLocals` 扫死代码；`grep` 统计每个导出符号的真实引用次数（只有 1 次 = 仅定义）。
3. **真实运行验证**：用 CDP 驱动打包后的 `.app`（`--remote-debugging-port`）跑本地终端 / SSH（自建假 sshd）/ 分屏 / 快捷键，确认「问题」不是纸面推测。
4. **产物检查**：`app.asar` 1.5 MB、`asar.unpacked` 含 node-pty、dmg 96 MB；确认白名单没有把源码/文档打进去。

### 1.3 明确的边界

- **未在 Windows / Linux 实机跑过**（本机只有 macOS）。涉及 Windows 路径、ConPTY、Linux 字体/WebKit 的问题只能标为「待验证」，不给结论。
- 未做长时间稳定性压测（8 小时以上、上千次连接），内存趋势结论仅基于代码结构推断。
- 未审计第三方依赖内部代码（`ssh2` / `node-pty` / `xterm` 均按可信上游处理）。

---

## 二、功能增强

| # | 当前问题 | 改进方案 | 预期收益 | 优先级 | 成本 | 变更类型 |
| --- | --- | --- | --- | --- | --- | --- |
| F1 | 关闭应用后分屏布局、标签、本地终端的工作目录全部丢失；每次重启要从头点 | 把 `TerminalTab.root`（已是纯数据：`kind/hostId/shellPath`）序列化进 `state.json`，启动时恢复布局但**不自动重连**（显示"已断开，点击重连"） | 每天重复搭建工作区的成本归零；这是终端类工具最高频的抱怨点 | 高 | 1 人天 | 新增字段，向后兼容 |
| F2 | 终端内无法搜索输出（`@xterm/addon-search` 未引入） | 引入同族小包 `@xterm/addon-search`（MIT），`⌘/Ctrl+F` 打开搜索条，复用现有快捷键体系 | `tail -f` / 编译日志场景刚需；实现只有搜索条 UI + 3 个 API 调用 | 高 | 0.3 人天 | 新增依赖 |
| F3 | 终端区域右键无任何反应，复制/粘贴只能靠快捷键 | 新增上下文菜单组件：复制（有选区时）/ 粘贴 / 清屏 / 全选 / 分屏 / 关闭分屏 | 可发现性提升；新用户不查文档也能复制 | 高 | 0.5 人天 | 纯新增 |
| F4 | 主机公钥指纹变化时只报错「请删除主机后重新添加」，没有对比与信任入口 | 新增 `hostkey:mismatch` 事件 + 弹窗（展示旧/新 SHA256），按钮「信任新指纹」→ 覆盖 `knownHosts` | 消除"要么删主机要么关校验"的粗鲁二选一；安全操作变得可执行 | 高 | 0.5 人天 | 新增 IPC |
| F5 | 无法导入已有 `~/.ssh/config`，几十台机器要手输 | 只在主进程解析（`Host`/`HostName`/`User`/`Port`/`IdentityFile`/`ProxyJump` 忽略），预览后批量导入，标记 `source: 'ssh-config'` 避免重复导入 | 面向目标用户（运维/后端）的"第一分钟体验"决定性功能 | 中 | 1 人天 | 纯新增 |
| F6 | SFTP 只能单文件下载、单文件上传，无取消 | 多选下载（目录则递归）、目录上传（遍历本地目录建远端层级）、`AbortController` 取消、下载后"用本地编辑器打开并回传" | 补齐"当文件管理器用"的闭环；是目前最明显的功能缺口 | 中 | 2 人天 | 扩展 IPC 参数 |
| F7 | 本地终端没有文件面板（切到文件会提示不支持） | 新增 `local-fs` 服务（`fs.readdir` / `trash` 删除 / `shell.openPath`），复用 `FileEntry` 与 `FilesPanel` | 本地/远端体验一致；也能顺带支持"在 Finder 中显示" | 中 | 1 人天 | 纯新增 |
| F8 | 端口转发只有后端（`tunnels.ts` 已能跑 `-L`），没有 UI | 标签栏加「转发」抽屉：列表 + 启停 + 复制本地地址；后端接口不动 | 盘活已写好的 200 行代码，覆盖"连内网数据库"的高价值场景 | 中 | 1 人天 | 纯新增 |
| F9 | 终端配色与应用主题独立，浅色模式下终端仍是深色 | 终端配色下拉增加「跟随应用主题」（映射到 `github-light` / `one-dark`） | 减少一次手调；视觉一致性 | 低 | 2 小时 | 纯新增 |
| F10 | 窗口大小/位置不记忆，每次打开都是默认 1280×820 | 监听 `resize`/`move`（防抖 500 ms）存 `state.json`，启动时校验是否在可见屏幕内 | 小但每天都能感知 | 低 | 2 小时 | 新增字段 |
| F11 | 标签不能拖动排序（分屏内也不能换位置） | 标签栏用 pointer 事件做水平拖拽重排；分屏暂不做（成本高收益低） | 多标签时的整理效率 | 低 | 0.5 人天 | 纯新增 |
| F12 | 想临时连一台机器必须先保存成主机 | 「快速连接」输入 `user@host:port` 直接开会话，可选择"保存为常用" | 降低一次性运维场景的摩擦 | 低 | 0.5 人天 | 纯新增 |
| F13 | 命令片段是纯静态文本，无法带上下文 | 支持占位符 `{{host}}` `{{user}}` `{{port}}` `{{cwd}}`，发送前替换 | 片段复用率提升（同一套命令跨机器） | 低 | 0.5 人天 | 纯新增 |
| F14 | 没有会话审计/复现能力 | 在 `terminal-registry.pushTerminalData` 旁路录制 asciinema cast v2（JSON 行）到 `~/.jshell/recordings`，默认关闭 | 排障、交接、教学；实现只挂一个钩子 | 低 | 1 人天 | 纯新增 |
| F15 | 配置只在本地单机，换机要重配 | 导出/导入加密配置包（`state.json` + `secrets.json` 用用户口令派生密钥重加密） | 换机迁移；也是"无云端"卖点的补强 | 低 | 0.5 人天 | 纯新增 |
| F16 | 断线后只能手动点「重新连接」 | 可选自动重连（指数退避 1/2/4/8s，最多 5 次），**默认关闭**并在设置里开关 | 弱网/笔记本休眠场景体验明显 | 中 | 0.5 人天 | 会改变行为，需默认关 |

---

## 三、性能优化

| # | 当前问题 | 改进方案 | 预期收益 | 优先级 | 成本 | 变更类型 |
| --- | --- | --- | --- | --- | --- | --- |
| P1 | 设置面板每拖一格字号、每敲一个字体字符，都会走 `IPC → updateSettings → persistState()`（`store.ts:108` 是**同步** `writeFileSync`），同时把整份 settings 回推并触发**每个**终端重设 options + `fit()` | 渲染层 250 ms 防抖（滑块拖动时只更新本地 state，松手/停止输入才落盘）；主进程侧 `persistState` 改为 300 ms 合并写（保留退出前 flush） | 拖动字号从"每帧一次磁盘写 + N 个终端重排"降到 1 次；多分屏时掉帧明显改善 | 高 | 2 小时 | 无接口变更 |
| P2 | 文件面板一次性渲染全部条目（`FilesPanel.tsx:199` `entries.map`），`/usr/bin`、`node_modules` 这类 3–10k 项会卡 | 先上零依赖方案：`.files-row { content-visibility: auto; contain-intrinsic-size: 32px }`；不够再上固定行高虚拟列表（~80 行） | 大目录首屏从数百 ms 降到 <50 ms；内存下降 | 中 | 0.5 小时 / 0.5 人天 | 纯样式 / 纯组件 |
| P3 | 分屏拖拽时每个 `pointermove` 都 `set()` 整棵树，React 会重建所有 pane 元素（含隐藏标签页的） | 用 `requestAnimationFrame` 合并到每帧一次；`PaneTree` 用 `React.memo` 并对 `node` 做引用比较 | 3+ 分屏拖拽时掉帧消失 | 中 | 1 小时 | 无接口变更 |
| P4 | 递归删除/递归建目录是串行 `await`（`sftp.ts`），删 `node_modules` 要等很久 | 层级遍历后按并发 8 的池执行（失败项收集后统一报错） | 大树删除从 O(n) 次往返串行变为 8 路并行，通常快 4–6 倍 | 中 | 2 小时 | 无接口变更 |
| P5 | 大输出（`cat` 大文件、`yes`）在集成显卡/高分屏下滚动丢帧 | 引入 `@xterm/addon-webgl`（MIT），加载失败自动回退 canvas（`onContextLoss` 处理） | 帧率与 CPU 占用改善，尤其 4K/外接屏 | 中 | 0.3 人天 | 新增依赖 |
| P6 | `App` 订阅整个 `tabs` 数组，任一分屏状态变化（connecting→ready）都会重建全部 pane 的 React 元素 | 拆分 selector（`activeTabId` / 每 tab 单独订阅），`SessionPane` 用 `memo`；状态更新走 `useSyncExternalStore` 的浅比较 | 标签多时状态切换更轻 | 低 | 0.5 人天 | 无接口变更 |
| P7 | 打包 96 MB（Electron 固有），`compression: normal` | 改 `compression: maximum` + 关闭不需要的语言包（`electronLanguages: ['zh_CN','en']`） | 安装包可降 8–15 MB | 低 | 1 小时 | 构建配置 |
| P8 | 冷启动 1–2 s（Electron 固有），`bootstrap` 一次并发 5 个 IPC | 已并行，收益有限；可把 `app:shells` 探测延迟到首次展开"本机"分组 | 启动感知略快（几十 ms） | 低 | 1 小时 | 无 |

> 已确认**不需要**优化的点：终端输出侧 8 ms/64 KB 聚合（实测大输出不卡）、SFTP 传输进度节流（120 ms）、xterm 实例常驻 + DOM reparent（分屏重排无重连、无历史丢失）。

---

## 四、代码质量 / 安全 / 错误处理 / 边界

| # | 当前问题 | 改进方案 | 预期收益 | 优先级 | 成本 | 变更类型 |
| --- | --- | --- | --- | --- | --- | --- |
| Q1 | **零自动化测试**（仓库内无任何 `*.test.*`） | 用 Node 内置 runner，**不新增依赖**：`node --test --experimental-strip-types`。已验证可直接跑 TS 源码（3 个 `pane-tree` 用例 3/3 通过）。首批覆盖：`pane-tree`（增删/折叠/比例夹取）、`shortcuts`（normalize/match 边界）、`store` 的 `upsertHost` 校验 | 分屏与快捷键是最容易回归的两块，纯函数覆盖率可到 100% | 高 | 0.5 人天 | 新增 `tests/` + npm script |
| Q2 | **下载失败会删掉目标文件**（`sftp.ts:144` `unlink(localPath)`）。若用户选择覆盖已有文件，中途失败后原文件已被截断再删除，数据丢失 | 下载先写 `xxx.part`，成功后 `rename` 原子替换；失败只删 `.part` | 消除一类真实数据丢失 | 高 | 1 小时 | 无接口变更 |
| Q3 | **缺少 `will-navigate` 拦截**：只设了 `setWindowOpenHandler`（`index.ts:48`），页面若被导航走（恶意/误触链接、拖入文件）会整窗跳转 | `webContents.on('will-navigate', e => e.preventDefault())`，仅允许 devtools/reload 的内部导航；再加 `session.setPermissionRequestHandler` 一律拒绝（当前无任何需要授权的能力） | 补齐 Electron 三大常规加固中最缺的一环 | 高 | 0.5 小时 | 无 |
| Q4 | **主机指纹键只有 `host:port`**（`ssh-session.ts:101`），不含密钥算法。服务器同时提供 rsa/ed25519 且协商结果变化时会误报"指纹不一致" | 键改为 `host:port:keyType`（ssh2 `hostVerifier` 可拿到算法），并保留旧键的兼容读取 | 消除误报（误报会让用户习惯性关校验，反而降低安全性） | 高 | 1 小时 | **数据迁移**：旧 `host:port` 键需迁移或一次性重建 |
| Q5 | 删除主机不清理 `knownHosts`（`store.ts:205`），条目无限累积，且重加同一主机仍命中旧指纹 | 删除时按 `host:port` 前缀清理；新增「清除指纹」入口 | 语义正确 + 配置不膨胀 | 中 | 0.5 小时 | 无 |
| Q6 | 快捷键在弹窗/输入框内仍生效：编辑主机表单时按 `⌘N` 会叠加新弹窗，`⌘1..9` 也会切标签 | 全局 keydown 先判 `document.querySelector('.modal-mask')` 与 `activeElement`（input/textarea/select 且非 xterm 的 helper textarea）→ 直接 return | 消除一批"手滑"类交互 bug | 中 | 0.5 小时 | 行为微调（更符合预期） |
| Q7 | 远端重命名/新建目录不校验名称（`FilesPanel` → `joinRemote(cwd, value)`），输入 `../../etc/x` 会跳出当前目录 | 校验：禁止 `/`、`\`、`\0`、`.`/`..`；长度上限 255 | 防误操作与路径穿越 | 中 | 0.5 小时 | 无 |
| Q8 | 生产 CSP 仍允许 `script-src 'unsafe-inline'`（`index.html:7`，为 dev HMR 保留） | 构建时区分：dev 用宽松 CSP，prod 由 `onHeadersReceived` 下发 `script-src 'self'`（需回归 HMR 与 `file://` 加载） | 降低 XSS 面（当前渲染层无 Node 权限，属纵深防御） | 中 | 1 小时 | 构建配置 |
| Q9 | 传输完成后进度被清零（`ipc.ts:145/170` `push(0,'done')`），状态栏瞬间显示 0 B/空进度条 | 在 `transfer()` 闭包里记住最后一次 `transferred/total`，完成时带上 | 状态栏不再"闪一下归零" | 低 | 15 分钟 | 无 |
| Q10 | 死代码：`writeTerminal`、`hasPassword`、`activePaneOf`（仅定义无引用）、`syncProviders`（整模块未接线）、`App.tsx` 未使用的 `IconServer` 导入、`LocalSession.status` 写了从不读（tsc 已确认） | 删除前三者与未用导入/字段；`services/sync.ts` 这个预留层已于 0.9.1 删除——能力由 `sync-service` / `sync-transport` 承接，不再保留空壳接口 | 降低阅读噪音；为开启 `noUnusedLocals` 铺路 | 低 | 1 小时 | 无 |
| Q11 | 状态文案重复：`App.tsx:16` `STATUS_TEXT` 与 `TabBar.tsx:24` `STATUS_LABEL` 内容相同 | 抽到 `shared/types.ts` 旁的常量，两处引用 | 防止文案改一处漏一处 | 低 | 15 分钟 | 无 |
| Q12 | `ipc.ts:58` 的 `handle(channel: string, fn: (...args: any[]) => unknown)` 让 handler 参数与 `JShellApi` 无编译期关联 | 从 `JShellApi` 派生 `ChannelArgs` 映射（`keyof JShellApi` → 参数元组），`handle` 用泛型约束 | 三端签名漂移在编译期暴露（现在只能靠人肉对齐） | 中 | 0.5 人天 | 内部重构 |
| Q13 | 主进程只有 `console.error`，用户遇到问题无法提供日志 | 落地 `~/Library/Logs/JShell/main.log`（滚动 2 个文件 × 2 MB），`sftp`/`ssh` 关键节点打结构化日志；设置页加「打开日志目录」 | 线上排障从"猜"变"看"，对终端工具尤其重要 | 中 | 0.5 人天 | 新增 |
| Q14 | 允许录制不带修饰键的 F 键绑定（`shortcuts.ts` `specFromEvent`），会被应用层吞掉导致终端收不到 F5 | 要求必须含 `Mod/Ctrl/Alt`；F 键也要求修饰键，或在录制时提示"会拦截终端按键" | 避免用户自伤 | 低 | 15 分钟 | 行为微调 |
| Q15 | `state.version` 写了但读取时不校验（`store.ts:78/87` 只写不判），未来改结构只能靠"读失败回退空配置" | 加 `migrate(state)` 分支（v0→v1…），未知版本先备份 `state.json.bak` 再降级读取 | 为 F1/F10/F15 的字段演进兜底 | 中 | 0.5 小时 | 数据兼容层 |
| Q16 | 没有 lint/format 配置，多人协作时风格靠自觉 | 可选：Biome（单依赖，替代 eslint+prettier）；若不加依赖，至少启用 `noUnusedLocals`/`noUnusedParameters` | 一致性 | 低 | 0.5 人天（含依赖） | 新增工具 |
| Q17 | 单实例已实现，但二次启动不会带参数（`jshell ssh://user@host` 无用） | `setAsDefaultProtocolClient('ssh')` + `second-instance` 解析 argv → 直接开快速连接 | CLI/浏览器唤起场景 | 低 | 0.5 人天 | 需要系统注册（配置） |
| Q18 | 打包未签名：用户首次打开会被 Gatekeeper 拦截 | 配置 `CSC_LINK`/`CSC_KEY_PASSWORD` + notarize（Apple ID / App Store Connect Key） | 可分发性 | 中 | 0.5 人天（+ 证书成本） | 仅配置/凭据 |
| Q19 | Windows/Linux 从未实机验证（ConPTY、路径、字体、`/etc/shells` 缺失场景） | 用 CI 产物在三平台各跑一遍冒烟清单：本地终端、SSH、分屏、文件面板、中文输入、复制粘贴 | 发布前必须；能提前暴露 ConPTY 与字体问题 | 高 | 1 人天 | 纯验证 |

---

## 五、破坏性变更 / 依赖 / 迁移 / 配置一览

| 项 | 类型 | 影响面 | 处置 |
| --- | --- | --- | --- |
| Q4 指纹键格式 `host:port` → `host:port:algo` | **数据迁移**（非破坏） | 已有用户的 `knownHosts` | 读取时先查新键、再回退旧键并就地迁移；迁移失败则清空该条并重新 TOFU（一次提示） |
| F1 布局持久化、F10 窗口状态、F15 导出 | 新增字段（向后兼容） | `state.json` | 老文件缺字段 → 走默认值，无需迁移 |
| Q15 版本迁移层 | 新增 | `state.json` | 首次写 v1 时生成 `state.json.bak` |
| F2 `@xterm/addon-search`、P5 `@xterm/addon-webgl` | **新增依赖** | 渲染层 bundle（+~20 KB / +~60 KB） | MIT，同 `@xterm` 生态；列为 devDependency 由 Vite 打包 |
| Q16 Biome | 新增开发依赖 | 仅开发 | 可选；不引入也不影响构建 |
| F6 多选下载/目录上传 | IPC **参数扩展**（加可选参数） | `preload` 与主进程 | 保持旧签名可用，不破坏现有调用 |
| F16 自动重连 | **改变交互行为** | 会话断线表现 | 默认关闭 + 设置项，避免隐式改变 |
| Q8 生产 CSP 收紧 | 构建配置 | 加载路径 | 必须回归：HMR（dev）、`file://`（prod）、外链打开 |
| Q18 签名/公证、Q17 协议注册 | **额外配置/凭据** | 分发 | 需要 Apple Developer 账号与 CI secrets；不影响代码逻辑 |
| P7 语言包裁剪 | 构建配置 | 安装包 | `electronLanguages: ['zh_CN','en']`，需验证系统菜单文案 |

> 没有任何一项要求修改 `JShellApi` 的既有方法签名或删除既有 IPC 通道；渲染层与主进程的既有交互行为保持不变（除 F16 需显式开启、Q6/Q14 属修正明显不合理的边界）。

---

## 六、按性价比排序的执行顺序

排序依据：**风险消除 > 用户可感知收益 > 成本**。同性价比内先做"改动面小、可独立回滚"的。

### 第一批：半天内，先把地基夯实（约 1 人天总计）

| 顺序 | 项 | 成本 | 为什么排这里 |
| --- | --- | --- | --- |
| 1 | Q2 下载写 `.part` 再 rename | 1 h | 唯一会造成**用户数据丢失**的问题，改动局部 |
| 2 | Q3 `will-navigate` + 权限拒绝 | 0.5 h | 安全加固里成本最低、收益最确定 |
| 3 | Q7 远端名称校验 | 0.5 h | 防路径穿越，10 行代码 |
| 4 | Q6 快捷键边界（弹窗/输入框不触发） | 0.5 h | 修掉最容易被用户撞到的交互 bug |
| 5 | Q9 + Q10 + Q11 + Q14 小修一批 | 1.5 h | 死代码/文案/进度归零/裸 F 键，纯清理 |
| 6 | Q1 测试骨架（pane-tree + shortcuts，先 10 个用例） | 0.5 天 | 零依赖、已验证可行，为后续所有改动兜底 |

### 第二批：1–2 天，用户能直接感知（约 3 人天）

| 顺序 | 项 | 成本 | 为什么 |
| --- | --- | --- | --- |
| 7 | P1 设置写入防抖 | 2 h | 拖字号/改字体立刻变顺，改动仅两处 |
| 8 | F3 右键菜单 | 0.5 天 | 可发现性提升最明显，纯新增 |
| 9 | F2 终端搜索 | 0.3 天 | 刚需，一个 addon + 一个搜索条 |
| 10 | Q4 + Q5 指纹键修复 + 清理 | 1.5 h | 安全正确性；含一次平滑迁移 |
| 11 | F1 布局持久化 | 1 天 | 每天开机的第一个动作；数据结构已就绪 |
| 12 | F4 指纹变更确认弹窗 | 0.5 天 | 与 #10 配套，否则用户仍只能删主机 |
| 13 | P2 文件列表 `content-visibility`（先低成本） | 0.5 h | 一行 CSS，大目录立刻不卡 |

### 第三批：按产品方向选择（每项 0.5–2 人天）

| 顺序 | 项 | 成本 | 适合什么时候做 |
| --- | --- | --- | --- |
| 14 | P4 递归删除并发 + P3 拖拽节流 | 3 h | 用户开始反馈"删目录慢""拖分屏卡" |
| 15 | F5 `~/.ssh/config` 导入 | 1 天 | 想拉运维/后端用户时，性价比最高的拉新功能 |
| 16 | F6 SFTP 补全（多选/目录/取消/远程编辑） | 2 天 | 定位从"终端"扩到"文件管理"时 |
| 17 | Q12 IPC 类型收紧 + Q15 迁移层 | 1 天 | 准备长期迭代、多人协作前 |
| 18 | F7 本地文件面板 或 F8 隧道 UI | 各 1 天 | 二选一，看用户提哪个多 |
| 19 | Q13 日志、Q8 CSP、P5 WebGL、P7 体积 | 1.5 天 | 进入"打磨/分发"阶段 |
| 20 | Q19 三平台实机冒烟 + Q18 签名公证 | 1.5 天 | **发布前必做**，不可跳过 |

---

## 七、需要你补充的信息（会影响上面 3 处取舍）

1. **Windows 是不是一线用户群？**
   如果是，Q19 + `shells.ts` 的 Windows 分支要提前到第二批，并且要单独确认 ConPTY 下的中文输入、`cmd/powershell` 的 `-NoLogo` 行为、路径分隔符（`FilesPanel` 的远端路径是全 POSIX，但本地终端 cwd 未暴露，暂无冲突）。
2. **是否需要英文界面 / 多语言？**
   当前主进程错误文案与渲染层文案都是中文硬编码。若需要 i18n，应在做 F3/F4/F5 之前先抽文案表（约 0.5 天），否则每加一个功能都要改两遍。
3. **分发方式：内部分发还是公开下载？**
   公开下载就必须做 Q18（签名 + 公证）与 Q17（协议注册），并接受"未签名包会被 Gatekeeper 拦"的现状；内部分发可以跳过，省下证书与 1 天配置时间。

> 这三项之外，其余建议都基于当前代码即可直接开工，不需要额外信息。

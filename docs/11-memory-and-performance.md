# 内存与性能：测量、优化与结论

> 本文记录 0.11.0 的性能专项：怎么量的、量到了什么、改了什么、还剩什么。
> 复现脚本在 `scripts/measure-memory.mjs`、`scripts/measure-startup.mjs`。

## 一、工具与场景

| 用途 | 工具 | 说明 |
| --- | --- | --- |
| 进程内存 | `ps -eo pid,rss,command` | 按 profile 路径过滤，汇总主/渲染/GPU 进程 |
| 归因到进程 | CDP `SystemInfo.getProcessInfo` + `ps` | 把 RSS 按 browser / renderer / GPU 归类 |
| 渲染层堆 | CDP `Performance.getMetrics` | `JSHeapUsedSize`、`Nodes`、`JSEventListeners` |
| 启动阶段 | 墙钟 + CDP `PerformanceNavigationTiming` | spawn → CDP 可连 → DOMContentLoaded → 可交互 |
| 交互驱动 | CDP `Input.insertText` / `dispatchKeyEvent` | 真实敲命令，不用内部后门 |

**内存测试场景**（固定可复现）：

1. `baseline`：冷启动后空载 3 秒；
2. `terminals`：点「本地终端」开 6 个标签，每个执行 `seq 1 40000`（填满 5000 行 scrollback）；
3. `closed`：全部 `⌘W` 关闭后再采样，观察是否回落到基线。

每步用 `echo DONE_i` 做完成标记并轮询等待，避免"点击丢失 / 输出没跑完"导致的假数据。

## 二、内存：来源与优化

### 2.1 主要来源

| 来源 | 量级 | 是否可优化 |
| --- | --- | --- |
| xterm 实例的 scrollback 缓冲 | **约 20MB / 终端**（5000 行 × 120 列） | ✅ 可 |
| 每个 xterm 的 DOM 渲染节点 | 约 250–600 节点 / 终端 | ⚠️ 随缓冲收敛 |
| Electron 基线（BrowserWindow + GPU + V8） | 约 330MB（主 134 / 渲染 99 / GPU 70） | ❌ 框架固有 |
| 主进程会话缓冲（`OutputBuffer` 8ms/64KB） | 每会话 < 200KB | 已封顶 |
| 渲染层待写队列 `pending` | 原实现只限 400 块 × 最坏 64KB | ✅ 已按字节封顶 |

结论：**内存随「存活终端数 × scrollback」线性增长**，是唯一有优化空间的大头；不存在对象泄漏（关闭后 DOM 精确回落）。

### 2.2 改动

`src/renderer/src/terminal-registry.ts`

- **后台标签收窄 scrollback**：不可见标签把 `scrollback` 降到 `min(设置值, 1000)`，切回可见时恢复。
  多标签时内存不再按标签数线性膨胀。
- **`pending` 队列按字节封顶**：新增 `PENDING_BYTES = 512KB`，与块数上限一起 trim，防止终端迟迟未创建时缓冲失控。

`src/renderer/src/components/TerminalView.tsx`

- 设置变更时按可见性决定 scrollback，避免"改字体/字号把后台标签的缓冲又顶回去"。

### 2.3 实测对比（6 标签 × 4 万行）

| 指标 | 优化前 | 优化后 | 变化 |
| --- | --- | --- | --- |
| 渲染进程增量（相对空载） | +91 ~ +131MB | +40 ~ +64MB | **约 -56%** |
| 进程总 RSS 增量 | +122 ~ +136MB | +41 ~ +72MB | **约 -56%** |
| JS 堆增量 | +14.8MB | +6.9 ~ +9.7MB | 约 -40% |
| 关闭全部标签后 DOM 节点 | 286 基线 | 279（基线 286） | 完整回收 |

> 绝对 RSS 受系统内存压力影响有 ±50MB 抖动，因此对比一律用「相对空载的增量」。

### 2.4 可衡量目标（已达成）

- 6 标签满载场景，渲染进程增量 **≤ 60MB** → 实测 40–64MB ✅
- 关闭全部标签后 DOM 节点回到基线 **±10%** → 实测 -2.4% ✅
- 无用户可感知的行为退化：终端历史仍可见，切回标签正常渲染 ✅

## 三、启动性能

### 3.1 macOS：真凶是装错架构

| 构建 | Electron 引导 | 可交互 | 结论 |
| --- | --- | --- | --- |
| 开发构建（arm64） | 519ms | 658ms | 正常 |
| 打包 arm64 | **304ms** | **421ms** | 正常，甚至更快 |
| 打包 x64（在 M 系上跑） | **5066ms** | **8781–9527ms** | **Rosetta 转译，慢 10–20 倍** |

`release/.../mac/` 是 x64 产物、`release/.../mac-arm64/` 是 arm64 产物。
Apple Silicon 用户若装了 x64 的 dmg，就会遇到"启动要等七八秒"。

**已做**：启动日志增加 Rosetta 检测（`app.runningUnderARM64Translation`），
命中时写明确警告；安装说明与使用说明标注「M 系列请选 arm64」。

补充排查结论：ad-hoc 签名对启动只带来 ~8% 改善（8781 vs 9527ms），不是主因；
代码侧启动路径无同步重活（`detectShells` 只有 statSync，store 读盘为一次性小文件）。

### 3.2 Windows：同类隐患清单

无法在本机实测，按代码路径给出风险与处置：

| 隐患 | 影响 | 处置 |
| --- | --- | --- |
| `enumerateDrives()` 每次同步都扫 A–Z | 断开的网络映射盘上 `existsSync` 会阻塞，单次可达数秒 | ✅ 改为**结果缓存** + 从 C 开始扫（跳过软驱位） |
| 首次生成 `askpass.exe`（PowerShell 编译）同步阻塞主线程 | 首次点「同步」界面卡 1–2 秒 | ✅ 改为**启动后异步预热**，编译改为 `execFile` 异步 |
| 未签名 exe 被 Defender 实时扫描 | 首次启动/首次运行子进程变慢 | 需代码签名（本次不做，记入待办） |
| asar 内资源读取 | 与 macOS 同构，无明显额外开销 | 无需处理 |

### 3.3 两个平台分别的瓶颈清单

**macOS**
1. 架构错配（x64 跑在 Apple Silicon）→ 已加检测与提示
2. 未签名时 Gatekeeper 每次启动校验 → 影响约 8%，正式分发需公证
3. 终端数量 × scrollback 带来的渲染进程内存 → 已优化

**Windows**
1. 盘符探测重复执行 → 已缓存
2. askpass 首次编译阻塞 → 已改为异步预热
3. 无签名导致的扫描开销 → 待签名解决
4. 遗留：图标/名称元数据异常（见 `docs/Windows打包手册.md`，需 Windows 原生构建验证）

## 四、回归验证方式

```bash
npm run build
node scripts/measure-memory.mjs --tabs=6     # 内存
node scripts/measure-startup.mjs --runs=5    # 启动（开发构建）
node scripts/measure-startup.mjs --runs=3 --app=release/<版本>/mac-arm64/JShell.app
```

判定线：内存增量 ≤ 60MB、启动可交互 ≤ 600ms（arm64 打包版）。

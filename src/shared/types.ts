/**
 * 主机认证方式。
 * - password: 密码登录
 * - key:      私钥文件登录（可选 passphrase）
 * - agent:    SSH Agent 转发登录（读取 SSH_AUTH_SOCK）
 */
export type AuthType = 'password' | 'key' | 'agent'

/** 主机连接配置（持久化，不含明文口令） */
export interface HostProfile {
  id: string
  /** 显示名称，例如「生产环境 Web」 */
  name: string
  host: string
  port: number
  username: string
  authType: AuthType
  /** 私钥绝对路径（authType = key 时使用） */
  privateKeyPath?: string
  /** 跳板机（另一台主机的 id）；空表示直连 */
  proxyJump?: string
  /** 分组，用于侧边栏归类 */
  group?: string
  /** 标签色，用于侧边栏/标签页小圆点 */
  color?: string
  lastUsedAt?: number
  createdAt: number
  updatedAt: number
}

/** 新建/编辑主机时提交的表单数据（口令为明文，仅单向传入主进程加密保存） */
/** 保存前「测试连接」的结果 */
export interface ConnectionTestResult {
  ok: boolean
  /** 已本地化的结果描述 */
  message: string
  /** 握手与认证耗时（毫秒）；失败为 0 */
  latencyMs: number
}

// ------------------------------------------------------------------ rsync

export type RsyncDirection = 'upload' | 'download' | 'relay'

export interface RsyncEndpoint {
  kind: 'local' | 'host'
  /** kind === 'host' 时为已保存主机 id */
  hostId?: string
  /** 本机绝对路径，或远端绝对路径 */
  path: string
}

export interface RsyncOptions {
  /** --delete：目标端删除源端已不存在的文件 */
  deleteExtraneous: boolean
  /** -z：传输压缩 */
  compress: boolean
  /** 逗号分隔的排除规则（可选） */
  exclude: string
  /** 失败重试次数（0-5） */
  retries: number
}

export interface RsyncPlan {
  direction: RsyncDirection
  source: RsyncEndpoint
  target: RsyncEndpoint
  options: RsyncOptions
}

export type RsyncStatus = 'running' | 'retrying' | 'done' | 'error' | 'canceled'

export interface RsyncTask {
  id: string
  plan: RsyncPlan
  status: RsyncStatus
  /** 0-100；无法估算时为 -1 */
  percent: number
  /** 已传输字节（按进度输出估算） */
  transferred: number
  total: number
  speed: string
  eta: string
  /** 当前尝试序号，从 1 开始 */
  attempt: number
  /** 中转时的阶段说明（如「下载到本机中转目录」） */
  stage: string
  message?: string
  startedAt: number
  finishedAt?: number
}

/** 远端 rsync 探测结果 */
export interface RsyncProbeResult {
  ok: boolean
  /** 远端 rsync 可执行文件路径（ok 时） */
  path?: string
  /** 已本地化的说明 */
  message: string
}

export interface RsyncCapability {
  available: boolean
  /** rsync 版本号，例如 2.6.9 / 3.2.7 */
  version: string
  /** 是否支持 --info=progress2（3.1+） */
  progress2: boolean
  /** 是否支持 --append-verify（3.0+）；旧版退化为 --append */
  appendVerify: boolean
  /** 是否支持 -s / --protect-args（3.0+）；旧版改为给远端路径加引号 */
  protectArgs: boolean
  binary: string
}

/** 内置编辑器读取的文本文件 */
export interface TextFile {
  text: string
  size: number
  /** 因超过大小上限被截断（当前实现直接拒绝，保留字段便于后续分块） */
  truncated: boolean
}

export interface HostDraft {
  id?: string
  name: string
  host: string
  port: number
  username: string
  authType: AuthType
  privateKeyPath?: string
  proxyJump?: string
  group?: string
  color?: string
  /** 密码登录口令；留空表示不修改已保存口令 */
  password?: string
  /** 私钥 passphrase；留空表示不修改已保存口令 */
  passphrase?: string
}

export type SessionStatus = 'connecting' | 'ready' | 'closed' | 'error'

/**
 * 会话为什么断开。
 *
 * 自动重连要靠它决策——**用户主动退出绝不能自动重连**，
 * 否则敲完 exit 又被连上，比手动点还难受。
 *
 * - user-exit：远端 shell 正常退出（客户端连接还活着，只是 shell 通道关了）
 * - network：网络层断开（客户端连接没了 / 超时）
 * - auth：认证失败（口令错、密钥不接受）→ 重试只会反复失败
 * - hostkey：主机指纹变了 → 必须人工确认，绝不自动重试
 * - unknown：判断不出来，保守当作可重试
 */
export type SessionCloseReason = 'user-exit' | 'network' | 'auth' | 'hostkey' | 'unknown'

/** 会话状态的中文展示文案（主进程与渲染层共用，避免多处硬编码） */
export const SESSION_STATUS_TEXT: Record<SessionStatus, string> = {
  connecting: '连接中',
  ready: '已连接',
  closed: '已断开',
  error: '连接失败'
}

/** 主机公钥指纹不匹配：交给 UI 决定是否信任新指纹 */
export interface HostKeyMismatch {
  sessionId: string
  host: string
  port: number
  /** 本次协商使用的密钥算法，如 ssh-ed25519 */
  algorithm: string
  /** 本地已记录的指纹 */
  known: string
  /** 本次连接实际拿到的指纹 */
  actual: string
}

/** 会话事件：主进程 -> 渲染进程的单向推送 */
export type SessionEvent =
  | {
      type: 'status'
      sessionId: string
      status: SessionStatus
      message?: string
      /** 断开原因，供渲染层决定要不要自动重连 */
      reason?: SessionCloseReason
    }
  | { type: 'data'; sessionId: string; data: string }
  | { type: 'cwd'; sessionId: string; cwd: string }
  | { type: 'transfer'; task: TransferTask }
  | { type: 'tunnel'; tunnel: TunnelState }
  | ({ type: 'hostkey' } & HostKeyMismatch)

export interface TransferTask {
  id: string
  sessionId: string
  direction: 'upload' | 'download'
  name: string
  transferred: number
  total: number
  status: 'running' | 'done' | 'error' | 'canceled'
  message?: string
}

export interface FileEntry {
  name: string
  path: string
  type: 'file' | 'dir' | 'link' | 'other'
  size: number
  mtime: number
  mode: number
}

export interface Snippet {
  id: string
  name: string
  command: string
  /** 触发词：在终端里输入它，按 Tab 可补全成整条命令（像 shell 的 alias） */
  alias?: string
  createdAt: number
}

export type TunnelKind = 'local' | 'remote' | 'dynamic'

/** 端口转发配置，MVP 仅实现 local（-L），其余为预留 */
export interface TunnelConfig {
  id: string
  sessionId?: string
  kind: TunnelKind
  bindHost: string
  bindPort: number
  destHost: string
  destPort: number
  enabled: boolean
}

export interface TunnelState {
  id: string
  sessionId: string
  status: 'listening' | 'closed' | 'error'
  message?: string
}

export type AppTheme = 'dark' | 'light' | 'system'

export interface AppSettings {
  theme: AppTheme
  /** 终端配色方案 id，见 renderer/themes.ts */
  terminalTheme: string
  fontFamily: string
  fontSize: number
  cursorBlink: boolean
  scrollback: number
  /** TOFU：首次信任并记录指纹，指纹变化时拒绝连接；ignore：跳过校验 */
  hostKeyPolicy: 'tofu' | 'ignore'
  /** 侧边栏宽度（px） */
  sidebarWidth: number
  /** 本地终端默认 shell 路径；空字符串表示自动检测 */
  localShell: string
  /** 自定义快捷键：actionId -> 快捷键串，缺省/空串表示使用默认值 */
  keybindings: Record<string, string>

  // ---------------------------------------------------------- 系统集成（跨平台）
  /** 开机自启（macOS 登录项 / Windows 当前用户启动项） */
  launchAtLogin: boolean
  /** 启动后仅驻留托盘，不显示主窗口 */
  startMinimized: boolean
  /** 关闭主窗口时最小化到托盘（而不是退出应用） */
  closeToTray: boolean
  /** 允许发送系统通知（会话异常断开、传输失败等） */
  notifications: boolean
  /** 侧边栏显示「本机」终端分组 */
  showLocalShells: boolean
  /** 主机列表行内显示删除按钮（关闭后仅右键菜单可删） */
  hostDeleteButton: boolean
  /** 删除主机前二次确认 */
  hostDeleteConfirm: boolean
  /** 连接后自动注入目录上报 hook，让目录树跟随终端 cd（关闭则登录零注入、树退回手动浏览） */
  autoFollowCwd: boolean
  /** 侧边栏里隐藏的本机终端（按 shell 绝对路径记录） */
  hiddenLocalShells: string[]
}

export interface AppInfo {
  version: string
  electron: string
  node: string
  platform: NodeJS.Platform | string
  arch: string
  userDataPath: string
  /** 当前系统是否支持安全存储（Linux 无 keyring 时可能为 false） */
  safeStorageAvailable: boolean
  /** 是否为打包版本（开发模式为 false） */
  packaged: boolean
  /** 是否为便携版（数据目录跟随程序目录） */
  portable: boolean
  /** 日志目录绝对路径 */
  logDir: string
  /** 分发渠道：内部渠道 / 公开下载 */
  channel: ReleaseChannel
  /** 构建时间（ISO 字符串，来自 release-meta.json） */
  buildTime: string
  /** 操作系统是否已登记开机自启（以系统状态为准，可能与设置项短暂不一致） */
  launchAtLogin: boolean
}

export type ReleaseChannel = 'internal' | 'public'

/** 构建时写入的发布元信息（release-meta.json） */
export interface ReleaseInfo {
  productName: string
  version: string
  channel: ReleaseChannel
  /** 公开下载时启用的更新检查地址；内部渠道为空 */
  updateUrl: string
  buildTime: string
  gitCommit?: string
  homepage?: string
}

export type UpdateStatus = 'disabled' | 'up-to-date' | 'available' | 'error'

export interface UpdateCheckResult {
  status: UpdateStatus
  currentVersion: string
  latestVersion?: string
  notes?: string
  url?: string
  message?: string
  checkedAt: number
}

/** 主进程 -> 渲染进程的应用级命令（托盘菜单、系统菜单共用） */
export type AppCommand =
  | 'new-local'
  | 'new-host'
  | 'settings'
  | 'about'
  | 'check-update'
  | 'open-logs'

export type SessionKind = 'ssh' | 'local'

export interface OpenSessionResult {
  sessionId: string
  kind: SessionKind
  /** 标签页标题：主机名 或 shell 名（zsh） */
  title: string
  /** 副标题：deploy@host:22 或 本地 · /Users/jay */
  subtitle: string
  hostId?: string
  /** kind = local 时的 shell 绝对路径 */
  shellPath?: string
}

/** 布局持久化：只存「怎么连」，不存运行时状态 */
export interface LayoutLeafPane {
  kind: SessionKind
  hostId?: string
  shellPath?: string
}

export type LayoutNode =
  | { type: 'leaf'; pane: LayoutLeafPane }
  | {
      type: 'split'
      direction: 'row' | 'column'
      ratio: number
      children: [LayoutNode, LayoutNode]
    }

export interface PersistedTab {
  id: string
  root: LayoutNode
}

/** 本地 shell 探测结果 */
export interface ShellInfo {
  path: string
  name: string
  label: string
  isDefault: boolean
}

export interface ShellsResult {
  defaultShell: string
  shells: ShellInfo[]
}

export interface TunnelRuntimeInfo extends TunnelConfig {
  status: 'listening' | 'closed' | 'error'
}

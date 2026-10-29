import type { AppSettings, HostProfile, Snippet, TunnelConfig } from './types'

/**
 * 数据共享 / 配置同步的公共契约。
 *
 * 设计前提：**存储位置与数据格式解耦**。
 * JShell 只定义「同步包」这一种文件格式，用户可以把它放在任意位置——
 * iCloud Drive / OneDrive / Dropbox / 坚果云 / 局域网共享 / U 盘 / 邮件 / 聊天工具，
 * 也可以只是本机的一个普通文件夹。应用不绑定任何云服务，也不假设用户拥有某个账号。
 *
 * 安全前提：整包加密由客户端完成（scrypt + AES-256-GCM），
 * 因此云盘只看到密文，即使服务商可读也无所谓。
 */

/** 同步内容范围。每一项都是用户可独立勾选的边界。 */
export type SyncScope = 'hosts' | 'snippets' | 'settings' | 'tunnels' | 'knownHosts' | 'credentials'

export interface SyncScopeDef {
  id: SyncScope
  label: string
  hint: string
  /** 默认是否勾选 */
  defaultOn: boolean
  /** 含敏感信息：整包必须加密，否则拒绝导出 */
  sensitive?: boolean
}

export const SYNC_SCOPES: SyncScopeDef[] = [
  {
    id: 'hosts',
    label: '主机与分组',
    hint: '主机地址、端口、用户名、认证方式、分组、标签色、跳板机关系',
    defaultOn: true
  },
  {
    id: 'snippets',
    label: '命令片段',
    hint: '常用命令，不含任何凭据',
    defaultOn: true
  },
  {
    id: 'settings',
    label: '偏好设置',
    hint: '主题、终端配色、字号、快捷键、跟随目录等；窗口尺寸与本机 shell 路径属于设备私有，不会同步',
    defaultOn: true
  },
  {
    id: 'tunnels',
    label: '端口转发规则',
    hint: '已保存的转发配置；会话绑定关系会被清空',
    defaultOn: true
  },
  {
    id: 'knownHosts',
    label: '主机指纹',
    hint: '同步后新设备会直接信任这些主机。默认关闭：信任应当是设备自己的决定，冲突时保留本机记录',
    defaultOn: false
  },
  {
    id: 'credentials',
    label: '密码与私钥口令',
    hint: '解密后的明文凭据会写入整包；因此必须设置口令加密，未加密的包不允许包含凭据',
    defaultOn: false,
    sensitive: true
  }
]

/**
 * 设备私有设置：即使勾选了「偏好设置」也不会被同步。
 * 这些值描述的是「这一台机器」而不是「这个用户」，
 * 同步过去轻则无效（shell 路径不存在），重则覆盖用户当前窗口布局。
 */
export const DEVICE_LOCAL_SETTINGS = [
  'sidebarWidth',
  'localShell',
  'hiddenLocalShells',
  'launchAtLogin'
] as const

export type DeviceLocalSetting = (typeof DEVICE_LOCAL_SETTINGS)[number]

// ------------------------------------------------------------------ 包格式

export const SYNC_FORMAT = 'jshell-sync'
export const SYNC_VERSION = 1
/** 文件首行标识：既便于人工辨认，也便于在解密前判断格式 */
export const SYNC_MAGIC = 'JSHELL-SYNC/1'
export const SYNC_EXTENSION = 'jshellsync'
/** 单个同步包大小上限（含 base64 膨胀后的余量） */
export const SYNC_MAX_BYTES = 20 * 1024 * 1024

export interface SyncBundleCounts {
  hosts: number
  snippets: number
  tunnels: number
  knownHosts: number
  credentials: number
}

/**
 * 元信息：**始终明文**。
 * 这样导入方在输入口令之前就能看到「来自哪台设备、什么时候、包含多少条目、是否含密码」，
 * 不至于对着一个陌生文件盲输口令。这里只放计数，不放任何主机名或路径。
 */
export interface SyncBundleMeta {
  appVersion: string
  /** 导出设备名（os.hostname），仅用于识别来源 */
  deviceName: string
  platform: string
  createdAt: string
  scopes: SyncScope[]
  counts: SyncBundleCounts
  hasCredentials: boolean
}

export interface SyncBundlePayload {
  hosts?: HostProfile[]
  snippets?: Snippet[]
  settings?: Partial<AppSettings>
  tunnels?: TunnelConfig[]
  knownHosts?: Record<string, string>
  /** hostId -> 明文凭据；仅在整包加密时允许出现 */
  credentials?: Record<string, SyncCredential>
}

export interface SyncCredential {
  password?: string
  passphrase?: string
}

export interface SyncKdf {
  name: 'scrypt'
  N: number
  r: number
  p: number
  keylen: number
  /** base64 */
  salt: string
}

export interface SyncCipher {
  name: 'aes-256-gcm'
  /** base64，12 字节 */
  iv: string
  /** base64，16 字节 GCM tag */
  tag: string
}

export interface SyncEnvelope {
  format: typeof SYNC_FORMAT
  version: number
  encrypted: boolean
  meta: SyncBundleMeta
  kdf?: SyncKdf
  cipher?: SyncCipher
  /** 加密时的密文（base64） */
  data?: string
  /** 未加密时的明文载荷 */
  payload?: SyncBundlePayload
}

// --------------------------------------------------------------- 落地方式

/** 一台机器上可用的同步位置 */
export interface SyncTarget {
  id: string
  label: string
  /** 目录绝对路径 */
  dir: string
  kind: 'icloud' | 'onedrive' | 'dropbox' | 'gdrive' | 'nutstore' | 'baidu' | 'other'
  /** 目录最近修改时间（毫秒）：用来在多个网盘之间自动挑一个最活跃的 */
  mtimeMs?: number
}

export type SyncDestination =
  /** 系统保存/打开对话框：任意位置（含已挂载的网盘、外置磁盘） */
  | { kind: 'dialog' }
  /** 直接写入探测到的云盘目录 */
  | { kind: 'folder'; targetId: string }
  /** 经剪贴板传递，适合临时在两台设备之间搬运 */
  | { kind: 'clipboard' }

export type SyncSource =
  | { kind: 'file' }
  | { kind: 'folder'; targetId: string; name: string }
  | { kind: 'clipboard' }

export interface SyncExportOptions {
  scopes: SyncScope[]
  /** 空表示不加密；含凭据时必须提供 */
  password?: string
  destination: SyncDestination
}

export interface SyncExportResult {
  canceled: boolean
  /** 写入文件时的绝对路径 */
  path?: string
  /** 经剪贴板传递时为 true */
  clipboard?: boolean
  bytes?: number
  meta?: SyncBundleMeta
}

/**
 * 导入语义。
 * - overwrite（默认）：**远端无条件覆盖本机**同 id 条目，本机独有条目保留；
 * - merge：同 id 取 updatedAt 较新者，谁新听谁的；
 * - replace：包里带的分区整体替换，本机独有条目会被删除。
 */
export type SyncImportMode = 'overwrite' | 'merge' | 'replace'

/**
 * 删除语义（0.9.2 拍板）：**不跨设备传播**。
 * 同步的定位是「把配置搬过去」，不是多端双向同步；做墓碑要引入删除时间、复活判定，
 * 对一个本地优先的工具来说复杂度不划算。所以不留模糊空间，界面与文档都要说清楚。
 */
export const SYNC_DELETE_NOTICE =
  '删除只影响本机：不会同步到其它设备，其它设备的删除也不会删掉这里的记录。'

export const SYNC_MODE_LABELS: Record<SyncImportMode, { label: string; hint: string }> = {
  overwrite: {
    label: '覆盖本机',
    hint: '同步包里的记录直接覆盖本机同名条目；本机独有的主机与片段不受影响。覆盖前会先做检测。'
  },
  // 合并与替换都沿用同一条边界：删除不传播，具体见 SYNC_DELETE_NOTICE
  merge: {
    label: '合并',
    hint: '同一条记录比较更新时间，较新的胜出；本机独有的内容保留。'
  },
  replace: {
    label: '替换本机',
    hint: '包里带的分区整体覆盖本机，本机独有的条目会被删除。导入前自动备份。'
  }
}

// ------------------------------------------------------------------ 检测

export type DiffAction = 'add' | 'update' | 'delete' | 'same'

export type DiffKind = 'host' | 'snippet' | 'tunnel' | 'knownHost' | 'settings'

/** 一条将要发生的变更 */
export interface DiffEntry {
  kind: DiffKind
  id: string
  /** 展示名：主机名 / 片段名 / 指纹端点 */
  label: string
  /** 附加说明：user@host:port 之类 */
  detail?: string
  action: DiffAction
  /** update 时若本机版本更新，说明这次覆盖会丢掉本机改动 */
  localNewer?: boolean
}

export interface DiffCounts {
  add: number
  update: number
  delete: number
  same: number
}

/**
 * 覆盖前的检测结果。
 * `risky` 是这次操作真正需要人确认的部分：
 * 覆盖掉本机更新的改动、或者删掉本机独有的条目。
 */
export interface DiffReport {
  mode: SyncImportMode
  entries: DiffEntry[]
  counts: DiffCounts
  risky: {
    /** 本机 updatedAt 更新、仍会被包里的旧版本覆盖 */
    overwriteNewer: number
    /** 本机独有、会随替换一起消失 */
    deleteLocal: number
  }
  settingsChanged: boolean
}

export interface SyncDiffResult {
  token: string
  report: DiffReport
}

export interface SyncInspectResult {
  canceled: boolean
  /** 主进程缓存句柄，导入时凭它取回校验过的载荷，避免渲染层自造路径或重复解密 */
  token?: string
  meta?: SyncBundleMeta
  encrypted?: boolean
  /** 旧版纯 JSON 配置（0.6 之前导出的文件） */
  legacy?: boolean
  sourceLabel?: string
  /** 预览到的条目摘要，用于导入前确认 */
  preview?: SyncPreview
}

export interface SyncPreview {
  hosts: Array<{ id: string; name: string; host: string; username: string; group?: string }>
  snippets: number
  tunnels: number
  knownHosts: number
  credentials: number
  settings: boolean
  /** 覆盖到本机时会发生的动作统计 */
  conflicts: { hosts: number; snippets: number; others: number }
}

export interface SyncImportRequest {
  token: string
  password?: string
  mode: SyncImportMode
  /**
   * 检测结果里有「覆盖本机较新改动」或「删除本机独有条目」时，
   * 必须由界面显式确认后置为 true——主进程拒绝在未确认的情况下动手。
   */
  acknowledge?: boolean
}

export interface SyncImportResult {
  hosts: number
  snippets: number
  tunnels: number
  knownHosts: number
  credentials: number
  settings: boolean
  warnings: string[]
  /** 导入前的自动备份路径（replace 模式必有） */
  backupPath?: string
}

/** 云盘目录里的同步包文件 */
export interface SyncFolderFile {
  name: string
  size: number
  mtime: number
}

export const SYNC_FILE_RE = /\.jshellsync$/i

/** 生成一个可读且可排序的文件名：jshell-sync-2026-10-27.jshellsync */
export function buildSyncFileName(date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `jshell-sync-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}.${SYNC_EXTENSION}`
}

/** 默认落盘目录：`<云盘>/JShell`，避免污染云盘根目录 */
export const SYNC_SUBDIR = 'JShell'

/**
 * 自动同步的固定文件名。
 * 与手动导出（带日期）区分开：自动同步必须始终读写同一个文件，
 * 否则每次同步都会在云盘里堆一个新包。
 */
export const SYNC_AUTO_FILE = 'jshell-auto.jshellsync'

// ------------------------------------------------------------ 自动同步

/** 传输方式：本地/云盘目录、SFTP 自有服务器、或 WebDAV */
export type SyncTransportKind = 'folder' | 'sftp' | 'webdav'

export interface AutoSyncConfig {
  enabled: boolean
  transport: SyncTransportKind
  /** 目标目录的 id（来自 `sync.targets()`）；渲染层永远只传 id */
  targetId: string
  targetLabel?: string
  /** 实际目录，仅主进程填写，回给界面用于显示 */
  dir?: string
  /** SFTP：用哪台已保存的主机作为传输通道 */
  sftpHostId?: string
  sftpHostLabel?: string
  /** SFTP：远端目录（绝对路径，支持 ~） */
  sftpDir?: string
  /** WebDAV：目录地址（含协议，指向放同步包的那个目录） */
  webdavUrl?: string
  /** WebDAV：用户名（密码单独存，只回 hasWebdavPassword） */
  webdavUsername?: string
  scopes: SyncScope[]
  /** 本机配置变化后自动写回远端 */
  pushLocalChanges: boolean
  /** 远端文件变化时自动拉取 */
  pullRemoteChanges: boolean
  /**
   * 拉取时若检测到「会覆盖本机较新改动」或「删除本机独有」，先暂停等人工确认。
   * 关闭即等同于「远端直接覆盖本地」。
   */
  pauseOnRisky: boolean
  /** 同步包口令是否已设置 */
  hasPassword: boolean
  /** WebDAV 是否已保存密码 */
  hasWebdavPassword: boolean
}

export interface AutoSyncPending {
  at: number
  /** 人类可读摘要：几项会被覆盖、几项会被删除 */
  summary: string
  report: DiffReport
}

export interface AutoSyncState extends AutoSyncConfig {
  running: boolean
  lastSyncedAt?: number
  lastResult?: string
  lastError?: string
  pending?: AutoSyncPending
}

export type AutoSyncTrigger = 'manual' | 'local' | 'remote' | 'startup'

export type AutoSyncAction = 'pushed' | 'pulled' | 'both' | 'idle' | 'paused' | 'error'

export interface AutoSyncRunResult {
  ok: boolean
  action: AutoSyncAction
  message: string
  at: number
  report?: DiffReport
}

/** 渲染层可提交的配置补丁；口令是唯一允许写入的敏感字段，读取时只回 hasPassword */
export interface AutoSyncPatch {
  enabled?: boolean
  transport?: SyncTransportKind
  targetId?: string
  scopes?: SyncScope[]
  pushLocalChanges?: boolean
  pullRemoteChanges?: boolean
  pauseOnRisky?: boolean
  /** SFTP 通道主机 id */
  sftpHostId?: string
  /** SFTP 远端目录 */
  sftpDir?: string
  /** WebDAV 目录地址 */
  webdavUrl?: string
  /** WebDAV 用户名 */
  webdavUsername?: string
  /** WebDAV 密码；传空字符串表示清除 */
  webdavPassword?: string
  /** 传空字符串表示清除口令（改用明文包） */
  password?: string
}

/** 「测试连接」结果 */
export interface AutoSyncTestResult {
  ok: boolean
  message: string
}


// ------------------------------------------------------------------ 口令

/** 口令最小长度：短口令面对离线爆破几乎没有意义，这里只是底线 */
export const MIN_PASSWORD_LENGTH = 8
/** 达到该长度即视为「足够」 */
export const STRONG_PASSWORD_LENGTH = 12

export type PasswordStrength = 'empty' | 'short' | 'weak' | 'fair' | 'good'

/** 口令强度分级，仅供界面提示，不参与任何安全判定 */
export function passwordStrength(password: string): PasswordStrength {
  if (!password) return 'empty'
  if (password.length < MIN_PASSWORD_LENGTH) return 'short'
  const varied = [/[a-z]/, /[A-Z]/, /\d/, /[^a-zA-Z0-9]/].filter((re) => re.test(password)).length
  if (password.length >= STRONG_PASSWORD_LENGTH + 2 || (password.length >= 12 && varied >= 3)) {
    return 'good'
  }
  if (password.length >= 10 && varied >= 2) return 'fair'
  return 'weak'
}

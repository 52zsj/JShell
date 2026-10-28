import { randomUUID } from 'node:crypto'
import { sanitizeSettings } from '../../shared/settings'
import { DEVICE_LOCAL_SETTINGS, type SyncBundlePayload, type SyncCredential, type SyncImportMode, type SyncPreview } from '../../shared/sync'
import type { AppSettings, AuthType, HostProfile, Snippet, TunnelConfig } from '../../shared/types'

/**
 * 合并逻辑（纯函数，不碰磁盘、不碰 Electron，便于单测）。
 *
 * 三条硬规则：
 * 1. **保留稳定 id**——跳板机关系靠 id 引用，重新生成 id 等于把关系打断；
 * 2. **不静默丢数据**——同 id 冲突按 updatedAt 较新者胜，指纹冲突保留本机并告警；
 * 3. **设备私有字段不参与同步**——窗口宽度、本机 shell 路径同步过去只会造成混乱。
 */

export interface Snapshot {
  hosts: HostProfile[]
  snippets: Snippet[]
  settings: AppSettings
  tunnels: TunnelConfig[]
  knownHosts: Record<string, string>
}

export interface MergeStats {
  hosts: number
  snippets: number
  tunnels: number
  knownHosts: number
  credentials: number
  settings: boolean
}

export interface MergeOutcome {
  next: Snapshot
  stats: MergeStats
  warnings: string[]
  conflicts: SyncPreview['conflicts']
  credentials: Record<string, SyncCredential>
}

const AUTH_TYPES: AuthType[] = ['password', 'key', 'agent']

const clampText = (value: unknown, max: number): string | undefined => {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, max) : undefined
}

const toNumber = (value: unknown, fallback: number): number => {
  const num = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(num) ? num : fallback
}

function sanitizeRemoteHost(raw: unknown, makeId: () => string): HostProfile | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as Partial<HostProfile>
  const host = clampText(item.host, 255)
  const username = clampText(item.username, 120)
  if (!host || !username) return null
  const port = Math.round(toNumber(item.port, 22))
  if (port < 1 || port > 65535) return null

  const now = Date.now()
  return {
    id: clampText(item.id, 64) ?? makeId(),
    name: clampText(item.name, 120) ?? host,
    host,
    port,
    username,
    authType: AUTH_TYPES.includes(item.authType as AuthType) ? (item.authType as AuthType) : 'password',
    privateKeyPath: clampText(item.privateKeyPath, 500),
    proxyJump: clampText(item.proxyJump, 64),
    group: clampText(item.group, 80),
    color: clampText(item.color, 32),
    lastUsedAt: typeof item.lastUsedAt === 'number' ? item.lastUsedAt : undefined,
    createdAt: toNumber(item.createdAt, now),
    updatedAt: toNumber(item.updatedAt, now)
  }
}

function sanitizeRemoteSnippet(raw: unknown, makeId: () => string): Snippet | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as Partial<Snippet>
  const command = typeof item.command === 'string' ? item.command.slice(0, 4000) : ''
  if (!command.trim()) return null
  return {
    id: clampText(item.id, 64) ?? makeId(),
    name: clampText(item.name, 80) ?? command.slice(0, 24),
    command,
    createdAt: toNumber(item.createdAt, Date.now())
  }
}

function sanitizeRemoteTunnel(raw: unknown): TunnelConfig | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as Partial<TunnelConfig>
  const kind = item.kind === 'remote' || item.kind === 'dynamic' ? item.kind : 'local'
  const bindHost = clampText(item.bindHost, 255) ?? '127.0.0.1'
  const destHost = clampText(item.destHost, 255)
  const bindPort = Math.round(toNumber(item.bindPort, 0))
  const destPort = Math.round(toNumber(item.destPort, 0))
  if (!destHost || bindPort < 1 || bindPort > 65535 || destPort < 1 || destPort > 65535) return null
  return {
    id: clampText(item.id, 64) ?? randomUUID(),
    // 会话是运行时概念，换了设备一定对不上，直接清空
    sessionId: undefined,
    kind,
    bindHost,
    bindPort,
    destHost,
    destPort,
    enabled: item.enabled !== false
  }
}

/** 只保留可跨设备迁移的设置项，丢弃设备私有字段与未知字段 */
function mergeSettings(local: AppSettings, remote: unknown): AppSettings {
  if (!remote || typeof remote !== 'object') return local
  const incoming = { ...(remote as Record<string, unknown>) }
  for (const key of DEVICE_LOCAL_SETTINGS) delete incoming[key]
  // sanitizeSettings 会补齐缺省值与越界值，避免坏包把界面搞崩
  const cleaned = sanitizeSettings(incoming)
  const merged: AppSettings = { ...local, ...cleaned }
  // 设备私有字段始终以本机为准
  merged.sidebarWidth = local.sidebarWidth
  merged.localShell = local.localShell
  merged.hiddenLocalShells = local.hiddenLocalShells
  merged.launchAtLogin = local.launchAtLogin
  return merged
}

function sanitizeCredentials(raw: unknown, hostIds: Set<string>): Record<string, SyncCredential> {
  const result: Record<string, SyncCredential> = {}
  if (!raw || typeof raw !== 'object') return result
  for (const [hostId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!hostIds.has(hostId)) continue
    if (!value || typeof value !== 'object') continue
    const item = value as SyncCredential
    const password = typeof item.password === 'string' ? item.password.slice(0, 4096) : undefined
    const passphrase = typeof item.passphrase === 'string' ? item.passphrase.slice(0, 4096) : undefined
    if (!password && !passphrase) continue
    result[hostId] = { password, passphrase }
  }
  return result
}

export interface MergeOptions {
  mode: SyncImportMode
  /** 便于测试注入确定性 id 生成器 */
  makeId?: () => string
}

/**
 * 把同步包合并到本机快照。
 * - merge：按 id 对齐，updatedAt 较新者胜；本机独有条目原样保留。
 * - replace：包里有哪个分区就整段替换哪个分区，没带的分区保留本机内容。
 */
export function mergeBundle(local: Snapshot, remote: SyncBundlePayload, options: MergeOptions): MergeOutcome {
  const makeId = options.makeId ?? randomUUID
  const warnings: string[] = []
  const stats: MergeStats = {
    hosts: 0,
    snippets: 0,
    tunnels: 0,
    knownHosts: 0,
    credentials: 0,
    settings: false
  }
  const conflicts: SyncPreview['conflicts'] = { hosts: 0, snippets: 0, others: 0 }

  // ---------------------------------------------------------------- 主机
  const incomingHosts: HostProfile[] = []
  let skippedHosts = 0
  if (Array.isArray(remote.hosts)) {
    for (const raw of remote.hosts.slice(0, 1000)) {
      const host = sanitizeRemoteHost(raw, makeId)
      if (!host) {
        skippedHosts += 1
        continue
      }
      incomingHosts.push(host)
    }
  }
  if (skippedHosts > 0) warnings.push(`跳过 ${skippedHosts} 条格式不完整的主机记录`)

  const localHostMap = new Map(local.hosts.map((host) => [host.id, host]))
  let hosts: HostProfile[]
  // 替换模式只替换「包里真正带了的分区」，没带的分区保留本机，避免一次导入清空无关数据
  const replaceHosts = options.mode === 'replace' && Array.isArray(remote.hosts)
  if (replaceHosts) {
    hosts = incomingHosts.map((host) => host)
    stats.hosts = hosts.length
  } else {
    hosts = [...local.hosts]
    for (const host of incomingHosts) {
      const existing = localHostMap.get(host.id)
      if (!existing) {
        hosts.push(host)
        stats.hosts += 1
        continue
      }
      if ((host.updatedAt ?? 0) > (existing.updatedAt ?? 0) || options.mode === 'overwrite') {
        const index = hosts.findIndex((item) => item.id === host.id)
        hosts[index] = { ...host, lastUsedAt: existing.lastUsedAt }
        conflicts.hosts += 1
      }
    }
  }

  // 跳板机关系：包内同 id 才保留，否则降级为直连并明确告警（绝不静默连错机器）
  const hostIds = new Set(hosts.map((host) => host.id))
  let brokenJump = 0
  hosts = hosts.map((host) => {
    if (!host.proxyJump) return host
    if (hostIds.has(host.proxyJump)) return host
    brokenJump += 1
    return { ...host, proxyJump: undefined }
  })
  if (brokenJump > 0) {
    warnings.push(`${brokenJump} 台主机的跳板机不在本次同步范围内，已改为直连`)
  }

  // ---------------------------------------------------------------- 片段
  const incomingSnippets: Snippet[] = []
  if (Array.isArray(remote.snippets)) {
    for (const raw of remote.snippets.slice(0, 1000)) {
      const snippet = sanitizeRemoteSnippet(raw, makeId)
      if (snippet) incomingSnippets.push(snippet)
    }
  }
  let snippets: Snippet[]
  if (options.mode === 'replace' && Array.isArray(remote.snippets)) {
    snippets = incomingSnippets
    stats.snippets = snippets.length
  } else {
    snippets = [...local.snippets]
    const byId = new Map(local.snippets.map((item) => [item.id, item]))
    const byCommand = new Set(local.snippets.map((item) => item.command.trim()))
    for (const snippet of incomingSnippets) {
      if (byId.has(snippet.id)) {
        // 片段没有 updatedAt：同 id 视为同一条，按包内内容更新
        const index = snippets.findIndex((item) => item.id === snippet.id)
        snippets[index] = snippet
        conflicts.snippets += 1
        continue
      }
      // 换了设备后 id 可能变（旧版本导入会重生成 id），同命令视为重复，避免刷屏
      if (byCommand.has(snippet.command.trim())) continue
      snippets.push(snippet)
      byCommand.add(snippet.command.trim())
      stats.snippets += 1
    }
  }

  // ------------------------------------------------------------ 端口转发
  const incomingTunnels: TunnelConfig[] = []
  if (Array.isArray(remote.tunnels)) {
    for (const raw of remote.tunnels.slice(0, 200)) {
      const tunnel = sanitizeRemoteTunnel(raw)
      if (tunnel) incomingTunnels.push(tunnel)
    }
  }
  let tunnels: TunnelConfig[]
  if (options.mode === 'replace' && Array.isArray(remote.tunnels)) {
    tunnels = incomingTunnels
    stats.tunnels = tunnels.length
  } else {
    tunnels = [...local.tunnels]
    const byId = new Map(local.tunnels.map((item) => [item.id, item]))
    for (const tunnel of incomingTunnels) {
      if (byId.has(tunnel.id)) {
        const index = tunnels.findIndex((item) => item.id === tunnel.id)
        tunnels[index] = tunnel
        conflicts.others += 1
        continue
      }
      tunnels.push(tunnel)
      stats.tunnels += 1
    }
  }

  // ------------------------------------------------------------ 主机指纹
  const incomingKnown = remote.knownHosts && typeof remote.knownHosts === 'object' ? remote.knownHosts : undefined
  let knownHosts: Record<string, string>
  let fingerprintKept = 0
  let fingerprintOverwritten = 0
  if (!incomingKnown) {
    knownHosts = { ...local.knownHosts }
  } else if (options.mode === 'replace') {
    knownHosts = {}
    for (const [key, value] of Object.entries(incomingKnown)) {
      if (typeof value !== 'string' || !value) continue
      knownHosts[key.slice(0, 300)] = value.slice(0, 200)
      stats.knownHosts += 1
    }
  } else {
    knownHosts = { ...local.knownHosts }
    for (const [key, value] of Object.entries(incomingKnown)) {
      if (typeof value !== 'string' || !value) continue
      const safeKey = key.slice(0, 300)
      const safeValue = value.slice(0, 200)
      if (!knownHosts[safeKey]) {
        knownHosts[safeKey] = safeValue
        stats.knownHosts += 1
      } else if (knownHosts[safeKey] !== safeValue) {
        if (options.mode === 'overwrite') {
          // 用户明确选择「远端覆盖本地」，指纹也照办——但必须在检测里能看到条数
          knownHosts[safeKey] = safeValue
          fingerprintOverwritten += 1
          stats.knownHosts += 1
          conflicts.others += 1
        } else {
          // 合并模式下，指纹代表「这台设备信任过什么」，冲突必须由用户自己重新确认
          fingerprintKept += 1
          conflicts.others += 1
        }
      }
    }
  }
  if (fingerprintKept > 0) {
    warnings.push(
      `${fingerprintKept} 个主机指纹与本地记录不一致，已保留本机记录；如需更新请重新连接并按提示确认`
    )
  }
  if (fingerprintOverwritten > 0) {
    warnings.push(
      `${fingerprintOverwritten} 个主机指纹已被同步包覆盖；下次连接若与新指纹不符会再次提示`
    )
  }

  // ------------------------------------------------------------------ 设置
  let settings = local.settings
  if (remote.settings && typeof remote.settings === 'object') {
    settings = mergeSettings(local.settings, remote.settings)
    stats.settings = true
  }

  // ------------------------------------------------------------------ 凭据
  const credentials = sanitizeCredentials(remote.credentials, hostIds)
  stats.credentials = Object.keys(credentials).length

  return {
    next: { hosts, snippets, settings, tunnels, knownHosts },
    stats,
    warnings,
    conflicts,
    credentials
  }
}

/** 导出前的快照裁剪：去掉设备私有设置，避免把「这台机器」的痕迹带到别处 */
export function pickPortableSettings(settings: Partial<AppSettings>): Partial<AppSettings> {
  const result: Record<string, unknown> = { ...settings }
  for (const key of DEVICE_LOCAL_SETTINGS) delete result[key]
  return result as Partial<AppSettings>
}

/** 生成导入前的预览（用于「确认前先看一眼」） */
export function buildPreview(remote: SyncBundlePayload, outcome: MergeOutcome): SyncPreview {
  const hosts = Array.isArray(remote.hosts)
    ? remote.hosts.slice(0, 500).map((raw) => {
        const item = raw as Partial<HostProfile>
        return {
          id: String(item.id ?? ''),
          name: String(item.name ?? item.host ?? '未命名'),
          host: String(item.host ?? ''),
          username: String(item.username ?? ''),
          group: item.group ? String(item.group) : undefined
        }
      })
    : []
  return {
    hosts,
    snippets: Array.isArray(remote.snippets) ? remote.snippets.length : 0,
    tunnels: Array.isArray(remote.tunnels) ? remote.tunnels.length : 0,
    knownHosts: remote.knownHosts ? Object.keys(remote.knownHosts).length : 0,
    credentials: remote.credentials ? Object.keys(remote.credentials).length : 0,
    settings: Boolean(remote.settings),
    conflicts: outcome.conflicts
  }
}

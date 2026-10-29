import { app, safeStorage } from 'electron'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { sanitizeLayout } from '../../shared/layout-schema'
import { DEFAULT_SETTINGS, sanitizeSettings } from '../../shared/settings'
import type { SyncCredential, SyncScope, SyncTransportKind } from '../../shared/sync'
import { SYNC_SCOPES, AutoSyncPath} from '../../shared/sync'
import type {
  AppSettings,
  HostDraft,
  HostProfile,
  PersistedTab,
  Snippet,
  TunnelConfig
} from '../../shared/types'
import type { Snapshot } from './sync-merge'

/**
 * 加密后的密文封装。
 * enc = true 表示使用 Electron safeStorage（macOS Keychain / Windows DPAPI / Linux libsecret）加密；
 * 当系统缺少可用 keyring 时降级为 enc = false（仅 base64 编码），并在 UI 中提示用户。
 */
interface Sealed {
  enc: boolean
  data: string
}

interface SecretRecord {
  password?: Sealed
  passphrase?: Sealed
}

/**
 * 自动同步的持久化状态。
 * 与主机配置分文件存放：它包含同步口令（经 safeStorage 封装）与「上次处理的指纹」，
 * 混进 state.json 既会让导出的同步包带上无关字段，也不方便单独重置。
 */
export interface StoredAutoSync {
  enabled: boolean
  /** 传输方式：本地/云盘目录，或 SFTP 到自己的服务器 */
  transport: SyncTransportKind
  /** 真实目录（由 targetId 解析后写入，渲染层读不到，也不允许指定） */
  dir: string
  targetId: string
  targetLabel?: string
  /** SFTP 通道：主机 id / 名称 / 远端目录 */
  sftpHostId?: string
  sftpHostLabel?: string
  sftpDir?: string
  /** WebDAV 通道：目录地址 / 用户名（密码单独封装） */
  webdavUrl?: string
  webdavUsername?: string
  /** 用户手动添加的同步路径（本机私有，不随配置包同步） */
  paths?: AutoSyncPath[]
  scopes: SyncScope[]
  pushLocalChanges: boolean
  pullRemoteChanges: boolean
  pauseOnRisky: boolean
  /** 同步包口令 */
  password?: Sealed
  /** WebDAV 认证密码（与同步包口令是两回事） */
  webdavPassword?: Sealed
  lastSyncedAt?: number
  lastResult?: string
  lastError?: string
  /** 上次由本机写入的内容指纹，避免自己的写入又触发一次拉取 */
  lastPushedHash?: string
  /** 上次推送时用的同步口令指纹（不含明文）：口令变了就重新写一份远端 */
  lastPushedPasswordTag?: string
  /** 上次成功应用的远端指纹 */
  lastPulledHash?: string
}

const DEFAULT_AUTO_SYNC: StoredAutoSync = {
  enabled: false,
  transport: 'folder',
  dir: '',
  targetId: '',
  scopes: ['hosts', 'snippets', 'settings', 'tunnels'],
  pushLocalChanges: true,
  pullRemoteChanges: true,
  pauseOnRisky: true
}

interface StateShape {
  version: number
  hosts: HostProfile[]
  settings: AppSettings
  snippets: Snippet[]
  tunnels: TunnelConfig[]
  /** key = host:port:算法，value = SHA256 指纹 */
  knownHosts: Record<string, string>
  /** 指纹库结构版本：1 = 只有 host:port，2 = 带算法 */
  knownHostsVersion: number
}

const STATE_VERSION = 1

/**
 * 本地配置存储（纯本地，无账号体系）。
 *
 * 设计要点：
 * 1. 单文件 JSON + 原子写入（tmp -> rename），避免写一半掉电导致配置损坏；
 * 2. 主机资料与口令分离存盘，口令经 safeStorage 加密后单独保存在 secrets.json；
 * 3. 存储层不依赖任何第三方库（electron-store 为 ESM-only，会给主进程打包引入额外复杂度）。
 */
export class StoreService {
  private readonly dir: string
  private readonly stateFile: string
  private readonly secretsFile: string
  private readonly layoutFile: string
  private readonly windowFile: string
  private readonly syncFile: string
  private layoutTimer?: NodeJS.Timeout
  private layoutPending: PersistedTab[] | null = null
  private state: StateShape
  private secrets: Record<string, SecretRecord>
  private autoSync: StoredAutoSync
  /** 配置写入后的变更通知：自动同步据此判断「本机是不是刚改过」 */
  private readonly changeListeners = new Set<() => void>()

  constructor(dirOverride?: string) {
    this.dir = dirOverride ?? path.join(app.getPath('userData'), 'data')
    this.stateFile = path.join(this.dir, 'state.json')
    this.secretsFile = path.join(this.dir, 'secrets.json')
    this.layoutFile = path.join(this.dir, 'layout.json')
    this.windowFile = path.join(this.dir, 'window.json')
    this.syncFile = path.join(this.dir, 'sync.json')
    fs.mkdirSync(this.dir, { recursive: true })
    this.state = this.loadState()
    this.secrets = this.loadSecrets()
    this.autoSync = this.loadAutoSync()
    this.migrate()
  }

  // ---------------------------------------------------------------- 底层读写

  /** 解析失败时先备份原文件，避免随后的一次写入把用户配置永久覆盖 */
  private backupBroken(file: string): void {
    try {
      if (!fs.existsSync(file)) return
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      fs.copyFileSync(file, `${file}.broken-${stamp}`)
    } catch {
      /* 备份失败也不能阻塞启动 */
    }
  }

  private loadState(): StateShape {
    try {
      const raw = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) as Partial<StateShape>
      return {
        version: STATE_VERSION,
        hosts: Array.isArray(raw.hosts) ? raw.hosts : [],
        settings: sanitizeSettings(raw.settings),
        snippets: Array.isArray(raw.snippets) ? raw.snippets : [],
        tunnels: Array.isArray(raw.tunnels) ? raw.tunnels : [],
        knownHosts: raw.knownHosts ?? {},
        knownHostsVersion: raw.knownHostsVersion ?? 1
      }
    } catch {
      this.backupBroken(this.stateFile)
      return {
        version: STATE_VERSION,
        hosts: [],
        settings: { ...DEFAULT_SETTINGS },
        snippets: [],
        tunnels: [],
        knownHosts: {},
        knownHostsVersion: 2
      }
    }
  }

  private loadSecrets(): Record<string, SecretRecord> {
    try {
      return JSON.parse(fs.readFileSync(this.secretsFile, 'utf8')) as Record<string, SecretRecord>
    } catch {
      this.backupBroken(this.secretsFile)
      return {}
    }
  }

  /** 原子写：先写临时文件再 rename，保证任一时刻磁盘上都是完整 JSON */
  private static writeJsonAtomic(file: string, value: unknown): void {
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 })
    fs.renameSync(tmp, file)
  }

  private persistState(): void {
    StoreService.writeJsonAtomic(this.stateFile, this.state)
    // 通知监听方（自动同步）：配置真的变了才需要往外推
    for (const listener of this.changeListeners) {
      try {
        listener()
      } catch {
        /* 监听方异常不能影响写盘 */
      }
    }
  }

  private persistSecrets(): void {
    StoreService.writeJsonAtomic(this.secretsFile, this.secrets)
  }

  private static seal(plain: string): Sealed {
    if (safeStorage.isEncryptionAvailable()) {
      return { enc: true, data: safeStorage.encryptString(plain).toString('base64') }
    }
    return { enc: false, data: Buffer.from(plain, 'utf8').toString('base64') }
  }

  private static unseal(sealed?: Sealed): string | undefined {
    if (!sealed) return undefined
    try {
      const buf = Buffer.from(sealed.data, 'base64')
      return sealed.enc ? safeStorage.decryptString(buf) : buf.toString('utf8')
    } catch {
      // 换机器 / 系统密钥变更后旧密文无法解密，视为未保存
      return undefined
    }
  }

  // ------------------------------------------------------------------ 主机

  listHosts(): HostProfile[] {
    return [...this.state.hosts].sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))
  }

  getHost(id: string): HostProfile | undefined {
    return this.state.hosts.find((h) => h.id === id)
  }

  /**
   * 新建或更新主机。
   * 口令类字段留空表示「保持原值」，因此编辑表单无需回填明文口令。
   */
  upsertHost(draft: HostDraft): HostProfile {
    const host = draft.host.trim()
    if (!host) throw new Error('主机地址不能为空')
    if (!draft.username.trim()) throw new Error('用户名不能为空')
    const port = Number(draft.port)
    if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('端口需在 1-65535 之间')

    const now = Date.now()
    const existing = draft.id ? this.getHost(draft.id) : undefined
    const profile: HostProfile = {
      id: existing?.id ?? randomUUID(),
      name: draft.name.trim() || host,
      host,
      port,
      username: draft.username.trim(),
      authType: draft.authType,
      privateKeyPath: draft.privateKeyPath?.trim() || undefined,
      proxyJump: draft.proxyJump?.trim() || undefined,
      group: draft.group?.trim() || undefined,
      color: draft.color,
      lastUsedAt: existing?.lastUsedAt,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    }

    if (draft.authType === 'key' && !profile.privateKeyPath) {
      throw new Error('私钥登录需要指定私钥文件')
    }
    if (profile.proxyJump) {
      if (profile.proxyJump === profile.id) throw new Error('跳板机不能是自己')
      if (!this.getHost(profile.proxyJump)) throw new Error('跳板机不存在')
    }

    const secrets: SecretRecord = { ...(this.secrets[profile.id] ?? {}) }
    if (draft.password !== undefined && draft.password !== '') {
      secrets.password = StoreService.seal(draft.password)
    }
    if (draft.passphrase !== undefined && draft.passphrase !== '') {
      secrets.passphrase = StoreService.seal(draft.passphrase)
    }
    // 切换认证方式时清理不再需要的凭据，避免残留敏感数据
    if (profile.authType === 'agent') {
      delete secrets.password
      delete secrets.passphrase
    }

    if (existing) {
      const idx = this.state.hosts.findIndex((h) => h.id === existing.id)
      this.state.hosts[idx] = profile
    } else {
      this.state.hosts.push(profile)
    }
    this.secrets[profile.id] = secrets
    this.persistState()
    this.persistSecrets()
    return profile
  }

  deleteHost(id: string): void {
    const host = this.getHost(id)
    this.state.hosts = this.state.hosts.filter((h) => h.id !== id)
    delete this.secrets[id]
    this.persistState()
    this.persistSecrets()
    if (host) this.removeKnownHostsByEndpoint(host.host, host.port)
  }

  /** 取回解密后的凭据，仅供主进程 SSH 层使用，绝不通过 IPC 回传渲染进程 */
  getCredentials(id: string): { password?: string; passphrase?: string } {
    const record = this.secrets[id]
    if (!record) return {}
    return {
      password: StoreService.unseal(record.password),
      passphrase: StoreService.unseal(record.passphrase)
    }
  }

  touchHost(id: string): void {
    const host = this.getHost(id)
    if (!host) return
    host.lastUsedAt = Date.now()
    this.persistState()
  }

  /**
   * 数据结构迁移。
   * v1 的指纹只按 `host:port` 记录，无法区分密钥算法；升级为 `host:port:algo` 后
   * 旧数据无法安全映射到具体算法，因此清空一次并重新走 TOFU（与首次连接等价）。
   */
  private migrate(): void {
    if (this.state.knownHostsVersion >= 2) return
    // 保留 v1 的 host:port 记录，连接时作为旧格式回退匹配，避免升级后静默重新 TOFU
    this.state.knownHostsVersion = 2
    this.persistState()
  }

  // ------------------------------------------------------------ 主机指纹

  getKnownHostFingerprint(key: string): string | undefined {
    return this.state.knownHosts[key]
  }

  setKnownHostFingerprint(key: string, fingerprint: string): void {
    this.state.knownHosts[key] = fingerprint
    this.persistState()
  }

  /** 删除主机时清掉该端点下所有算法的指纹，避免残留导致「删了还有记录」 */
  removeKnownHostsByEndpoint(host: string, port: number): void {
    const prefix = `${host}:${port}:`
    let changed = false
    if (this.state.knownHosts[`${host}:${port}`]) {
      delete this.state.knownHosts[`${host}:${port}`]
      changed = true
    }
    for (const key of Object.keys(this.state.knownHosts)) {
      if (key.startsWith(prefix)) {
        delete this.state.knownHosts[key]
        changed = true
      }
    }
    if (changed) this.persistState()
  }

  /** 用户在「指纹变更」弹窗里确认后写入新指纹 */
  trustKnownHost(host: string, port: number, algorithm: string, fingerprint: string): void {
    this.state.knownHosts[`${host}:${port}:${algorithm}`] = fingerprint
    this.persistState()
  }

  // -------------------------------------------------------------- 布局持久化

  /** 读取上次退出时的标签/分屏结构（只含连接参数，不含运行态） */
  loadLayout(): PersistedTab[] {
    try {
      return sanitizeLayout(JSON.parse(fs.readFileSync(this.layoutFile, 'utf8')))
    } catch {
      return []
    }
  }

  private writeLayout(): void {
    if (!this.layoutPending) return
    StoreService.writeJsonAtomic(this.layoutFile, this.layoutPending)
    this.layoutPending = null
  }

  /** 布局变化频繁，合并 400ms 再落盘；退出前调用 flushLayout 兜底 */
  saveLayout(tabs: PersistedTab[]): void {
    this.layoutPending = tabs.slice(0, 30)
    if (this.layoutTimer) clearTimeout(this.layoutTimer)
    this.layoutTimer = setTimeout(() => {
      this.layoutTimer = undefined
      this.writeLayout()
    }, 400)
  }

  flushLayout(): void {
    if (this.layoutTimer) {
      clearTimeout(this.layoutTimer)
      this.layoutTimer = undefined
    }
    this.writeLayout()
  }

  // ------------------------------------------------------------ 窗口位置

  loadWindowState(): { x?: number; y?: number; width: number; height: number } | null {
    try {
      const raw = JSON.parse(fs.readFileSync(this.windowFile, 'utf8')) as Record<string, unknown>
      const width = Number(raw.width)
      const height = Number(raw.height)
      if (!Number.isFinite(width) || !Number.isFinite(height)) return null
      return {
        width: Math.max(900, Math.min(4000, width)),
        height: Math.max(560, Math.min(3000, height)),
        x: Number.isFinite(Number(raw.x)) ? Number(raw.x) : undefined,
        y: Number.isFinite(Number(raw.y)) ? Number(raw.y) : undefined
      }
    } catch {
      return null
    }
  }

  saveWindowState(bounds: { x: number; y: number; width: number; height: number }): void {
    try {
      StoreService.writeJsonAtomic(this.windowFile, bounds)
    } catch {
      /* 窗口状态写失败不影响退出 */
    }
  }

  // ---------------------------------------------------------------- 设置

  getSettings(): AppSettings {
    return { ...this.state.settings }
  }

  updateSettings(patch: Partial<AppSettings>): AppSettings {
    this.state.settings = sanitizeSettings({ ...this.state.settings, ...patch })
    this.persistState()
    return this.getSettings()
  }

  // ------------------------------------------------------------ 数据同步支撑

  /** 应用数据目录（备份、同步包默认落点等都以它为基准） */
  get dataDir(): string {
    return this.dir
  }

  /** 深拷贝一份当前配置，供同步/合并计算使用（避免外部直接改内部状态） */
  snapshot(): Snapshot {
    return {
      hosts: this.state.hosts.map((host) => ({ ...host })),
      snippets: this.state.snippets.map((snippet) => ({ ...snippet })),
      settings: { ...this.state.settings },
      tunnels: this.state.tunnels.map((tunnel) => ({ ...tunnel })),
      knownHosts: { ...this.state.knownHosts }
    }
  }

  /** 用合并结果整体覆盖内存状态并落盘（合并本身由 sync-merge 纯函数完成） */
  applySnapshot(next: Snapshot): void {
    this.state.hosts = next.hosts
    this.state.snippets = next.snippets
    this.state.settings = sanitizeSettings(next.settings)
    this.state.tunnels = next.tunnels
    this.state.knownHosts = next.knownHosts
    this.persistState()

    // 替换导入后可能留下孤儿凭据，顺手清掉，避免 secrets.json 越滚越大
    const alive = new Set(next.hosts.map((host) => host.id))
    let pruned = false
    for (const id of Object.keys(this.secrets)) {
      if (!alive.has(id)) {
        delete this.secrets[id]
        pruned = true
      }
    }
    if (pruned) this.persistSecrets()
  }

  /**
   * 导出指定主机的凭据（解密后返回明文）。
   * 只应由同步服务在主进程内调用，结果必须立刻进加密信封，绝不落地明文。
   */
  exportCredentials(hostIds: string[]): Record<string, SyncCredential> {
    const result: Record<string, SyncCredential> = {}
    for (const id of hostIds) {
      const record = this.secrets[id]
      if (!record) continue
      const password = StoreService.unseal(record.password)
      const passphrase = StoreService.unseal(record.passphrase)
      if (!password && !passphrase) continue
      result[id] = { password, passphrase }
    }
    return result
  }

  /**
   * 导入凭据：用本机 safeStorage 重新封装后落盘。
   * 跨机器的密文在这里被彻底丢弃，换设备后不需要重新输入口令。
   */
  applyCredentials(map: Record<string, SyncCredential>): number {
    let count = 0
    for (const [id, value] of Object.entries(map)) {
      if (!this.state.hosts.some((host) => host.id === id)) continue
      if (!value.password && !value.passphrase) continue
      const record: SecretRecord = { ...(this.secrets[id] ?? {}) }
      if (value.password) record.password = StoreService.seal(value.password)
      if (value.passphrase) record.passphrase = StoreService.seal(value.passphrase)
      this.secrets[id] = record
      count += 1
    }
    if (count > 0) this.persistSecrets()
    return count
  }

  /**
   * 导入前的自动备份：把配置与凭据复制到 data/backups/<reason>-<时间戳>/。
   * 这是「替换导入」的安全网——用户后悔时可以直接把文件拷回来。
   */
  backupNow(reason = 'sync'): string {
    const dir = path.join(this.dir, 'backups')
    fs.mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const target = path.join(dir, `${reason}-${stamp}`)
    fs.mkdirSync(target, { recursive: true })
    for (const file of [this.stateFile, this.secretsFile]) {
      try {
        if (fs.existsSync(file)) fs.copyFileSync(file, path.join(target, path.basename(file)))
      } catch {
        /* 备份失败不应阻塞导入，调用方会在结果里提示 */
      }
    }
    return target
  }

  // ------------------------------------------------------------ 自动同步

  /** 配置写入后的通知；返回取消订阅函数 */
  onDidChange(listener: () => void): () => void {
    this.changeListeners.add(listener)
    return () => {
      this.changeListeners.delete(listener)
    }
  }

  private loadAutoSync(): StoredAutoSync {
    try {
      const raw = JSON.parse(fs.readFileSync(this.syncFile, 'utf8')) as Partial<StoredAutoSync>
      const allowed = new Set(SYNC_SCOPES.map((item) => item.id))
      const scopes = Array.isArray(raw.scopes)
        ? raw.scopes.filter((item): item is SyncScope => allowed.has(item as SyncScope))
        : []
      return {
        ...DEFAULT_AUTO_SYNC,
        ...raw,
        scopes: scopes.length > 0 ? scopes : [...DEFAULT_AUTO_SYNC.scopes]
      }
    } catch {
      return { ...DEFAULT_AUTO_SYNC, scopes: [...DEFAULT_AUTO_SYNC.scopes] }
    }
  }

  getAutoSync(): StoredAutoSync {
    return {
      ...this.autoSync,
      scopes: [...this.autoSync.scopes],
      paths: (this.autoSync.paths ?? []).map((item) => ({ ...item }))
    }
  }

  saveAutoSync(patch: Partial<StoredAutoSync>): StoredAutoSync {
    this.autoSync = { ...this.autoSync, ...patch }
    StoreService.writeJsonAtomic(this.syncFile, this.autoSync)
    return this.getAutoSync()
  }

  /** 自动同步口令（明文），仅在主进程内部使用，绝不通过 IPC 回传 */
  syncPassword(): string | undefined {
    return StoreService.unseal(this.autoSync.password)
  }

  setSyncPassword(plain: string | null): void {
    if (!plain) delete this.autoSync.password
    else this.autoSync.password = StoreService.seal(plain)
    StoreService.writeJsonAtomic(this.syncFile, this.autoSync)
  }

  /** WebDAV 认证密码（明文），同样只在主进程内部使用 */
  webdavPassword(): string | undefined {
    return StoreService.unseal(this.autoSync.webdavPassword)
  }

  setWebdavPassword(plain: string | null): void {
    if (!plain) delete this.autoSync.webdavPassword
    else this.autoSync.webdavPassword = StoreService.seal(plain)
    StoreService.writeJsonAtomic(this.syncFile, this.autoSync)
  }

  // ------------------------------------------------------------- 命令片段

  listSnippets(): Snippet[] {
    return [...this.state.snippets].sort((a, b) => a.createdAt - b.createdAt)
  }

  saveSnippet(input: { id?: string; name: string; command: string; alias?: string }): Snippet {
    if (!input.command.trim()) throw new Error('命令内容不能为空')
    const existing = input.id ? this.state.snippets.find((s) => s.id === input.id) : undefined
    const snippet: Snippet = {
      id: existing?.id ?? randomUUID(),
      name: input.name.trim() || input.command.slice(0, 24),
      command: input.command,
      alias: input.alias?.trim() || undefined,
      createdAt: existing?.createdAt ?? Date.now()
    }
    if (existing) {
      this.state.snippets = this.state.snippets.map((s) => (s.id === snippet.id ? snippet : s))
    } else {
      this.state.snippets.push(snippet)
    }
    this.persistState()
    return snippet
  }

  deleteSnippet(id: string): void {
    this.state.snippets = this.state.snippets.filter((s) => s.id !== id)
    this.persistState()
  }

  // ------------------------------------------------------------- 端口转发

  listTunnels(): TunnelConfig[] {
    return [...this.state.tunnels]
  }

  saveTunnel(cfg: TunnelConfig): TunnelConfig {
    const existing = this.state.tunnels.find((t) => t.id === cfg.id)
    this.state.tunnels = existing
      ? this.state.tunnels.map((t) => (t.id === cfg.id ? cfg : t))
      : [...this.state.tunnels, cfg]
    this.persistState()
    return cfg
  }
}

import { app, type BrowserWindow, dialog } from 'electron'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  buildSyncFileName,
  SYNC_EXTENSION,
  SYNC_MAX_BYTES,
  SYNC_SCOPES,
  type DiffReport,
  type SyncBundleMeta,
  type SyncBundlePayload,
  type SyncEnvelope,
  type SyncExportOptions,
  type SyncExportResult,
  type SyncFolderFile,
  type SyncImportMode,
  type SyncImportRequest,
  type SyncImportResult,
  type SyncInspectResult,
  type SyncScope,
  type SyncSource,
  type SyncTarget
} from '../../shared/sync'
import type { AppSettings, HostProfile } from '../../shared/types'
import { readClipboard, writeClipboard } from './clipboard'
import { log } from './logger'
import { diffBundle } from './sync-diff'
import { composeLocalBundle } from './sync-bundle'
import { buildPreview, mergeBundle, pickPortableSettings } from './sync-merge'
import {
  decryptBundle,
  encryptBundle,
  parseSyncText,
  plainBundle,
  serializeBundle,
  SyncError
} from './sync-crypto'
import { detectSyncTargets, ensureSyncFolder, resolveTargetDir, syncFolderPath } from './sync-targets'
import type { StoreService } from './store'

interface PendingImport {
  payload?: SyncBundlePayload
  envelope?: SyncEnvelope
  meta: SyncBundleMeta
  legacy: boolean
  sourceLabel: string
}

/** 同时挂起的导入会话上限：超过就丢最早的，避免长期占内存 */
const MAX_PENDING = 6

/**
 * 数据共享服务。
 *
 * 职责边界很清楚：
 * - **只做搬运与校验**，不持有任何云端凭据，也不联网；
 * - 渲染层永远只能传 `targetId` / `token`，真实路径与解密结果都留在主进程，
 *   这样即使渲染层被注入，也无法用 IPC 读写任意路径或拿到明文凭据；
 * - 导入必然先备份，替换导入也留退路。
 */
export class SyncService {
  private readonly pending = new Map<string, PendingImport>()

  constructor(private readonly store: StoreService) {}

  /** 本机可用的同步位置（只含真实存在的目录，可能为空） */
  targets(): SyncTarget[] {
    return detectSyncTargets()
  }

  /** 云盘目录里的历史同步包，按时间倒序 */
  listFolderFiles(targetId: string): SyncFolderFile[] {
    const dir = syncFolderPath(resolveTargetDir(this.targets(), targetId))
    let names: string[]
    try {
      names = fs.readdirSync(dir)
    } catch {
      return []
    }
    const files: SyncFolderFile[] = []
    for (const name of names) {
      if (!name.toLowerCase().endsWith(`.${SYNC_EXTENSION}`)) continue
      try {
        const stat = fs.statSync(path.join(dir, name))
        if (!stat.isFile()) continue
        files.push({ name, size: stat.size, mtime: stat.mtimeMs })
      } catch {
        /* 读不到就跳过，不让单个坏文件拖垮列表 */
      }
    }
    return files.sort((a, b) => b.mtime - a.mtime).slice(0, 50)
  }

  // ------------------------------------------------------------------ 导出

  async export(options: SyncExportOptions, win: BrowserWindow | null): Promise<SyncExportResult> {
    const scopes = this.sanitizeScopes(options.scopes)
    if (scopes.length === 0) throw new SyncError('请至少选择一项要同步的内容')

    const { payload, meta } = this.compose(scopes)
    const hasCredentials = Object.keys(payload.credentials ?? {}).length > 0
    if (hasCredentials && !options.password) {
      throw new SyncError('包含密码的同步包必须设置口令加密')
    }

    const envelope = options.password
      ? encryptBundle(payload, meta, options.password)
      : plainBundle(payload, meta)
    const text = serializeBundle(envelope)
    const bytes = Buffer.byteLength(text, 'utf8')

    if (options.destination.kind === 'clipboard') {
      await writeClipboard(text)
      log.info(`同步包已复制到剪贴板（${bytes} 字节）`)
      return { canceled: false, clipboard: true, bytes, meta }
    }

    if (options.destination.kind === 'folder') {
      const targetDir = resolveTargetDir(this.targets(), options.destination.targetId)
      const dir = ensureSyncFolder(targetDir)
      const filePath = this.uniquePath(dir, buildSyncFileName())
      this.writeFile(filePath, text)
      log.info(`同步包已写入云盘目录：${filePath}`)
      return { canceled: false, path: filePath, bytes, meta }
    }

    const defaultPath = path.join(app.getPath('documents'), buildSyncFileName())
    const dialogOptions = {
      title: '导出同步包',
      defaultPath,
      filters: [{ name: 'JShell 同步包', extensions: [SYNC_EXTENSION] }]
    }
    const result = win
      ? await dialog.showSaveDialog(win, dialogOptions)
      : await dialog.showSaveDialog(dialogOptions)
    if (result.canceled || !result.filePath) return { canceled: true }

    this.writeFile(result.filePath, text)
    log.info(`同步包已导出：${result.filePath}`)
    return { canceled: false, path: result.filePath, bytes, meta }
  }

  // ------------------------------------------------------------------ 预览

  /**
   * 读取并解析来源。
   * 未加密的包会直接给出预览；加密包在提供正确口令后才返回预览与可用 token。
   */
  async inspect(
    source: SyncSource,
    password: string | undefined,
    win: BrowserWindow | null
  ): Promise<SyncInspectResult> {
    const read = await this.readSource(source, win)
    if (!read) return { canceled: true }
    const { text, sourceLabel } = read
    if (Buffer.byteLength(text, 'utf8') > SYNC_MAX_BYTES) {
      throw new SyncError('同步包超过 20MB，已拒绝读取')
    }

    const parsed = parseSyncText(text)
    const token = randomUUID()

    if (parsed.legacy) {
      const payload = this.normalizeLegacy(parsed.payload)
      const hasContent =
        (payload.hosts?.length ?? 0) > 0 ||
        (payload.snippets?.length ?? 0) > 0 ||
        Boolean(payload.settings) ||
        Boolean(payload.knownHosts)
      if (!hasContent) throw new SyncError('这个文件里没有可导入的 JShell 配置')
      const meta = this.legacyMeta(payload, parsed.payload)
      this.remember(token, { payload, meta, legacy: true, sourceLabel })
      return this.withPreview(token, payload, meta, {
        encrypted: false,
        legacy: true,
        sourceLabel
      })
    }

    const envelope = parsed.envelope
    const meta = envelope.meta
    if (!envelope.encrypted) {
      const payload = envelope.payload ?? {}
      this.remember(token, { payload, meta, legacy: false, sourceLabel })
      return this.withPreview(token, payload, meta, {
        encrypted: false,
        legacy: false,
        sourceLabel
      })
    }

    if (!password) {
      // 只记住信封，口令与明文都不缓存；真正校验发生在导入时
      this.remember(token, { envelope, meta, legacy: false, sourceLabel })
      return { canceled: false, token, meta, encrypted: true, legacy: false, sourceLabel }
    }

    const payload = decryptBundle(envelope, password)
    this.remember(token, { payload, envelope, meta, legacy: false, sourceLabel })
    return this.withPreview(token, payload, meta, {
      encrypted: true,
      legacy: false,
      sourceLabel
    })
  }

  // ------------------------------------------------------------------ 检测

  /**
   * 覆盖前检测：只读，不动任何数据。
   * 界面在切换覆盖 / 合并 / 替换时切换口径，用户点「确认」之前先看清代价。
   */
  diff(token: string, mode: SyncImportMode): DiffReport {
    const pending = this.requirePending(token)
    if (!pending.payload) throw new SyncError('请先输入口令解读同步包')
    return diffBundle(this.store.snapshot(), pending.payload, mode)
  }

  // ------------------------------------------------------------------ 导入

  import(request: SyncImportRequest): SyncImportResult {
    const pending = this.requirePending(request.token)

    let payload = pending.payload
    if (!payload) {
      if (!pending.envelope) throw new SyncError('同步包内容不可用')
      if (!request.password) throw new SyncError('请输入同步包口令')
      payload = decryptBundle(pending.envelope, request.password)
      pending.payload = payload
    }

    // 覆盖/替换会改变本机已有的东西，必须先过一道检测；有风险项且未确认就拒绝
    const report = diffBundle(this.store.snapshot(), payload, request.mode)
    const riskyTotal = report.risky.overwriteNewer + report.risky.deleteLocal
    if (riskyTotal > 0 && !request.acknowledge) {
      throw new SyncError(
        `检测到 ${report.risky.overwriteNewer} 项会覆盖本机较新的改动、${report.risky.deleteLocal} 项会删除本机独有条目，请确认后再导入`
      )
    }

    const backupPath = this.store.backupNow(request.mode === 'replace' ? 'replace' : 'import')
    const outcome = mergeBundle(this.store.snapshot(), payload, { mode: request.mode })
    this.store.applySnapshot(outcome.next)
    const appliedCredentials = this.store.applyCredentials(outcome.credentials)

    const warnings = [...outcome.warnings]
    const missingKeys = outcome.next.hosts.filter(
      (host) => host.authType === 'key' && host.privateKeyPath && !fs.existsSync(host.privateKeyPath)
    ).length
    if (missingKeys > 0) {
      warnings.push(
        `${missingKeys} 台主机的私钥路径在本机不存在，连接前请在主机设置里重新选择私钥文件`
      )
    }

    this.pending.delete(request.token)
    log.info(
      `同步包已导入（${request.mode}）：主机 ${outcome.stats.hosts}、片段 ${outcome.stats.snippets}、凭据 ${appliedCredentials}`
    )

    return {
      ...outcome.stats,
      credentials: appliedCredentials,
      warnings,
      backupPath
    }
  }

  /** 面板关闭时清空挂起会话，不把明文/信封留在内存里 */
  clearPending(): void {
    this.pending.clear()
  }

  // ------------------------------------------------------------------ 内部

  private requirePending(token: string): PendingImport {
    const pending = this.pending.get(token)
    if (!pending) throw new SyncError('会话已过期，请重新选择同步包')
    return pending
  }

  private withPreview(
    token: string,
    payload: SyncBundlePayload,
    meta: SyncBundleMeta,
    flags: { encrypted: boolean; legacy: boolean; sourceLabel: string }
  ): SyncInspectResult {
    const outcome = mergeBundle(this.store.snapshot(), payload, { mode: 'merge' })
    return {
      canceled: false,
      token,
      meta,
      preview: buildPreview(payload, outcome),
      ...flags
    }
  }

  private remember(token: string, entry: PendingImport): void {
    this.pending.set(token, entry)
    if (this.pending.size > MAX_PENDING) {
      const oldest = this.pending.keys().next().value
      if (oldest) this.pending.delete(oldest)
    }
  }

  private sanitizeScopes(input: SyncScope[]): SyncScope[] {
    const allowed = new Set(SYNC_SCOPES.map((item) => item.id))
    const seen = new Set<SyncScope>()
    for (const scope of Array.isArray(input) ? input : []) {
      if (allowed.has(scope)) seen.add(scope)
    }
    return [...seen]
  }

  /** 按勾选范围裁剪快照，并生成明文元信息（与自动同步共用同一实现） */
  private compose(scopes: SyncScope[]): { payload: SyncBundlePayload; meta: SyncBundleMeta } {
    return composeLocalBundle(this.store, scopes)
  }

  private async readSource(
    source: SyncSource,
    win: BrowserWindow | null
  ): Promise<{ text: string; sourceLabel: string } | null> {
    if (source.kind === 'clipboard') {
      const text = await readClipboard()
      if (!text || !text.trim()) throw new SyncError('剪贴板里没有内容')
      return { text, sourceLabel: '剪贴板' }
    }

    if (source.kind === 'folder') {
      const targetDir = resolveTargetDir(this.targets(), source.targetId)
      const dir = syncFolderPath(targetDir)
      const name = path.basename(source.name)
      if (!name.toLowerCase().endsWith(`.${SYNC_EXTENSION}`)) throw new SyncError('不是 JShell 同步包')
      const filePath = path.join(dir, name)
      if (!fs.existsSync(filePath)) throw new SyncError('文件已不存在，请刷新列表')
      return { text: this.readFile(filePath), sourceLabel: name }
    }

    const result = win
      ? await dialog.showOpenDialog(win, {
          title: '选择同步包',
          properties: ['openFile'],
          filters: [
            { name: 'JShell 同步包', extensions: [SYNC_EXTENSION, 'json'] },
            { name: '全部文件', extensions: ['*'] }
          ]
        })
      : await dialog.showOpenDialog({
          title: '选择同步包',
          properties: ['openFile'],
          filters: [
            { name: 'JShell 同步包', extensions: [SYNC_EXTENSION, 'json'] },
            { name: '全部文件', extensions: ['*'] }
          ]
        })
    if (result.canceled || result.filePaths.length === 0) return null
    const filePath = result.filePaths[0]
    return { text: this.readFile(filePath), sourceLabel: path.basename(filePath) }
  }

  private readFile(filePath: string): string {
    const stat = fs.statSync(filePath)
    if (stat.size > SYNC_MAX_BYTES) throw new SyncError('同步包超过 20MB，已拒绝读取')
    return fs.readFileSync(filePath, 'utf8')
  }

  private writeFile(filePath: string, text: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    const tmp = `${filePath}.tmp`
    fs.writeFileSync(tmp, text, { mode: 0o600 })
    fs.renameSync(tmp, filePath)
  }

  /** 同一天多次导出不覆盖：加时分秒后缀 */
  private uniquePath(dir: string, name: string): string {
    const first = path.join(dir, name)
    if (!fs.existsSync(first)) return first
    const ext = path.extname(name)
    const base = name.slice(0, name.length - ext.length)
    const stamp = new Date().toTimeString().slice(0, 8).replace(/:/g, '')
    const second = path.join(dir, `${base}-${stamp}${ext}`)
    if (!fs.existsSync(second)) return second
    return path.join(dir, `${base}-${stamp}-${Math.random().toString(36).slice(2, 6)}${ext}`)
  }

  /** 旧版纯 JSON：`{ version, exportedAt, hosts, snippets }` */
  private normalizeLegacy(raw: Record<string, unknown>): SyncBundlePayload {
    const payload: SyncBundlePayload = {}
    if (Array.isArray(raw.hosts)) payload.hosts = raw.hosts as HostProfile[]
    if (Array.isArray(raw.snippets)) {
      payload.snippets = raw.snippets as SyncBundlePayload['snippets']
    }
    if (Array.isArray(raw.tunnels)) {
      payload.tunnels = raw.tunnels as SyncBundlePayload['tunnels']
    }
    if (raw.settings && typeof raw.settings === 'object') {
      payload.settings = pickPortableSettings(raw.settings as Partial<AppSettings>)
    }
    if (raw.knownHosts && typeof raw.knownHosts === 'object') {
      payload.knownHosts = raw.knownHosts as Record<string, string>
    }
    return payload
  }

  private legacyMeta(payload: SyncBundlePayload, raw: Record<string, unknown>): SyncBundleMeta {
    const exportedAt = typeof raw.exportedAt === 'string' ? raw.exportedAt : new Date().toISOString()
    return {
      appVersion: typeof raw.version === 'number' ? `0.5.x（旧版格式 v${raw.version}）` : '旧版格式',
      deviceName: '旧版导出文件',
      platform: 'unknown',
      createdAt: exportedAt,
      scopes: ['hosts', 'snippets'],
      counts: {
        hosts: payload.hosts?.length ?? 0,
        snippets: payload.snippets?.length ?? 0,
        tunnels: payload.tunnels?.length ?? 0,
        knownHosts: payload.knownHosts ? Object.keys(payload.knownHosts).length : 0,
        credentials: 0
      },
      hasCredentials: false
    }
  }
}

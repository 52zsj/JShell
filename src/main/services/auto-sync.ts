import { dialog, type BrowserWindow } from 'electron'
import path from 'node:path'
import {
  CUSTOM_PATH_PREFIX,
  SYNC_AUTO_FILE,
  SYNC_SCOPES,
  type AutoSyncPatch,
  type AutoSyncRunResult,
  type AutoSyncState,
  type AutoSyncTestResult,
  type AutoSyncTrigger,
  type DiffReport,
  type SyncBundlePayload,
  type SyncScope
} from '../../shared/sync'
import { composeLocalBundle } from './sync-bundle'
import {
  contentHash,
  decryptBundle,
  encryptBundle,
  parseSyncText,
  plainBundle,
  serializeBundle,
  SyncError
} from './sync-crypto'
import { diffBundle } from './sync-diff'
import { passwordChanged, passwordTag } from './sync-password'
import { changedCount, decidePull, shouldPush, summarizeReport } from './sync-auto-plan'
import { mergeBundle } from './sync-merge'
import { createSftpTransport, normalizeRemoteDir } from './sftp-transport'
import { createWebdavTransport, normalizeWebdavUrl } from './webdav-transport'
import { createFolderTransport, type SyncTransport } from './sync-transport'
import { detectSyncTargets, ensureSyncFolder } from './sync-targets'
import type { StoredAutoSync, StoreService } from './store'

/** 本机改动后延迟推送：合并短时间内的连续编辑，避免每改一个字就写一次云盘 */
const PUSH_DEBOUNCE_MS = 1500
/** 远端文件变化后延迟拉取：云盘客户端同步文件时常常连续触发多次事件 */
const PULL_DEBOUNCE_MS = 800

type StatusListener = (state: AutoSyncState) => void

/**
 * 文件夹自动同步。
 *
 * 语义按用户选择固定为「远端覆盖本机」，但保留检测：
 * - 拉取前先 diff，只有真的会产生变更才动手；
 * - 有风险项（本机较新会被覆盖 / 本机独有会被删除）时默认暂停，等人工确认；
 * - 关闭 `pauseOnRisky` 才不等，直接覆盖，但结果里仍写明覆盖了多少项。
 *
 * 防回声靠内容指纹：自己写出去的文件再次被 watcher 看到时，
 * 指纹与「上次推送」一致就直接跳过，不会来回写。
 */
export class AutoSyncService {
  private transport: SyncTransport | null = null
  private unwatch: (() => void) | null = null
  private offStore: (() => void) | null = null
  private pushTimer?: NodeJS.Timeout
  private pullTimer?: NodeJS.Timeout
  private startupTimer?: NodeJS.Timeout
  private running = false
  /** 应用远端变更期间不要把自己的写盘当成「用户改动」再推回去 */
  private suppressLocal = false
  private pending?: AutoSyncState['pending']
  private readonly listeners = new Set<StatusListener>()

  constructor(private readonly store: StoreService) {}

  // ------------------------------------------------------------------ 生命周期

  /** 应用启动后调用：按已保存的配置恢复监听 */
  start(): void {
    this.begin()
  }

  stop(): void {
    this.teardown()
    this.emit()
  }

  private clearTimers(): void {
    if (this.pushTimer) clearTimeout(this.pushTimer)
    if (this.pullTimer) clearTimeout(this.pullTimer)
    if (this.startupTimer) clearTimeout(this.startupTimer)
    this.pushTimer = undefined
    this.pullTimer = undefined
    this.startupTimer = undefined
  }

  /** 拆掉监听、定时器与传输连接（SFTP 会真的断开） */
  private teardown(): void {
    this.clearTimers()
    this.unwatch?.()
    this.unwatch = null
    this.offStore?.()
    this.offStore = null
    void this.transport?.dispose()
    this.transport = null
  }

  /** 按当前配置装配传输层；配置不完整返回 null */
  private buildTransport(): SyncTransport | null {
    const config = this.store.getAutoSync()
    if (config.transport === 'webdav') {
      if (!config.webdavUrl) return null
      return createWebdavTransport({
        url: config.webdavUrl,
        username: config.webdavUsername,
        password: this.store.webdavPassword()
      })
    }
    if (config.transport === 'sftp') {
      const host = config.sftpHostId ? this.store.getHost(config.sftpHostId) : null
      if (!host || !config.sftpDir) return null
      return createSftpTransport({ host, dir: config.sftpDir, store: this.store })
    }
    if (!config.dir) return null
    return createFolderTransport(config.dir)
  }

  private begin(): void {
    const config = this.store.getAutoSync()
    if (!config.enabled) return
    const transport = this.buildTransport()
    if (!transport) return

    this.transport = transport
    this.unwatch = transport.watch(() => this.schedulePull())
    this.offStore = this.store.onDidChange(() => this.schedulePush())

    // 启动时先拉一次：另一台设备可能刚改过，先把远端状态对齐再决定推送
    this.startupTimer = setTimeout(() => {
      this.startupTimer = undefined
      void this.run('startup')
    }, 600)
  }

  private restart(): void {
    this.teardown()
    this.begin()
  }

  // ------------------------------------------------------------------ 配置

  state(): AutoSyncState {
    const config = this.store.getAutoSync()
    return {
      enabled: config.enabled,
      transport: config.transport,
      targetId: config.targetId,
      targetLabel: config.targetLabel,
      dir: config.dir,
      sftpHostId: config.sftpHostId,
      sftpHostLabel: config.sftpHostLabel,
      sftpDir: config.sftpDir,
      webdavUrl: config.webdavUrl,
      webdavUsername: config.webdavUsername,
      hasWebdavPassword: Boolean(config.webdavPassword),
      paths: (config.paths ?? []).map((item) => ({ ...item })),
      scopes: [...config.scopes],
      pushLocalChanges: config.pushLocalChanges,
      pullRemoteChanges: config.pullRemoteChanges,
      pauseOnRisky: config.pauseOnRisky,
      hasPassword: Boolean(config.password),
      running: this.running,
      lastSyncedAt: config.lastSyncedAt,
      lastResult: config.lastResult,
      lastError: config.lastError,
      pending: this.pending
    }
  }

  onStatus(listener: StatusListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private emit(): void {
    if (this.listeners.size === 0) return
    const state = this.state()
    for (const listener of this.listeners) {
      try {
        listener(state)
      } catch {
        /* 界面异常不影响同步 */
      }
    }
  }

  /** 更新配置：本地目录只接受 targetId，SFTP 只接受主机 id + 目录，真实路径都在主进程解析 */
  configure(patch: AutoSyncPatch): AutoSyncState {
    const current = this.store.getAutoSync()
    const transport = patch.transport ?? current.transport
    let { dir, targetId, targetLabel } = current
    let { sftpHostId, sftpHostLabel, sftpDir } = current

    if (patch.targetId !== undefined) {
      if (!patch.targetId) {
        dir = ''
        targetId = ''
        targetLabel = undefined
      } else if (patch.targetId.startsWith(CUSTOM_PATH_PREFIX)) {
        // 用户手动添加的路径
        const customId = patch.targetId.slice(CUSTOM_PATH_PREFIX.length)
        const hit = (current.paths ?? []).find((item) => item.id === customId)
        if (!hit) throw new SyncError('该同步路径已被删除，请重新选择')
        targetId = patch.targetId
        targetLabel = hit.label
        dir = ensureSyncFolder(hit.dir)
      } else {
        const hit = detectSyncTargets().find((item) => item.id === patch.targetId)
        if (!hit) throw new SyncError('该同步目录已不存在，请重新选择')
        targetId = hit.id
        targetLabel = hit.label
        dir = ensureSyncFolder(hit.dir)
      }
    }

    if (patch.sftpHostId !== undefined) {
      if (!patch.sftpHostId) {
        sftpHostId = ''
        sftpHostLabel = undefined
      } else {
        const host = this.store.getHost(patch.sftpHostId)
        if (!host) throw new SyncError('所选主机不存在，请重新选择')
        sftpHostId = host.id
        sftpHostLabel = host.name
      }
    }

    if (patch.sftpDir !== undefined) {
      // 立刻校验格式，避免把明显写错的路径留到后台去报错
      sftpDir = patch.sftpDir ? normalizeRemoteDir(patch.sftpDir) : ''
    }

    let { webdavUrl, webdavUsername } = current
    if (patch.webdavUrl !== undefined) {
      webdavUrl = patch.webdavUrl ? normalizeWebdavUrl(patch.webdavUrl) : ''
    }
    if (patch.webdavUsername !== undefined) {
      webdavUsername = patch.webdavUsername.trim() || undefined
    }
    if (patch.webdavPassword !== undefined) {
      this.store.setWebdavPassword(patch.webdavPassword || null)
    }

    if (patch.password !== undefined) this.store.setSyncPassword(patch.password || null)

    const scopes = patch.scopes ? sanitizeScopes(patch.scopes) : current.scopes
    const hasPassword = Boolean(this.store.getAutoSync().password)
    if (!hasPassword && scopes.includes('credentials')) {
      throw new SyncError('勾选「密码与私钥口令」时必须设置同步口令')
    }

    this.store.saveAutoSync({
      enabled: patch.enabled ?? current.enabled,
      transport,
      pushLocalChanges: patch.pushLocalChanges ?? current.pushLocalChanges,
      pullRemoteChanges: patch.pullRemoteChanges ?? current.pullRemoteChanges,
      pauseOnRisky: patch.pauseOnRisky ?? current.pauseOnRisky,
      scopes,
      dir,
      targetId,
      targetLabel,
      sftpHostId,
      sftpHostLabel,
      sftpDir,
      webdavUrl,
      webdavUsername
    })

    this.pending = undefined
    this.restart()
    this.emit()
    return this.state()
  }

  /** 测试当前配置：连一次、建目录、写探针，把失败原因原文带回来 */
  async test(): Promise<AutoSyncTestResult> {
    const config = this.store.getAutoSync()
    if (config.transport === 'sftp' && (!config.sftpHostId || !config.sftpDir)) {
      return { ok: false, message: '请先选择主机并填写远端目录' }
    }
    if (config.transport === 'folder' && !config.dir) {
      return { ok: false, message: '请先选择同步目录' }
    }
    if (config.transport === 'webdav' && !config.webdavUrl) {
      return { ok: false, message: '请先填写 WebDAV 目录地址' }
    }
    const transport = this.buildTransport()
    if (!transport) return { ok: false, message: '同步位置尚未配置完整' }
    try {
      const message = await transport.test()
      return { ok: true, message }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    } finally {
      void transport.dispose()
    }
  }

  // ------------------------------------------------------------------ 执行

  /**
   * 「选择文件夹…」：目录由主进程的系统对话框选出，渲染层不传任何路径。
   * 覆盖「云盘不在探测列表里」的情况——例如网络共享、加密盘、自建同步目录。
   */
  /**
   * 添加一个自定义同步路径。
   *
   * 自动探测只认各网盘客户端的约定位置，自建网盘、NAS/SMB、U 盘、
   * 装在非默认路径的网盘都探测不到，所以留这个手动入口。
   */
  async addCustomPath(win: BrowserWindow | null): Promise<AutoSyncState> {
    const options = {
      title: '选择同步路径',
      properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'>
    }
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) return this.state()

    const chosen = result.filePaths[0]
    const current = this.store.getAutoSync()
    const paths = [...(current.paths ?? [])]
    // 同一个目录不重复添加
    if (!paths.some((item) => item.dir === chosen)) {
      paths.push({
        id: `p${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`,
        label: path.basename(chosen) || chosen,
        dir: chosen
      })
    }
    this.store.saveAutoSync({ paths })
    this.emit()
    return this.state()
  }

  /** 给自定义路径改名 */
  renameCustomPath(id: string, label: string): AutoSyncState {
    const current = this.store.getAutoSync()
    const paths = [...(current.paths ?? [])]
    const hit = paths.find((item) => item.id === id)
    if (!hit) throw new SyncError('该同步路径已被删除')
    const next = label.trim()
    if (!next) throw new SyncError('名称不能为空')
    hit.label = next
    this.store.saveAutoSync({ paths })
    // 当前正在用它的话，标签也要跟着更新
    if (current.targetId === `${CUSTOM_PATH_PREFIX}${id}`) {
      this.store.saveAutoSync({ targetLabel: next })
    }
    this.emit()
    return this.state()
  }

  /** 删掉一个自定义路径；若正在用它，同步位置一并清空 */
  removeCustomPath(id: string): AutoSyncState {
    const current = this.store.getAutoSync()
    const paths = (current.paths ?? []).filter((item) => item.id !== id)
    const patch: Partial<StoredAutoSync> = { paths }
    if (current.targetId === `${CUSTOM_PATH_PREFIX}${id}`) {
      patch.dir = ''
      patch.targetId = ''
      patch.targetLabel = undefined
    }
    this.store.saveAutoSync(patch)
    this.emit()
    return this.state()
  }

  async pickDirectory(win: BrowserWindow | null): Promise<AutoSyncState> {
    const options = {
      title: '选择自动同步目录',
      properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'>
    }
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) return this.state()

    const chosen = result.filePaths[0]
    const dir = ensureSyncFolder(chosen)
    this.store.saveAutoSync({
      transport: 'folder',
      dir,
      targetId: 'custom',
      targetLabel: path.basename(chosen) || chosen
    })
    this.pending = undefined
    this.restart()
    this.emit()
    return this.state()
  }

  private schedulePull(): void {
    if (this.pullTimer) clearTimeout(this.pullTimer)
    this.pullTimer = setTimeout(() => {
      this.pullTimer = undefined
      void this.run('remote')
    }, PULL_DEBOUNCE_MS)
  }

  private schedulePush(): void {
    if (this.suppressLocal) return
    const config = this.store.getAutoSync()
    if (!config.enabled || !config.pushLocalChanges) return
    if (this.pushTimer) clearTimeout(this.pushTimer)
    this.pushTimer = setTimeout(() => {
      this.pushTimer = undefined
      void this.run('local')
    }, PUSH_DEBOUNCE_MS)
  }

  async run(trigger: AutoSyncTrigger): Promise<AutoSyncRunResult> {
    if (this.running) {
      return { ok: true, action: 'idle', message: '正在同步，本次已跳过', at: Date.now() }
    }
    this.running = true
    this.emit()
    try {
      return await this.execute(trigger)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.store.saveAutoSync({ lastError: message, lastResult: message })
      return { ok: false, action: 'error', message, at: Date.now() }
    } finally {
      this.running = false
      this.emit()
    }
  }

  private async execute(trigger: AutoSyncTrigger): Promise<AutoSyncRunResult> {
    const config = this.store.getAutoSync()
    if (!config.enabled && trigger !== 'manual') {
      return { ok: true, action: 'idle', message: '自动同步未启用', at: Date.now() }
    }

    const transport = this.transport ?? this.buildTransport()
    if (!transport) {
      const message =
        config.transport === 'sftp'
          ? 'SFTP 同步还没配置完整（主机与远端目录）'
          : config.transport === 'webdav'
            ? 'WebDAV 同步还没配置完整（目录地址）'
            : '还没有选择同步目录'
      return { ok: false, action: 'error', message, at: Date.now() }
    }
    this.transport = transport
    const password = this.store.syncPassword()

    // 只有手动触发才忽略方向开关；自动触发一律按用户配置来
    const wantsPull =
      trigger === 'manual' || (trigger !== 'local' && config.pullRemoteChanges)
    const wantsPush =
      trigger === 'manual' || (trigger !== 'remote' && config.pushLocalChanges)

    if (!wantsPull && !wantsPush) {
      return { ok: true, action: 'idle', message: '该方向已关闭', at: Date.now() }
    }

    let pulled = false
    let pushed = false
    let recreated = false
    /** 远端口令与本机不一致：需要用本机口令重写远端 */
    let passwordMismatch = false
    let report: DiffReport | undefined
    let pulledCount = 0

    // 远端文件在不在，只查一次：拉取和写回都要用
    const remoteExists = await transport.exists()

    if (wantsPull && remoteExists) {
      const text = await transport.read()
      if (text) {
        let payload: SyncBundlePayload | null = null
        try {
          payload = this.decode(text, password)
        } catch (err) {
          // 口令对不上不是致命错误：多半是本机刚换了口令，
          // 或者另一台机器用了不同的口令。继续往下走，用本机口令把远端重写一遍，
          // 否则用户改完口令就再也推不上去（拉取先抛错 → 推送执行不到）。
          if (err instanceof SyncError && err.code === 'password-mismatch') {
            passwordMismatch = true
          } else {
            throw err
          }
        }
        if (payload) {
        const hash = contentHash(payload)
        const diff = diffBundle(this.store.snapshot(), payload, 'overwrite')
        const decision = decidePull({
          remoteHash: hash,
          lastPulledHash: config.lastPulledHash,
          report: diff,
          pauseOnRisky: config.pauseOnRisky
        })
        report = diff

        if (decision === 'skip') {
          // 自己刚写出去的：什么都没发生
        } else if (decision === 'record') {
          this.store.saveAutoSync({ lastPulledHash: hash })
        } else if (decision === 'pause') {
          this.pending = { at: Date.now(), summary: summarizeReport(diff), report: diff }
          // 状态栏要和暂停状态一致，不能停在上一轮的「已是最新」
          this.store.saveAutoSync({ lastResult: this.pending.summary, lastError: undefined })
          this.emit()
          return {
            ok: true,
            action: 'paused',
            message: this.pending.summary,
            at: Date.now(),
            report
          }
        } else {
          this.applyRemote(payload, hash)
          pulled = true
          pulledCount = changedCount(diff)
        }
        }
      }
    }

    if (wantsPush) {
      const { payload, meta } = composeLocalBundle(this.store, config.scopes)
      if (!password) delete payload.credentials
      const hash = contentHash(payload)
      const current = this.store.getAutoSync()
      // 口令变了也必须重写：内容没变时哈希相同，只看哈希会判定「没变化」，
      // 于是远端还挂着旧口令的密文，本机却已经换口令了 —— 之后必然解不开
      const needPush =
        shouldPush(hash, current.lastPushedHash, remoteExists) ||
        passwordChanged(password, current.lastPushedPasswordTag) ||
        passwordMismatch
      if (needPush) {
        const envelope = password
          ? encryptBundle(payload, meta, password)
          : plainBundle(payload, meta)
        await transport.write(serializeBundle(envelope))
        this.store.saveAutoSync({
          lastPushedHash: hash,
          lastPushedPasswordTag: passwordTag(password)
        })
        pushed = true
        recreated = !remoteExists
      }
    }

    const at = Date.now()
    const action = pulled && pushed ? 'both' : pulled ? 'pulled' : pushed ? 'pushed' : 'idle'
    const message = passwordMismatch
      ? '远端的同步口令与本机不一致，已用本机口令重写同步位置（远端原内容被覆盖）'
      : recreated
        ? '同步位置的文件已不存在，已按本机配置重新创建'
        : !remoteExists && !wantsPush
          ? '同步位置的文件不存在；已关闭「本机改动后写回」，无法自动重建'
          : this.describe(action, pulledCount)
    if (action !== 'idle' || trigger === 'manual') {
      // 后台空转不覆盖上一轮有意义的结果，否则状态栏永远显示「已是最新」
      this.store.saveAutoSync({ lastSyncedAt: at, lastResult: message, lastError: undefined })
      this.pending = undefined
    }
    this.emit()
    return { ok: true, action, message, at, report }
  }

  private decode(text: string, password: string | undefined): SyncBundlePayload {
    const parsed = parseSyncText(text)
    if (parsed.legacy) {
      throw new SyncError(`自动同步目录里的 ${SYNC_AUTO_FILE} 不是有效的同步包`)
    }
    const envelope = parsed.envelope
    if (!envelope.encrypted) return envelope.payload ?? {}
    if (!password) throw new SyncError('同步包已加密，但本机没有保存口令')
    try {
      return decryptBundle(envelope, password)
    } catch (err) {
      throw new SyncError(
        '同步口令不对：另一台机器用的口令可能和你这台不同。',
        'password-mismatch'
      )
    }
  }

  private applyRemote(payload: SyncBundlePayload, hash: string): void {
    this.store.backupNow('auto')
    this.suppressLocal = true
    try {
      const outcome = mergeBundle(this.store.snapshot(), payload, { mode: 'overwrite' })
      this.store.applySnapshot(outcome.next)
      this.store.applyCredentials(outcome.credentials)
    } finally {
      this.suppressLocal = false
    }
    // 应用后本地内容已与远端一致，把自己写盘产生的变更视为已推送，避免立刻回声
    this.store.saveAutoSync({ lastPulledHash: hash })
  }

  private describe(action: 'pushed' | 'pulled' | 'both' | 'idle', pulledCount: number): string {
    if (action === 'idle') return '已比对：同步位置与本机内容一致，没有变化'
    if (action === 'pulled') return `已应用远端 ${pulledCount} 项变更`
    if (action === 'pushed') return '已把本机配置写入同步位置'
    return `已应用远端 ${pulledCount} 项变更，并回写本机配置`
  }

  /** 供界面「去处理」使用：把被暂停的远端变更应用到本机 */
  async applyPending(): Promise<AutoSyncRunResult> {
    const pending = this.pending
    if (!pending) {
      return { ok: false, action: 'error', message: '没有待处理的变更', at: Date.now() }
    }
    const transport = this.transport ?? this.buildTransport()
    if (!transport) {
      return { ok: false, action: 'error', message: '同步位置尚未配置完整', at: Date.now() }
    }
    const text = (await transport.exists()) ? await transport.read() : null
    if (!text) {
      this.pending = undefined
      return { ok: false, action: 'error', message: '同步文件已被移除', at: Date.now() }
    }
    const payload = this.decode(text, this.store.syncPassword())
    this.applyRemote(payload, contentHash(payload))
    const message = `已按远端覆盖本机（${pending.summary}）`
    this.store.saveAutoSync({ lastSyncedAt: Date.now(), lastResult: message, lastError: undefined })
    this.pending = undefined
    this.emit()
    return { ok: true, action: 'pulled', message, at: Date.now(), report: pending.report }
  }

}

function sanitizeScopes(input: SyncScope[]): SyncScope[] {
  const allowed = new Set(SYNC_SCOPES.map((item) => item.id))
  const seen = new Set<SyncScope>()
  for (const scope of Array.isArray(input) ? input : []) {
    if (allowed.has(scope)) seen.add(scope)
  }
  return [...seen]
}

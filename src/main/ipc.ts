import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type {
  AppInfo,
  AppSettings,
  HostDraft,
  PersistedTab,
  ReleaseInfo,
  RsyncPlan,
  SessionEvent,
  TransferTask,
  TunnelConfig,
  UpdateCheckResult
} from '../shared/types'
import { mapErrorToChinese } from '../shared/errors'
import { IPC, type IpcChannel } from '../shared/ipc'
import type { AutoSyncPatch, SyncExportOptions, SyncImportMode, SyncImportRequest, SyncSource } from '../shared/sync'
import { appVersion, getPortableState } from './services/app-env'
import { readClipboard, setTerminalFocused, writeClipboard } from './services/clipboard'
import { detectShells } from './services/shells'
import { getLaunchAtLogin, setLaunchAtLogin } from './services/login-item'
import { log, openLogDir } from './services/logger'
import { testHostConnection } from './services/connection-test'
import { RsyncService } from './services/rsync'
import { LocalFsService } from './services/local-fs'
import { notifySystem, setNotificationsEnabled } from './services/notifications'
import { assertSafeName, SftpService } from './services/sftp'
import { SessionManager } from './services/session-manager'
import { StoreService } from './services/store'
import { SyncService } from './services/sync-service'
import { AutoSyncService } from './services/auto-sync'
import { TunnelManager } from './services/tunnels'
import { checkForUpdates, loadReleaseInfo } from './services/update'

export interface AppContext {
  store: StoreService
  sessions: SessionManager
  sftp: SftpService
  localFs: LocalFsService
  tunnels: TunnelManager
  rsync: RsyncService
  sync: SyncService
  autoSync: AutoSyncService
}

/** 统一错误出口：把主进程异常转成渲染进程可读的 message */
function normalizeError(err: unknown): string {
  log.error('IPC 操作失败', err)
  return mapErrorToChinese(err)
}

function assertRemotePath(target: string): string {
  if (!target || !target.startsWith('/')) throw new Error('远端路径必须是绝对路径')
  if (target === '/' || target.split('/').includes('..')) throw new Error('不允许操作该远端路径')
  return target
}

async function confirmOverwrite(win: BrowserWindow, name: string): Promise<boolean> {
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    title: '目标已存在',
    message: `「${name}」已存在，是否覆盖？`,
    detail: '覆盖后原文件内容将无法恢复。',
    buttons: ['取消', '覆盖'],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  })
  return response === 1
}

/**
 * 限制「用系统程序打开」的范围：
 * 只允许应用数据目录与安装资源目录，防止渲染层被注入后借 IPC 打开任意本地路径。
 */
function assertOpenablePath(target: string): string {
  if (!target) throw new Error('路径不能为空')
  const resolved = path.resolve(target)
  const roots = [app.getPath('userData'), process.resourcesPath, app.getAppPath()].map(
    (root) => path.resolve(root) + path.sep
  )
  if (!roots.some((root) => resolved.startsWith(root))) {
    throw new Error('只能打开应用数据目录或安装目录内的文件')
  }
  return resolved
}

export function createContext(getWindow: () => BrowserWindow | null): AppContext {
  const store = new StoreService()
  setNotificationsEnabled(store.getSettings().notifications)

  // 会话事件唯一出口：所有 SSH 数据/状态都经由这里推给渲染进程
  const emit = (event: SessionEvent): void => {
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send(IPC.evtSession, event)

    // 只在窗口没有焦点时提醒，避免用户正看着终端还被弹通知
    if (event.type === 'status' && event.status === 'error') {
      notifySystem('会话连接异常', event.message || 'SSH 会话已断开，请检查网络或主机状态。')
    } else if (event.type === 'transfer' && event.task.status === 'error') {
      notifySystem('文件传输失败', `${event.task.name}：${event.task.message ?? '未知错误'}`)
    }
  }

  let tunnels: TunnelManager | null = null
  const sessions = new SessionManager(store, (event) => {
    // 输出背压：先记账再推送，渲染端跟不上时这里会暂停会话的数据源
    if (event.type === 'data') sessions.noteOutput(event.sessionId, event.data.length)
    emit(event)
    // 会话断开/出错时停掉挂在其上的本地转发，避免遗留监听端口
    if (event.type === 'status' && (event.status === 'closed' || event.status === 'error')) {
      tunnels?.stopBySession(event.sessionId)
    }
  })
  const sftp = new SftpService(sessions)
  const localFs = new LocalFsService()
  tunnels = new TunnelManager(sessions, store, (event) => emit(event))

  // rsync 任务事件单独走一条通道，避免把进度塞进会话事件
  const rsync = new RsyncService(store, (task) => {
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send(IPC.evtRsync, task)
  })

  const autoSync = new AutoSyncService(store)
  let notifiedPendingAt = 0
  autoSync.onStatus((state) => {
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send(IPC.evtSyncAuto, state)
    // 被暂停的远端变更只提醒一次，避免每次状态刷新都弹通知
    if (state.pending && state.pending.at !== notifiedPendingAt) {
      notifiedPendingAt = state.pending.at
      notifySystem('有远端配置待确认', state.pending.summary)
    }
  })
  autoSync.start()

  return {
    store,
    sessions,
    sftp,
    localFs,
    tunnels,
    rsync,
    sync: new SyncService(store),
    autoSync
  }
}

interface LocalEntry {
  dir: string
  file?: string
}

function walkLocal(root: string, limit = 5000): LocalEntry[] {
  const result: LocalEntry[] = []
  const visit = (dir: string): void => {
    if (result.length > limit) return
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      if (result.length > limit) return
      const full = path.join(dir, item.name)
      if (item.isDirectory()) {
        result.push({ dir: full })
        visit(full)
      } else if (item.isFile()) {
        result.push({ dir, file: item.name })
      }
    }
  }
  visit(root)
  return result
}

/**
 * 注册所有 IPC 处理器。
 * 约定：所有 ipcMain.handle 都经过 handle() 包装，保证异常统一转为 reject，
 * 渲染进程侧可以 try/catch 拿到中文错误提示。
 */
export function registerIpc(ctx: AppContext, getWindow: () => BrowserWindow | null): void {
  const { store, sessions, sftp, tunnels, sync, autoSync } = ctx

  /**
   * 通道名必须是 `IPC` 里声明过的字面量：写错会在编译期报错，而不是运行时静默失联。
   * 参数与返回值的类型仍由各 handler 自己负责（见 shared/api.ts 的 JShellApi）。
   */
  const handle = <Args extends unknown[]>(
    channel: IpcChannel,
    fn: (...args: Args) => unknown
  ): void => {
    ipcMain.handle(channel, async (_event, ...args: unknown[]) => {
      try {
        return await fn(...(args as Args))
      } catch (err) {
        throw new Error(normalizeError(err))
      }
    })
  }

  const transferCancels = new Map<string, () => void>()

  /** 构造并推送一条传输任务进度 */
  const transfer =
    (sessionId: string, direction: 'upload' | 'download', name: string, total: number) => {
      const id = randomUUID()
      const controller = new AbortController()
      transferCancels.set(id, () => controller.abort())
      let lastEmit = 0
      // 记录最后一次进度：完成/失败时不能把数字清零，否则状态栏会闪一下 0 B
      let lastTransferred = 0
      let lastTotal = total
      /**
       * @param transferred 已传输字节
       * @param status      任务状态
       * @param message     失败原因
       * @param totalKnown  本次回调带来的总字节（下载前 stat 可能拿不到，由进度回调补全）
       */
      const push = (
        transferred: number,
        status: TransferTask['status'],
        message?: string,
        totalKnown?: number
      ) => {
        const now = Date.now()
        // 进度节流：约 8 帧/秒，避免高频 IPC 拖慢终端
        if (status === 'running' && now - lastEmit < 120) return
        lastEmit = now
        if (status === 'running') {
          lastTransferred = transferred
          if (totalKnown && totalKnown > 0) lastTotal = totalKnown
        }
        const task: TransferTask = {
          id,
          sessionId,
          direction,
          name,
          // 完成/失败时沿用最后一次进度，避免状态栏闪一下 0 B
          transferred: status === 'running' ? transferred : lastTransferred,
          total: lastTotal,
          status,
          message
        }
        const win = getWindow()
        if (win && !win.isDestroyed()) win.webContents.send(IPC.evtSession, { type: 'transfer', task })
      }
      push(0, 'running')
      return {
        push,
        signal: controller.signal,
        cleanup: () => transferCancels.delete(id)
      }
    }

  // 终端焦点（不是 invoke，纯通知，避免多一次往返）
  ipcMain.on(IPC.terminalFocus, (_event, focused: boolean) => setTerminalFocused(Boolean(focused)))
  handle(IPC.clipboardWrite, (text: string) => writeClipboard(text))
  handle(IPC.clipboardRead, () => readClipboard())

  // ------------------------------------------------------------------ 主机
  handle(IPC.hostList, () => store.listHosts())
  handle(IPC.hostSave, (draft: HostDraft) => store.upsertHost(draft))
  handle(IPC.hostRemove, (id: string) => store.deleteHost(id))
  handle(IPC.hostTest, (draft: HostDraft) => {
    if (!draft || typeof draft !== 'object') throw new Error('主机参数无效')
    return testHostConnection(draft, store)
  })
  handle(
    IPC.hostTrustKey,
    (host: string, port: number, algorithm: string, fingerprint: string) => {
      // IPC 是信任边界：这里只接受「看起来合法」的指纹，避免被写入任意字符串
      if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('参数无效')
      if (!/^[a-z0-9@._-]{2,40}$/i.test(algorithm)) throw new Error('密钥算法无效')
      if (!/^SHA256:[A-Za-z0-9+/]{20,64}$/.test(fingerprint)) throw new Error('指纹格式无效')
      store.trustKnownHost(host, port, algorithm, fingerprint)
    }
  )

  // ---------------------------------------------------------------- 布局
  handle(IPC.layoutGet, () => store.loadLayout())
  handle(IPC.layoutSave, (tabs: PersistedTab[]) => {
    if (!Array.isArray(tabs)) throw new Error('布局数据无效')
    store.saveLayout(tabs)
  })

  // ------------------------------------------------------------------ 会话
  handle(IPC.sessionOpen, (hostId: string, size: { cols: number; rows: number }, sessionId: string) =>
    sessions.openSsh(hostId, size, sessionId)
  )
  handle(
    IPC.sessionOpenLocal,
    (size: { cols: number; rows: number }, sessionId: string, shellPath?: string) =>
      sessions.openLocal(size, sessionId, shellPath)
  )
  handle(IPC.sessionClose, (sessionId: string) => sessions.close(sessionId))
  // 输出回执：渲染端解析完一块才回一条，主进程据此做背压
  ipcMain.on(IPC.sessionAck, (_event, sessionId: string, chars: number) => {
    sessions.ack(sessionId, Number(chars) || 0)
  })

  // 键盘输入走单向通道：不需要回执，省掉每次按键的 IPC 往返。
  // 会话不在就直接丢弃——标签页刚关时输入还在路上是常态。
  ipcMain.on(IPC.sessionWrite, (_event, sessionId: string, data: string) => {
    sessions.get(sessionId)?.write(data)
  })
  handle(IPC.sessionResize, (sessionId: string, cols: number, rows: number) =>
    sessions.get(sessionId)?.resize(cols, rows)
  )

  // ------------------------------------------------------------------- SFTP
  handle(IPC.sftpHome, (sessionId: string) => sftp.home(sessionId))
  handle(IPC.sftpList, (sessionId: string, dirPath: string) => sftp.list(sessionId, dirPath))
  handle(IPC.sftpMkdir, (sessionId: string, dirPath: string) => {
    assertSafeName(path.posix.basename(dirPath))
    return sftp.mkdir(sessionId, dirPath)
  })
  handle(IPC.sftpReadText, (sessionId: string, target: string) => {
    assertRemotePath(target)
    return sftp.readText(sessionId, target)
  })
  handle(IPC.sftpWriteText, (sessionId: string, target: string, text: string) => {
    assertRemotePath(target)
    if (typeof text !== 'string') throw new Error('内容无效')
    return sftp.writeText(sessionId, target, text)
  })
  handle(IPC.sftpRemove, (sessionId: string, target: string, isDir: boolean) => {
    assertRemotePath(target)
    return sftp.remove(sessionId, target, isDir)
  })
  handle(IPC.sftpRename, async (sessionId: string, from: string, to: string) => {
    // 只校验目标名的最后一段：不允许通过重命名把文件写到别的目录
    assertSafeName(path.posix.basename(to))
    assertRemotePath(from)
    assertRemotePath(to)
    const win = getWindow()
    if (from !== to && win && (await sftp.exists(sessionId, to)) && !(await confirmOverwrite(win, path.posix.basename(to)))) {
      throw new Error('已取消覆盖')
    }
    return sftp.rename(sessionId, from, to)
  })

  handle(IPC.sftpDownload, async (sessionId: string, remotePath: string) => {
    const win = getWindow()
    if (!win) return { canceled: true }
    const result = await dialog.showSaveDialog(win, {
      title: '保存到本地',
      defaultPath: path.join(app.getPath('downloads'), path.posix.basename(remotePath)),
      buttonLabel: '下载'
    })
    if (result.canceled || !result.filePath) return { canceled: true }

    const task = transfer(sessionId, 'download', path.posix.basename(remotePath), 0)
    try {
      await sftp.download(
        sessionId,
        remotePath,
        result.filePath,
        (transferred, total) => task.push(transferred, 'running', undefined, total),
        task.signal
      )
      task.push(0, 'done')
      return { canceled: false, path: result.filePath }
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        task.push(0, 'canceled', '已取消')
        return { canceled: true }
      }
      task.push(0, 'error', normalizeError(err))
      throw err
    } finally {
      task.cleanup()
    }
  })

  handle(IPC.sftpUpload, async (sessionId: string, remoteDir: string) => {
    const win = getWindow()
    if (!win) return { canceled: true, count: 0 }
    const result = await dialog.showOpenDialog(win, {
      title: `上传到 ${remoteDir}`,
      properties: ['openFile', 'multiSelections']
    })
    if (result.canceled || result.filePaths.length === 0) return { canceled: true, count: 0 }

    let count = 0
    for (const localPath of result.filePaths) {
      const name = path.basename(localPath)
      const remotePath = path.posix.join(remoteDir, name)
      if ((await sftp.exists(sessionId, remotePath)) && !(await confirmOverwrite(win, name))) {
        continue
      }
      const task = transfer(sessionId, 'upload', name, 0)
      try {
        await sftp.upload(
          sessionId,
          localPath,
          remotePath,
          (transferred, total) => task.push(transferred, 'running', undefined, total),
          task.signal
        )
        task.push(0, 'done')
        count += 1
      } catch (err) {
        if ((err as Error).name === 'AbortError') {
          task.push(0, 'canceled', '已取消')
          continue
        }
        task.push(0, 'error', normalizeError(err))
        throw err
      } finally {
        task.cleanup()
      }
    }
    return { canceled: false, count }
  })

  // ------------------------------------------------------------ 本地文件
  handle(IPC.localFsHome, () => ctx.localFs.home())
  handle(IPC.localFsList, (dirPath: string) => ctx.localFs.list(dirPath))
  handle(IPC.localFsMkdir, (dirPath: string) => ctx.localFs.mkdir(dirPath))
  handle(IPC.localFsRename, (from: string, to: string) => ctx.localFs.rename(from, to))
  handle(IPC.localFsRemove, (target: string) => ctx.localFs.remove(target))
  handle(IPC.localFsReadText, (target: string) => ctx.localFs.readText(target))
  handle(IPC.localFsWriteText, (target: string, text: string) => {
    if (typeof text !== 'string') throw new Error('内容无效')
    return ctx.localFs.writeText(target, text)
  })
  ipcMain.on(IPC.localFsReveal, (_event, target: string) => {
    try {
      ctx.localFs.reveal(target)
    } catch (err) {
      log.warn('定位本地文件失败', err)
    }
  })

  handle(IPC.sftpDownloadTo, async (sessionId: string, remotePaths: string[], localDir: string) => {
    let count = 0
    const win = getWindow()
    for (const remotePath of remotePaths.slice(0, 500)) {
      assertRemotePath(remotePath)
      const target = path.join(localDir, path.posix.basename(remotePath))
      if (fs.existsSync(target) && win && !(await confirmOverwrite(win, path.basename(target)))) {
        continue
      }
      const task = transfer(sessionId, 'download', path.posix.basename(remotePath), 0)
      try {
        await sftp.download(
          sessionId,
          remotePath,
          target,
          (transferred, total) => task.push(transferred, 'running', undefined, total),
          task.signal
        )
        task.push(0, 'done')
        count += 1
      } catch (err) {
        if ((err as Error).name !== 'AbortError') task.push(0, 'error', normalizeError(err))
      } finally {
        task.cleanup()
      }
    }
    return { count }
  })

  handle(IPC.sftpUploadDir, async (sessionId: string, remoteDir: string) => {
    const win = getWindow()
    if (!win) return { canceled: true, count: 0 }
    const result = await dialog.showOpenDialog(win, {
      title: `上传目录到 ${remoteDir}`,
      properties: ['openDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return { canceled: true, count: 0 }

    const localRoot = result.filePaths[0]
    const remoteRoot = path.posix.join(remoteDir, path.basename(localRoot))
    const entries = walkLocal(localRoot)
    await sftp.mkdir(sessionId, remoteRoot)
    let count = 0

    for (const entry of entries) {
      const relative = path.relative(localRoot, entry.dir).split(path.sep).filter(Boolean)
      const remotePath = relative.length ? path.posix.join(remoteRoot, ...relative) : remoteRoot
      if (!entry.file) {
        await sftp.mkdir(sessionId, remotePath)
        continue
      }
      const remoteFile = path.posix.join(remotePath, entry.file)
      const task = transfer(sessionId, 'upload', entry.file, 0)
      try {
        await sftp.upload(
          sessionId,
          path.join(entry.dir, entry.file),
          remoteFile,
          (transferred, total) => task.push(transferred, 'running', undefined, total),
          task.signal
        )
        task.push(0, 'done')
        count += 1
      } catch (err) {
        if ((err as Error).name !== 'AbortError') task.push(0, 'error', normalizeError(err))
      } finally {
        task.cleanup()
      }
    }
    return { canceled: false, count }
  })

  handle(IPC.transferCancel, (taskId: string) => {
    transferCancels.get(taskId)?.()
  })

  // ------------------------------------------------------------- rsync 同步
  handle(IPC.rsyncCheck, () => ctx.rsync.check())
  handle(IPC.rsyncProbe, (hostId: string) => ctx.rsync.probe(hostId))
  handle(IPC.rsyncStart, (plan: RsyncPlan) => ctx.rsync.start(plan))
  handle(IPC.rsyncCancel, (taskId: string) => ctx.rsync.cancel(taskId))

  // ------------------------------------------------------ 数据共享（同步包）
  handle(IPC.syncTargets, () => sync.targets())
  handle(IPC.syncFiles, (targetId: string) => sync.listFolderFiles(targetId))
  handle(IPC.syncExport, (options: SyncExportOptions) => sync.export(options, getWindow()))
  handle(IPC.syncInspect, (source: SyncSource, password?: string) =>
    sync.inspect(source, password, getWindow())
  )
  handle(IPC.syncDiff, (token: string, mode: SyncImportMode) => sync.diff(token, mode))
  handle(IPC.syncImport, (request: SyncImportRequest) => sync.import(request))
  handle(IPC.syncDispose, () => sync.clearPending())

  // ------------------------------------------------------------ 自动同步
  handle(IPC.syncAutoGet, () => autoSync.state())
  handle(IPC.syncAutoSet, (patch: AutoSyncPatch) => autoSync.configure(patch))
  handle(IPC.syncAutoRun, () => autoSync.run('manual'))
  handle(IPC.syncAutoApply, () => autoSync.applyPending())
  handle(IPC.syncAutoPick, () => autoSync.pickDirectory(getWindow()))
  handle(IPC.syncAutoTest, () => autoSync.test())

  // -------------------------------------------------------------- 设置/片段
  handle(IPC.settingsGet, () => store.getSettings())
  handle(IPC.settingsUpdate, (patch: Partial<AppSettings>) => {
    // 开机自启先落到系统，再写配置：系统拒绝时不要把设置改成「已开启」
    if (
      typeof patch.launchAtLogin === 'boolean' &&
      patch.launchAtLogin !== store.getSettings().launchAtLogin
    ) {
      setLaunchAtLogin(patch.launchAtLogin)
    }
    const next = store.updateSettings(patch)
    if (typeof patch.notifications === 'boolean') setNotificationsEnabled(patch.notifications)
    return next
  })

  handle(IPC.snippetList, () => store.listSnippets())
  handle(IPC.snippetSave, (input: { id?: string; name: string; command: string }) =>
    store.saveSnippet(input)
  )
  handle(IPC.snippetRemove, (id: string) => store.deleteSnippet(id))

  // ---------------------------------------------------------------- 端口转发
  handle(IPC.tunnelList, () => store.listTunnels())
  handle(
    IPC.tunnelStart,
    (sessionId: string, cfg: Omit<TunnelConfig, 'id' | 'enabled'> & { id?: string }) =>
      tunnels.start(sessionId, cfg)
  )
  handle(IPC.tunnelStop, (tunnelId: string) => tunnels.stop(tunnelId))

  // ------------------------------------------------------------ 系统与对话框
  handle(IPC.appShells, () => detectShells())

  handle(IPC.appInfo, (): AppInfo => {
    const meta = loadReleaseInfo()
    const portable = getPortableState()
    return {
      version: appVersion(),
      electron: process.versions.electron,
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      userDataPath: app.getPath('userData'),
      safeStorageAvailable: safeStorage.isEncryptionAvailable(),
      packaged: app.isPackaged,
      portable: portable.portable,
      logDir: log.getDir(),
      channel: meta.channel,
      buildTime: meta.buildTime,
      launchAtLogin: getLaunchAtLogin()
    }
  })

  handle(IPC.appReleaseInfo, (): ReleaseInfo => loadReleaseInfo())
  handle(IPC.updateCheck, (): Promise<UpdateCheckResult> => checkForUpdates(true))
  handle(IPC.appOpenLogs, () => openLogDir())

  // 只允许打开随包分发的四份文档，避免渲染层传入任意路径
  const DOC_FILES: Record<string, string> = {
    manual: 'manual.md',
    privacy: 'privacy.md',
    license: 'license.md',
    changelog: 'CHANGELOG.md'
  }
  handle(IPC.appOpenDoc, async (name: string) => {
    const file = DOC_FILES[name]
    if (!file) throw new Error('未知的文档')
    const target = app.isPackaged
      ? path.join(process.resourcesPath, 'docs', file)
      : path.join(app.getAppPath(), 'docs', file)
    const message = await shell.openPath(target)
    if (message) throw new Error(`无法打开文档：${message}`)
  })

  handle(IPC.appOpenPath, async (target: string) => {
    const resolved = assertOpenablePath(target)
    const message = await shell.openPath(resolved)
    if (message) throw new Error(`无法打开：${message}`)
  })

  handle(IPC.appOpenExternal, async (url: string) => {
    // 只允许 https：避免 file:// 或自定义协议被更新元信息/文档链接利用
    if (!/^https:\/\/[^\s]+$/i.test(url)) throw new Error('仅支持打开 https 链接')
    await shell.openExternal(url)
  })

  handle(IPC.pickFile, async (options?: { title?: string; multi?: boolean }) => {
    const win = getWindow()
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      title: options?.title ?? '选择文件',
      properties: options?.multi ? ['openFile', 'multiSelections'] : ['openFile']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return options?.multi ? result.filePaths : result.filePaths[0]
  })

  handle(IPC.pickDirectory, async (options?: { title?: string }) => {
    const win = getWindow()
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      title: options?.title ?? '选择目录',
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  handle(
    IPC.confirm,
    async (options: { title: string; message: string; detail?: string; danger?: boolean }) => {
      const win = getWindow()
      if (!win) return false
      const { response } = await dialog.showMessageBox(win, {
        type: options.danger ? 'warning' : 'question',
        title: options.title,
        message: options.message,
        detail: options.detail,
        buttons: ['取消', '确认'],
        defaultId: 0,
        cancelId: 0,
        noLink: true
      })
      return response === 1
    }
  )
}

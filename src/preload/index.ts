import { contextBridge, ipcRenderer } from 'electron'
import type { JShellApi } from '../shared/api'
import { IPC } from '../shared/ipc'
import type { SessionEvent } from '../shared/types'

/**
 * 预加载脚本：渲染进程与主进程之间的唯一桥。
 *
 * 安全边界：
 *  - 渲染进程没有 Node 权限（nodeIntegration=false / sandbox=true）；
 *  - 仅暴露白名单方法，不透出 ipcRenderer 本体；
 *  - 明文密码只做「单向入参」，任何读取类接口都不会回传已保存的密码。
 */
const api: JShellApi = {
  hosts: {
    list: () => ipcRenderer.invoke(IPC.hostList),
    save: (draft) => ipcRenderer.invoke(IPC.hostSave, draft),
    remove: (id) => ipcRenderer.invoke(IPC.hostRemove, id),
    trustKey: (host, port, algorithm, fingerprint) =>
      ipcRenderer.invoke(IPC.hostTrustKey, host, port, algorithm, fingerprint),
    test: (draft) => ipcRenderer.invoke(IPC.hostTest, draft)
  },
  sessions: {
    open: (hostId, size, sessionId) => ipcRenderer.invoke(IPC.sessionOpen, hostId, size, sessionId),
    openLocal: (size, sessionId, shellPath) =>
      ipcRenderer.invoke(IPC.sessionOpenLocal, size, sessionId, shellPath),
    close: (sessionId) => ipcRenderer.invoke(IPC.sessionClose, sessionId),
    write: (sessionId, data) => ipcRenderer.send(IPC.sessionWrite, sessionId, data),
    resize: (sessionId, cols, rows) => ipcRenderer.invoke(IPC.sessionResize, sessionId, cols, rows),
    ack: (sessionId, chars) => ipcRenderer.send(IPC.sessionAck, sessionId, chars)
  },
  sftp: {
    home: (sessionId) => ipcRenderer.invoke(IPC.sftpHome, sessionId),
    list: (sessionId, path) => ipcRenderer.invoke(IPC.sftpList, sessionId, path),
    mkdir: (sessionId, path) => ipcRenderer.invoke(IPC.sftpMkdir, sessionId, path),
    remove: (sessionId, target, isDir) => ipcRenderer.invoke(IPC.sftpRemove, sessionId, target, isDir),
    rename: (sessionId, from, to) => ipcRenderer.invoke(IPC.sftpRename, sessionId, from, to),
    download: (sessionId, remotePath) => ipcRenderer.invoke(IPC.sftpDownload, sessionId, remotePath),
    upload: (sessionId, remoteDir) => ipcRenderer.invoke(IPC.sftpUpload, sessionId, remoteDir),
    uploadDir: (sessionId, remoteDir) => ipcRenderer.invoke(IPC.sftpUploadDir, sessionId, remoteDir),
    downloadTo: (sessionId, remotePaths, localDir) =>
      ipcRenderer.invoke(IPC.sftpDownloadTo, sessionId, remotePaths, localDir),
    cancel: (taskId) => ipcRenderer.invoke(IPC.transferCancel, taskId),
    readText: (sessionId, remotePath) => ipcRenderer.invoke(IPC.sftpReadText, sessionId, remotePath),
    writeText: (sessionId, remotePath, text) =>
      ipcRenderer.invoke(IPC.sftpWriteText, sessionId, remotePath, text)
  },
  rsync: {
    check: () => ipcRenderer.invoke(IPC.rsyncCheck),
    probe: (hostId) => ipcRenderer.invoke(IPC.rsyncProbe, hostId),
    start: (plan) => ipcRenderer.invoke(IPC.rsyncStart, plan),
    cancel: (taskId) => ipcRenderer.invoke(IPC.rsyncCancel, taskId),
    onEvent: (listener) => {
      ipcRenderer.removeAllListeners(IPC.evtRsync)
      ipcRenderer.on(IPC.evtRsync, (_event, payload) => listener(payload))
    },
    unsubscribe: () => ipcRenderer.removeAllListeners(IPC.evtRsync)
  },
  localFs: {
    home: () => ipcRenderer.invoke(IPC.localFsHome),
    list: (dirPath) => ipcRenderer.invoke(IPC.localFsList, dirPath),
    mkdir: (dirPath) => ipcRenderer.invoke(IPC.localFsMkdir, dirPath),
    rename: (from, to) => ipcRenderer.invoke(IPC.localFsRename, from, to),
    remove: (targetPath) => ipcRenderer.invoke(IPC.localFsRemove, targetPath),
    reveal: (targetPath) => ipcRenderer.send(IPC.localFsReveal, targetPath),
    readText: (targetPath) => ipcRenderer.invoke(IPC.localFsReadText, targetPath),
    writeText: (targetPath, text) => ipcRenderer.invoke(IPC.localFsWriteText, targetPath, text)
  },
  layout: {
    get: () => ipcRenderer.invoke(IPC.layoutGet),
    save: (tabs) => ipcRenderer.invoke(IPC.layoutSave, tabs)
  },
  sync: {
    targets: () => ipcRenderer.invoke(IPC.syncTargets),
    files: (targetId) => ipcRenderer.invoke(IPC.syncFiles, targetId),
    exportBundle: (options) => ipcRenderer.invoke(IPC.syncExport, options),
    inspect: (source, password) => ipcRenderer.invoke(IPC.syncInspect, source, password),
    diff: (token, mode) => ipcRenderer.invoke(IPC.syncDiff, token, mode),
    import: (request) => ipcRenderer.invoke(IPC.syncImport, request),
    dispose: () => ipcRenderer.invoke(IPC.syncDispose)
  },
  autoSync: {
    get: () => ipcRenderer.invoke(IPC.syncAutoGet),
    set: (patch) => ipcRenderer.invoke(IPC.syncAutoSet, patch),
    run: () => ipcRenderer.invoke(IPC.syncAutoRun),
    applyPending: () => ipcRenderer.invoke(IPC.syncAutoApply),
    pick: () => ipcRenderer.invoke(IPC.syncAutoPick),
    test: () => ipcRenderer.invoke(IPC.syncAutoTest),
    onStatus: (listener) => {
      ipcRenderer.removeAllListeners(IPC.evtSyncAuto)
      ipcRenderer.on(IPC.evtSyncAuto, (_event, state) => listener(state))
    },
    unsubscribe: () => ipcRenderer.removeAllListeners(IPC.evtSyncAuto)
  },
  settings: {
    get: () => ipcRenderer.invoke(IPC.settingsGet),
    update: (patch) => ipcRenderer.invoke(IPC.settingsUpdate, patch)
  },
  snippets: {
    list: () => ipcRenderer.invoke(IPC.snippetList),
    save: (input) => ipcRenderer.invoke(IPC.snippetSave, input),
    remove: (id) => ipcRenderer.invoke(IPC.snippetRemove, id)
  },
  tunnels: {
    list: () => ipcRenderer.invoke(IPC.tunnelList),
    start: (sessionId, cfg) => ipcRenderer.invoke(IPC.tunnelStart, sessionId, cfg),
    stop: (tunnelId) => ipcRenderer.invoke(IPC.tunnelStop, tunnelId)
  },
  terminal: {
    setFocused: (focused) => ipcRenderer.send(IPC.terminalFocus, focused)
  },
  clipboard: {
    onCommand: (listener) => {
      ipcRenderer.removeAllListeners(IPC.clipboardCommand)
      ipcRenderer.on(IPC.clipboardCommand, (_event, payload) => listener(payload))
    },
    unsubscribe: () => ipcRenderer.removeAllListeners(IPC.clipboardCommand),
    writeText: (text) => ipcRenderer.invoke(IPC.clipboardWrite, text),
    readText: () => ipcRenderer.invoke(IPC.clipboardRead)
  },
  app: {
    info: () => ipcRenderer.invoke(IPC.appInfo),
    shells: () => ipcRenderer.invoke(IPC.appShells),
    release: () => ipcRenderer.invoke(IPC.appReleaseInfo),
    openLogs: () => ipcRenderer.invoke(IPC.appOpenLogs),
    openPath: (target) => ipcRenderer.invoke(IPC.appOpenPath, target),
    openDoc: (name) => ipcRenderer.invoke(IPC.appOpenDoc, name),
    openExternal: (url) => ipcRenderer.invoke(IPC.appOpenExternal, url),
    onCommand: (listener) => {
      ipcRenderer.removeAllListeners(IPC.evtAppCommand)
      ipcRenderer.on(IPC.evtAppCommand, (_event, command) => listener(command))
    },
    unsubscribeCommand: () => ipcRenderer.removeAllListeners(IPC.evtAppCommand)
  },
  update: {
    check: () => ipcRenderer.invoke(IPC.updateCheck)
  },
  dialog: {
    pickFile: (options) => ipcRenderer.invoke(IPC.pickFile, options),
    pickDirectory: (options) => ipcRenderer.invoke(IPC.pickDirectory, options),
    confirm: (options) => ipcRenderer.invoke(IPC.confirm, options)
  },
  events: {
    subscribe: (listener) => {
      ipcRenderer.removeAllListeners(IPC.evtSession)
      ipcRenderer.on(IPC.evtSession, (_event, payload: SessionEvent) => listener(payload))
    },
    unsubscribe: () => ipcRenderer.removeAllListeners(IPC.evtSession)
  }
}

contextBridge.exposeInMainWorld('jshell', api)

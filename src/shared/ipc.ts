/**
 * IPC 通道常量。
 * 命名规则：<域>:<动作>（invoke/handle），事件推送统一走 EVT_SESSION。
 *
 * 主进程与预加载脚本共享此文件，避免字符串散落导致拼写错误。
 */
/**
 * 通道常量表。`as const` 让每个值成为字面量类型，
 * 于是 `IpcChannel` 能把「通道名打错」变成编译错误，而不是运行时静默失联。
 */
export const IPC = {
  // 主机配置
  hostList: 'host:list',
  hostSave: 'host:save',
  hostRemove: 'host:remove',
  hostTrustKey: 'host:trust-key',
  hostTest: 'host:test',

  // 会话
  sessionOpen: 'session:open',
  sessionOpenLocal: 'session:open-local',
  sessionClose: 'session:close',
  sessionWrite: 'session:write',
  sessionResize: 'session:resize',

  // SFTP
  sftpList: 'sftp:list',
  sftpHome: 'sftp:home',
  sftpMkdir: 'sftp:mkdir',
  sftpRemove: 'sftp:remove',
  sftpRename: 'sftp:rename',
  sftpDownload: 'sftp:download',
  sftpUpload: 'sftp:upload',
  sftpUploadDir: 'sftp:upload-dir',
  sftpDownloadTo: 'sftp:download-to',
  sftpReadText: 'sftp:read-text',
  sftpWriteText: 'sftp:write-text',
  transferCancel: 'transfer:cancel',

  // rsync 同步
  rsyncCheck: 'rsync:check',
  rsyncProbe: 'rsync:probe',
  rsyncStart: 'rsync:start',
  rsyncCancel: 'rsync:cancel',

  // 本地文件
  localFsHome: 'local:home',
  localFsList: 'local:list',
  localFsMkdir: 'local:mkdir',
  localFsRename: 'local:rename',
  localFsRemove: 'local:remove',
  localFsReveal: 'local:reveal',
  localFsReadText: 'local:read-text',
  localFsWriteText: 'local:write-text',

  // 配置 / 偏好
  layoutGet: 'layout:get',
  layoutSave: 'layout:save',

  // 数据共享（加密同步包）
  syncTargets: 'sync:targets',
  syncFiles: 'sync:files',
  syncExport: 'sync:export',
  syncInspect: 'sync:inspect',
  syncDiff: 'sync:diff',
  syncImport: 'sync:import',
  syncDispose: 'sync:dispose',

  // 自动同步（文件夹）
  syncAutoGet: 'sync:auto-get',
  syncAutoSet: 'sync:auto-set',
  syncAutoRun: 'sync:auto-run',
  syncAutoApply: 'sync:auto-apply',
  syncAutoPick: 'sync:auto-pick',
  syncAutoTest: 'sync:auto-test',

  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',

  // 命令片段
  snippetList: 'snippet:list',
  snippetSave: 'snippet:save',
  snippetRemove: 'snippet:remove',

  // 端口转发（预留，后端已可用）
  tunnelList: 'tunnel:list',
  tunnelStart: 'tunnel:start',
  tunnelStop: 'tunnel:stop',

  // 终端焦点与剪贴板（菜单快捷键按焦点路由到终端或系统编辑命令）
  terminalFocus: 'term:focus',
  clipboardCommand: 'clip:command',
  clipboardWrite: 'clip:write',
  clipboardRead: 'clip:read',

  // 系统能力
  appInfo: 'app:info',
  appShells: 'app:shells',
  appOpenLogs: 'app:open-logs',
  appOpenPath: 'app:open-path',
  appOpenDoc: 'app:open-doc',
  appOpenExternal: 'app:open-external',
  appReleaseInfo: 'app:release-info',
  updateCheck: 'update:check',
  pickFile: 'dialog:pick-file',
  pickDirectory: 'dialog:pick-directory',
  confirm: 'dialog:confirm',

  // 主进程 -> 渲染进程事件
  evtSession: 'evt:session',
  evtRsync: 'evt:rsync',
  evtAppCommand: 'evt:app-command',
  evtSyncAuto: 'evt:sync-auto'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]

/** 所有合法通道名的联合类型；主进程 handle 只接受这里的值 */

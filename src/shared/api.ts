import type {
  AppCommand,
  AppInfo,
  AppSettings,
  ConnectionTestResult,
  FileEntry,
  HostDraft,
  HostProfile,
  OpenSessionResult,
  PersistedTab,
  ReleaseInfo,
  RsyncCapability,
  RsyncPlan,
  RsyncProbeResult,
  RsyncTask,
  SessionEvent,
  ShellsResult,
  Snippet,
  TextFile,
  TunnelConfig,
  TunnelRuntimeInfo,
  UpdateCheckResult
} from './types'
import type {
  AutoSyncPatch,
  AutoSyncRunResult,
  AutoSyncState,
  AutoSyncTestResult,
  DiffReport,
  SyncExportOptions,
  SyncExportResult,
  SyncFolderFile,
  SyncImportMode,
  SyncImportRequest,
  SyncImportResult,
  SyncInspectResult,
  SyncSource,
  SyncTarget
} from './sync'

/**
 * 预加载脚本通过 contextBridge 暴露给渲染进程的 API 契约。
 * 主进程实现（src/main/ipc.ts）与渲染进程调用（window.jshell）共用同一份类型，
 * 保证三端（main / preload / renderer）签名一致。
 */
export interface JShellApi {
  hosts: {
    list(): Promise<HostProfile[]>
    save(draft: HostDraft): Promise<HostProfile>
    remove(id: string): Promise<void>
    /** 信任某个主机的公钥指纹（指纹变更确认后调用） */
    trustKey(host: string, port: number, algorithm: string, fingerprint: string): Promise<void>
    /** 保存前测试连接；不写入配置、不记录指纹 */
    test(draft: HostDraft): Promise<ConnectionTestResult>
  }
  sessions: {
    /** 打开 SSH 会话；sessionId 由渲染进程生成，避免事件早于标签页创建 */
    open(
      hostId: string,
      size: { cols: number; rows: number },
      sessionId: string
    ): Promise<OpenSessionResult>
    /** 打开本地终端（默认 shell 或指定 shell 路径） */
    openLocal(
      size: { cols: number; rows: number },
      sessionId: string,
      shellPath?: string
    ): Promise<OpenSessionResult>
    close(sessionId: string): Promise<void>
    write(sessionId: string, data: string): Promise<void>
    resize(sessionId: string, cols: number, rows: number): Promise<void>
  }
  sftp: {
    /** 登录后默认目录（通常是 /home/<user>） */
    home(sessionId: string): Promise<string>
    list(sessionId: string, dirPath: string): Promise<FileEntry[]>
    mkdir(sessionId: string, dirPath: string): Promise<void>
    remove(sessionId: string, targetPath: string, isDir: boolean): Promise<void>
    rename(sessionId: string, from: string, to: string): Promise<void>
    download(sessionId: string, remotePath: string): Promise<{ canceled: boolean; path?: string }>
    upload(sessionId: string, remoteDir: string): Promise<{ canceled: boolean; count: number }>
    uploadDir(sessionId: string, remoteDir: string): Promise<{ canceled: boolean; count: number }>
    downloadTo(sessionId: string, remotePaths: string[], localDir: string): Promise<{ count: number }>
    cancel(taskId: string): Promise<void>
    readText(sessionId: string, remotePath: string): Promise<TextFile>
    writeText(sessionId: string, remotePath: string, text: string): Promise<void>
  }
  rsync: {
    /** 探测本机 rsync 与进度能力 */
    check(): Promise<RsyncCapability>
    /** 探测远端是否装了 rsync（避免跑到执行页才发现） */
    probe(hostId: string): Promise<RsyncProbeResult>
    start(plan: RsyncPlan): Promise<RsyncTask>
    cancel(taskId: string): Promise<void>
    onEvent(listener: (task: RsyncTask) => void): void
    unsubscribe(): void
  }
  localFs: {
    home(): Promise<string>
    list(dirPath: string): Promise<FileEntry[]>
    mkdir(dirPath: string): Promise<void>
    rename(from: string, to: string): Promise<void>
    remove(targetPath: string): Promise<void>
    reveal(targetPath: string): void
    readText(targetPath: string): Promise<TextFile>
    writeText(targetPath: string, text: string): Promise<void>
  }
  layout: {
    /** 上次退出时的标签/分屏结构 */
    get(): Promise<PersistedTab[]>
    save(tabs: PersistedTab[]): Promise<void>
  }
  /**
   * 数据共享：加密同步包。
   * 应用不绑定任何云服务——同步包就是一个普通文件，
   * 可以放在 iCloud / OneDrive / Dropbox / 坚果云 / 局域网共享 / U 盘 / 剪贴板里的任意位置。
   */
  sync: {
    /** 本机探测到的同步位置（可能为空，为空时仍可用「选择文件」与「剪贴板」） */
    targets(): Promise<SyncTarget[]>
    /** 某个同步目录里已有的同步包 */
    files(targetId: string): Promise<SyncFolderFile[]>
    exportBundle(options: SyncExportOptions): Promise<SyncExportResult>
    /** 读取并解析同步包；加密包需要传入口令才会返回预览 */
    inspect(source: SyncSource, password?: string): Promise<SyncInspectResult>
    /** 覆盖前检测：只读，返回「会新增/覆盖/删除什么」，不改动任何数据 */
    diff(token: string, mode: SyncImportMode): Promise<DiffReport>
    import(request: SyncImportRequest): Promise<SyncImportResult>
    /** 关闭面板时清空挂起的导入会话 */
    dispose(): Promise<void>
  }
  /**
   * 自动同步：把同步包固定放在某个云盘目录，本机改动后自动写回、远端变化时自动拉取。
   * 拉取前仍走同一套检测，风险项默认暂停等确认。
   */
  autoSync: {
    get(): Promise<AutoSyncState>
    set(patch: AutoSyncPatch): Promise<AutoSyncState>
    /** 立即同步一次（手动触发时忽略方向开关，双向各做一次） */
    run(): Promise<AutoSyncRunResult>
    /** 把被暂停的远端变更强制应用到本机 */
    applyPending(): Promise<AutoSyncRunResult>
    /** 系统对话框选择任意目录（网络共享、加密盘等不在探测列表里的位置） */
    pick(): Promise<AutoSyncState>
    /** 自检当前同步位置：目录可读写、SFTP 能连上并建目录 */
    test(): Promise<AutoSyncTestResult>
    onStatus(listener: (state: AutoSyncState) => void): void
    unsubscribe(): void
  }
  settings: {
    get(): Promise<AppSettings>
    update(patch: Partial<AppSettings>): Promise<AppSettings>
  }
  snippets: {
    list(): Promise<Snippet[]>
    save(input: { id?: string; name: string; command: string }): Promise<Snippet>
    remove(id: string): Promise<void>
  }
  tunnels: {
    /** 已配置的转发规则 */
    list(): Promise<TunnelConfig[]>
    start(sessionId: string, cfg: Omit<TunnelConfig, 'id' | 'enabled'> & { id?: string }): Promise<TunnelRuntimeInfo>
    stop(tunnelId: string): Promise<void>
  }
  terminal: {
    /**
     * 终端是否获得焦点。主进程据此决定 Cmd+C / Cmd+V 是走系统编辑命令（输入框）
     * 还是回投给终端自行处理（有选区时复制、粘贴时写入 PTY）。
     */
    setFocused(focused: boolean): void
  }
  clipboard: {
    /** 主进程按焦点路由后回投的动作，paste 会携带剪贴板文本 */
    onCommand(
      listener: (payload: { action: 'copy' | 'paste' | 'selectAll'; text?: string }) => void
    ): void
    unsubscribe(): void
    /** 由主进程写剪贴板，不依赖页面焦点 */
    writeText(text: string): Promise<void>
    readText(): Promise<string>
  }
  app: {
    info(): Promise<AppInfo>
    /** 探测本机可用的 shell（macOS 读 /etc/shells，Windows 探 cmd/PowerShell） */
    shells(): Promise<ShellsResult>
    /** 构建时的发布元信息（渠道 / 构建时间 / 更新地址） */
    release(): Promise<ReleaseInfo>
    /** 打开日志目录（Finder / 资源管理器） */
    openLogs(): Promise<void>
    /** 用系统程序打开本地文件或目录（仅允许应用数据目录与资源目录内） */
    openPath(target: string): Promise<void>
    /** 打开随包分发的说明文档：manual / privacy / license / changelog */
    openDoc(name: 'manual' | 'privacy' | 'license' | 'changelog'): Promise<void>
    /** 用系统浏览器打开 https 链接（更新说明、许可与隐私页面） */
    openExternal(url: string): Promise<void>
    /** 托盘 / 系统菜单发来的应用级命令 */
    onCommand(listener: (command: AppCommand) => void): void
    unsubscribeCommand(): void
  }
  update: {
    /** 检查更新；内部渠道未配置更新地址时返回 disabled，不发起任何网络请求 */
    check(): Promise<UpdateCheckResult>
  }
  dialog: {
    /** 选择本地文件（用于挑选私钥 / 上传），返回绝对路径或 null */
    pickFile(options?: { title?: string; multi?: boolean }): Promise<string | string[] | null>
    pickDirectory(options?: { title?: string }): Promise<string | null>
    confirm(options: { title: string; message: string; detail?: string; danger?: boolean }): Promise<boolean>
  }
  events: {
    subscribe(listener: (event: SessionEvent) => void): void
    unsubscribe(): void
  }
}

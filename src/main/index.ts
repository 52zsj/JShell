import { app, BrowserWindow, Menu, screen, session, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { IPC } from '../shared/ipc'
import type { AppCommand } from '../shared/types'
import { createContext, registerIpc, type AppContext } from './ipc'
import { applyPortableDataDir, getPortableState, portableHint, appVersion } from './services/app-env'
import { copySelection, isTerminalFocused, pasteInto, selectAll } from './services/clipboard'
import { syncLaunchAtLogin } from './services/login-item'
import { installProcessHandlers, log, openLogDir, pruneLogsOnStartup } from './services/logger'
import { configureNotifications } from './services/notifications'
import { TrayService } from './services/tray'
import { loadReleaseInfo } from './services/update'

// 必须在 app ready 之前决定数据目录：便携版要写到程序目录，安装版写系统用户目录
const portable = applyPortableDataDir()

installProcessHandlers()

let mainWindow: BrowserWindow | null = null
let ctx: AppContext | null = null
let trayService: TrayService | null = null
let rendererReady = false
/** 渲染进程还没加载完时先缓存托盘/菜单命令，加载完成后再投递 */
let pendingCommands: AppCommand[] = []
/** 是否正在真正退出（区分「关闭窗口」与「退出应用」） */
let quitting = false

const isDev = !app.isPackaged
const isMac = process.platform === 'darwin'

/** Windows 通知与任务栏分组依赖 AppUserModelId，必须与安装包 appId 一致 */
if (process.platform === 'win32') app.setAppUserModelId('cn.jshell.desktop')

/** 只允许打开一个实例，避免多份配置并发写同一份 state.json */
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    // 早期启动阶段的第二实例事件可能在 ready 之前到达，此时还不能建窗口
    if (app.isReady()) showMainWindow()
  })
}

// ---------------------------------------------------------------- 窗口管理

function windowShouldStartHidden(): boolean {
  if (process.argv.includes('--hidden')) return true
  const settings = ctx?.store.getSettings()
  if (settings?.startMinimized) return true
  return false
}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow(true)
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function sendCommand(command: AppCommand): void {
  showMainWindow()
  if (!mainWindow) return
  if (!rendererReady) {
    pendingCommands.push(command)
    return
  }
  mainWindow.webContents.send(IPC.evtAppCommand, command)
}

function flushPendingCommands(): void {
  if (!mainWindow) return
  const queue = pendingCommands
  pendingCommands = []
  for (const command of queue) mainWindow.webContents.send(IPC.evtAppCommand, command)
}

function createWindow(showWhenReady = !windowShouldStartHidden()): void {
  const saved = ctx?.store.loadWindowState()
  const visible =
    saved?.x !== undefined &&
    saved?.y !== undefined &&
    screen.getAllDisplays().some((display) => {
      const area = display.workArea
      return (
        saved.x! < area.x + area.width &&
        saved.x! + saved.width > area.x &&
        saved.y! < area.y + area.height &&
        saved.y! + saved.height > area.y
      )
    })

  mainWindow = new BrowserWindow({
    width: saved?.width ?? 1280,
    height: saved?.height ?? 820,
    ...(visible ? { x: saved!.x, y: saved!.y } : {}),
    minWidth: 900,
    minHeight: 560,
    show: false,
    title: 'JShell 终端工作台',
    backgroundColor: '#0f1115',
    // macOS 使用内嵌红绿灯，让顶部标签栏与窗口融合；Windows 保留系统标题栏
    ...(isMac
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 14, y: 14 } }
      : {}),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  })

  rendererReady = false
  mainWindow.once('ready-to-show', () => {
    if (showWhenReady) mainWindow?.show()
  })
  mainWindow.webContents.on('did-finish-load', () => {
    rendererReady = true
    flushPendingCommands()
  })

  // 外部链接交给系统浏览器，避免在应用内被导航劫持
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  // 单页应用没有合法导航：除 http(s) 交给浏览器外一律拦截
  mainWindow.webContents.on('will-navigate', (event, url) => {
    event.preventDefault()
    if (/^https?:/i.test(url)) void shell.openExternal(url)
  })

  /**
   * 关闭窗口的跨平台行为：
   * - 开启「关闭时最小化到托盘」→ 隐藏窗口，SSH 会话继续在后台运行；
   * - 关闭该选项 → 与系统习惯一致（Windows 退出应用，macOS 保留在 Dock）。
   */
  mainWindow.on('close', (event) => {
    if (quitting) return
    const closeToTray = ctx?.store.getSettings().closeToTray ?? true
    if (!closeToTray) return
    event.preventDefault()
    mainWindow?.hide()
    log.info('窗口已隐藏到托盘（关闭窗口不退出）')
  })

  // 记住窗口位置；防抖避免拖动过程中频繁写盘
  let boundsTimer: NodeJS.Timeout | undefined
  const saveBounds = (): void => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    ctx?.store.saveWindowState(mainWindow.getBounds())
  }
  const scheduleSaveBounds = (): void => {
    if (boundsTimer) clearTimeout(boundsTimer)
    boundsTimer = setTimeout(saveBounds, 300)
  }
  mainWindow.on('resize', scheduleSaveBounds)
  mainWindow.on('move', scheduleSaveBounds)
  mainWindow.on('close', saveBounds)

  mainWindow.on('closed', () => {
    if (boundsTimer) clearTimeout(boundsTimer)
    log.info('主窗口已销毁')
    mainWindow = null
    rendererReady = false
    // 走到这里说明窗口是真销毁（不是「隐藏到托盘」）：
    // 渲染层没了，后台的 SSH / pty 会话再也没有 UI 入口能关，
    // 而且它们会继续把远端输出读进内存再丢掉（背压见 flow-control）。
    // 所以在这里一并关掉，避免每开关一次窗口泄漏一批连接。
    ctx?.sessions.closeAll()
  })

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

// ------------------------------------------------------------------ 系统菜单

/** 打开随包分发的说明文档（隐私 / 许可 / 更新记录） */
async function openBundledDoc(name: string): Promise<void> {
  const file = app.isPackaged
    ? path.join(process.resourcesPath, 'docs', name)
    : path.join(app.getAppPath(), 'docs', name)
  const message = await shell.openPath(file)
  if (message) log.warn(`打开文档失败：${name}`, message)
}

/**
 * 应用菜单（全中文）。
 * 编辑菜单保留系统 role，保证输入框里的 ⌘C/⌘V 与中文输入法候选框正常工作。
 */
function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: 'JShell',
            submenu: [
              { label: '关于 JShell', click: () => sendCommand('about') },
              { label: '设置…', click: () => sendCommand('settings') },
              { label: '检查更新', click: () => sendCommand('check-update') },
              { type: 'separator' as const },
              { role: 'hide' as const, label: '隐藏 JShell' },
              { role: 'hideOthers' as const, label: '隐藏其他' },
              { role: 'unhide' as const, label: '全部显示' },
              { type: 'separator' as const },
              { role: 'quit' as const, label: '退出 JShell' }
            ]
          }
        ]
      : []),
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        // 复制/粘贴/全选不用系统 role：终端聚焦时要转给 xterm 的选区，而不是 DOM 选区。
        // 也不能靠 before-input-event 拦：macOS 的菜单快捷键会先于页面键盘事件生效。
        {
          label: '复制',
          // Windows / Linux 的 Ctrl+C 必须留给终端发中断信号，复制走 Ctrl+Shift+C
          accelerator: isMac ? 'CommandOrControl+C' : 'CommandOrControl+Shift+C',
          click: () => copySelection(mainWindow)
        },
        {
          label: '粘贴',
          accelerator: 'CommandOrControl+V',
          click: () => pasteInto(mainWindow)
        },
        {
          label: '全选',
          accelerator: 'CommandOrControl+A',
          click: () => selectAll(mainWindow)
        }
      ]
    },
    {
      label: '视图',
      submenu: [
        // 生产包不提供 reload / DevTools：reload 会让渲染层丢标签、主进程会话变成孤儿
        ...(isDev
          ? [
              { role: 'reload' as const, label: '重新加载' },
              { role: 'toggleDevTools' as const, label: '开发者工具' },
              { type: 'separator' as const }
            ]
          : []),
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '切换全屏' }
      ]
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { label: '隐藏到托盘', click: () => mainWindow?.hide() },
        // 不用 role: 'close'：它自带 Cmd+W 加速键，会抢掉应用内「关闭标签页」的快捷键
        { label: '关闭窗口', click: () => mainWindow?.close() }
      ]
    },
    {
      label: '帮助',
      submenu: [
        { label: '使用说明', click: () => void openBundledDoc('manual.md') },
        { label: '隐私说明', click: () => void openBundledDoc('privacy.md') },
        { label: '许可协议', click: () => void openBundledDoc('license.md') },
        { label: '更新记录', click: () => void openBundledDoc('CHANGELOG.md') },
        { type: 'separator' },
        { label: '检查更新', click: () => sendCommand('check-update') },
        { label: '打开日志目录', click: () => void openLogDir().catch(() => undefined) }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/**
 * E2E 调试钩子：仅当启动时显式设置 JSHELL_E2E=1 才会挂到主进程 globalThis，
 * 用于自动化验证「关闭窗口隐藏到托盘 / 第二实例唤醒」等只能由主进程触发的行为。
 * 不通过 IPC 暴露给渲染进程，正常运行（无该环境变量）时完全不存在。
 */
if (process.env.JSHELL_E2E === '1') {
  ;(globalThis as Record<string, unknown>).__jshellE2E = {
    closeWindow: () => mainWindow?.close(),
    isVisible: () => mainWindow?.isVisible() ?? false,
    windowCount: () => BrowserWindow.getAllWindows().length,
    // 触发「编辑」菜单里的复制/粘贴/全选，等价于按下对应快捷键
    editCommand: (action: 'copy' | 'paste' | 'selectAll') => {
      const label = { copy: '复制', paste: '粘贴', selectAll: '全选' }[action]
      const edit = Menu.getApplicationMenu()?.items.find((item) => item.label === '编辑')
      const item = edit?.submenu?.items.find((it) => it.label === label)
      item?.click(undefined, mainWindow ?? undefined, undefined)
      return item ? 'ok' : 'no-item'
    },
    // 让窗口真正获得系统焦点（自动化测试里窗口常在后台，focus 事件不触发）
    focusWindow: () => {
      mainWindow?.show()
      mainWindow?.focus()
      mainWindow?.webContents.focus()
      return 'ok'
    },
    isTerminalFocused: () => isTerminalFocused()
  }
}

// ---------------------------------------------------------------------- 启动

app.whenReady().then(() => {
  // 打包冒烟：只验证二进制与原生模块可加载，不创建窗口/托盘
  if (process.argv.includes('--smoke-test')) {
    log.info('SMOKE_OK')
    app.exit(0)
    return
  }

  /**
   * 权限加固：渲染层只需要剪贴板（终端复制粘贴），
   * 其余能力（摄像头、麦克风、地理位置等）一律拒绝。
   */
  const ALLOWED_PERMISSIONS = new Set(['clipboard-read', 'clipboard-sanitized-write'])
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(ALLOWED_PERMISSIONS.has(permission))
  })
  session.defaultSession.setPermissionCheckHandler((_contents, permission) =>
    ALLOWED_PERMISSIONS.has(permission)
  )

  ctx = createContext(() => mainWindow)
  registerIpc(ctx, () => mainWindow)
  configureNotifications(() => mainWindow)

  // 启动时把配置里的开机自启状态同步到系统（重装 / 换便携目录后仍然有效）
  const settings = ctx.store.getSettings()
  syncLaunchAtLogin(settings.launchAtLogin)

  buildMenu()
  createWindow()

  // Windows 首次要编译 askpass 组件（1~2 秒），放到窗口出来之后后台做，
  // 避免用户点「同步」时主线程卡一下
  void ctx.rsync.preheat()

  trayService = new TrayService({
    showWindow: showMainWindow,
    sendCommand,
    openLogs: () => void openLogDir().catch((err) => log.warn('打开日志目录失败', err)),
    quit: () => {
      quitting = true
      app.quit()
    }
  })
  trayService.create()

  // 清掉过期日志：每天一个文件，不清理会随使用年限无限增长
  pruneLogsOnStartup()

  const meta = loadReleaseInfo()
  log.info(
    `JShell ${appVersion()} 启动 | 平台 ${process.platform}/${process.arch} | 渠道 ${meta.channel}` +
      ` | ${getPortableState().portable ? '便携模式' : '安装模式'} | 数据目录 ${app.getPath('userData')}`
  )
  if (portableHint()) log.info(portableHint())

  // Apple Silicon 上跑 Intel 版本会走 Rosetta，启动会慢 10 倍以上（实测 0.4s → 8.8s），
  // 这不是代码问题，装错架构而已。日志里写清楚，用户在「关于」里能一眼看到。
  if (isMac && app.runningUnderARM64Translation) {
    log.warn('当前为 Intel(x64) 版本，正在 Apple Silicon 上通过 Rosetta 转译运行，启动与响应会明显变慢；请改用 arm64 安装包')
  }

  if (isMac) {
    app.setAboutPanelOptions({
      applicationName: 'JShell 终端工作台',
      applicationVersion: appVersion(),
      version: meta.buildTime ? `构建于 ${meta.buildTime}` : '',
      copyright: 'Copyright © 2026 JShell',
      credits: '本地优先的 SSH / 终端工作台，无账号体系，默认不采集任何数据。'
    })
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(true)
    else showMainWindow()
  })
})

app.on('window-all-closed', () => {
  // 关闭到托盘时窗口不会真正关闭；未开启托盘驻留则遵循系统习惯
  if (!isMac && !(ctx?.store.getSettings().closeToTray ?? false)) app.quit()
})

// 退出前优雅关闭所有 SSH 连接与监听端口，避免远端残留会话
app.on('before-quit', () => {
  quitting = true
  ctx?.store.flushLayout()
  ctx?.tunnels.stopAll()
  ctx?.sessions.closeAll()
  ctx?.sessions.dispose()
  ctx?.autoSync.stop()
  trayService?.destroy()
  trayService = null
  log.info('JShell 已退出')
})

// 便携版数据目录不可写时给出明确提示（否则用户会以为配置没保存）
if (portable.portableDir && !portable.portable) {
  app.whenReady().then(() => {
    log.warn(`便携模式未启用：${portable.portableDir} 不可写，已回退到系统数据目录`)
  })
}

// 保证 sessionData 目录存在（setPath 不会自动创建）
if (portable.dataDir) {
  try {
    fs.mkdirSync(path.join(portable.dataDir, 'session'), { recursive: true })
  } catch {
    /* 已在上面的可写性检查中处理 */
  }
}

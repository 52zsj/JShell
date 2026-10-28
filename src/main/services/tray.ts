import { app, Menu, Tray, nativeImage } from 'electron'
import path from 'node:path'
import type { AppCommand } from '../../shared/types'
import { log } from './logger'

export interface TrayDeps {
  showWindow: () => void
  sendCommand: (command: AppCommand) => void
  openLogs: () => void
  quit: () => void
}

/**
 * 托盘图标与菜单。
 *
 * macOS 使用 Template Image（随系统深浅色自动反色），Windows 使用多尺寸 .ico；
 * 两者都从 resources/tray 读取，开发模式回落到 build/tray。
 */
function trayDir(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'tray')
    : path.join(app.getAppPath(), 'build', 'tray')
}

function trayIconPath(): string {
  return process.platform === 'darwin'
    ? path.join(trayDir(), 'trayTemplate.png')
    : path.join(trayDir(), 'tray-win.ico')
}

export class TrayService {
  private tray: Tray | null = null

  constructor(private readonly deps: TrayDeps) {}

  create(): void {
    if (this.tray) return
    try {
      const image = nativeImage.createFromPath(trayIconPath())
      if (image.isEmpty()) {
        log.warn(`托盘图标缺失或无法读取：${trayIconPath()}`)
      }
      // macOS 模板图：系统会自动按深浅色反色
      if (process.platform === 'darwin') image.setTemplateImage(true)

      this.tray = new Tray(image)
      this.tray.setToolTip('JShell · SSH / 终端工作台')
      this.tray.setContextMenu(this.buildMenu())

      if (process.platform !== 'darwin') {
        this.tray.on('click', () => this.deps.showWindow())
        this.tray.on('double-click', () => this.deps.showWindow())
      }
      log.info('托盘图标已创建')
    } catch (err) {
      log.error('创建托盘图标失败', err)
    }
  }

  private buildMenu(): Menu {
    return Menu.buildFromTemplate([
      { label: '显示主窗口', click: () => this.deps.showWindow() },
      { type: 'separator' },
      { label: '新建本地终端', click: () => this.deps.sendCommand('new-local') },
      { label: '新建 SSH 主机', click: () => this.deps.sendCommand('new-host') },
      { type: 'separator' },
      { label: '设置…', click: () => this.deps.sendCommand('settings') },
      { label: '检查更新', click: () => this.deps.sendCommand('check-update') },
      { label: '打开日志目录', click: () => this.deps.openLogs() },
      { type: 'separator' },
      { label: '退出 JShell', click: () => this.deps.quit() }
    ])
  }

  destroy(): void {
    this.tray?.destroy()
    this.tray = null
  }
}

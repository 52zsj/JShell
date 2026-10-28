import { BrowserWindow, Notification } from 'electron'
import { log } from './logger'

/**
 * 系统通知。
 *
 * 规则（两个平台一致）：
 *  - 只在本应用窗口不处于焦点时提醒，避免用户正在看终端还被弹一次；
 *  - 相同标题+内容的提醒 8 秒内只发一次，防止网络抖动时刷屏；
 *  - 用户关掉「系统通知」后完全不发送；
 *  - 通知内容只包含本地文案，不含主机口令等敏感信息。
 */

const DEDUPE_MS = 8000

let enabled = true
let resolveWindow: () => BrowserWindow | null = () => null
const recent = new Map<string, number>()

export function configureNotifications(getWindow: () => BrowserWindow | null): void {
  resolveWindow = getWindow
}

export function setNotificationsEnabled(value: boolean): void {
  enabled = value
}

export function notificationsEnabled(): boolean {
  return enabled
}

export function notifySystem(title: string, body: string): void {
  if (!enabled) return
  if (!Notification.isSupported()) return

  const win = resolveWindow()
  if (win && !win.isDestroyed() && win.isFocused()) return

  const key = `${title}\u0000${body}`
  const now = Date.now()
  const last = recent.get(key)
  if (last && now - last < DEDUPE_MS) return
  recent.set(key, now)
  // 控制记录大小，长期运行不会无限增长
  if (recent.size > 50) {
    for (const [item, at] of recent) if (now - at > DEDUPE_MS) recent.delete(item)
  }

  try {
    const notification = new Notification({ title, body, silent: false })
    notification.on('click', () => {
      const target = resolveWindow()
      if (!target || target.isDestroyed()) return
      if (target.isMinimized()) target.restore()
      target.show()
      target.focus()
    })
    notification.show()
  } catch (err) {
    log.warn('系统通知发送失败', err)
  }
}

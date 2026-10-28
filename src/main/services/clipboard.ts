import { BrowserWindow, clipboard } from 'electron'
import { IPC } from '../../shared/ipc'
import { log } from './logger'

/**
 * 终端剪贴板路由。
 *
 * 为什么不在 before-input-event 里拦：
 *  macOS 的菜单快捷键（role: copy / paste）由系统菜单直接处理，它与页面键盘事件的
 *  先后顺序并不可靠 —— 一旦菜单先吃掉 Cmd+C，before-input-event 就永远收不到，
 *  表现为「终端里按 Cmd+C 没反应、Cmd+V 也贴不进去」。
 *  改成让菜单项自己判断「转给终端」还是「走系统编辑」，顺序问题就不存在了。
 *
 * 平台差异：
 *  - macOS：复制/粘贴用 ⌘C / ⌘V；
 *  - Windows / Linux：Ctrl+C 必须留给终端发 SIGINT，复制改走 Ctrl+Shift+C。
 */

let terminalFocused = false

export function setTerminalFocused(focused: boolean): void {
  terminalFocused = focused
}

export function isTerminalFocused(): boolean {
  return terminalFocused
}

type ClipboardAction = 'copy' | 'paste' | 'selectAll'

function forward(win: BrowserWindow | null, payload: { action: ClipboardAction; text?: string }): boolean {
  if (!win || win.isDestroyed()) return false
  win.webContents.send(IPC.clipboardCommand, payload)
  return true
}

/** 菜单「复制」：终端聚焦时复制 xterm 选区，否则走系统编辑命令 */
export function copySelection(win: BrowserWindow | null): void {
  if (terminalFocused && forward(win, { action: 'copy' })) return
  win?.webContents.copy()
}

/** 菜单「粘贴」：终端聚焦时把文本写进 PTY，否则走系统编辑命令 */
export function pasteInto(win: BrowserWindow | null): void {
  if (!terminalFocused) {
    win?.webContents.paste()
    return
  }
  // Electron 45 起 clipboard.readText 是 Promise
  void clipboard.readText().then((text) => forward(win, { action: 'paste', text }))
}

/** 菜单「全选」：终端聚焦时选中终端全部输出，否则选中输入框内容 */
export function selectAll(win: BrowserWindow | null): void {
  if (terminalFocused && forward(win, { action: 'selectAll' })) return
  win?.webContents.selectAll()
}

/**
 * 渲染层复制时调用。写剪贴板放在主进程：
 * 页面里的 navigator.clipboard 依赖文档焦点与用户激活，经 IPC 回投后常常已经失效。
 */
export function writeClipboard(text: string): Promise<void> {
  if (typeof text !== 'string' || text.length === 0) return Promise.resolve()
  return clipboard.writeText(text).then(() => log.info(`已写入剪贴板：${text.length} 个字符`))
}

/** 渲染层读取剪贴板（右键菜单粘贴），免去 clipboard-read 权限 */
export function readClipboard(): Promise<string> {
  return clipboard.readText()
}

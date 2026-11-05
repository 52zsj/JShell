import type { Terminal } from '@xterm/xterm'
import { getFocusedSession, getTerminal } from './terminal-registry'
import { useAppStore } from './store'
import { errorMessage } from './utils'

/**
 * 终端剪贴板动作（复制 / 粘贴 / 全选）。
 *
 * 键盘触发与菜单回投（主进程把菜单点击转给渲染层）走同一份实现，避免两套语义。
 * 剪贴板读写放在主进程：页面里的 navigator.clipboard 依赖文档焦点与用户激活，
 * 反而更容易失效。
 */

/** 当前应该接收剪贴板动作的终端：优先焦点所在，其次当前选中分屏 */
export function activeTerminal(): Terminal | undefined {
  const state = useAppStore.getState()
  const tab = state.tabs.find((item) => item.id === state.activeTabId)
  const sessionId = getFocusedSession() ?? tab?.activeSessionId ?? null
  if (!sessionId) return undefined
  return getTerminal(sessionId)
}

/** 终端里是否有选区（决定 Ctrl+C 是「复制」还是「发中断」） */
export function hasTerminalSelection(): boolean {
  return Boolean(activeTerminal()?.hasSelection())
}

/**
 * 复制终端选区。
 * 返回 false 表示没有选区、什么都没做——调用方据此决定是否把按键让给终端。
 */
export function copyTerminalSelection(): boolean {
  const term = activeTerminal()
  if (!term) return false
  const selection = term.getSelection()
  if (!selection) return false
  const state = useAppStore.getState()
  void window.jshell.clipboard
    .writeText(selection)
    .catch((err) => state.pushToast(errorMessage(err), 'error'))
  return true
}

/** 粘贴到终端。返回 false 表示当前没有终端可粘贴 */
export function pasteIntoTerminal(): boolean {
  const term = activeTerminal()
  if (!term) return false
  const state = useAppStore.getState()
  void window.jshell.clipboard
    .readText()
    .then((text) => {
      if (text) term.paste(text)
    })
    .catch((err) => state.pushToast(errorMessage(err), 'error'))
  return true
}

/** 选中终端全部输出（含 scrollback）。返回 false 表示当前没有终端 */
export function selectAllTerminal(): boolean {
  const term = activeTerminal()
  if (!term) return false
  term.selectAll()
  return true
}

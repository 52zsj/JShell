import { useAppStore } from './store'
import { broadcastInput } from './input-sync'

/**
 * 往终端写输入，并遵守「批量编辑」的设置。
 *
 * 为什么需要这个函数：正常按键是 xterm 的 `onData` → 主进程，广播挂在 `onData` 上就自动覆盖了；
 * 但**命令片段**（Tab 补全、片段面板的「填入」）是渲染层自己拼好字符串**直接**写 IPC 的，
 * 根本不经过 `onData`。于是“批量编辑开着，片段却只进了当前终端”—— 曾经的 bug。
 *
 * 今后凡是「代替用户输入」的地方都走这里，就不会再漏：
 *  - 命令片段补全（Tab）
 *  - 片段面板的「填入终端」
 *  - 之后要是加「粘贴到全部」「粘贴历史命令」之类，也走它
 */
export function sendInput(sessionId: string, data: string): void {
  if (!data) return
  window.jshell.sessions.write(sessionId, data)

  const state = useAppStore.getState()
  if (!state.inputSyncEnabled) return
  broadcastInput(
    sessionId,
    data,
    { enabled: true, tabs: state.tabs, selected: state.inputSyncSessions },
    (targetSessionId, payload) => {
      window.jshell.sessions.write(targetSessionId, payload)
    }
  )
}

import { useAppStore } from './store'
import { broadcastInput } from './input-sync'

/**
 * 写输入并遵守批量编辑设置。
 *
 * 正常按键走 xterm 的 onData（广播挂在那里），但命令片段是直接写 IPC 的，
 * 不经过 onData —— 所以片段入口必须走这个函数，否则批量编辑对片段不生效。
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

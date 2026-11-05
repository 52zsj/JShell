import type { TerminalTab } from './store'
import { findLeaf, firstLeaf } from './pane-tree'

/**
 * 批量编辑（同屏广播输入）：在任意一个终端里敲的字，同时发给其它选中的终端。
 *
 * 选谁：以**标签页**为单位（和 Ctrl+1..9 的序号一致），取每个标签当前聚焦的那个分屏。
 * 为什么按标签而不是按分屏：一个标签通常就是一台机器，用户嘴里的「1、2、3 号」说的是标签；
 * 标签内部分屏在做批量运维时反而是杂音，取「你正看着的那个分屏」最符合直觉。
 *
 * 「不选 = 全部」：`selected` 为空数组表示所有标签都参与。
 * 界面上也是这么写的（不勾任何一项时的提示就是「全部终端」）。
 *
 * 安全约定：
 *  - 只在内存里生效，不写进设置；重启后必定是关闭状态，避免「上次开了、这次忘了」把命令广播出去；
 *  - 只发给 status === 'ready' 的会话，连接中/已断开的自动跳过，不会把命令丢进黑洞；
 *  - 永远不发给按键的来源会话，否则同一个字符会被写两次。
 */
export interface InputSyncTarget {
  tabId: string
  /** 该标签当前聚焦分屏的会话；理论上总有，留 null 以防布局异常 */
  sessionId: string | null
  /** 标签序号，1 起，与 Ctrl+1..9 对齐 */
  index: number
  label: string
  /** 只有 ready 才能真收到输入 */
  ready: boolean
  /** 是否在本次广播范围内（空选择时全部为 true） */
  selected: boolean
}

export function syncTargets(tabs: TerminalTab[], selected: string[]): InputSyncTarget[] {
  const all = selected.length === 0
  return tabs.map((tab, i) => {
    const pane = (findLeaf(tab.root, tab.activeSessionId) ?? firstLeaf(tab.root)).pane
    return {
      tabId: tab.id,
      sessionId: pane?.sessionId ?? null,
      index: i + 1,
      label: pane?.title || pane?.subtitle || '终端',
      ready: pane?.status === 'ready',
      selected: all || selected.includes(tab.id)
    }
  })
}

/** 真正会写入的会话：选中 + ready + 不是输入来源 + 去重 */
export function activeSyncSessions(
  targets: InputSyncTarget[],
  sourceSessionId?: string
): string[] {
  const out: string[] = []
  for (const target of targets) {
    if (!target.selected || !target.ready || !target.sessionId) continue
    if (target.sessionId === sourceSessionId) continue
    if (!out.includes(target.sessionId)) out.push(target.sessionId)
  }
  return out
}

/**
 * 把一次输入同时写给其它终端。返回实际送出的会话数（0 表示没开或没有别的终端）。
 *
 * 刻意把「读状态」和「写会话」都做成入参（而不是在这里直接摸 store / window.jshell）：
 *  - 这个文件因此没有运行时依赖，可以在 Node 里直接单测「发给谁、不发给谁」；
 *  - 调用方（TerminalView）本来就持有 store 与 IPC，不需要再绕一层。
 */
export function broadcastInput(
  sourceSessionId: string,
  data: string,
  env: { enabled: boolean; tabs: TerminalTab[]; selected: string[] },
  write: (sessionId: string, data: string) => void
): number {
  if (!data || !env.enabled) return 0
  const targets = activeSyncSessions(syncTargets(env.tabs, env.selected), sourceSessionId)
  for (const sessionId of targets) write(sessionId, data)
  return targets.length
}

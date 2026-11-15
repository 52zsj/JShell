import type { TerminalTab } from './store'
import { leaves } from './pane-tree'

/**
 * 批量编辑：一个终端里敲的字，同时发给其它选中的终端。
 *
 * 粒度是分屏（会话），序号按「标签.分屏」展示；`selected` 为空表示全部。
 * 只发给 ready 的会话，且不发给来源会话；状态只在内存里，重启即关闭。
 * 详见 README「批量编辑」。
 */
export interface InputSyncTarget {
  tabId: string
  sessionId: string
  /** 标签序号，1 起，与 Ctrl+1..9 对齐 */
  tabIndex: number
  /** 该分屏在标签内的序号，1 起；单分屏标签恒为 1 */
  paneIndex: number
  /** 标签内的分屏总数（决定序号显示成 `2` 还是 `2.1`） */
  paneCount: number
  label: string
  /** 只有 ready 才能真收到输入 */
  ready: boolean
  /** 是否在本次广播范围内（空选择时全部为 true） */
  selected: boolean
}

/**
 * 列出所有可广播的分屏。顺序 = 标签顺序 → 标签内的分屏顺序，
 * 与界面上看到的排列一致，序号也据此生成。
 */
export function syncTargets(tabs: TerminalTab[], selected: string[]): InputSyncTarget[] {
  const all = selected.length === 0
  const targets: InputSyncTarget[] = []
  tabs.forEach((tab, tabIndex) => {
    const panes = leaves(tab.root)
    panes.forEach((leaf, paneIndex) => {
      const pane = leaf.pane
      targets.push({
        tabId: tab.id,
        sessionId: pane.sessionId,
        tabIndex: tabIndex + 1,
        paneIndex: paneIndex + 1,
        paneCount: panes.length,
        label: pane.title || pane.subtitle || '终端',
        ready: pane.status === 'ready',
        selected: all || selected.includes(pane.sessionId)
      })
    })
  })
  return targets
}

/** 某个标签下所有分屏的会话 id（快捷键「只对当前标签生效」时用） */
export function tabSessionIds(tabs: TerminalTab[], tabId: string | null): string[] {
  const tab = tabs.find((item) => item.id === tabId)
  if (!tab) return []
  return leaves(tab.root).map((node) => node.pane.sessionId)
}

/** 列表里的序号：单分屏标签是 `2`，多分屏是 `2.1` / `2.2` */
export function targetLabel(target: InputSyncTarget): string {
  return target.paneCount > 1 ? `${target.tabIndex}.${target.paneIndex}` : String(target.tabIndex)
}

/** 某个标签下有几个分屏在参与广播（标签上的红点 / 「N 个分屏」用） */
export function syncingPaneCount(targets: InputSyncTarget[], tabId: string): number {
  return targets.filter((t) => t.tabId === tabId && t.selected && t.ready).length
}

/** 真正会写入的会话：选中 + ready + 不是输入来源 + 去重 */
export function activeSyncSessions(
  targets: InputSyncTarget[],
  sourceSessionId?: string
): string[] {
  const out: string[] = []
  for (const target of targets) {
    if (!target.selected || !target.ready) continue
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

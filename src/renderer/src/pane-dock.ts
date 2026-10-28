import {
  findLeaf,
  firstLeaf,
  removeLeaf,
  replaceLeaf,
  type PaneNode
} from './pane-tree'

/**
 * 拖拽吸附（docking）的纯逻辑。
 *
 * 语义：把「来源」放到「目标分屏」的某一侧，二者组成一个新的 split。
 *  - 来源 = 整个标签（拖标签栏）→ 该标签的所有分屏作为一棵子树整体并入，原标签消失；
 *  - 来源 = 单个分屏（拖分屏标题栏）→ 只摘出这一片叶子并入；
 *  - 同标签内也可以移动分屏（相当于重新排列）。
 *
 * 放在 store 之外是为了可单测：只依赖 pane-tree 的纯函数，不碰 React / IPC。
 */

export type DockSide = 'left' | 'right' | 'top' | 'bottom'

/** 拖拽时写入 dataTransfer 的自定义类型，避免与文件拖拽等冲突 */
export const DRAG_MIME = 'application/x-jshell-dock'

export interface DragPayload {
  tabId: string
  /** 缺省表示拖动的是整个标签 */
  sessionId?: string
}

export interface DockableTab {
  id: string
  root: PaneNode
  activeSessionId: string
}

export interface DockRequest {
  sourceTabId: string
  /** 缺省表示整标签吸附 */
  sourceSessionId?: string
  targetTabId: string
  targetSessionId: string
  side: DockSide
}

/** 左/右 → 水平分割（row），上/下 → 垂直分割（column） */
export function sideToDirection(side: DockSide): 'row' | 'column' {
  return side === 'left' || side === 'right' ? 'row' : 'column'
}

/**
 * 把 node 插到 targetSessionId 的指定一侧。
 * 目标叶子会被一个新的 split 节点替换，node 与它成为兄弟。
 */
export function insertBeside(
  root: PaneNode,
  targetSessionId: string,
  node: PaneNode,
  side: DockSide,
  splitId: string
): PaneNode {
  if (!findLeaf(root, targetSessionId)) return root
  const target = findLeaf(root, targetSessionId)!
  const children: [PaneNode, PaneNode] =
    side === 'left' || side === 'top' ? [node, target] : [target, node]
  return replaceLeaf(root, targetSessionId, {
    type: 'split',
    id: splitId,
    direction: sideToDirection(side),
    ratio: 0.5,
    children
  })
}

export interface DockResult<T extends DockableTab> {
  tabs: T[]
  activeTabId: string
}

/**
 * 计算吸附后的标签集合。返回 null 表示这是一次无效拖拽（应当忽略）：
 *  - 落到自己身上；
 *  - 整标签拖到自己所在的标签；
 *  - 目标在来源子树内部（会造成循环引用）。
 */
export function dockTabs<T extends DockableTab>(
  tabs: T[],
  request: DockRequest,
  makeId: () => string
): DockResult<T> | null {
  const sourceTab = tabs.find((tab) => tab.id === request.sourceTabId)
  const targetTab = tabs.find((tab) => tab.id === request.targetTabId)
  if (!sourceTab || !targetTab) return null

  const wholeTab = !request.sourceSessionId
  if (wholeTab && sourceTab.id === targetTab.id) return null
  if (request.sourceSessionId && request.sourceSessionId === request.targetSessionId) return null

  const sourceNode: PaneNode | null = wholeTab
    ? sourceTab.root
    : (findLeaf(sourceTab.root, request.sourceSessionId!) ?? null)
  if (!sourceNode) return null
  if (!findLeaf(targetTab.root, request.targetSessionId)) return null
  if (!wholeTab && findLeaf(sourceNode, request.targetSessionId)) return null

  // 吸附后焦点落到新并入的子树的第一片叶子
  const incomingActive = firstLeaf(sourceNode).pane.sessionId

  // ---- 同标签内重排 ----
  if (sourceTab.id === targetTab.id) {
    const pruned = removeLeaf(sourceTab.root, request.sourceSessionId!)
    if (!pruned) return null
    const root = insertBeside(
      pruned,
      request.targetSessionId,
      sourceNode,
      request.side,
      makeId()
    )
    return {
      tabs: tabs.map((tab) =>
        tab.id === targetTab.id ? { ...tab, root, activeSessionId: incomingActive } : tab
      ),
      activeTabId: targetTab.id
    }
  }

  // ---- 跨标签 ----
  const targetRoot = insertBeside(
    targetTab.root,
    request.targetSessionId,
    sourceNode,
    request.side,
    makeId()
  )

  const withTarget = (list: T[]): T[] =>
    list.map((tab) =>
      tab.id === targetTab.id ? { ...tab, root: targetRoot, activeSessionId: incomingActive } : tab
    )

  // 整标签吸附：来源标签直接消失
  if (wholeTab) {
    return {
      tabs: withTarget(tabs.filter((tab) => tab.id !== sourceTab.id)),
      activeTabId: targetTab.id
    }
  }

  // 单分屏吸附：来源标签可能只剩空壳
  const remaining = removeLeaf(sourceTab.root, request.sourceSessionId!)
  if (!remaining) {
    return {
      tabs: withTarget(tabs.filter((tab) => tab.id !== sourceTab.id)),
      activeTabId: targetTab.id
    }
  }

  return {
    tabs: withTarget(
      tabs.map((tab) =>
        tab.id === sourceTab.id
          ? {
              ...tab,
              root: remaining,
              activeSessionId:
                tab.activeSessionId === request.sourceSessionId
                  ? firstLeaf(remaining).pane.sessionId
                  : tab.activeSessionId
            }
          : tab
      )
    ),
    activeTabId: targetTab.id
  }
}

/** 根据鼠标在目标分屏内的相对位置，判定吸附到哪一侧（就近原则） */
export function resolveDockSide(
  offsetX: number,
  offsetY: number,
  width: number,
  height: number
): DockSide {
  if (width <= 0 || height <= 0) return 'right'
  const left = offsetX / width
  const right = 1 - left
  const top = offsetY / height
  const bottom = 1 - top
  const min = Math.min(left, right, top, bottom)
  if (min === left) return 'left'
  if (min === right) return 'right'
  if (min === top) return 'top'
  return 'bottom'
}

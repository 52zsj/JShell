import type { SessionKind, SessionStatus } from '@shared/types'

export type PaneMode = 'terminal' | 'files'

/** 单个分屏（叶子节点）的状态 */
export interface PaneState {
  sessionId: string
  kind: SessionKind
  mode: PaneMode
  status: SessionStatus
  message?: string
  title: string
  subtitle: string
  hostId?: string
  shellPath?: string
  color?: string
}

export interface LeafNode {
  type: 'leaf'
  /** 与 sessionId 相同，便于按会话快速定位 */
  id: string
  pane: PaneState
}

export interface SplitNode {
  type: 'split'
  id: string
  /** row = 左右并排（垂直分割线），column = 上下堆叠 */
  direction: 'row' | 'column'
  /** 第一个子节点占的空间比例，0.15 ~ 0.85 */
  ratio: number
  children: [PaneNode, PaneNode]
}

export type PaneNode = LeafNode | SplitNode

export const MIN_RATIO = 0.15
export const MAX_RATIO = 0.85

export function leaf(pane: PaneState): LeafNode {
  return { type: 'leaf', id: pane.sessionId, pane }
}

/** 按顺序收集所有叶子节点（用于快捷键在分屏间循环） */
export function leaves(node: PaneNode): LeafNode[] {
  if (node.type === 'leaf') return [node]
  return [...leaves(node.children[0]), ...leaves(node.children[1])]
}

export function countLeaves(node: PaneNode): number {
  return node.type === 'leaf' ? 1 : countLeaves(node.children[0]) + countLeaves(node.children[1])
}

export function firstLeaf(node: PaneNode): LeafNode {
  return node.type === 'leaf' ? node : firstLeaf(node.children[0])
}

export function findLeaf(node: PaneNode, sessionId: string): LeafNode | null {
  if (node.type === 'leaf') return node.pane.sessionId === sessionId ? node : null
  return findLeaf(node.children[0], sessionId) ?? findLeaf(node.children[1], sessionId)
}

export function mapLeaves(node: PaneNode, fn: (leafNode: LeafNode) => LeafNode): PaneNode {
  if (node.type === 'leaf') return fn(node)
  return {
    ...node,
    children: [mapLeaves(node.children[0], fn), mapLeaves(node.children[1], fn)]
  }
}

/** 用新节点替换指定叶子（分屏时用 split 节点替换原叶子） */
export function replaceLeaf(node: PaneNode, sessionId: string, next: PaneNode): PaneNode {
  if (node.type === 'leaf') return node.pane.sessionId === sessionId ? next : node
  return {
    ...node,
    children: [
      replaceLeaf(node.children[0], sessionId, next),
      replaceLeaf(node.children[1], sessionId, next)
    ]
  }
}

/**
 * 移除叶子并在需要时折叠父节点：
 *  - 两个子节点都在 -> 保留 split
 *  - 只剩一个子节点 -> 用该子节点顶替自己（避免出现单分支的 split）
 *  - 全部移除 -> null（调用方据此关闭标签页）
 */
export function removeLeaf(node: PaneNode, sessionId: string): PaneNode | null {
  if (node.type === 'leaf') return node.pane.sessionId === sessionId ? null : node

  const left = removeLeaf(node.children[0], sessionId)
  const right = removeLeaf(node.children[1], sessionId)
  if (!left && !right) return null
  if (!left) return right
  if (!right) return left
  return { ...node, children: [left, right] }
}

export function setSplitRatio(node: PaneNode, splitId: string, ratio: number): PaneNode {
  if (node.type === 'leaf') return node
  if (node.id === splitId) {
    return {
      ...node,
      ratio: Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio))
    }
  }
  return {
    ...node,
    children: [
      setSplitRatio(node.children[0], splitId, ratio),
      setSplitRatio(node.children[1], splitId, ratio)
    ]
  }
}

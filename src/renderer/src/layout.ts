import type { HostProfile, LayoutLeafPane, LayoutNode, PersistedTab } from '@shared/types'
import { leaf, type LeafNode, type PaneNode, type PaneState } from './pane-tree'

/**
 * 布局序列化 / 恢复。
 *
 * 只持久化「怎么连」（kind + hostId / shellPath）与分屏结构，
 * **不持久化运行态**（不自动重连、不恢复终端内容）。恢复出来的分屏状态是 closed，
 * 由用户点「重新连接」再建立会话——这样不会在启动时把几十台机器同时连上。
 */

interface SerializableTab {
  id: string
  root: PaneNode
}

function serializeNode(node: PaneNode): LayoutNode {
  if (node.type === 'leaf') {
    // 只写入有值的字段，避免出现 `shellPath: undefined` 这种噪声
    const pane: LayoutLeafPane = { kind: node.pane.kind }
    if (node.pane.hostId) pane.hostId = node.pane.hostId
    if (node.pane.shellPath) pane.shellPath = node.pane.shellPath
    return { type: 'leaf', pane }
  }
  return {
    type: 'split',
    direction: node.direction,
    ratio: node.ratio,
    children: [serializeNode(node.children[0]), serializeNode(node.children[1])]
  }
}

export function serializeTabs(tabs: SerializableTab[]): PersistedTab[] {
  return tabs.map((tab) => ({ id: tab.id, root: serializeNode(tab.root) }))
}

export interface RestoredTab {
  id: string
  root: PaneNode
  activeSessionId: string
}

function shellName(shellPath?: string): string {
  if (!shellPath) return '终端'
  const base = shellPath.split(/[\\/]/).pop() ?? '终端'
  return base.replace(/\.exe$/i, '')
}

/**
 * 恢复布局。主机已被删除（或本地 shell 路径失效）的分屏会被丢弃；
 * 整棵子树都失效时该标签页不恢复。
 */
export function restoreTabs(
  layout: PersistedTab[],
  hosts: HostProfile[],
  makeId: () => string
): RestoredTab[] {
  const buildPane = (kind: 'ssh' | 'local', hostId?: string, shellPath?: string): PaneState | null => {
    const sessionId = makeId()
    if (kind === 'ssh') {
      const host = hosts.find((item) => item.id === hostId)
      if (!host) return null
      return {
        sessionId,
        kind,
        mode: 'terminal',
        status: 'closed',
        message: '上次会话已结束，点击「重新连接」恢复',
        title: host.name || host.host,
        subtitle: `${host.username}@${host.host}:${host.port}`,
        hostId,
        color: host.color
      }
    }
    return {
      sessionId,
      kind,
      mode: 'terminal',
      status: 'closed',
      message: '上次会话已结束，点击「重新连接」恢复',
      title: shellName(shellPath),
      subtitle: '本地终端',
      shellPath
    }
  }

  const buildNode = (node: LayoutNode): PaneNode | null => {
    if (node.type === 'leaf') {
      const pane = buildPane(node.pane.kind, node.pane.hostId, node.pane.shellPath)
      return pane ? leaf(pane) : null
    }
    const left = buildNode(node.children[0])
    const right = buildNode(node.children[1])
    if (!left) return right
    if (!right) return left
    return {
      type: 'split',
      id: makeId(),
      direction: node.direction,
      ratio: node.ratio,
      children: [left, right]
    }
  }

  const result: RestoredTab[] = []
  for (const tab of layout) {
    const root = buildNode(tab.root)
    if (!root) continue
    result.push({ id: tab.id, root, activeSessionId: leftmost(root).pane.sessionId })
  }
  return result
}

function leftmost(node: PaneNode): LeafNode {
  return node.type === 'leaf' ? node : leftmost(node.children[0])
}

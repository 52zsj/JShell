import type { LayoutNode, LayoutLeafPane, PersistedTab } from './types'

const MAX_TABS = 30
const MAX_DEPTH = 8
const MAX_LEAVES = 64
const MIN_RATIO = 0.15
const MAX_RATIO = 0.85

interface Budget {
  depth: number
  leaves: number
}

function sanitizeLeaf(value: unknown): LayoutLeafPane | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  if (raw.kind !== 'ssh' && raw.kind !== 'local') return null
  const leaf: LayoutLeafPane = { kind: raw.kind }
  if (typeof raw.hostId === 'string' && raw.hostId) leaf.hostId = raw.hostId.slice(0, 80)
  if (typeof raw.shellPath === 'string' && raw.shellPath) leaf.shellPath = raw.shellPath.slice(0, 500)
  return leaf
}

function sanitizeNode(value: unknown, budget: Budget): LayoutNode | null {
  if (!value || typeof value !== 'object') return null
  if (budget.depth > MAX_DEPTH || budget.leaves >= MAX_LEAVES) return null
  const raw = value as Record<string, unknown>

  if (raw.type === 'leaf') {
    const pane = sanitizeLeaf(raw.pane)
    if (!pane) return null
    budget.leaves += 1
    return { type: 'leaf', pane }
  }

  if (raw.type === 'split') {
    if (!Array.isArray(raw.children) || raw.children.length !== 2) return null
    const direction = raw.direction === 'column' ? 'column' : 'row'
    const ratioValue = typeof raw.ratio === 'number' ? raw.ratio : 0.5
    const ratio = Math.min(MAX_RATIO, Math.max(MIN_RATIO, Number.isFinite(ratioValue) ? ratioValue : 0.5))
    budget.depth += 1
    const left = sanitizeNode(raw.children[0], budget)
    const right = sanitizeNode(raw.children[1], budget)
    budget.depth -= 1
    if (!left) return right
    if (!right) return left
    return { type: 'split', direction, ratio, children: [left, right] }
  }

  return null
}

/** 校验并修正持久化布局；无法修复的整棵子树会被丢弃，绝不让坏数据进入渲染层 */
export function sanitizeLayout(input: unknown): PersistedTab[] {
  if (!Array.isArray(input)) return []
  const tabs: PersistedTab[] = []
  for (const item of input.slice(0, MAX_TABS)) {
    if (!item || typeof item !== 'object') continue
    const raw = item as Record<string, unknown>
    if (typeof raw.id !== 'string' || !raw.id) continue
    const root = sanitizeNode(raw.root, { depth: 0, leaves: 0 })
    if (!root) continue
    tabs.push({ id: raw.id.slice(0, 80), root })
  }
  return tabs
}

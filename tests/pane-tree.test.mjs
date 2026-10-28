import test from 'node:test'
import assert from 'node:assert/strict'
import {
  leaf,
  leaves,
  countLeaves,
  firstLeaf,
  findLeaf,
  replaceLeaf,
  removeLeaf,
  setSplitRatio,
  MIN_RATIO,
  MAX_RATIO
} from '../src/renderer/src/pane-tree.ts'

const pane = (id, extra = {}) => ({
  sessionId: id,
  kind: 'local',
  mode: 'terminal',
  status: 'ready',
  title: id,
  subtitle: id,
  ...extra
})

let seq = 0
const split = (children, direction = 'row', ratio = 0.5) => ({
  type: 'split',
  id: 'split-' + (seq += 1),
  direction,
  ratio,
  children
})

test('replaceLeaf 会把目标叶子包进新的 split', () => {
  const a = leaf(pane('a'))
  const root = replaceLeaf(a, 'a', split([a, leaf(pane('b'))]))
  assert.equal(countLeaves(root), 2)
  assert.deepEqual(
    leaves(root).map((n) => n.pane.sessionId),
    ['a', 'b']
  )
})

test('removeLeaf 后只剩一个子节点时自动折叠', () => {
  const a = leaf(pane('a'))
  const b = leaf(pane('b'))
  const result = removeLeaf(split([a, b]), 'b')
  assert.equal(result.type, 'leaf')
  assert.equal(result.pane.sessionId, 'a')
})

test('removeLeaf 删掉唯一叶子时返回 null', () => {
  assert.equal(removeLeaf(leaf(pane('a')), 'a'), null)
})

test('嵌套 split 的叶子顺序 = 深度优先', () => {
  const a = leaf(pane('a'))
  const b = leaf(pane('b'))
  const c = leaf(pane('c'))
  const root = split([a, split([b, c], 'column')])
  assert.deepEqual(
    leaves(root).map((n) => n.pane.sessionId),
    ['a', 'b', 'c']
  )
  assert.equal(firstLeaf(root).pane.sessionId, 'a')
})

test('setSplitRatio 会夹到 0.15~0.85，且不改动原对象', () => {
  const a = leaf(pane('a'))
  const b = leaf(pane('b'))
  const root = split([a, b])
  assert.equal(setSplitRatio(root, root.id, 0.01).ratio, MIN_RATIO)
  assert.equal(setSplitRatio(root, root.id, 0.99).ratio, MAX_RATIO)
  assert.equal(setSplitRatio(root, root.id, 0.42).ratio, 0.42)
  assert.equal(root.ratio, 0.5, '原对象不应被修改')
})

test('findLeaf 找不到时返回 null', () => {
  const root = split([leaf(pane('a')), leaf(pane('b'))])
  assert.equal(findLeaf(root, 'zzz'), null)
  assert.equal(findLeaf(root, 'b')?.pane.sessionId, 'b')
})

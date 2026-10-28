import test from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeLayout } from '../src/shared/layout-schema.ts'

const leaf = (kind = 'local') => ({ type: 'leaf', pane: { kind, shellPath: '/bin/zsh' } })

test('合法布局原样保留', () => {
  const layout = [{ id: 't1', root: { type: 'split', direction: 'row', ratio: 0.4, children: [leaf(), leaf('ssh')] } }]
  const result = sanitizeLayout(layout)
  assert.equal(result.length, 1)
  assert.equal(result[0].root.type, 'split')
  assert.equal(result[0].root.children.length, 2)
})

test('比例被夹取，方向回落到 row', () => {
  const result = sanitizeLayout([
    { id: 't1', root: { type: 'split', direction: 'weird', ratio: 9, children: [leaf(), leaf()] } }
  ])
  assert.equal(result[0].root.direction, 'row')
  assert.equal(result[0].root.ratio, 0.85)
})

test('坏 children 被丢弃，不抛异常', () => {
  assert.deepEqual(sanitizeLayout([{ id: 't1', root: { type: 'split', children: [] } }]), [])
  assert.deepEqual(sanitizeLayout([{ id: 't1', root: { type: 'split', children: [leaf()] } }]), [])
  assert.deepEqual(sanitizeLayout('bad'), [])
})

test('单侧失效时折叠为另一侧', () => {
  const result = sanitizeLayout([
    { id: 't1', root: { type: 'split', children: [leaf(), { type: 'leaf', pane: { kind: 'bad' } }] } }
  ])
  assert.equal(result[0].root.type, 'leaf')
})

test('超深嵌套被截断而不是栈溢出', () => {
  let node = leaf()
  for (let i = 0; i < 40; i += 1) {
    node = { type: 'split', direction: 'row', ratio: 0.5, children: [node, leaf()] }
  }
  const result = sanitizeLayout([{ id: 't1', root: node }])
  assert.equal(result.length, 1)
})

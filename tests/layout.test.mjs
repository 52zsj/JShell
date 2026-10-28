import test from 'node:test'
import assert from 'node:assert/strict'
import { leaf } from '../src/renderer/src/pane-tree.ts'
import { restoreTabs, serializeTabs } from '../src/renderer/src/layout.ts'

const host = {
  id: 'h1',
  name: 'prod-web',
  host: '10.0.0.1',
  port: 22,
  username: 'deploy',
  authType: 'key',
  createdAt: 1,
  updatedAt: 1
}

const pane = (overrides) => ({
  sessionId: 's1',
  kind: 'ssh',
  mode: 'terminal',
  status: 'ready',
  title: 'prod-web',
  subtitle: 'deploy@10.0.0.1:22',
  hostId: 'h1',
  ...overrides
})

let seq = 0
const makeId = () => 'id-' + (seq += 1)

test('serializeTabs 只保留连接参数，丢弃运行时状态', () => {
  const tabs = [
    {
      id: 't1',
      root: {
        type: 'split',
        id: 'sp1',
        direction: 'row',
        ratio: 0.35,
        children: [leaf(pane({})), leaf(pane({ sessionId: 's2', hostId: 'h1' }))]
      }
    }
  ]
  const out = serializeTabs(tabs)
  assert.equal(out.length, 1)
  assert.equal(out[0].root.type, 'split')
  assert.equal(out[0].root.ratio, 0.35)
  assert.deepEqual(out[0].root.children[0], { type: 'leaf', pane: { kind: 'ssh', hostId: 'h1' } })
  // 不应包含 sessionId / status / title 等运行态字段
  assert.equal('sessionId' in out[0].root.children[0], false)
})

test('restoreTabs 还原结构与比例，状态是 closed（不自动重连）', () => {
  const layout = [
    {
      id: 't1',
      root: {
        type: 'split',
        direction: 'column',
        ratio: 0.4,
        children: [
          { type: 'leaf', pane: { kind: 'ssh', hostId: 'h1' } },
          { type: 'leaf', pane: { kind: 'local', shellPath: '/bin/zsh' } }
        ]
      }
    }
  ]
  const restored = restoreTabs(layout, [host], makeId)
  assert.equal(restored.length, 1)
  const root = restored[0].root
  assert.equal(root.direction, 'column')
  assert.equal(root.ratio, 0.4)
  assert.equal(root.children[0].pane.status, 'closed')
  assert.equal(root.children[0].pane.title, 'prod-web')
  assert.equal(root.children[0].pane.subtitle, 'deploy@10.0.0.1:22')
  assert.equal(root.children[1].pane.title, 'zsh')
  assert.equal(root.children[1].pane.kind, 'local')
  assert.equal(restored[0].activeSessionId, root.children[0].pane.sessionId)
})

test('主机已被删除时丢弃对应叶子，整树失效则整个标签不恢复', () => {
  const mixed = [
    {
      id: 't1',
      root: {
        type: 'split',
        direction: 'row',
        ratio: 0.5,
        children: [
          { type: 'leaf', pane: { kind: 'ssh', hostId: 'deleted' } },
          { type: 'leaf', pane: { kind: 'local', shellPath: '/bin/bash' } }
        ]
      }
    }
  ]
  const restored = restoreTabs(mixed, [host], makeId)
  assert.equal(restored.length, 1)
  assert.equal(restored[0].root.type, 'leaf', '只剩一个叶子时自动折叠')
  assert.equal(restored[0].root.pane.kind, 'local')

  const gone = [{ id: 't2', root: { type: 'leaf', pane: { kind: 'ssh', hostId: 'deleted' } } }]
  assert.deepEqual(restoreTabs(gone, [host], makeId), [])
})

test('序列化 → 恢复 → 再序列化 结构稳定（往返一致）', () => {
  const tabs = [
    {
      id: 't1',
      root: {
        type: 'split',
        id: 'sp',
        direction: 'row',
        ratio: 0.6,
        children: [
          leaf(pane({})),
          {
            type: 'split',
            id: 'sp2',
            direction: 'column',
            ratio: 0.3,
            children: [leaf(pane({ sessionId: 's2' })), leaf(pane({ sessionId: 's3' }))]
          }
        ]
      }
    }
  ]
  const once = serializeTabs(tabs)
  const restored = restoreTabs(once, [host], makeId)
  const twice = serializeTabs(restored)
  assert.deepEqual(twice, once)
})

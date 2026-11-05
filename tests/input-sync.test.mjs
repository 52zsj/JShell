import assert from 'node:assert/strict'
import test from 'node:test'
import {
  activeSyncSessions,
  broadcastInput,
  syncTargets
} from '../src/renderer/src/input-sync.ts'

/** 造一个单分屏标签 */
function tab(id, sessionId, status = 'ready', title = id) {
  return {
    id,
    activeSessionId: sessionId,
    root: {
      type: 'leaf',
      id: sessionId,
      pane: {
        sessionId,
        kind: 'local',
        mode: 'terminal',
        status,
        title,
        subtitle: '/bin/zsh'
      }
    }
  }
}

/** 造一个「左右分屏」的标签，active 指向右半边 */
function splitTab(id, leftSession, rightSession, status = 'ready') {
  return {
    id,
    activeSessionId: rightSession,
    root: {
      type: 'split',
      id: 'split-1',
      direction: 'row',
      ratio: 0.5,
      children: [
        {
          type: 'leaf',
          id: leftSession,
          pane: {
            sessionId: leftSession,
            kind: 'local',
            mode: 'terminal',
            status,
            title: leftSession,
            subtitle: ''
          }
        },
        {
          type: 'leaf',
          id: rightSession,
          pane: {
            sessionId: rightSession,
            kind: 'local',
            mode: 'terminal',
            status,
            title: rightSession,
            subtitle: ''
          }
        }
      ]
    }
  }
}

const tabs = [tab('t1', 's1'), tab('t2', 's2'), tab('t3', 's3')]

test('不选 = 全部：空选择时所有标签都参与', () => {
  const targets = syncTargets(tabs, [])
  assert.equal(targets.length, 3)
  assert.deepEqual(
    targets.map((t) => t.selected),
    [true, true, true]
  )
})

test('选了就只作用于选中的标签', () => {
  const targets = syncTargets(tabs, ['t1', 't3'])
  assert.deepEqual(
    targets.map((t) => t.tabId),
    ['t1', 't2', 't3']
  )
  assert.deepEqual(
    targets.map((t) => t.selected),
    [true, false, true]
  )
  assert.deepEqual(activeSyncSessions(targets, 's2'), ['s1', 's3'])
})

test('序号与 Ctrl+1..9 对齐（1 起）', () => {
  assert.deepEqual(
    syncTargets(tabs, []).map((t) => t.index),
    [1, 2, 3]
  )
})

test('只发给 ready 的会话：连接中 / 已断开自动跳过', () => {
  const mixed = [tab('t1', 's1', 'ready'), tab('t2', 's2', 'connecting'), tab('t3', 's3', 'closed')]
  const targets = syncTargets(mixed, [])
  assert.deepEqual(
    targets.map((t) => t.ready),
    [true, false, false]
  )
  // 以 s1 为来源时，没有别的可用目标
  assert.deepEqual(activeSyncSessions(targets, 's1'), [])
})

test('绝不发给输入来源自己（否则同一个字符会被写两次）', () => {
  const targets = syncTargets(tabs, [])
  assert.deepEqual(activeSyncSessions(targets, 's1'), ['s2', 's3'])
  assert.deepEqual(activeSyncSessions(targets, 's2'), ['s1', 's3'])
})

test('分屏标签取当前聚焦的那个分屏', () => {
  const split = [splitTab('t1', 'left', 'right'), tab('t2', 's2')]
  const targets = syncTargets(split, [])
  assert.equal(targets[0].sessionId, 'right')
  // 在 s2 里输入 → 只发给 t1 当前聚焦的 right
  assert.deepEqual(activeSyncSessions(targets, 's2'), ['right'])
})

test('同一个会话只写一次', () => {
  const dup = [tab('t1', 's1'), tab('t2', 's1'), tab('t3', 's3')]
  const targets = syncTargets(dup, [])
  const sessions = activeSyncSessions(targets, 's3')
  assert.deepEqual(sessions, ['s1'])
})

test('未开启时什么都不写', () => {
  const written = []
  const count = broadcastInput('s1', 'ls\r', { enabled: false, tabs, selected: [] }, (id, data) =>
    written.push([id, data])
  )
  assert.equal(count, 0)
  assert.deepEqual(written, [])
})

test('开启后：把同一份输入写给其余选中的、ready 的终端', () => {
  const written = []
  const count = broadcastInput('s1', 'ls -l\r', { enabled: true, tabs, selected: [] }, (id, data) =>
    written.push([id, data])
  )
  assert.equal(count, 2)
  assert.deepEqual(written, [
    ['s2', 'ls -l\r'],
    ['s3', 'ls -l\r']
  ])
})

test('开启但只选了别的标签时，不发给未选中的', () => {
  const written = []
  const count = broadcastInput(
    's1',
    'pwd\r',
    { enabled: true, tabs, selected: ['t2'] },
    (id, data) => written.push([id, data])
  )
  assert.equal(count, 1)
  assert.deepEqual(written, [['s2', 'pwd\r']])
})

test('空输入不触发写入（避免无意义 IPC）', () => {
  const written = []
  const count = broadcastInput('s1', '', { enabled: true, tabs, selected: [] }, (id, data) =>
    written.push([id, data])
  )
  assert.equal(count, 0)
  assert.deepEqual(written, [])
})

test('只有一个终端时开启无害（不写、不报错）', () => {
  const only = [tab('t1', 's1')]
  const written = []
  const count = broadcastInput('s1', 'x', { enabled: true, tabs: only, selected: [] }, (id, d) =>
    written.push([id, d])
  )
  assert.equal(count, 0)
  assert.deepEqual(written, [])
})

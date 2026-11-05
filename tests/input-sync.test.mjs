import assert from 'node:assert/strict'
import test from 'node:test'
import {
  activeSyncSessions,
  broadcastInput,
  syncTargets,
  syncingPaneCount,
  tabSessionIds,
  targetLabel
} from '../src/renderer/src/input-sync.ts'

function paneState(sessionId, status = 'ready', title = sessionId) {
  return {
    sessionId,
    kind: 'local',
    mode: 'terminal',
    status,
    title,
    subtitle: ''
  }
}

/** 单分屏标签 */
function tab(id, sessionId, status = 'ready', title = id) {
  return {
    id,
    activeSessionId: sessionId,
    root: { type: 'leaf', id: sessionId, pane: paneState(sessionId, status, title) }
  }
}

/** 多分屏标签：左右两块，active 指向第二块（模拟用户正看着右边） */
function splitTab(id, sessions, activeIndex = 1, status = 'ready') {
  // 分屏是**二叉树**（SplitNode.children 恒为两个），三块以上要嵌套着搭
  const nodes = sessions.map((s) => ({ type: 'leaf', id: s, pane: paneState(s, status) }))
  let root = nodes[0]
  for (let i = 1; i < nodes.length; i += 1) {
    root = {
      type: 'split',
      id: `${id}-split-${i}`,
      direction: 'row',
      ratio: 0.5,
      children: [root, nodes[i]]
    }
  }
  return { id, activeSessionId: sessions[activeIndex], root }
}

const tabs = [tab('t1', 's1'), tab('t2', 's2'), tab('t3', 's3')]

// ---------------------------------------------------------------- 多标签

test('不选 = 全部：空选择时所有标签的所有分屏都参与', () => {
  const targets = syncTargets(tabs, [])
  assert.equal(targets.length, 3)
  assert.deepEqual(targets.map((t) => t.selected), [true, true, true])
})

test('选了就只作用于选中的会话', () => {
  const targets = syncTargets(tabs, ['s1', 's3'])
  assert.deepEqual(targets.map((t) => t.selected), [true, false, true])
  assert.deepEqual(activeSyncSessions(targets, 's2'), ['s1', 's3'])
})

test('单分屏标签的序号就是标签序号（1 起，与 Ctrl+1..9 对齐）', () => {
  const targets = syncTargets(tabs, [])
  assert.deepEqual(targets.map((t) => targetLabel(t)), ['1', '2', '3'])
  assert.deepEqual(targets.map((t) => t.tabIndex), [1, 2, 3])
})

// ---------------------------------------------------------------- 多分屏（本次重点）

test('多分屏标签：每个分屏都单独参与，不是只取当前聚焦的那个', () => {
  const mixed = [splitTab('t1', ['a', 'b']), tab('t2', 'c')]
  const targets = syncTargets(mixed, [])
  assert.deepEqual(targets.map((t) => t.sessionId), ['a', 'b', 'c'])
  // 旧实现只看 activeSessionId（这里指向 b），a 会被漏掉
  assert.deepEqual(activeSyncSessions(targets, 'c'), ['a', 'b'])
})

test('多分屏的序号是「标签.分屏」', () => {
  const mixed = [splitTab('t1', ['a', 'b']), tab('t2', 'c'), splitTab('t3', ['d', 'e', 'f'])]
  assert.deepEqual(syncTargets(mixed, []).map((t) => targetLabel(t)), ['1.1', '1.2', '2', '3.1', '3.2', '3.3'])
})

test('多分屏里只勾一个：只发给那一个', () => {
  const mixed = [splitTab('t1', ['a', 'b']), tab('t2', 'c')]
  const targets = syncTargets(mixed, ['c', 'b'])
  assert.deepEqual(activeSyncSessions(targets, 'c'), ['b'])
})

test('在分屏标签内部输入：同一标签的另一个分屏也会收到', () => {
  const mixed = [splitTab('t1', ['a', 'b'])]
  const written = []
  const count = broadcastInput('a', 'ls\r', { enabled: true, tabs: mixed, selected: [] }, (id, data) =>
    written.push([id, data])
  )
  assert.equal(count, 1)
  assert.deepEqual(written, [['b', 'ls\r']])
})

test('syncingPaneCount 按标签统计参与广播的分屏数', () => {
  const mixed = [splitTab('t1', ['a', 'b']), tab('t2', 'c')]
  const targets = syncTargets(mixed, [])
  assert.equal(syncingPaneCount(targets, 't1'), 2)
  assert.equal(syncingPaneCount(targets, 't2'), 1)
  // 关掉 b 之后 t1 只剩 1 个
  assert.equal(syncingPaneCount(syncTargets(mixed, ['a', 'c']), 't1'), 1)
})

// ---------------------------------------------------------------- 连接状态

test('只发给 ready 的会话：连接中 / 已断开自动跳过', () => {
  const mixed = [tab('t1', 's1', 'ready'), tab('t2', 's2', 'connecting'), tab('t3', 's3', 'closed')]
  const targets = syncTargets(mixed, [])
  assert.deepEqual(targets.map((t) => t.ready), [true, false, false])
  assert.deepEqual(activeSyncSessions(targets, 's1'), [])
})

test('多分屏里断开的那一块不会被写入', () => {
  const mixed = [
    {
      id: 't1',
      activeSessionId: 'a',
      root: {
        type: 'split',
        id: 'sp',
        direction: 'row',
        ratio: 0.5,
        children: [
          { type: 'leaf', id: 'a', pane: paneState('a', 'ready') },
          { type: 'leaf', id: 'b', pane: paneState('b', 'closed') }
        ]
      }
    }
  ]
  const targets = syncTargets(mixed, [])
  assert.deepEqual(activeSyncSessions(targets, 'a'), [])
})

test('绝不发给输入来源自己（否则同一个字符会被写两次）', () => {
  const targets = syncTargets(tabs, [])
  assert.deepEqual(activeSyncSessions(targets, 's1'), ['s2', 's3'])
  assert.deepEqual(activeSyncSessions(targets, 's2'), ['s1', 's3'])
})

test('同一个会话只写一次', () => {
  const dup = [tab('t1', 's1'), tab('t2', 's1'), tab('t3', 's3')]
  assert.deepEqual(activeSyncSessions(syncTargets(dup, []), 's3'), ['s1'])
})

// ---------------------------------------------------------------- 广播

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

test('开启但只选了别的会话时，不发给未选中的', () => {
  const written = []
  const count = broadcastInput('s1', 'pwd\r', { enabled: true, tabs, selected: ['s2'] }, (id, data) =>
    written.push([id, data])
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

// ---------------------------------------------------------------- 快捷键「只对当前标签」

test('tabSessionIds 返回该标签下所有分屏的会话（快捷关键用来锁范围）', () => {
  const mixed = [splitTab('t1', ['a', 'b']), tab('t2', 'c')]
  assert.deepEqual(tabSessionIds(mixed, 't1'), ['a', 'b'])
  assert.deepEqual(tabSessionIds(mixed, 't2'), ['c'])
  assert.deepEqual(tabSessionIds(mixed, 'nope'), [])
  assert.deepEqual(tabSessionIds(mixed, null), [])
})

test('锁在单个标签时的广播效果：同标签分屏互发，跨标签不受影响', () => {
  const mixed = [splitTab('t1', ['a', 'b']), tab('t2', 'c')]
  const scope = tabSessionIds(mixed, 't1')
  const written = []
  const count = broadcastInput('a', 'ls\r', { enabled: true, tabs: mixed, selected: scope }, (id, d) =>
    written.push([id, d])
  )
  assert.equal(count, 1)
  assert.deepEqual(written, [['b', 'ls\r']])
})

test('单分屏标签锁范围时没有可写目标（调用方要给用户提示）', () => {
  const mixed = [tab('t1', 'a'), tab('t2', 'b')]
  const scope = tabSessionIds(mixed, 't1')
  assert.equal(activeSyncSessions(syncTargets(mixed, scope), 'a').length, 0)
})

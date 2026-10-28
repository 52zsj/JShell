import test from 'node:test'
import assert from 'node:assert/strict'
import { leaf } from '../src/renderer/src/pane-tree.ts'
import { dockTabs, insertBeside, resolveDockSide, sideToDirection } from '../src/renderer/src/pane-dock.ts'

const pane = (id) => ({
  sessionId: id,
  kind: 'local',
  mode: 'terminal',
  status: 'ready',
  title: id,
  subtitle: id
})

const tab = (id, sessionIds) => {
  let root = leaf(pane(sessionIds[0]))
  for (const sid of sessionIds.slice(1)) {
    root = {
      type: 'split',
      id: 's-' + sid,
      direction: 'row',
      ratio: 0.5,
      children: [root, leaf(pane(sid))]
    }
  }
  return { id, root, activeSessionId: sessionIds[0] }
}

let n = 0
const nextId = () => 'generated-' + (n += 1)

test('sideToDirection：左右为 row，上下为 column', () => {
  assert.equal(sideToDirection('left'), 'row')
  assert.equal(sideToDirection('right'), 'row')
  assert.equal(sideToDirection('top'), 'column')
  assert.equal(sideToDirection('bottom'), 'column')
})

test('insertBeside：插到右侧时顺序为 [目标, 新节点]', () => {
  const root = leaf(pane('a'))
  const inserted = insertBeside(root, 'a', leaf(pane('b')), 'right', 'x')
  assert.equal(inserted.type, 'split')
  assert.equal(inserted.direction, 'row')
  assert.equal(inserted.children[0].pane.sessionId, 'a')
  assert.equal(inserted.children[1].pane.sessionId, 'b')
})

test('insertBeside：插到顶部时顺序为 [新节点, 目标] 且为纵向', () => {
  const root = leaf(pane('a'))
  const inserted = insertBeside(root, 'a', leaf(pane('b')), 'top', 'x')
  assert.equal(inserted.direction, 'column')
  assert.equal(inserted.children[0].pane.sessionId, 'b')
  assert.equal(inserted.children[1].pane.sessionId, 'a')
})

test('整标签吸附：来源标签消失，目标标签变成两个分屏', () => {
  const tabs = [tab('t1', ['a']), tab('t2', ['b'])]
  const result = dockTabs(
    tabs,
    { sourceTabId: 't2', targetTabId: 't1', targetSessionId: 'a', side: 'right' },
    nextId
  )
  assert.equal(result.tabs.length, 1)
  assert.equal(result.tabs[0].id, 't1')
  assert.equal(result.tabs[0].root.type, 'split')
  assert.equal(result.activeTabId, 't1')
  assert.equal(result.activeSessionId === undefined, true)
})

test('整标签吸附：多分屏标签整体并入（子树保持结构）', () => {
  const tabs = [tab('t1', ['a']), tab('t2', ['b', 'c'])]
  const result = dockTabs(
    tabs,
    { sourceTabId: 't2', targetTabId: 't1', targetSessionId: 'a', side: 'bottom' },
    nextId
  )
  const root = result.tabs[0].root
  assert.equal(root.direction, 'column')
  // 目标在上，来源整体（b|c 的子树）在下
  assert.equal(root.children[0].pane.sessionId, 'a')
  assert.equal(root.children[1].type, 'split')
  assert.equal(result.tabs[0].activeSessionId, 'b', '焦点落到新并入子树的第一片叶子')
})

test('单分屏吸附：来源标签还剩分屏时保留，只剩一个则整个标签移除', () => {
  const tabs = [tab('t1', ['a']), tab('t2', ['b'])]
  const docked = dockTabs(
    tabs,
    { sourceTabId: 't2', sourceSessionId: 'b', targetTabId: 't1', targetSessionId: 'a', side: 'left' },
    nextId
  )
  assert.equal(docked.tabs.length, 1)

  const two = [tab('t1', ['a']), tab('t2', ['b', 'c'])]
  const partial = dockTabs(
    two,
    { sourceTabId: 't2', sourceSessionId: 'b', targetTabId: 't1', targetSessionId: 'a', side: 'right' },
    nextId
  )
  assert.equal(partial.tabs.length, 2)
  assert.equal(partial.tabs[1].root.pane.sessionId, 'c', '来源标签保留剩余分屏')
})

test('同一标签内重排：把 c 拖到 a 的左边', () => {
  const tabs = [tab('t1', ['a', 'b', 'c'])]
  const result = dockTabs(
    tabs,
    { sourceTabId: 't1', sourceSessionId: 'c', targetTabId: 't1', targetSessionId: 'a', side: 'left' },
    nextId
  )
  const root = result.tabs[0].root
  // 语义：a 原来的位置被替换成 (c | a)，因此外层是 ((c|a) | b)
  assert.equal(root.children[0].type, 'split')
  assert.equal(root.children[0].children[0].pane.sessionId, 'c')
  assert.equal(root.children[0].children[1].pane.sessionId, 'a')
  assert.equal(root.children[1].pane.sessionId, 'b')
  assert.equal(result.tabs.length, 1)
})

test('无效拖拽返回 null：落自己、整标签拖自己、目标在来源子树内', () => {
  const tabs = [tab('t1', ['a', 'b']), tab('t2', ['c'])]
  assert.equal(
    dockTabs(tabs, { sourceTabId: 't1', sourceSessionId: 'a', targetTabId: 't1', targetSessionId: 'a', side: 'left' }, nextId),
    null
  )
  assert.equal(
    dockTabs(tabs, { sourceTabId: 't1', targetTabId: 't1', targetSessionId: 'a', side: 'left' }, nextId),
    null
  )
  assert.equal(
    dockTabs(tabs, { sourceTabId: 't2', targetTabId: 't1', targetSessionId: 'missing', side: 'left' }, nextId),
    null
  )
})

test('resolveDockSide 就近判定四个方向', () => {
  assert.equal(resolveDockSide(10, 100, 400, 200), 'left')
  assert.equal(resolveDockSide(390, 100, 400, 200), 'right')
  assert.equal(resolveDockSide(200, 5, 400, 200), 'top')
  assert.equal(resolveDockSide(200, 195, 400, 200), 'bottom')
  assert.equal(resolveDockSide(0, 0, 0, 0), 'right', '零尺寸时回退到 right，不抛错')
})

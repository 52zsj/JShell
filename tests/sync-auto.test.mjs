import test from 'node:test'
import assert from 'node:assert/strict'
import {
  changedCount,
  decidePull,
  decidePushGate,
  isLocalEmpty,
  riskyCount,
  shouldPush,
  summarizeReport
} from '../src/main/services/sync-auto-plan.ts'
import { contentHash } from '../src/main/services/sync-crypto.ts'

function report({ add = 0, update = 0, deleteCount = 0, riskyNewer = 0, riskyDelete = 0 } = {}) {
  return {
    mode: 'overwrite',
    entries: [],
    counts: { add, update, delete: deleteCount, same: 0 },
    risky: { overwriteNewer: riskyNewer, deleteLocal: riskyDelete },
    settingsChanged: false
  }
}

test('指纹与上次一致时跳过：自己写出去的文件不会来回同步', () => {
  const decision = decidePull({
    remoteHash: 'abc',
    lastPulledHash: 'abc',
    report: report({ add: 3 }),
    pauseOnRisky: true
  })
  assert.equal(decision, 'skip')
})

test('内容不同但没有实际变更时只记账', () => {
  const decision = decidePull({
    remoteHash: 'def',
    lastPulledHash: 'abc',
    report: report(),
    pauseOnRisky: true
  })
  assert.equal(decision, 'record')
})

test('有变更且无风险时直接应用', () => {
  const decision = decidePull({
    remoteHash: 'def',
    lastPulledHash: 'abc',
    report: report({ add: 2, update: 1 }),
    pauseOnRisky: true
  })
  assert.equal(decision, 'apply')
})

test('有风险且开启暂停时不动手', () => {
  const decision = decidePull({
    remoteHash: 'def',
    lastPulledHash: 'abc',
    report: report({ update: 1, riskyNewer: 1 }),
    pauseOnRisky: true
  })
  assert.equal(decision, 'pause')
})

test('关闭暂停后等价于直接覆盖', () => {
  const decision = decidePull({
    remoteHash: 'def',
    lastPulledHash: 'abc',
    report: report({ update: 1, deleteCount: 2, riskyNewer: 1, riskyDelete: 2 }),
    pauseOnRisky: false
  })
  assert.equal(decision, 'apply')
})

test('首次同步（没有历史指纹）会正常处理', () => {
  const decision = decidePull({
    remoteHash: 'def',
    lastPulledHash: undefined,
    report: report({ add: 1 }),
    pauseOnRisky: true
  })
  assert.equal(decision, 'apply')
})

test('推送判定：没有历史指纹就推，内容没变就不推', () => {
  assert.equal(shouldPush('h1', undefined), true)
  assert.equal(shouldPush('h1', 'h1'), false)
  assert.equal(shouldPush('h2', 'h1'), true)
})

test('推送判定：远端文件不存在时必须重建（哪怕内容哈希没变）', () => {
  // 用户手动删掉同步位置里的文件后，内容哈希与上次推的一样，
  // 如果只看哈希就会永远不重建——这正是之前「删了文件仍提示一致」的根因
  assert.equal(shouldPush('h1', 'h1', false), true)
  assert.equal(shouldPush('h1', undefined, false), true)
  // 远端还在时行为不变
  assert.equal(shouldPush('h1', 'h1', true), false)
})

test('计数与摘要', () => {
  const risky = report({ add: 1, update: 2, deleteCount: 1, riskyNewer: 2, riskyDelete: 1 })
  assert.equal(changedCount(risky), 4)
  assert.equal(riskyCount(risky), 3)
  const text = summarizeReport(risky)
  assert.match(text, /将应用 4 项变更/)
  assert.match(text, /2 项本机改动较新会被覆盖/)
  assert.match(text, /1 项本机独有条目会被删除/)

  assert.equal(summarizeReport(report()), '已是最新，无需同步')
  assert.equal(summarizeReport(report({ add: 1 })), '将应用 1 项变更')
})

test('内容指纹与键顺序无关，内容变化才变化', () => {
  const a = contentHash({ hosts: [{ id: 'h1', name: 'A' }], snippets: [] })
  const b = contentHash({ snippets: [], hosts: [{ name: 'A', id: 'h1' }] })
  assert.equal(a, b)
  const c = contentHash({ hosts: [{ id: 'h1', name: 'B' }], snippets: [] })
  assert.notEqual(a, c)
  assert.equal(a.length, 64)
})

test('口令对不上时必须先问人，绝不能直接覆盖云端', () => {
  assert.equal(
    decidePushGate({ needPush: true, passwordMismatch: true, password: 'a' }),
    'need-password'
  )
  // 即使没有内容变化要推，也一样要先问
  assert.equal(
    decidePushGate({ needPush: false, passwordMismatch: true, password: 'a' }),
    'need-password'
  )
})

test('云端是明文包而本机有口令：推上去云端会变密文，要先确认', () => {
  assert.equal(
    decidePushGate({
      needPush: true,
      passwordMismatch: false,
      password: 'a',
      remoteEncrypted: false,
      allowPlaintextUpgrade: false
    }),
    'need-plaintext-confirm'
  )
  // 用户确认过就直接推
  assert.equal(
    decidePushGate({
      needPush: true,
      passwordMismatch: false,
      password: 'a',
      remoteEncrypted: false,
      allowPlaintextUpgrade: true
    }),
    'push'
  )
})

test('本机没设口令时云端保持明文，直接推即可', () => {
  assert.equal(
    decidePushGate({
      needPush: true,
      passwordMismatch: false,
      password: undefined,
      remoteEncrypted: false,
      allowPlaintextUpgrade: false
    }),
    'push'
  )
})

test('云端是密文且口令能解开：正常推', () => {
  assert.equal(
    decidePushGate({
      needPush: true,
      passwordMismatch: false,
      password: 'a',
      remoteEncrypted: true,
      allowPlaintextUpgrade: false
    }),
    'push'
  )
})

test('本机空判定：主机/片段/转发规则都没有才算空', () => {
  assert.equal(isLocalEmpty({ hosts: [], snippets: [], tunnels: [] }), true)
  assert.equal(isLocalEmpty({}), true)
  assert.equal(isLocalEmpty({ hosts: [], snippets: [{ id: 's1' }], tunnels: [] }), false)
  assert.equal(isLocalEmpty({ hosts: [{ id: 'h1' }], snippets: [], tunnels: [] }), false)
  assert.equal(isLocalEmpty({ hosts: [], snippets: [], tunnels: [{ id: 't1' }] }), false)
})

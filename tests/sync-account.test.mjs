import assert from 'node:assert/strict'
import test from 'node:test'
import {
  accountsCompatible,
  normalizeAccount
} from '../src/shared/sync.ts'
import { decidePull } from '../src/main/services/sync-auto-plan.ts'

// ---------------------------------------------------------------- 账号 = 唯一的身份

test('账号只做匹配：大小写与首尾空格不敏感', () => {
  assert.equal(normalizeAccount('  Home  '), 'Home')
  assert.equal(normalizeAccount(undefined), '')
  assert.equal(normalizeAccount(123), '')
  assert.equal(accountsCompatible('Home', 'home '), true)
  assert.equal(accountsCompatible('home', 'work'), false)
})

test('任意一侧留空 = 不限制（单机或不想管名字时照常工作）', () => {
  assert.equal(accountsCompatible('', 'home'), true)
  assert.equal(accountsCompatible('home', ''), true)
  assert.equal(accountsCompatible('', ''), true)
})

test('账号长度被截断，避免把超长串写进包里', () => {
  assert.equal(normalizeAccount('a'.repeat(200)).length, 40)
})

// ---------------------------------------------------------------- 拉取决策

const baseReport = { counts: { add: 0, update: 3, delete: 0 }, risky: { overwriteNewer: 0, deleteLocal: 0 } }

test('账号不一致时优先判为 account，即使哈希与上次相同也不碰本机', () => {
  const decision = decidePull({
    remoteHash: 'abc',
    lastPulledHash: 'abc',
    report: baseReport,
    pauseOnRisky: false,
    accountMismatch: true
  })
  assert.equal(decision, 'account')
})

test('账号一致时按原来的规则走（skip / record / apply / pause）', () => {
  assert.equal(
    decidePull({ remoteHash: 'a', lastPulledHash: 'a', report: baseReport, pauseOnRisky: false }),
    'skip'
  )
  assert.equal(
    decidePull({
      remoteHash: 'b',
      report: { counts: { add: 0, update: 0, delete: 0 }, risky: { overwriteNewer: 0, deleteLocal: 0 } },
      pauseOnRisky: false
    }),
    'record'
  )
  assert.equal(decidePull({ remoteHash: 'b', report: baseReport, pauseOnRisky: false }), 'apply')
  assert.equal(
    decidePull({
      remoteHash: 'b',
      report: { ...baseReport, risky: { overwriteNewer: 1, deleteLocal: 0 } },
      pauseOnRisky: true
    }),
    'pause'
  )
})

test('账号不一致且本机是空配置：仍然拒绝应用（防止把别人的配置灌进来）', () => {
  const decision = decidePull({
    remoteHash: 'x',
    report: { counts: { add: 20, update: 0, delete: 0 }, risky: { overwriteNewer: 0, deleteLocal: 0 } },
    pauseOnRisky: true,
    accountMismatch: true
  })
  assert.equal(decision, 'account')
})

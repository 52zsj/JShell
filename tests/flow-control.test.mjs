import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_HIGH, DEFAULT_LOW, FlowControl } from '../src/main/services/flow-control.ts'

function make(options) {
  const calls = { pause: 0, resume: 0, stall: 0 }
  const fc = new FlowControl(
    {
      pause: () => calls.pause++,
      resume: () => calls.resume++
    },
    { ...options, onStall: () => calls.stall++ }
  )
  return { fc, calls }
}

test('未超过高水位不暂停', () => {
  const { fc, calls } = make()
  fc.onOutput(DEFAULT_HIGH - 1)
  assert.equal(fc.isPaused, false)
  assert.equal(calls.pause, 0)
})

test('超过高水位暂停一次（重复输出不会重复调用）', () => {
  const { fc, calls } = make()
  fc.onOutput(DEFAULT_HIGH)
  fc.onOutput(1024)
  fc.onOutput(1024)
  assert.equal(fc.isPaused, true)
  assert.equal(calls.pause, 1)
})

test('ack 回落到低水位以下才恢复', () => {
  const { fc, calls } = make()
  fc.onOutput(DEFAULT_HIGH)
  assert.equal(fc.isPaused, true)

  // 只回执一部分，仍在低水位之上，不恢复
  fc.onAck(DEFAULT_HIGH - DEFAULT_LOW - 1)
  assert.equal(fc.isPaused, true)
  assert.equal(calls.resume, 0)

  fc.onAck(2)
  assert.equal(fc.isPaused, false)
  assert.equal(calls.resume, 1)
})

test('ack 多于未确认数时不会记成负数', () => {
  const { fc } = make()
  fc.onOutput(100)
  fc.onAck(1000)
  assert.equal(fc.pending, 0)
})

test('看门狗：未到阈值不动作，超时后强制恢复并清零', () => {
  const { fc, calls } = make({ stallMs: 1000 })
  fc.onOutput(DEFAULT_HIGH)
  assert.equal(fc.isPaused, true)

  const base = Date.now()
  fc.onOutput(0) // 保持接口一致性，时间由 tick 注入
  assert.equal(fc.tick(base + 500), false)
  assert.equal(calls.resume, 0)

  assert.equal(fc.tick(base + 1500), true)
  assert.equal(fc.isPaused, false)
  assert.equal(fc.pending, 0)
  assert.equal(calls.resume, 1)
  assert.equal(calls.stall, 1)
})

test('ack 会重置看门狗计时，正常回执不会被误判为卡死', () => {
  const { fc, calls } = make({ stallMs: 1000 })
  const t0 = 10_000
  fc.onOutput(DEFAULT_HIGH, t0)

  // 每 900ms 有一次回执（都没降到低水位），刚好处在阈值内，不应触发看门狗
  fc.onAck(1, t0 + 900)
  assert.equal(fc.tick(t0 + 1200), false)
  fc.onAck(1, t0 + 1800)
  assert.equal(fc.tick(t0 + 2400), false)
  // 真正断了回执：超过 stallMs 才恢复
  assert.equal(fc.tick(t0 + 2900), true)
  assert.equal(calls.resume, 1)
})

test('暂停状态下继续 onOutput 不重复暂停，恢复后再次越线会重新暂停', () => {
  const { fc, calls } = make()
  fc.onOutput(DEFAULT_HIGH)
  fc.onOutput(DEFAULT_HIGH)
  assert.equal(calls.pause, 1)

  fc.onAck(DEFAULT_HIGH * 2)
  assert.equal(calls.resume, 1)

  fc.onOutput(DEFAULT_HIGH)
  assert.equal(calls.pause, 2)
})

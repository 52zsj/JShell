import test from 'node:test'
import assert from 'node:assert/strict'
import { reconnectDelay, shouldAutoReconnect } from '../src/renderer/src/reconnect-policy.ts'

const MAX = 5

test('用户主动退出（exit / 关终端）绝不自动重连', () => {
  assert.equal(shouldAutoReconnect('closed', 'user-exit', 0, MAX), false)
})

test('认证失败不重连（重试只会反复失败）', () => {
  assert.equal(shouldAutoReconnect('error', 'auth', 0, MAX), false)
})

test('主机指纹变更不重连（必须人工确认）', () => {
  assert.equal(shouldAutoReconnect('error', 'hostkey', 0, MAX), false)
})

test('网络断开会自动重连', () => {
  assert.equal(shouldAutoReconnect('closed', 'network', 0, MAX), true)
  assert.equal(shouldAutoReconnect('error', 'network', 0, MAX), true)
})

test('原因未知时保守重连（总比只能手动点好）', () => {
  assert.equal(shouldAutoReconnect('closed', undefined, 0, MAX), true)
  assert.equal(shouldAutoReconnect('error', 'unknown', 2, MAX), true)
})

test('连接中/已连接状态不触发重连', () => {
  assert.equal(shouldAutoReconnect('connecting', 'network', 0, MAX), false)
  assert.equal(shouldAutoReconnect('ready', undefined, 0, MAX), false)
})

test('重试次数用完就不再自动重连', () => {
  assert.equal(shouldAutoReconnect('closed', 'network', MAX - 1, MAX), true)
  assert.equal(shouldAutoReconnect('closed', 'network', MAX, MAX), false)
})

test('退避间隔：1s → 2s → 4s → 8s → 8s，超出取最后一档', () => {
  const delays = [1000, 2000, 4000, 8000, 8000]
  assert.equal(reconnectDelay(delays, 0), 1000)
  assert.equal(reconnectDelay(delays, 1), 2000)
  assert.equal(reconnectDelay(delays, 2), 4000)
  assert.equal(reconnectDelay(delays, 3), 8000)
  assert.equal(reconnectDelay(delays, 4), 8000)
  // 越界与负数都不该炸
  assert.equal(reconnectDelay(delays, 99), 8000)
  assert.equal(reconnectDelay(delays, -1), 1000)
  assert.equal(reconnectDelay([], 3), 0)
})

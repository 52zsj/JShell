import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_SETTINGS, keepaliveConfig, sanitizeSettings } from '../src/shared/settings.ts'

test('保活默认：开启、60 秒、连续 3 次', () => {
  assert.equal(DEFAULT_SETTINGS.keepaliveEnabled, true)
  assert.equal(DEFAULT_SETTINGS.keepaliveIntervalSeconds, 60)
  assert.equal(DEFAULT_SETTINGS.keepaliveCountMax, 3)
})

test('旧配置里没有保活字段时补上默认值（升级不丢功能）', () => {
  const settings = sanitizeSettings({ theme: 'light', fontSize: 14 })
  assert.equal(settings.keepaliveEnabled, true)
  assert.equal(settings.keepaliveIntervalSeconds, 60)
  assert.equal(settings.keepaliveCountMax, 3)
})

test('间隔被限制在 10–300 秒', () => {
  assert.equal(sanitizeSettings({ keepaliveIntervalSeconds: 1 }).keepaliveIntervalSeconds, 10)
  assert.equal(sanitizeSettings({ keepaliveIntervalSeconds: 0 }).keepaliveIntervalSeconds, 10)
  assert.equal(sanitizeSettings({ keepaliveIntervalSeconds: -5 }).keepaliveIntervalSeconds, 10)
  assert.equal(sanitizeSettings({ keepaliveIntervalSeconds: 9999 }).keepaliveIntervalSeconds, 300)
  assert.equal(sanitizeSettings({ keepaliveIntervalSeconds: 30 }).keepaliveIntervalSeconds, 30)
})

test('次数被限制在 1–10', () => {
  assert.equal(sanitizeSettings({ keepaliveCountMax: 0 }).keepaliveCountMax, 1)
  assert.equal(sanitizeSettings({ keepaliveCountMax: 99 }).keepaliveCountMax, 10)
  assert.equal(sanitizeSettings({ keepaliveCountMax: 5 }).keepaliveCountMax, 5)
})

test('非数字输入回退到默认值', () => {
  const settings = sanitizeSettings({ keepaliveIntervalSeconds: 'abc', keepaliveCountMax: 'xyz' })
  assert.equal(settings.keepaliveIntervalSeconds, 60)
  assert.equal(settings.keepaliveCountMax, 3)
})

test('null / 空串按 0 处理，被夹到下限（沿用项目既有的 clamp 语义）', () => {
  // clamp() 用 Number(null) === 0，所以这类值是「有值但过小」而不是「没提供」。
  // 这里把既有语义固定下来，避免以后有人改 clamp 时悄悄改变行为。
  assert.equal(sanitizeSettings({ keepaliveCountMax: null }).keepaliveCountMax, 1)
  assert.equal(sanitizeSettings({ keepaliveIntervalSeconds: '' }).keepaliveIntervalSeconds, 10)
})

test('开启时把秒换算成毫秒', () => {
  const config = keepaliveConfig({
    ...DEFAULT_SETTINGS,
    keepaliveEnabled: true,
    keepaliveIntervalSeconds: 60,
    keepaliveCountMax: 3
  })
  assert.equal(config.intervalMs, 60_000)
  assert.equal(config.countMax, 3)
})

test('关闭时 interval 必须是 0（ssh2 的禁用约定），不能省略', () => {
  const config = keepaliveConfig({
    ...DEFAULT_SETTINGS,
    keepaliveEnabled: false,
    keepaliveIntervalSeconds: 60
  })
  assert.equal(config.intervalMs, 0)
})

test('间隔为 0 时也按禁用处理（防止外部传入脏值导致无效轮询）', () => {
  const config = keepaliveConfig({
    ...DEFAULT_SETTINGS,
    keepaliveEnabled: true,
    keepaliveIntervalSeconds: 0
  })
  assert.equal(config.intervalMs, 0)
})

test('自定义间隔正确换算', () => {
  const config = keepaliveConfig({
    ...DEFAULT_SETTINGS,
    keepaliveEnabled: true,
    keepaliveIntervalSeconds: 15,
    keepaliveCountMax: 5
  })
  assert.equal(config.intervalMs, 15_000)
  assert.equal(config.countMax, 5)
})

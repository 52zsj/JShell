import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_SETTINGS, sanitizeSettings } from '../src/shared/settings.ts'

test('终端外观默认值：竖线光标、行高 1.25', () => {
  assert.equal(DEFAULT_SETTINGS.cursorStyle, 'bar')
  assert.equal(DEFAULT_SETTINGS.lineHeight, 1.25)
})

test('光标形状只接受三种已知值，其它回落到默认', () => {
  assert.equal(sanitizeSettings({ cursorStyle: 'block' }).cursorStyle, 'block')
  assert.equal(sanitizeSettings({ cursorStyle: 'underline' }).cursorStyle, 'underline')
  assert.equal(sanitizeSettings({ cursorStyle: 'beam' }).cursorStyle, 'bar')
  assert.equal(sanitizeSettings({ cursorStyle: 42 }).cursorStyle, 'bar')
})

test('行高被夹在 1.0–1.6，并保留两位小数', () => {
  assert.equal(sanitizeSettings({ lineHeight: 1.4 }).lineHeight, 1.4)
  assert.equal(sanitizeSettings({ lineHeight: 0.5 }).lineHeight, 1)
  assert.equal(sanitizeSettings({ lineHeight: 9 }).lineHeight, 1.6)
  assert.equal(sanitizeSettings({ lineHeight: 1.234 }).lineHeight, 1.23)
  assert.equal(sanitizeSettings({ lineHeight: 'abc' }).lineHeight, 1.25)
})

test('旧配置没有这两个字段时补默认值（升级不丢外观）', () => {
  const settings = sanitizeSettings({ fontSize: 15 })
  assert.equal(settings.cursorStyle, 'bar')
  assert.equal(settings.lineHeight, 1.25)
  assert.equal(settings.fontSize, 15)
})

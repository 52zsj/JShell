import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_SETTINGS, sanitizeSettings } from '../src/shared/settings.ts'

test('非法设置回落到默认值', () => {
  assert.deepEqual(sanitizeSettings(null), DEFAULT_SETTINGS)
  assert.deepEqual(sanitizeSettings('x'), DEFAULT_SETTINGS)
})

test('数值夹取到安全区间', () => {
  const s = sanitizeSettings({ fontSize: 99, scrollback: 1, sidebarWidth: 9999 })
  assert.equal(s.fontSize, 22)
  assert.equal(s.scrollback, 500)
  assert.equal(s.sidebarWidth, 400)
})

test('枚举与布尔值校验', () => {
  const s = sanitizeSettings({ theme: 'blue', hostKeyPolicy: 'ignore', cursorBlink: 'yes' })
  assert.equal(s.theme, 'dark')
  assert.equal(s.hostKeyPolicy, 'ignore')
  assert.equal(s.cursorBlink, DEFAULT_SETTINGS.cursorBlink)
})

test('键位表过滤非字符串项，未知字段被丢弃', () => {
  const s = sanitizeSettings({
    keybindings: { 'tab.close': 'Mod+W', bad: 1 },
    unknown: 'x'
  })
  assert.deepEqual(s.keybindings, { 'tab.close': 'Mod+W' })
  assert.equal('unknown' in s, false)
})


test('侧边栏「本机」分组默认为显示，可被关闭', () => {
  assert.equal(DEFAULT_SETTINGS.showLocalShells, true)
  assert.equal(sanitizeSettings({}).showLocalShells, true)
  assert.equal(sanitizeSettings({ showLocalShells: false }).showLocalShells, false)
  assert.equal(sanitizeSettings({ showLocalShells: 'no' }).showLocalShells, true)
})


test('隐藏的本机终端只接受短字符串并去重', () => {
  assert.deepEqual(DEFAULT_SETTINGS.hiddenLocalShells, [])
  const s = sanitizeSettings({
    hiddenLocalShells: ['/bin/bash', '/bin/bash', 42, '', 'x'.repeat(600), '/bin/sh']
  })
  assert.deepEqual(s.hiddenLocalShells, ['/bin/bash', '/bin/sh'])
  assert.deepEqual(sanitizeSettings({ hiddenLocalShells: 'nope' }).hiddenLocalShells, [])
})

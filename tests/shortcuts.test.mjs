import test from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeSpec,
  resolveBindings,
  matchesBinding,
  findAction,
  formatBinding,
  specFromEvent,
  keyTokenFromEvent
} from '../src/renderer/src/shortcuts.ts'

const evt = (key, code, mods = {}) => ({
  key,
  code,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...mods
})

test('normalizeSpec 统一顺序并小写按键', () => {
  assert.equal(normalizeSpec('shift+mod+d'), 'Mod+Shift+d')
  assert.equal(normalizeSpec('Mod+Alt+ArrowLeft'), 'Mod+Alt+ArrowLeft')
  assert.equal(normalizeSpec(''), '')
})

test('macOS 上 Mod 映射到 ⌘，且不误判 Ctrl', () => {
  assert.equal(matchesBinding(evt('d', 'KeyD', { metaKey: true }), 'Mod+D', true), true)
  assert.equal(matchesBinding(evt('d', 'KeyD', { ctrlKey: true }), 'Mod+D', true), false)
  assert.equal(matchesBinding(evt('d', 'KeyD', { ctrlKey: true }), 'Mod+D', false), true)
})

test('精确匹配修饰键：⌘D 不应被 ⌘⇧D 触发，反之亦然', () => {
  const withShift = evt('d', 'KeyD', { metaKey: true, shiftKey: true })
  assert.equal(matchesBinding(withShift, 'Mod+D', true), false)
  assert.equal(matchesBinding(withShift, 'Mod+Shift+D', true), true)
  assert.equal(matchesBinding(evt('d', 'KeyD', { metaKey: true }), 'Mod+Shift+D', true), false)
})

test('findAction 命中正确的动作 id', () => {
  const bindings = resolveBindings(undefined)
  assert.equal(findAction(bindings, evt('w', 'KeyW', { metaKey: true, shiftKey: true }), true), 'pane.close')
  assert.equal(findAction(bindings, evt('w', 'KeyW', { metaKey: true }), true), 'tab.close')
  assert.equal(findAction(bindings, evt('q', 'KeyQ', { metaKey: true }), true), null)
})

test('用户自定义覆盖默认值，空串回退默认', () => {
  const bindings = resolveBindings({ 'pane.splitRight': 'Mod+Alt+R', 'tab.close': '' })
  assert.equal(bindings['pane.splitRight'], 'Mod+Alt+r')
  assert.equal(bindings['tab.close'], 'Mod+w', '空串应回退到默认值（并归一化）')
})

test('specFromEvent 拒绝裸键与纯修饰键', () => {
  assert.equal(specFromEvent(evt('F5', 'F5'), true), null, '裸 F5 不能作为绑定')
  assert.equal(specFromEvent(evt('Shift', 'ShiftLeft', { shiftKey: true }), true), null)
  assert.equal(
    specFromEvent(evt('d', 'KeyD', { metaKey: true, shiftKey: true }), true),
    'Mod+Shift+d'
  )
})

test('keyTokenFromEvent 用物理键位，忽略 Shift 造成的字符变化', () => {
  assert.equal(keyTokenFromEvent(evt('D', 'KeyD', { shiftKey: true })), 'd')
  assert.equal(keyTokenFromEvent(evt('!', 'Digit1', { shiftKey: true })), '1')
  assert.equal(keyTokenFromEvent(evt(' ', 'Space')), 'Space')
})

test('formatBinding 在 macOS 上用符号', () => {
  assert.equal(formatBinding('Mod+Shift+D', true), '⌘⇧D')
  assert.equal(formatBinding('Mod+Shift+D', false), 'Ctrl+Shift+D')
  assert.equal(formatBinding('', true), '未设置')
})

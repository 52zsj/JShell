import assert from 'node:assert/strict'
import test from 'node:test'
import {
  defaultKeysFor,
  formatBinding,
  matchClipboardAction,
  matchesBinding,
  normalizeSpec,
  resolveBindings,
  SHORTCUTS,
  specFromEvent
} from '../src/renderer/src/shortcuts.ts'

/** 造一个够用的 KeyboardEvent 替身（只用到 matchesBinding / matchClipboardAction 读的字段） */
function key(init) {
  return {
    key: init.key,
    code: init.code ?? '',
    ctrlKey: Boolean(init.ctrlKey),
    metaKey: Boolean(init.metaKey),
    altKey: Boolean(init.altKey),
    shiftKey: Boolean(init.shiftKey)
  }
}

const win = (spec, extra = {}) => {
  const [mods, k] = spec.split('|')
  const set = new Set(mods ? mods.split('+') : [])
  return key({
    key: k,
    code: /^[a-z]$/.test(k) ? `Key${k.toUpperCase()}` : '',
    ctrlKey: set.has('Ctrl'),
    metaKey: set.has('Meta'),
    altKey: set.has('Alt'),
    shiftKey: set.has('Shift'),
    ...extra
  })
}

// ------------------------------------------------------------------ 平台默认值

test('macOS 默认全部用 ⌘（Mod），不出现 Ctrl', () => {
  for (const def of SHORTCUTS) {
    const spec = defaultKeysFor(def, true)
    if (spec.includes('Ctrl')) {
      assert.fail(`${def.id} 的 macOS 默认值不该含 Ctrl：${spec}`)
    }
  }
})

test('Windows 默认不含裸 Ctrl+字母（readline 已占用）', () => {
  // readline 系 shell 里被占用的组合：裸 Ctrl+单字母一律不许抢
  const occupied = new Set(['a', 'b', 'd', 'e', 'f', 'k', 'l', 'n', 't', 'w', 'c', 'v', 'u', 'y', 'r', 'o', 'p', 'h', 'j', 'm', 'q', 'z', 's', 'g', 'i', 'x'])
  for (const def of SHORTCUTS) {
    const spec = normalizeSpec(defaultKeysFor(def, false))
    const parts = spec.split('+')
    const k = parts[parts.length - 1]
    const mods = parts.slice(0, -1)
    const isBareCtrlLetter =
      mods.includes('Ctrl') && !mods.includes('Shift') && !mods.includes('Alt') && k.length === 1
    if (isBareCtrlLetter && occupied.has(k.toLowerCase())) {
      assert.fail(`${def.id} 的 Windows 默认值 ${spec} 会被 shell 的 readline 抢走`)
    }
  }
})

test('Windows 默认不用 Ctrl+Alt+方向键（Intel 显卡驱动会抢去转屏）', () => {
  for (const def of SHORTCUTS) {
    const spec = normalizeSpec(defaultKeysFor(def, false))
    const parts = spec.split('+')
    if (parts.includes('Ctrl') && parts.includes('Alt') && parts[0].startsWith('Arrow')) {
      assert.fail(`${def.id} 的 Windows 默认值 ${spec} 与显卡驱动热键冲突`)
    }
  }
})

test('两端默认值都不重复（同一平台上没有两个动作抢同一个键）', () => {
  for (const isMac of [true, false]) {
    const seen = new Map()
    for (const def of SHORTCUTS) {
      const spec = normalizeSpec(defaultKeysFor(def, isMac))
      if (seen.has(spec)) {
        assert.fail(`${isMac ? 'macOS' : 'Windows'} 上 ${def.id} 与 ${seen.get(spec)} 都是 ${spec}`)
      }
      seen.set(spec, def.id)
    }
  }
})

test('resolveBindings 按平台取默认值，用户自定义优先', () => {
  const mac = resolveBindings(undefined, true)
  const windows = resolveBindings(undefined, false)
  assert.equal(mac['pane.splitRight'], 'Mod+d')
  assert.equal(windows['pane.splitRight'], 'Ctrl+Shift+d')

  const custom = resolveBindings({ 'pane.splitRight': 'Ctrl+Alt+P' }, false)
  assert.equal(custom['pane.splitRight'], 'Ctrl+Alt+p')
  // 未覆盖的项仍取 Windows 默认值
  assert.equal(custom['pane.splitDown'], 'Ctrl+Shift+e')
})

// ------------------------------------------------------------------ 匹配

test('Windows：Ctrl+Shift+D 命中分屏，裸 Ctrl+D 不命中（留给 shell 的 EOF）', () => {
  const bindings = resolveBindings(undefined, false)
  assert.equal(matchesBinding(win('Ctrl+Shift|d'), bindings['pane.splitRight'], false), true)
  assert.equal(matchesBinding(win('Ctrl|d'), bindings['pane.splitRight'], false), false)
})

test('Windows：多按一个 Shift 不会误触少 Shift 的绑定', () => {
  const bindings = resolveBindings(undefined, false)
  // 粘贴是 Ctrl+V，Ctrl+Shift+V 不应命中「粘贴」以外的动作；这里验证精确匹配
  assert.equal(matchesBinding(win('Ctrl+Shift|k'), bindings['snippets.toggle'], false), true)
  assert.equal(matchesBinding(win('Ctrl|k'), bindings['snippets.toggle'], false), false)
})

test('macOS：⌘D 命中，Ctrl+D 不命中（Ctrl 组合属于终端）', () => {
  const bindings = resolveBindings(undefined, true)
  assert.equal(matchesBinding(win('Meta|d'), bindings['pane.splitRight'], true), true)
  assert.equal(matchesBinding(win('Ctrl|d'), bindings['pane.splitRight'], true), false)
})

test('Windows：Alt+方向键切分屏，且不要求 Ctrl', () => {
  const bindings = resolveBindings(undefined, false)
  assert.equal(
    matchesBinding(win('Alt|ArrowRight'), bindings['pane.next'], false),
    true
  )
  assert.equal(matchesBinding(win('Ctrl+Alt|ArrowRight'), bindings['pane.next'], false), false)
})

test('Windows：Ctrl+F4 关闭标签页能被识别（功能键名大小写不敏感）', () => {
  const bindings = resolveBindings(undefined, false)
  assert.equal(bindings['tab.close'], 'Ctrl+F4')
  assert.equal(matchesBinding(key({ key: 'F4', ctrlKey: true }), bindings['tab.close'], false), true)
})

test('录制快捷键：Windows 上按 Ctrl+Shift+D 记成 Mod+Shift+D（Mod = 当前平台的主修饰键）', () => {
  // 存成 Mod 是刻意的：同一份配置拿到 macOS 上就是 ⌘⇧D，不需要各平台各存一份。
  // 匹配时 matchesBinding 会把 Mod 解释成 Ctrl（非 mac）/ ⌘（mac）。
  const spec = specFromEvent(key({ key: 'D', code: 'KeyD', ctrlKey: true, shiftKey: true }), false)
  assert.equal(spec, 'Mod+Shift+d')
  assert.equal(matchesBinding(key({ key: 'D', code: 'KeyD', ctrlKey: true, shiftKey: true }), spec, false), true)
})

// ------------------------------------------------------------------ 剪贴板

test('macOS：⌘C / ⌘V / ⌘A 分别是复制、粘贴、全选', () => {
  assert.equal(matchClipboardAction(win('Meta|c'), true, false), 'copy')
  assert.equal(matchClipboardAction(win('Meta|v'), true, false), 'paste')
  assert.equal(matchClipboardAction(win('Meta|a'), true, false), 'selectAll')
})

test('macOS：Ctrl+C 不归剪贴板（要留给终端发中断）', () => {
  assert.equal(matchClipboardAction(win('Ctrl|c'), true, true), null)
})

test('Windows：Ctrl+C 有选区才复制，没选区放行给终端发 SIGINT', () => {
  assert.equal(matchClipboardAction(win('Ctrl|c'), false, true), 'copy')
  assert.equal(matchClipboardAction(win('Ctrl|c'), false, false), null)
})

test('Windows：Ctrl+Shift+C 无视选区始终复制', () => {
  assert.equal(matchClipboardAction(win('Ctrl+Shift|c'), false, false), 'copy')
})

test('Windows：Ctrl+V 与 Ctrl+Shift+V 都粘贴', () => {
  assert.equal(matchClipboardAction(win('Ctrl|v'), false, false), 'paste')
  assert.equal(matchClipboardAction(win('Ctrl+Shift|v'), false, false), 'paste')
})

test('Windows：裸 Ctrl+A 不动（readline 行首），全选走 Ctrl+Shift+A', () => {
  assert.equal(matchClipboardAction(win('Ctrl|a'), false, false), null)
  assert.equal(matchClipboardAction(win('Ctrl+Shift|a'), false, false), 'selectAll')
})

test('Windows：带 Alt 的组合不当作剪贴板（AltGr 输入法场景）', () => {
  assert.equal(matchClipboardAction(win('Ctrl+Alt|c'), false, true), null)
})

// ------------------------------------------------------------------ 展示

test('formatBinding：按平台给出符号或 Ctrl 文字', () => {
  assert.equal(formatBinding('Mod+Shift+D', true), '⌘⇧D')
  assert.equal(formatBinding('Ctrl+Shift+D', false), 'Ctrl+Shift+D')
  assert.equal(formatBinding('Ctrl+F4', false), 'Ctrl+F4')
  assert.equal(formatBinding('Alt+ArrowRight', false), 'Alt+→')
})

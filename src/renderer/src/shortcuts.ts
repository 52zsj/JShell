/**
 * 快捷键体系。
 *
 * 存储格式：`Mod+Shift+D`（Mod = macOS 的 ⌘ / 其他平台的 Ctrl）。
 * 默认值集中在 SHORTCUTS，用户在设置里改过的项存在 settings.keybindings，
 * 空字符串表示「恢复默认」。
 *
 * 匹配采用「精确匹配」：多按或少按 Shift / Alt 都不会触发，
 * 避免 Mod+D 与 Mod+Shift+D 互相误触。
 */

export interface ShortcutDef {
  id: string
  label: string
  group: string
  defaultKeys: string
}

export const SHORTCUTS: ShortcutDef[] = [
  { id: 'session.local', label: '新建本地终端', group: '会话', defaultKeys: 'Mod+T' },
  { id: 'session.host', label: '新建主机', group: '会话', defaultKeys: 'Mod+N' },
  { id: 'pane.splitRight', label: '向右分屏', group: '分屏', defaultKeys: 'Mod+D' },
  { id: 'pane.splitDown', label: '向下分屏', group: '分屏', defaultKeys: 'Mod+Shift+D' },
  { id: 'pane.close', label: '关闭当前分屏', group: '分屏', defaultKeys: 'Mod+Shift+W' },
  { id: 'pane.next', label: '下一个分屏', group: '分屏', defaultKeys: 'Mod+Alt+ArrowRight' },
  { id: 'pane.prev', label: '上一个分屏', group: '分屏', defaultKeys: 'Mod+Alt+ArrowLeft' },
  { id: 'pane.toggleFiles', label: '切换 终端 / 文件', group: '分屏', defaultKeys: 'Mod+E' },
  { id: 'pane.find', label: '在终端中搜索', group: '分屏', defaultKeys: 'Mod+F' },
  { id: 'files.path', label: '跳转到路径（文件面板）', group: '分屏', defaultKeys: 'Mod+L' },
  { id: 'tab.close', label: '关闭标签页', group: '标签页', defaultKeys: 'Mod+W' },
  { id: 'tab.reopen', label: '重新打开关闭的标签', group: '标签页', defaultKeys: 'Mod+Shift+T' },
  { id: 'snippets.toggle', label: '命令片段', group: '视图', defaultKeys: 'Mod+B' },
  { id: 'settings.open', label: '打开设置', group: '窗口', defaultKeys: 'Mod+,' }
]

export type Bindings = Record<string, string>

const ORDER = ['Mod', 'Ctrl', 'Alt', 'Shift']

/** 把用户输入的写法归一化为 `Mod+Alt+ArrowLeft` 形式 */
export function normalizeSpec(spec: string): string {
  const tokens = spec
    .split('+')
    .map((t) => t.trim())
    .filter(Boolean)
  if (tokens.length === 0) return ''

  const mods = new Set<string>()
  let key = ''

  for (const token of tokens) {
    const lower = token.toLowerCase()
    if (lower === 'mod' || lower === 'cmd' || lower === 'command' || lower === 'meta' || lower === 'super') {
      mods.add('Mod')
    } else if (lower === 'ctrl' || lower === 'control') {
      mods.add('Ctrl')
    } else if (lower === 'alt' || lower === 'opt' || lower === 'option') {
      mods.add('Alt')
    } else if (lower === 'shift') {
      mods.add('Shift')
    } else {
      key = normalizeKeyToken(token)
    }
  }

  if (!key) return ''
  const parts = ORDER.filter((m) => mods.has(m))
  parts.push(key)
  return parts.join('+')
}

function normalizeKeyToken(token: string): string {
  const t = token.trim()
  if (t.length === 1) return t.toLowerCase()
  if (/^f\d{1,2}$/i.test(t)) return t.toUpperCase()
  if (t.toLowerCase() === 'space') return 'Space'
  // ArrowLeft / Escape / Enter 等保持首字母大写形式
  return t.charAt(0).toUpperCase() + t.slice(1)
}

/** 合并默认值与用户自定义 */
export function resolveBindings(custom: Record<string, string> | undefined): Bindings {
  const result: Bindings = {}
  for (const def of SHORTCUTS) {
    const override = custom?.[def.id]
    // 默认值也走一次归一化，保证表内所有绑定格式一致（键名小写、修饰键定序）
    result[def.id] = override && override.trim() ? normalizeSpec(override) : normalizeSpec(def.defaultKeys)
  }
  return result
}

/** 从键盘事件取出「键」部分；纯修饰键返回 null */
export function keyTokenFromEvent(event: KeyboardEvent): string | null {
  const pureModifiers = ['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Dead', 'Unidentified']
  if (pureModifiers.includes(event.key)) return null

  // 字母/数字用物理键位，保证 Shift+D 仍记为 d + Shift
  if (/^Key[A-Z]$/.test(event.code)) return event.code.slice(3).toLowerCase()
  if (/^Digit\d$/.test(event.code)) return event.code.slice(5)
  if (/^F\d{1,2}$/.test(event.key)) return event.key
  if (event.key === ' ') return 'Space'
  if (event.key.length === 1) return event.key.toLowerCase()
  return event.key
}

/** 把一次按键组合转成存储用的字符串；只按修饰键或缺少 Mod/Ctrl/Alt 时返回 null */
export function specFromEvent(event: KeyboardEvent, isMac: boolean): string | null {
  const key = keyTokenFromEvent(event)
  if (!key) return null

  const parts: string[] = []
  if (isMac ? event.metaKey : event.ctrlKey) parts.push('Mod')
  if (isMac && event.ctrlKey) parts.push('Ctrl')
  if (!isMac && event.metaKey) parts.push('Mod')
  if (event.altKey) parts.push('Alt')
  if (event.shiftKey) parts.push('Shift')

  // 必须带修饰键：裸 F 键会被应用层吞掉，导致终端里的 F5 等功能键失效
  if (parts.length === 0) return null

  parts.push(key)
  return normalizeSpec(parts.join('+'))
}

/** 事件是否命中某个绑定 */
export function matchesBinding(event: KeyboardEvent, spec: string, isMac: boolean): boolean {
  if (!spec) return false
  const parts = spec.split('+')
  const key = parts[parts.length - 1]
  const mods = new Set(parts.slice(0, -1))

  const eventKey = keyTokenFromEvent(event)
  if (!eventKey || eventKey.toLowerCase() !== key.toLowerCase()) return false

  const wantCtrl = isMac ? mods.has('Ctrl') : mods.has('Mod') || mods.has('Ctrl')
  const wantMeta = isMac ? mods.has('Mod') : false
  const wantAlt = mods.has('Alt')
  const wantShift = mods.has('Shift')

  return (
    event.ctrlKey === wantCtrl &&
    event.metaKey === wantMeta &&
    event.altKey === wantAlt &&
    event.shiftKey === wantShift
  )
}

/** 找到命中的动作 id */
export function findAction(bindings: Bindings, event: KeyboardEvent, isMac: boolean): string | null {
  for (const [id, spec] of Object.entries(bindings)) {
    if (matchesBinding(event, spec, isMac)) return id
  }
  return null
}

const KEY_LABEL: Record<string, string> = {
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
  Space: 'Space',
  Escape: 'Esc',
  Enter: 'Enter',
  Backspace: '⌫',
  Delete: 'Del'
}

/** 展示用格式：macOS 下用符号（⌘⇧D），其他平台用 Ctrl+Shift+D */
export function formatBinding(spec: string, isMac: boolean): string {
  if (!spec) return '未设置'
  const parts = spec.split('+')
  const key = parts[parts.length - 1]
  const mods = parts.slice(0, -1)

  const keyLabel = KEY_LABEL[key] ?? (key.length === 1 ? key.toUpperCase() : key)

  if (isMac) {
    const symbols = mods
      .map((m) => (m === 'Mod' ? '⌘' : m === 'Ctrl' ? '⌃' : m === 'Alt' ? '⌥' : m === 'Shift' ? '⇧' : m))
      .join('')
    return `${symbols}${keyLabel}`
  }

  const labels = mods.map((m) => (m === 'Mod' ? 'Ctrl' : m))
  return [...labels, keyLabel].join('+')
}

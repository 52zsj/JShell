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
  /** macOS 默认：⌘ 系。macOS 的 ⌘ 不会被 shell 占用，可以放心用单字母 */
  defaultKeys: string
  /**
   * Windows / Linux 默认，不填表示与 macOS 相同（仅限不含字母的键，如 Ctrl+,）。
   *
   * 为什么不能简单把 ⌘ 换成 Ctrl：在 readline 系 shell 里，**裸 Ctrl + 字母几乎全被占用**
   * （Ctrl+A 行首、Ctrl+B 后退、Ctrl+D EOF、Ctrl+E 行尾、Ctrl+F 前进、Ctrl+K 删到行尾、
   * Ctrl+L 清屏、Ctrl+N 下一条历史、Ctrl+T 交换字符、Ctrl+W 删前一个词…）。
   * 抢了这些键，用户在 shell 里就没法正常编辑命令行。所以 Windows 端的字母类快捷键
   * 统一退到 Ctrl+Shift+<字母>（这也是 Windows Terminal / VS Code 的做法），
   * 分屏切换这类导航键用 Alt+方向键（避开 Intel 显卡驱动的 Ctrl+Alt+方向键旋转屏幕热键）。
   */
  defaultKeysWin?: string
}

export const SHORTCUTS: ShortcutDef[] = [
  {
    id: 'session.local',
    label: '新建本地终端',
    group: '会话',
    defaultKeys: 'Mod+T',
    defaultKeysWin: 'Ctrl+Shift+T'
  },
  {
    id: 'session.host',
    label: '新建主机',
    group: '会话',
    defaultKeys: 'Mod+N',
    defaultKeysWin: 'Ctrl+Shift+N'
  },
  {
    id: 'batch.toggle',
    label: '批量编辑（同屏输入）',
    group: '会话',
    defaultKeys: 'Mod+Shift+S',
    // S = Sync；Ctrl+Shift+S 在 shell 里无绑定（裸 Ctrl+S 是流控 XOFF，绝不能抢）
    defaultKeysWin: 'Ctrl+Shift+S'
  },
  {
    id: 'pane.splitRight',
    label: '向右分屏',
    group: '分屏',
    defaultKeys: 'Mod+D',
    defaultKeysWin: 'Ctrl+Shift+D'
  },
  {
    id: 'pane.splitDown',
    label: '向下分屏',
    group: '分屏',
    defaultKeys: 'Mod+Shift+D',
    defaultKeysWin: 'Ctrl+Shift+E'
  },
  {
    id: 'pane.close',
    label: '关闭当前分屏',
    group: '分屏',
    defaultKeys: 'Mod+Shift+W',
    defaultKeysWin: 'Ctrl+Shift+W'
  },
  {
    id: 'pane.next',
    label: '下一个分屏',
    group: '分屏',
    defaultKeys: 'Mod+Alt+ArrowRight',
    // Ctrl+Alt+方向键在 Windows 上常被 Intel 显卡驱动抢去旋转屏幕，改用 Alt+方向键
    defaultKeysWin: 'Alt+ArrowRight'
  },
  {
    id: 'pane.prev',
    label: '上一个分屏',
    group: '分屏',
    defaultKeys: 'Mod+Alt+ArrowLeft',
    defaultKeysWin: 'Alt+ArrowLeft'
  },
  {
    id: 'pane.toggleFiles',
    label: '切换 终端 / 文件',
    group: '分屏',
    defaultKeys: 'Mod+E',
    defaultKeysWin: 'Ctrl+Shift+B'
  },
  {
    id: 'pane.find',
    label: '在终端中搜索',
    group: '分屏',
    defaultKeys: 'Mod+F',
    defaultKeysWin: 'Ctrl+Shift+F'
  },
  {
    id: 'files.path',
    label: '跳转到路径（文件面板）',
    group: '分屏',
    defaultKeys: 'Mod+L',
    defaultKeysWin: 'Ctrl+Shift+L'
  },
  {
    id: 'tab.close',
    label: '关闭标签页',
    group: '标签页',
    defaultKeys: 'Mod+W',
    // Ctrl+W 在 readline 里是「删掉前一个词」，Windows 上改用系统惯例 Ctrl+F4
    defaultKeysWin: 'Ctrl+F4'
  },
  {
    id: 'tab.reopen',
    label: '重新打开关闭的标签',
    group: '标签页',
    defaultKeys: 'Mod+Shift+T',
    defaultKeysWin: 'Alt+Shift+T'
  },
  {
    id: 'snippets.toggle',
    label: '命令片段',
    group: '视图',
    defaultKeys: 'Mod+B',
    defaultKeysWin: 'Ctrl+Shift+K'
  },
  {
    id: 'settings.open',
    label: '打开设置',
    group: '窗口',
    defaultKeys: 'Mod+,',
    // Ctrl+, 无 readline 冲突，按 Windows 应用惯例保留
    defaultKeysWin: 'Ctrl+,'
  }
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

/** 某个动作在当前平台上的默认键位（未归一化） */
export function defaultKeysFor(def: ShortcutDef, isMac: boolean): string {
  return isMac ? def.defaultKeys : (def.defaultKeysWin ?? def.defaultKeys)
}

/**
 * 合并默认值与用户自定义。
 *
 * 默认值按平台取（macOS 用 ⌘ 系、Windows/Linux 用 Ctrl+Shift 系）；
 * 用户改过的项优先，跨平台共用同一份 keybindings —— 用户是两套机器的话，
 * 各自平台只会在「没改过」的项上落到自己的默认值。
 */
export function resolveBindings(
  custom: Record<string, string> | undefined,
  isMac: boolean
): Bindings {
  const result: Bindings = {}
  for (const def of SHORTCUTS) {
    const override = custom?.[def.id]
    // 默认值也走一次归一化，保证表内所有绑定格式一致（键名小写、修饰键定序）
    result[def.id] = override && override.trim()
      ? normalizeSpec(override)
      : normalizeSpec(defaultKeysFor(def, isMac))
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

export type ClipboardAction = 'copy' | 'paste' | 'selectAll'

/**
 * 识别剪贴板快捷键，按各平台终端惯例。
 *
 * macOS：
 *   ⌘C 复制、⌘V 粘贴、⌘A 全选（⌘ 不被 shell 占用，可以直给）
 *
 * Windows / Linux：
 *   · Ctrl+C：**有选区时复制，没有选区则放行**给终端发 SIGINT
 *     —— 这是 Windows Terminal / VS Code 终端的行为，既保住「复制」，也没抢走「中断」
 *   · Ctrl+Shift+C 始终复制（无视选区），Ctrl+Shift+V 也可以粘贴
 *   · Ctrl+V 粘贴（Windows Terminal 的默认）
 *   · Ctrl+Shift+A 全选；裸 Ctrl+A 是 readline 的「移到行首」，必须放行
 *
 * @param hasSelection 终端当前是否有选区（决定裸 Ctrl+C 的去向）
 */
export function matchClipboardAction(
  event: KeyboardEvent,
  isMac: boolean,
  hasSelection: boolean
): ClipboardAction | null {
  const key = keyTokenFromEvent(event)
  if (!key) return null
  const k = key.toLowerCase()

  if (isMac) {
    // 只认 ⌘，⌃ 组合留给终端（Ctrl+C 中断等）
    if (!event.metaKey || event.ctrlKey || event.altKey) return null
    if (k === 'c' && !event.shiftKey) return 'copy'
    if (k === 'v' && !event.shiftKey) return 'paste'
    if (k === 'a' && !event.shiftKey) return 'selectAll'
    return null
  }

  if (!event.ctrlKey || event.altKey || event.metaKey) return null
  if (k === 'c') return event.shiftKey || hasSelection ? 'copy' : null
  if (k === 'v') return 'paste'
  if (k === 'a') return event.shiftKey ? 'selectAll' : null
  return null
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

import type { AppSettings, AppTheme } from './types'

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'dark',
  terminalTheme: 'one-dark',
  fontFamily:
    '"JetBrains Mono", "SF Mono", SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
  fontSize: 13,
  cursorBlink: true,
  scrollback: 5000,
  hostKeyPolicy: 'tofu',
  sidebarWidth: 264,
  localShell: '',
  keybindings: {},
  launchAtLogin: false,
  startMinimized: false,
  closeToTray: true,
  notifications: true,
  showLocalShells: true,
  hostDeleteButton: true,
  hostDeleteConfirm: true,
  hiddenLocalShells: [],
  autoFollowCwd: true
}

const THEMES: AppTheme[] = ['dark', 'light', 'system']

function text(value: unknown, fallback: string, max = 300): string {
  return typeof value === 'string' && value.length <= max ? value : fallback
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function clamp(value: unknown, fallback: number, min: number, max: number): number {
  const num = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(num)) return fallback
  return Math.min(max, Math.max(min, Math.round(num)))
}

function keybindings(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const result: Record<string, string> = {}
  for (const [key, spec] of Object.entries(value as Record<string, unknown>)) {
    if (typeof spec === 'string' && spec.length <= 40) result[key] = spec
  }
  return result
}

/** 已隐藏的本机 shell 列表：只接受绝对路径形态的短字符串，最多 50 条 */
function shellList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  for (const item of value.slice(0, 50)) {
    if (typeof item === 'string' && item.length > 0 && item.length <= 500) seen.add(item)
  }
  return [...seen]
}

/** 设置校验：过滤未知字段，修正越界值，保证旧配置/手改配置不会让终端崩溃 */
export function sanitizeSettings(input: unknown): AppSettings {
  const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  return {
    theme: THEMES.includes(raw.theme as AppTheme) ? (raw.theme as AppTheme) : DEFAULT_SETTINGS.theme,
    terminalTheme: text(raw.terminalTheme, DEFAULT_SETTINGS.terminalTheme, 64),
    fontFamily: text(raw.fontFamily, DEFAULT_SETTINGS.fontFamily, 500),
    fontSize: clamp(raw.fontSize, DEFAULT_SETTINGS.fontSize, 10, 22),
    cursorBlink: bool(raw.cursorBlink, DEFAULT_SETTINGS.cursorBlink),
    scrollback: clamp(raw.scrollback, DEFAULT_SETTINGS.scrollback, 500, 50000),
    hostKeyPolicy: raw.hostKeyPolicy === 'ignore' ? 'ignore' : 'tofu',
    sidebarWidth: clamp(raw.sidebarWidth, DEFAULT_SETTINGS.sidebarWidth, 200, 400),
    localShell: text(raw.localShell, '', 500),
    keybindings: keybindings(raw.keybindings),
    launchAtLogin: bool(raw.launchAtLogin, DEFAULT_SETTINGS.launchAtLogin),
    startMinimized: bool(raw.startMinimized, DEFAULT_SETTINGS.startMinimized),
    closeToTray: bool(raw.closeToTray, DEFAULT_SETTINGS.closeToTray),
    notifications: bool(raw.notifications, DEFAULT_SETTINGS.notifications),
    showLocalShells: bool(raw.showLocalShells, DEFAULT_SETTINGS.showLocalShells),
    hostDeleteButton: bool(raw.hostDeleteButton, DEFAULT_SETTINGS.hostDeleteButton),
    hostDeleteConfirm: bool(raw.hostDeleteConfirm, DEFAULT_SETTINGS.hostDeleteConfirm),
    hiddenLocalShells: shellList(raw.hiddenLocalShells),
    autoFollowCwd: bool(raw.autoFollowCwd, DEFAULT_SETTINGS.autoFollowCwd)
  }
}

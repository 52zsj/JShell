import { useAppStore } from './store'
import { formatBinding, resolveBindings } from './shortcuts'

/**
 * 取某个动作在当前平台上的键位展示文本（含用户自定义）。
 *
 * 界面上的快捷键提示一律走这里，不要写字面量：写死的 `⌘/Ctrl + L` 这类文案
 * 在 Windows 上既不对平台、也不对真实绑定，出问题时会误导用户以为功能坏了。
 */
export function useShortcutHint(id: string): string {
  const info = useAppStore((s) => s.info)
  const keybindings = useAppStore((s) => s.settings.keybindings)
  const isMac = (info?.platform ?? 'darwin') === 'darwin'
  return formatBinding(resolveBindings(keybindings, isMac)[id] ?? '', isMac)
}

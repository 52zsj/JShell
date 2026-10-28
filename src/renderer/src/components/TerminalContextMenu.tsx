import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useAppStore } from '../store'
import { getTerminal } from '../terminal-registry'

export interface TerminalMenuTarget {
  x: number
  y: number
  sessionId: string
}

interface Props {
  target: TerminalMenuTarget
  onClose: () => void
}

interface MenuItem {
  label: string
  hint?: string
  disabled?: boolean
  danger?: boolean
  divider?: boolean
  onClick?: () => void
}

/**
 * 终端右键菜单。
 * 只做「看得见就能用」的高频操作，所有动作复用既有的 store / registry 能力，不新增 IPC。
 */
export function TerminalContextMenu({ target, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: target.x, top: target.y })

  const splitPane = useAppStore((s) => s.splitPane)
  const closeSession = useAppStore((s) => s.closeSession)
  const focusSession = useAppStore((s) => s.focusSession)
  const openFind = useAppStore((s) => s.openFind)

  const term = getTerminal(target.sessionId)
  const hasSelection = Boolean(term?.hasSelection())

  // 贴边时把菜单收回视口内
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    setPos({
      left: Math.max(8, Math.min(target.x, window.innerWidth - rect.width - 8)),
      top: Math.max(8, Math.min(target.y, window.innerHeight - rect.height - 8))
    })
  }, [target.x, target.y])

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', onPointerDown, true)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('blur', onClose)
    window.addEventListener('resize', onClose)
    return () => {
      window.removeEventListener('mousedown', onPointerDown, true)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('blur', onClose)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose])

  const copy = () => {
    const selection = term?.getSelection()
    if (selection) void window.jshell.clipboard.writeText(selection)
    onClose()
  }

  const paste = () => {
    void window.jshell.clipboard
      .readText()
      .then((text) => {
        if (text) term?.paste(text)
      })
      .finally(onClose)
  }

  const items: MenuItem[] = [
    { label: '复制', hint: '⌘C', disabled: !hasSelection, onClick: copy },
    { label: '粘贴', hint: '⌘V', onClick: paste },
    { label: '全选', hint: '⌘A', onClick: () => { term?.selectAll(); onClose() } },
    { label: '在终端中搜索…', hint: '⌘F', onClick: () => { openFind(target.sessionId); onClose() } },
    { label: '清屏', hint: '⌘K', onClick: () => { term?.clear(); onClose() } },
    { divider: true, label: '' },
    {
      label: '向右分屏',
      hint: '⌘D',
      onClick: () => { focusSession(target.sessionId); void splitPane('row'); onClose() }
    },
    {
      label: '向下分屏',
      hint: '⌘⇧D',
      onClick: () => { focusSession(target.sessionId); void splitPane('column'); onClose() }
    },
    { divider: true, label: '' },
    {
      label: '关闭当前分屏',
      hint: '⌘⇧W',
      danger: true,
      onClick: () => { void closeSession(target.sessionId); onClose() }
    }
  ]

  return (
    <div className="context-menu" ref={ref} style={{ left: pos.left, top: pos.top }}>
      {items.map((item, index) =>
        item.divider ? (
          <div className="context-divider" key={`d-${index}`} />
        ) : (
          <button
            key={item.label}
            className={`context-item${item.danger ? ' is-danger' : ''}`}
            disabled={item.disabled}
            onClick={item.onClick}
          >
            <span>{item.label}</span>
            {item.hint && <span className="context-hint">{item.hint}</span>}
          </button>
        )
      )}
    </div>
  )
}

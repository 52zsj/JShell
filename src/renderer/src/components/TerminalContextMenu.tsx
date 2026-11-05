import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useAppStore } from '../store'
import { fitTerminal, getTerminal } from '../terminal-registry'

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

  const info = useAppStore((s) => s.info)
  // 键位提示必须跟着平台走：Windows 上显示 ⌘C 会让人以为快捷键坏了
  const isMac = (info?.platform ?? 'darwin') === 'darwin'
  const key = (mac: string, other: string): string => (isMac ? mac : other)

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
    {
      label: '复制',
      // Windows 上 Ctrl+C 要留给终端发 SIGINT，复制走 Ctrl+Shift+C（与菜单 accelerator 一致）
      hint: key('⌘C', 'Ctrl+Shift+C'),
      disabled: !hasSelection,
      onClick: copy
    },
    { label: '粘贴', hint: key('⌘V', 'Ctrl+V'), onClick: paste },
    { label: '全选', hint: key('⌘A', 'Ctrl+A'), onClick: () => { term?.selectAll(); onClose() } },
    {
      label: '在终端中搜索…',
      hint: key('⌘F', 'Ctrl+F'),
      onClick: () => { openFind(target.sessionId); onClose() }
    },
    {
      // 清屏没有全局快捷键（⌘K 在 shell 里是 kill-line，不能抢），所以不显示 hint
      label: '清屏',
      onClick: () => {
        term?.clear()
        // clear() 之后视口可能还停在历史位置，看起来就像「清了但光标在中间」
        term?.scrollToBottom()
        onClose()
      }
    },
    {
      // 出现残影/文字叠在一起时的逃生口：只重绘，不动缓冲区内容与 shell 状态
      label: '重绘终端（出现残影时用）',
      onClick: () => {
        fitTerminal(target.sessionId)
        const current = getTerminal(target.sessionId)
        if (current) current.refresh(0, Math.max(0, current.rows - 1))
        onClose()
      }
    },
    { divider: true, label: '' },
    {
      label: '向右分屏',
      hint: key('⌘D', 'Ctrl+D'),
      onClick: () => { focusSession(target.sessionId); void splitPane('row'); onClose() }
    },
    {
      label: '向下分屏',
      hint: key('⌘⇧D', 'Ctrl+Shift+D'),
      onClick: () => { focusSession(target.sessionId); void splitPane('column'); onClose() }
    },
    { divider: true, label: '' },
    {
      label: '关闭当前分屏',
      hint: key('⌘⇧W', 'Ctrl+Shift+W'),
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

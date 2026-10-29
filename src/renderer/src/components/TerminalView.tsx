import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import '@xterm/xterm/css/xterm.css'
import type { AppSettings } from '@shared/types'
import { acquireTerminal, fitTerminal, getTerminal, hiddenScrollback, setFocusedSession, setTerminalVisible } from '../terminal-registry'
import { useAppStore } from '../store'
import { acceptanceSequence, matchSuggestion, type SnippetSuggestion } from '../snippet-suggest'
import { getTerminalTheme } from '../themes'

interface Props {
  sessionId: string
  active: boolean
  settings: AppSettings
  /** 右键菜单：由上层定位并渲染菜单本体 */
  onContextMenu?: (event: React.MouseEvent<HTMLDivElement>) => void
}

/**
 * 终端视图。
 *
 * 关键设计：xterm 实例与它的宿主 div 由 terminal-registry 常驻，本组件只负责
 * 「把宿主 div 搬进当前容器」以及焦点/尺寸适配。因此：
 *  - 分屏重排导致组件卸载重建时，终端历史输出不丢（只是 DOM reparent）；
 *  - 切换标签页 / 分屏只是 CSS 隐藏，终端仍在后台接收数据。
 * 真正销毁实例的时机是会话关闭（store 中调用 disposeTerminal）。
 */
export function TerminalView({ sessionId, active, settings, onContextMenu }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  /** 当前输入行能补全成的命令（片段触发词） */
  const [suggestion, setSuggestion] = useState<SnippetSuggestion | null>(null)
  const suggestionRef = useRef<SnippetSuggestion | null>(null)
  const settingsRef = useRef(settings)
  settingsRef.current = settings

  useLayoutEffect(() => {
    const container = containerRef.current
    if (!container) return

    const entry = acquireTerminal(sessionId, settingsRef.current)
    container.appendChild(entry.host)

    requestAnimationFrame(() => {
      fitTerminal(sessionId)
      entry.term.refresh(0, Math.max(0, entry.term.rows - 1))
      if (active) entry.term.focus()
    })

    // 焦点跟踪：主进程据此区分「终端剪贴板」与「输入框系统编辑命令」
    const textarea = entry.term.textarea
    const handleFocus = () => {
      setFocusedSession(sessionId)
      window.jshell.terminal.setFocused(true)
      // 键盘/点击进入某个分屏时，同步 store 里的「当前分屏」，高亮才不会错位
      useAppStore.getState().focusSession(sessionId)
    }
    const handleBlur = () => {
      setFocusedSession(null)
      window.jshell.terminal.setFocused(false)
    }
    textarea?.addEventListener('focus', handleFocus)
    textarea?.addEventListener('blur', handleBlur)

    // 尺寸变化合并到下一帧再 fit：拖窗口时 ResizeObserver 一帧可能回调多次，
    // 每次都 fit 会重复测量 DOM 并向主进程发多余的 resize IPC
    let frame = 0
    const scheduleFit = (): void => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        fitTerminal(sessionId)
      })
    }
    // ---- 片段补全：像 shell 的 alias 一样，输入触发词按 Tab 补全 ----
    const applySuggestion = (next: SnippetSuggestion | null): void => {
      const current = suggestionRef.current
      // 只有内容真的变了才更新，避免每次渲染都触发 React 重渲染
      if (current === next) return
      if (current && next && current.typed === next.typed && current.full === next.full) return
      suggestionRef.current = next
      setSuggestion(next)
    }
    const updateSuggestion = (): void => {
      const term = getTerminal(sessionId)
      if (!term) return
      const buffer = term.buffer.active
      const line = buffer.getLine(buffer.cursorY)
      if (!line) {
        applySuggestion(null)
        return
      }
      // 只看光标处的最后一个词：整行里还带着 shell 提示符（`~ gps`），
      // 而且触发词就是命令名所在的那个词
      const before = line.translateToString(true).slice(0, buffer.cursorX)
      const token = before.match(/[^\s]*$/)?.[0] ?? ''
      applySuggestion(matchSuggestion(useAppStore.getState().snippets, token))
    }
    // 必须用 onRender（渲染完成后）而不是 onData（用户输入时）：
    // onData 触发时 pty 还没回显，xterm buffer 里还是旧内容，匹配不到触发词
    const renderDisposable = entry.term.onRender(() => updateSuggestion())
    // xterm 的 attachCustomKeyEventHandler 返回 void，没有 dispose
    entry.term.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown' || event.key !== 'Tab') return true
      const current = suggestionRef.current
      if (!current) return true
      event.preventDefault()
      // 先退格删掉已经输入的触发词，再写补全后的整行；不代为回车，交给用户确认
      window.jshell.sessions.write(sessionId, acceptanceSequence(current))
      applySuggestion(null)
      return false
    })

    const observer = new ResizeObserver(scheduleFit)
    observer.observe(container)

    return () => {
      if (frame) cancelAnimationFrame(frame)
      observer.disconnect()
      textarea?.removeEventListener('focus', handleFocus)
      textarea?.removeEventListener('blur', handleBlur)
      renderDisposable.dispose()
      // 只摘除宿主节点，不销毁终端（终端生命周期由会话决定）
      if (entry.host.parentElement === container) container.removeChild(entry.host)
    }
    // active 只影响初次聚焦，不进依赖，避免切换时重建监听
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  // 设置变更：合并 120ms 后再更新，拖动滑块时不再每个 tick 重排所有终端
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const term = getTerminal(sessionId)
      if (!term) return
      term.options.fontFamily = settings.fontFamily
      term.options.fontSize = settings.fontSize
      term.options.cursorBlink = settings.cursorBlink
      // 后台标签维持收窄后的缓冲，避免改设置把内存又顶回去
      term.options.scrollback = active ? settings.scrollback : hiddenScrollback(settings)
      term.options.theme = getTerminalTheme(settings.terminalTheme)
      requestAnimationFrame(() => fitTerminal(sessionId))
    }, 120)
    return () => window.clearTimeout(timer)
  }, [settings, sessionId, active])

  // 可见性变化：后台标签收窄 scrollback，切回可见时恢复用户设置
  useEffect(() => {
    setTerminalVisible(sessionId, active, settings)
  }, [active, sessionId, settings])

  // 从隐藏切回可见时重新测量并聚焦
  useEffect(() => {
    if (!active) return
    const id = requestAnimationFrame(() => {
      fitTerminal(sessionId)
      const term = getTerminal(sessionId)
      term?.focus()
      if (term) term.refresh(0, Math.max(0, term.rows - 1))
    })
    return () => cancelAnimationFrame(id)
  }, [active, sessionId])

  return (
    <div
      className="terminal-wrap"
      ref={containerRef}
      onContextMenu={(event) => {
        event.preventDefault()
        onContextMenu?.(event)
      }}
    >
      {suggestion && (
        <div className="snippet-suggest">
          <span className="snippet-suggest-from">
            {suggestion.matchedAlias ?? suggestion.snippet.name}
          </span>
          <span className="snippet-suggest-arrow">→</span>
          <code>{suggestion.full.slice(suggestion.typed.length) || suggestion.full}</code>
          <em>Tab 补全</em>
        </div>
      )}
    </div>
  )
}

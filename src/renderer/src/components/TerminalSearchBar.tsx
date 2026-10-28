import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { getSearchAddon } from '../terminal-registry'
import { IconClose, IconSearch } from '../icons'

interface Props {
  sessionId: string
  onClose: () => void
}

/**
 * 终端搜索条（@xterm/addon-search）。
 * 行为：输入即增量搜索；Enter 下一个、Shift+Enter 上一个、Esc 关闭。
 * 关闭时清除高亮装饰，避免"关掉了还留着黄块"。
 */
export function TerminalSearchBar({ sessionId, onClose }: Props) {
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<{ index: number; total: number } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useLayoutEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    const addon = getSearchAddon(sessionId)
    if (!addon) return
    const sub = addon.onDidChangeResults(({ resultIndex, resultCount }) => {
      setResult(resultCount > 0 ? { index: resultIndex, total: resultCount } : null)
    })
    return () => {
      sub.dispose()
      addon.clearDecorations()
    }
  }, [sessionId])

  const find = (direction: 'next' | 'prev', incremental = false) => {
    const addon = getSearchAddon(sessionId)
    if (!addon || !query) return
    const options = { incremental, caseSensitive: false }
    if (direction === 'next') addon.findNext(query, options)
    else addon.findPrevious(query, options)
  }

  return (
    <div className="search-bar" onMouseDown={(e) => e.stopPropagation()}>
      <IconSearch />
      <input
        ref={inputRef}
        className="search-input"
        placeholder="在终端中搜索…"
        value={query}
        onChange={(e) => {
          const value = e.target.value
          setQuery(value)
          if (!value) {
            getSearchAddon(sessionId)?.clearDecorations()
            setResult(null)
            return
          }
          const addon = getSearchAddon(sessionId)
          addon?.findNext(value, { incremental: true, caseSensitive: false })
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            find(e.shiftKey ? 'prev' : 'next')
          } else if (e.key === 'Escape') {
            e.preventDefault()
            onClose()
          }
        }}
      />
      <span className="search-count">{result ? `${result.index + 1}/${result.total}` : '—'}</span>
      <button className="icon-btn tiny" title="上一个 (⇧Enter)" onClick={() => find('prev')}>
        ↑
      </button>
      <button className="icon-btn tiny" title="下一个 (Enter)" onClick={() => find('next')}>
        ↓
      </button>
      <button className="icon-btn tiny" title="关闭 (Esc)" onClick={onClose}>
        <IconClose />
      </button>
    </div>
  )
}

import { useEffect, useRef, useState } from 'react'
import type { TextFile } from '@shared/types'
import { errorMessage } from '../utils'
import { IconClose, IconRefresh, IconSave } from '../icons'

interface Props {
  /** 标题：文件名 */
  title: string
  /** 完整路径，显示在标题下方 */
  path: string
  load: () => Promise<TextFile>
  save: (text: string) => Promise<void>
  onClose: () => void
  /** 保存成功后通知外层刷新列表 */
  onSaved?: () => void
}

/**
 * 内置文本编辑器。
 *
 * 只做「读入 -> 编辑 -> 原子保存」，不依赖远端 vim/nano；
 * 二进制与超过 2 MB 的文件在主进程侧被拒绝，这里只负责展示错误。
 */
export function TextEditor({ title, path, load, save, onClose, onSaved }: Props) {
  const [text, setText] = useState('')
  const [initial, setInitial] = useState('')
  const [size, setSize] = useState(0)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const loadRef = useRef(load)
  const areaRef = useRef<HTMLTextAreaElement>(null)
  const dirty = text !== initial

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const file = await loadRef.current()
        if (!alive) return
        setText(file.text)
        setInitial(file.text)
        setSize(file.size)
        requestAnimationFrame(() => areaRef.current?.focus())
      } catch (err) {
        if (alive) setError(errorMessage(err))
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  const doSave = async (): Promise<void> => {
    if (saving || loading || !!error || !dirty) return
    setSaving(true)
    setError('')
    setMessage('')
    try {
      await save(text)
      setInitial(text)
      setSize(new TextEncoder().encode(text).length)
      setMessage('已保存')
      onSaved?.()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        void doSave()
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        if (dirty) {
          setError('有未保存的修改：按 ⌘/Ctrl + S 保存，或点「放弃修改」关闭')
          return
        }
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const lines = text.length === 0 ? 1 : text.split('\n').length

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal editor-modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <div className="editor-title">
            <h2>
              {title}
              {dirty && <span className="editor-dirty" title="有未保存的修改">•</span>}
            </h2>
            <span className="editor-path mono" title={path}>
              {path}
            </span>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} title="关闭">
            <IconClose />
          </button>
        </header>

        <div className="editor-body">
          {loading ? (
            <div className="files-hint">读取中…</div>
          ) : (
            <textarea
              ref={areaRef}
              className="editor-textarea mono"
              value={text}
              spellCheck={false}
              readOnly={!!error}
              onChange={(e) => {
                setText(e.target.value)
                setMessage('')
              }}
              onKeyDown={(e) => {
                // Tab 插入两个空格，避免焦点跳出编辑区
                if (e.key === 'Tab') {
                  e.preventDefault()
                  const area = e.currentTarget
                  const start = area.selectionStart
                  const end = area.selectionEnd
                  setText(`${text.slice(0, start)}  ${text.slice(end)}`)
                  requestAnimationFrame(() => {
                    area.selectionStart = start + 2
                    area.selectionEnd = start + 2
                  })
                }
              }}
            />
          )}
        </div>

        {error && <p className="editor-error">{error}</p>}

        <footer className="modal-foot">
          <span className="editor-meta">
            {loading ? '—' : `${lines} 行 · ${size} 字节`}
            {message && <em className="editor-saved">{message}</em>}
          </span>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              setText(initial)
              setError('')
              setMessage('')
            }}
            disabled={!dirty || saving}
          >
            <IconRefresh />
            撤销修改
          </button>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            {dirty ? '放弃修改' : '关闭'}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void doSave()}
            disabled={!dirty || saving || loading || !!error}
          >
            <IconSave />
            {saving ? '保存中…' : '保存'}
          </button>
        </footer>
      </div>
    </div>
  )
}

import { useCallback, useEffect, useRef, useState } from 'react'
import type { FileEntry } from '@shared/types'
import { useAppStore } from '../store'
import { errorMessage, formatBytes, formatDateTime, localJoin, localParent } from '../utils'
import {
  IconChevronLeft,
  IconEdit,
  IconFile,
  IconFolder,
  IconHome,
  IconLink,
  IconLocate,
  IconRefresh,
  IconTrash
} from '../icons'
import { TextEditor } from './TextEditor'

interface Props {
  active: boolean
}

interface PromptState {
  mode: 'mkdir' | 'rename'
  value: string
  target?: FileEntry
}

/** 本地文件面板：浏览、新建、重命名、移入回收站、系统定位 */
export function LocalFilesPanel({ active }: Props) {
  const pushToast = useAppStore((s) => s.pushToast)
  const [cwd, setCwd] = useState('')
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [prompt, setPrompt] = useState<PromptState | null>(null)
  const [editing, setEditing] = useState<FileEntry | null>(null)
  const [pathDraft, setPathDraft] = useState('')
  const initialized = useRef(false)

  const load = useCallback(
    async (target: string) => {
      setLoading(true)
      setError('')
      setSelected(null)
      try {
        const list = await window.jshell.localFs.list(target)
        setEntries(list)
        setCwd(target)
      } catch (err) {
        setError(errorMessage(err))
      } finally {
        setLoading(false)
      }
    },
    []
  )

  useEffect(() => {
    if (!active || initialized.current) return
    initialized.current = true
    void window.jshell.localFs
      .home()
      .then(load)
      .catch((err) => {
        setError(errorMessage(err))
        setLoading(false)
      })
  }, [active, load])

  const submitPrompt = async (value: string) => {
    const name = value.trim()
    if (!prompt || !name) return
    if (name === '.' || name === '..' || /[/\\]/.test(name)) {
      pushToast('名称不能包含 / 或 \\，也不能是 . 或 ..', 'error')
      return
    }
    try {
      if (prompt.mode === 'mkdir') {
        await window.jshell.localFs.mkdir(localJoin(cwd, name))
      } else {
        if (!prompt.target) throw new Error('未选择要重命名的文件')
        await window.jshell.localFs.rename(
          prompt.target.path,
          localJoin(localParent(prompt.target.path), name)
        )
      }
      setPrompt(null)
      await load(cwd)
    } catch (err) {
      pushToast(errorMessage(err), 'error')
    }
  }

  const handleDelete = async (entry: FileEntry) => {
    const ok = await window.jshell.dialog.confirm({
      title: '移入回收站',
      message: `确定把「${entry.name}」移入回收站？`,
      detail: '可以从系统回收站恢复。',
      danger: true
    })
    if (!ok) return
    try {
      await window.jshell.localFs.remove(entry.path)
      await load(cwd)
      pushToast('已移入回收站', 'success')
    } catch (err) {
      pushToast(errorMessage(err), 'error')
    }
  }

  useEffect(() => setPathDraft(cwd), [cwd])

  /** 地址栏跳转：支持绝对路径、~、相对当前目录 */
  const goToPath = async (): Promise<void> => {
    const raw = pathDraft.trim()
    if (!raw) return
    let target = raw
    if (raw === '~' || raw.startsWith('~/')) {
      const home = await window.jshell.localFs.home()
      target = raw === '~' ? home : localJoin(home, raw.slice(2))
    } else if (!/^([A-Za-z]:[\\/]|\/)/.test(raw)) {
      target = localJoin(cwd, raw)
    }
    await load(target)
  }

  return (
    <div className="files-panel">
      <div className="files-toolbar">
        <button className="icon-btn" title="上一级" onClick={() => void load(localParent(cwd))}>
          <IconChevronLeft />
        </button>
        <button
          className="icon-btn"
          title="主目录"
          onClick={() =>
            void window.jshell.localFs
              .home()
              .then(load)
              .catch((err) => pushToast(errorMessage(err), 'error'))
          }
        >
          <IconHome />
        </button>
        <button className="icon-btn" title="刷新" onClick={() => void load(cwd)}>
          <IconRefresh />
        </button>

        <input
          className="input files-path-input mono"
          value={pathDraft}
          spellCheck={false}
          placeholder="粘贴路径后回车跳转（支持 ~ 与 ..）"
          title="路径（⌘/Ctrl + L 聚焦）"
          onChange={(e) => setPathDraft(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={() => setPathDraft(cwd)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void goToPath()
            if (e.key === 'Escape') {
              setPathDraft(cwd)
              e.currentTarget.blur()
            }
          }}
        />

        <div className="files-actions">
          <button className="btn btn-ghost" onClick={() => setPrompt({ mode: 'mkdir', value: '' })}>
            新建目录
          </button>
        </div>
      </div>

      {error && (
        <div className="files-error">
          <span>{error}</span>
          <button className="btn btn-ghost" onClick={() => void load(cwd)}>
            重试
          </button>
        </div>
      )}

      <div className="files-table">
        <div className="files-head">
          <span>名称</span>
          <span className="col-size">大小</span>
          <span className="col-time">修改时间</span>
          <span className="col-ops" />
        </div>

        <div className="files-body">
          {loading && <div className="files-hint">加载中…</div>}
          {!loading && entries.length === 0 && !error && <div className="files-hint">空目录</div>}

          {entries.map((entry) => (
            <div
              key={entry.path}
              className={`files-row${selected === entry.path ? ' is-selected' : ''}`}
              onClick={() => setSelected(entry.path)}
              onDoubleClick={() => {
                if (entry.type === 'dir') void load(entry.path)
                else if (entry.type === 'file') setEditing(entry)
                else window.jshell.localFs.reveal(entry.path)
              }}
            >
              <span className="col-name">
                <span className={`file-icon type-${entry.type}`}>
                  {entry.type === 'dir' ? (
                    <IconFolder />
                  ) : entry.type === 'link' ? (
                    <IconLink />
                  ) : (
                    <IconFile />
                  )}
                </span>
                <span className="file-name" title={entry.path}>
                  {entry.name}
                </span>
              </span>
              <span className="col-size">{entry.type === 'dir' ? '—' : formatBytes(entry.size)}</span>
              <span className="col-time">{formatDateTime(entry.mtime)}</span>
              <span className="col-ops">
                <button
                  className="icon-btn tiny"
                  title="在系统中显示"
                  onClick={(e) => {
                    e.stopPropagation()
                    window.jshell.localFs.reveal(entry.path)
                  }}
                >
                  <IconLocate />
                </button>
                <button
                  className="icon-btn tiny"
                  title="重命名"
                  onClick={(e) => {
                    e.stopPropagation()
                    setPrompt({ mode: 'rename', value: entry.name, target: entry })
                  }}
                >
                  <IconEdit />
                </button>
                <button
                  className="icon-btn tiny danger"
                  title="移入回收站"
                  onClick={(e) => {
                    e.stopPropagation()
                    void handleDelete(entry)
                  }}
                >
                  <IconTrash />
                </button>
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="files-footer">
        {entries.length} 项 · 双击目录进入，双击文件在系统中显示
      </div>

      {prompt && (
        <div className="mini-modal-mask" onClick={() => setPrompt(null)}>
          <div className="mini-modal" onClick={(e) => e.stopPropagation()}>
            <div className="mini-modal-title">{prompt.mode === 'mkdir' ? '新建目录' : '重命名'}</div>
            <input
              autoFocus
              className="input"
              value={prompt.value}
              placeholder={prompt.mode === 'mkdir' ? '目录名称' : '新名称'}
              onChange={(e) => setPrompt({ ...prompt, value: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submitPrompt(prompt.value)
                if (e.key === 'Escape') setPrompt(null)
              }}
            />
            <div className="mini-modal-actions">
              <button className="btn btn-ghost" onClick={() => setPrompt(null)}>
                取消
              </button>
              <button className="btn btn-primary" onClick={() => void submitPrompt(prompt.value)}>
                确定
              </button>
            </div>
          </div>
        </div>
      )}

      {editing && (
        <TextEditor
          title={editing.name}
          path={editing.path}
          load={() => window.jshell.localFs.readText(editing.path)}
          save={(text) => window.jshell.localFs.writeText(editing.path, text)}
          onClose={() => setEditing(null)}
          onSaved={() => void load(cwd)}
        />
      )}
    </div>
  )
}

import { useCallback, useEffect, useRef, useState } from 'react'
import type { FileEntry } from '@shared/types'
import { useAppStore } from '../store'
import { errorMessage, formatBytes, formatDateTime, joinRemote, parentRemote } from '../utils'
import {
  IconChevronLeft,
  IconDownload,
  IconEdit,
  IconFile,
  IconFolder,
  IconHome,
  IconLink,
  IconRefresh,
  IconTrash,
  IconUpload
} from '../icons'
import { TextEditor } from './TextEditor'

interface Props {
  sessionId: string
  active: boolean
}

interface PromptState {
  mode: 'mkdir' | 'rename'
  value: string
  /** rename 模式下的目标项 */
  target?: FileEntry
}

/**
 * 远端文件面板。
 *
 * 复用当前 SSH 连接的 SFTP 子通道，不额外建立连接；
 * 上传/下载走主进程流式管道，进度通过 evt:session(transfer) 推送到状态栏。
 */
export function FilesPanel({ sessionId, active }: Props) {
  const pushToast = useAppStore((s) => s.pushToast)
  const [cwd, setCwd] = useState('')
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [prompt, setPrompt] = useState<PromptState | null>(null)
  const [editing, setEditing] = useState<FileEntry | null>(null)
  /** 地址栏草稿：回车跳转，失焦回到当前目录 */
  const [pathDraft, setPathDraft] = useState('')
  const initialized = useRef(false)

  const load = useCallback(
    async (target: string) => {
      setLoading(true)
      setError('')
      setSelected(new Set())
      try {
        const list = await window.jshell.sftp.list(sessionId, target || '/')
        setEntries(list)
        setCwd(target || '/')
      } catch (err) {
        setError(errorMessage(err))
      } finally {
        setLoading(false)
      }
    },
    [sessionId]
  )

  useEffect(() => {
    if (!active || initialized.current) return
    initialized.current = true
    void (async () => {
      try {
        const home = await window.jshell.sftp.home(sessionId)
        await load(home)
      } catch (err) {
        setError(errorMessage(err))
        setLoading(false)
      }
    })()
  }, [active, load, sessionId])

  const handleDownload = async (entry: FileEntry) => {
    try {
      const result = await window.jshell.sftp.download(sessionId, entry.path)
      if (!result.canceled && result.path) pushToast(`已保存到 ${result.path}`, 'success')
    } catch (err) {
      pushToast(errorMessage(err), 'error')
    }
  }

  const toggleSelected = (path: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const handleDownloadSelected = async () => {
    if (selected.size === 0) return
    const dir = await window.jshell.dialog.pickDirectory({ title: '选择下载目录' })
    if (!dir) return
    try {
      const result = await window.jshell.sftp.downloadTo(sessionId, [...selected], dir)
      pushToast(`已下载 ${result.count} 个文件`, 'success')
    } catch (err) {
      pushToast(errorMessage(err), 'error')
    }
  }

  const handleUploadDir = async () => {
    try {
      const result = await window.jshell.sftp.uploadDir(sessionId, cwd)
      if (!result.canceled) {
        pushToast(`已上传目录内 ${result.count} 个文件`, 'success')
        await load(cwd)
      }
    } catch (err) {
      pushToast(errorMessage(err), 'error')
    }
  }

  const handleUpload = async () => {
    try {
      const result = await window.jshell.sftp.upload(sessionId, cwd)
      if (!result.canceled) {
        pushToast(`已上传 ${result.count} 个文件`, 'success')
        await load(cwd)
      }
    } catch (err) {
      pushToast(errorMessage(err), 'error')
    }
  }

  const handleDelete = async (entry: FileEntry) => {
    const ok = await window.jshell.dialog.confirm({
      title: '删除确认',
      message: `确定删除「${entry.name}」？`,
      detail: entry.type === 'dir' ? '该目录及其内部所有文件都会被删除，操作不可撤销。' : '操作不可撤销。',
      danger: true
    })
    if (!ok) return
    try {
      await window.jshell.sftp.remove(sessionId, entry.path, entry.type === 'dir')
      await load(cwd)
      pushToast('已删除', 'success')
    } catch (err) {
      pushToast(errorMessage(err), 'error')
    }
  }

  const submitPrompt = async (value: string) => {
    const name = value.trim()
    if (!prompt || !name) return
    // 本地先拦一次，给即时反馈；主进程还会再校验一遍（IPC 是信任边界）
    if (name === '.' || name === '..' || /[/\\]/.test(name)) {
      pushToast('名称不能包含 / 或 \\，也不能是 . 或 ..', 'error')
      return
    }
    if ([...name].length > 255) {
      pushToast('名称过长（最多 255 个字符）', 'error')
      return
    }

    try {
      if (prompt.mode === 'mkdir') {
        await window.jshell.sftp.mkdir(sessionId, joinRemote(cwd, name))
      } else {
        if (!prompt.target) throw new Error('未选择要重命名的文件')
        await window.jshell.sftp.rename(sessionId, prompt.target.path, joinRemote(cwd, name))
      }
      setPrompt(null)
      await load(cwd)
    } catch (err) {
      pushToast(errorMessage(err), 'error')
    }
  }

  useEffect(() => setPathDraft(cwd), [cwd])

  /** 地址栏跳转：支持绝对路径、~、相对当前目录 */
  const goToPath = async (): Promise<void> => {
    const raw = pathDraft.trim()
    if (!raw) return
    try {
      let target = raw
      if (raw === '~' || raw.startsWith('~/')) {
        const home = await window.jshell.sftp.home(sessionId)
        target = raw === '~' ? home : joinRemote(home, raw.slice(2))
      } else if (!raw.startsWith('/')) {
        target = joinRemote(cwd, raw)
      }
      await load(target)
    } catch (err) {
      pushToast(errorMessage(err), 'error')
      setPathDraft(cwd)
    }
  }

  return (
    <div className="files-panel">
      <div className="files-toolbar">
        <button className="icon-btn" title="上一级" onClick={() => void load(parentRemote(cwd))}>
          <IconChevronLeft />
        </button>
        <button
          className="icon-btn"
          title="主目录"
          onClick={() =>
            void window.jshell.sftp
              .home(sessionId)
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
          <button className="btn btn-ghost" onClick={() => void handleUploadDir()}>
            上传目录
          </button>
          <button className="btn btn-primary" onClick={() => void handleUpload()}>
            <IconUpload />
            上传
          </button>
          {selected.size > 0 && (
            <button className="btn btn-ghost" onClick={() => void handleDownloadSelected()}>
              下载选中（{selected.size}）
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="files-error">
          <span>{error}</span>
          <button className="btn btn-ghost" onClick={() => void load(cwd || '/')}>
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
              className={`files-row${selected.has(entry.path) ? ' is-selected' : ''}`}
              onClick={() => toggleSelected(entry.path)}
              onDoubleClick={() =>
                entry.type === 'dir'
                  ? void load(entry.path)
                  : entry.type === 'file'
                    ? setEditing(entry)
                    : void handleDownload(entry)
              }
            >
              <span className="col-name">
                <input
                  type="checkbox"
                  className="file-check"
                  checked={selected.has(entry.path)}
                  onClick={(e) => e.stopPropagation()}
                  onChange={() => toggleSelected(entry.path)}
                  title="选择"
                />
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
                {entry.type !== 'dir' && (
                  <button
                    className="icon-btn tiny"
                    title="下载"
                    onClick={(e) => {
                      e.stopPropagation()
                      void handleDownload(entry)
                    }}
                  >
                    <IconDownload />
                  </button>
                )}
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
                  title="删除"
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
        {entries.length} 项 · 双击目录进入，双击文本文件用内置编辑器打开（目录树在终端上方）
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
          load={() => window.jshell.sftp.readText(sessionId, editing.path)}
          save={(text) => window.jshell.sftp.writeText(sessionId, editing.path, text)}
          onClose={() => setEditing(null)}
          onSaved={() => void load(cwd)}
        />
      )}
    </div>
  )
}

import { useCallback, useEffect, useRef, useState } from 'react'
import type { FileEntry } from '@shared/types'
import { useAppStore } from '../store'
import { errorMessage, formatBytes, parentRemote } from '../utils'
import { TextEditor } from './TextEditor'
import {
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconCode,
  IconFile,
  IconFolder,
  IconLink,
  IconLocate,
  IconRefresh
} from '../icons'

interface Props {
  /** 当前选中的 SSH 会话 */
  sessionId: string
}

/**
 * 左侧栏的目录树（跟随终端当前工作目录）。
 *
 * 与主机列表同列、位于其下方，跟随「当前选中的终端」；多分屏/多标签切换时
 * 自动切到该会话的目录。终端的 cwd 由主进程解析 OSC 7 上报，cd 后实时刷新。
 */
export function SidebarTree({ sessionId }: Props) {
  const pushToast = useAppStore((s) => s.pushToast)
  const open = useAppStore((s) => s.treeOpen)
  const height = useAppStore((s) => s.treeHeight)
  const toggleTree = useAppStore((s) => s.toggleTree)
  const setTreeHeight = useAppStore((s) => s.setTreeHeight)
  const cwd = useAppStore((s) => s.cwdBySession[sessionId])

  /** 当前浏览到的目录（默认跟随 cwd，也可手动点进子目录） */
  const [viewDir, setViewDir] = useState('')
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<FileEntry | null>(null)
  const dragRef = useRef<{ startY: number; startHeight: number } | null>(null)
  const prevCwdRef = useRef<string | undefined>(undefined)

  const load = useCallback(
    async (dir: string): Promise<void> => {
      if (!dir) return
      setViewDir(dir)
      setLoading(true)
      setError('')
      try {
        setEntries(await window.jshell.sftp.list(sessionId, dir))
      } catch (err) {
        setEntries([])
        // 目录不存在 / 无权限时明确提示，绝不静默回退到 /root
        setError(errorMessage(err))
      } finally {
        setLoading(false)
      }
    },
    [sessionId]
  )

  // 切换会话：初始化到该会话已上报的 cwd，未知则回落到 home
  useEffect(() => {
    prevCwdRef.current = cwd
    if (cwd) {
      void load(cwd)
      return
    }
    let alive = true
    void window.jshell.sftp
      .home(sessionId)
      .then((home) => {
        if (alive) void load(home)
      })
      .catch((err) => {
        if (alive) setError(errorMessage(err))
      })
    return () => {
      alive = false
    }
    // 仅切换会话时执行；cwd 变化走下面的 effect
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  // 终端 cd / 新会话首个提示符上报 cwd 后实时跟随
  useEffect(() => {
    if (cwd && cwd !== prevCwdRef.current) {
      prevCwdRef.current = cwd
      void load(cwd)
    }
  }, [cwd, load])

  const locate = (): void => {
    if (cwd) void load(cwd)
    else pushToast('尚未获取到当前目录，请先在终端里执行一条命令', 'info')
  }

  /** 拖动上边缘调整高度：往上拖变高 */
  const startResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    dragRef.current = { startY: event.clientY, startHeight: height }
    document.body.classList.add('is-resizing')

    const onMove = (moveEvent: PointerEvent): void => {
      const start = dragRef.current
      if (!start) return
      setTreeHeight(start.startHeight - (moveEvent.clientY - start.startY))
    }
    const onUp = (): void => {
      dragRef.current = null
      document.body.classList.remove('is-resizing')
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const iconFor = (entry: FileEntry) => {
    if (entry.type === 'dir') return <IconFolder />
    if (entry.type === 'link') return <IconLink />
    return <IconFile />
  }

  return (
    <section className="sidebar-tree" style={{ height: open ? height : 30 }}>
      {open && <div className="sidebar-tree-resize" onPointerDown={startResize} title="拖动调整高度" />}

      <header className="sidebar-tree-head">
        <button
          className="sidebar-tree-toggle"
          title={open ? '收起目录树' : '展开目录树'}
          onClick={toggleTree}
        >
          {open ? <IconChevronDown /> : <IconChevronRight />}
        </button>
        <span className="sidebar-tree-title">目录树</span>
        <span className="sidebar-tree-path mono" title={viewDir}>
          {viewDir || (cwd ? cwd : '读取中…')}
        </span>
        <button
          className="icon-btn tiny"
          title="定位当前目录"
          onClick={locate}
        >
          <IconLocate />
        </button>
        <button
          className="icon-btn tiny"
          title="上一级"
          onClick={() => void load(parentRemote(viewDir))}
          disabled={!viewDir || viewDir === '/'}
        >
          <IconChevronLeft />
        </button>
        <button
          className="icon-btn tiny"
          title="刷新"
          onClick={() => void load(viewDir)}
        >
          <IconRefresh />
        </button>
      </header>

      {open && viewDir && (
        <div className="sidetree-body">
          {loading && entries.length === 0 && <div className="sidetree-hint">加载中…</div>}
          {!loading && error && <div className="sidetree-hint is-error">{error}</div>}
          {!error &&
            entries.map((entry) => (
              <div
                key={entry.path}
                className="sidetree-row"
                title={entry.path}
                onDoubleClick={() =>
                  entry.type === 'dir' || entry.type === 'link' ? void load(entry.path) : setEditing(entry)
                }
              >
                <span className={`sidetree-icon type-${entry.type}`}>{iconFor(entry)}</span>
                <span className="sidetree-name">{entry.name}</span>
                <span className="sidetree-meta">
                  {entry.type !== 'dir' ? formatBytes(entry.size) : ''}
                </span>
                <span className="sidetree-ops">
                  {entry.type === 'file' && (
                    <button
                      className="icon-btn tiny"
                      title="编辑"
                      onClick={(e) => {
                        e.stopPropagation()
                        setEditing(entry)
                      }}
                    >
                      <IconCode />
                    </button>
                  )}
                </span>
              </div>
            ))}
          {!loading && !error && entries.length === 0 && <div className="sidetree-hint">空目录</div>}
        </div>
      )}

      {editing && (
        <TextEditor
          title={editing.name}
          path={editing.path}
          load={() => window.jshell.sftp.readText(sessionId, editing.path)}
          save={(text) => window.jshell.sftp.writeText(sessionId, editing.path, text)}
          onClose={() => setEditing(null)}
          onSaved={() => void load(viewDir)}
        />
      )}
    </section>
  )
}

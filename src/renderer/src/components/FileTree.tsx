import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FileEntry } from '@shared/types'
import { errorMessage, formatBytes } from '../utils'
import {
  IconChevronDown,
  IconChevronRight,
  IconCode,
  IconEdit,
  IconFile,
  IconFolder,
  IconLink,
  IconTrash
} from '../icons'

interface Props {
  sessionId: string
  /** 树的根目录（通常是登录后的 home 或当前目录） */
  rootPath: string
  /** 变更计数：外层增删改后 +1，触发已展开目录重新拉取 */
  refreshKey: number
  onOpenFile: (entry: FileEntry) => void
  /** 省略时不显示对应行内操作（用于只读的目录树 Dock） */
  onRename?: (entry: FileEntry) => void
  onRemove?: (entry: FileEntry) => void
}

interface Row {
  entry: FileEntry
  depth: number
}

/**
 * 远端目录树：按需加载、记住展开状态。
 *
 * 只在展开某个目录时发起一次 sftp.readdir，避免一次性递归整棵树；
 * 数据留在组件内部，外层增删改后通过 refreshKey 触发已展开目录的刷新。
 */
export function FileTree({
  sessionId,
  rootPath,
  refreshKey,
  onOpenFile,
  onRename,
  onRemove
}: Props) {
  const [cache, setCache] = useState<Map<string, FileEntry[]>>(new Map())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState<Set<string>>(new Set())
  const [error, setError] = useState('')
  const expandedRef = useRef<Set<string>>(new Set())

  const loadDir = useCallback(
    async (dirPath: string): Promise<void> => {
      setLoading((prev) => new Set(prev).add(dirPath))
      try {
        const list = await window.jshell.sftp.list(sessionId, dirPath)
        setCache((prev) => new Map(prev).set(dirPath, list))
        setError('')
      } catch (err) {
        setError(errorMessage(err))
      } finally {
        setLoading((prev) => {
          const next = new Set(prev)
          next.delete(dirPath)
          return next
        })
      }
    },
    [sessionId]
  )

  // 根目录变化：重置缓存，默认展开根
  useEffect(() => {
    setCache(new Map())
    setError('')
    const next = new Set([rootPath])
    expandedRef.current = next
    setExpanded(next)
    void loadDir(rootPath)
  }, [rootPath, sessionId, loadDir])

  // 增删改后刷新根与所有已展开目录，保留展开状态
  useEffect(() => {
    if (refreshKey === 0) return
    for (const dirPath of [rootPath, ...expandedRef.current]) void loadDir(dirPath)
  }, [refreshKey, rootPath, loadDir])

  const toggle = (entry: FileEntry): void => {
    const next = new Set(expandedRef.current)
    if (next.has(entry.path)) {
      next.delete(entry.path)
    } else {
      next.add(entry.path)
      if (!cache.has(entry.path)) void loadDir(entry.path)
    }
    expandedRef.current = next
    setExpanded(next)
  }

  const rows = useMemo(() => {
    const result: Row[] = []
    const walk = (dirPath: string, depth: number): void => {
      for (const entry of cache.get(dirPath) ?? []) {
        result.push({ entry, depth })
        if (entry.type === 'dir' && expanded.has(entry.path)) walk(entry.path, depth + 1)
      }
    }
    walk(rootPath, 0)
    return result
  }, [cache, expanded, rootPath])

  const rootLoading = loading.has(rootPath) && rows.length === 0

  return (
    <div className="file-tree">
      {error && (
        <div className="files-error">
          <span>{error}</span>
          <button className="btn btn-ghost" onClick={() => void loadDir(rootPath)}>
            重试
          </button>
        </div>
      )}

      <div className="tree-body">
        {rootLoading && <div className="files-hint">加载中…</div>}
        {!rootLoading && rows.length === 0 && !error && <div className="files-hint">空目录</div>}

        {rows.map(({ entry, depth }) => {
          const isDir = entry.type === 'dir'
          const open = expanded.has(entry.path)
          return (
            <div
              key={entry.path}
              className="tree-row"
              style={{ paddingLeft: 6 + depth * 14 }}
              onDoubleClick={() => {
                if (isDir) toggle(entry)
                else if (entry.type === 'file') onOpenFile(entry)
              }}
              title={entry.path}
            >
              <button
                className={`tree-toggle${isDir ? '' : ' is-empty'}${open ? ' is-open' : ''}`}
                title={isDir ? (open ? '折叠' : '展开') : undefined}
                onClick={(e) => {
                  e.stopPropagation()
                  if (isDir) toggle(entry)
                }}
              >
                {isDir ? open ? <IconChevronDown /> : <IconChevronRight /> : null}
              </button>

              <span className={`file-icon type-${entry.type}`}>
                {isDir ? <IconFolder /> : entry.type === 'link' ? <IconLink /> : <IconFile />}
              </span>

              <span className="tree-name">{entry.name}</span>
              {isDir && loading.has(entry.path) && <span className="tree-loading">…</span>}

              <span className="tree-size">{isDir ? '' : formatBytes(entry.size)}</span>

              <span className="tree-ops">
                {!isDir && entry.type === 'file' && (
                  <button
                    className="icon-btn tiny"
                    title="编辑"
                    onClick={(e) => {
                      e.stopPropagation()
                      onOpenFile(entry)
                    }}
                  >
                    <IconCode />
                  </button>
                )}
                {onRename && (
                  <button
                    className="icon-btn tiny"
                    title="重命名"
                    onClick={(e) => {
                      e.stopPropagation()
                      onRename(entry)
                    }}
                  >
                    <IconEdit />
                  </button>
                )}
                {onRemove && (
                  <button
                    className="icon-btn tiny danger"
                    title="删除"
                    onClick={(e) => {
                      e.stopPropagation()
                      onRemove(entry)
                    }}
                  >
                    <IconTrash />
                  </button>
                )}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

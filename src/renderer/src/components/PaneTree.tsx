import { useEffect, useRef, useState } from 'react'
import type { AppSettings } from '@shared/types'
import type { LeafNode, PaneNode, SplitNode } from '../pane-tree'
import {
  DRAG_MIME,
  resolveDockSide,
  type DockSide,
  type DragPayload
} from '../pane-dock'
import { useAppStore } from '../store'
import { cx } from '../utils'
import { TerminalView } from './TerminalView'
import { FilesPanel } from './FilesPanel'
import { LocalFilesPanel } from './LocalFilesPanel'
import { TerminalSearchBar } from './TerminalSearchBar'
import type { TerminalMenuTarget } from './TerminalContextMenu'
import { IconClose } from '../icons'

interface Props {
  tabId: string
  node: PaneNode
  activeSessionId: string
  tabActive: boolean
  settings: AppSettings
  /** 同一标签页内是否有多于一个分屏（决定是否显示分屏标题栏） */
  multi?: boolean
  /** 终端右键：把坐标与会话交给上层渲染菜单 */
  onRequestMenu?: (target: TerminalMenuTarget) => void
}

/**
 * 分屏渲染器（递归）。
 *
 * 布局树是二叉结构：leaf 渲染一个会话，split 把空间按 ratio 分给两个子节点。
 * 每个叶子都常驻挂载（隐藏标签页只是 display:none），所以分屏切换不会丢终端历史。
 */
export function PaneTree(props: Props) {
  if (props.node.type === 'leaf') return <SessionPane {...props} node={props.node} />
  return <SplitView {...props} node={props.node} />
}

function SplitView({ node, ...rest }: Props & { node: SplitNode }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const resizeSplit = useAppStore((s) => s.resizeSplit)
  const [dragging, setDragging] = useState(false)

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    const container = containerRef.current
    if (!container) return

    const rect = container.getBoundingClientRect()
    setDragging(true)
    document.body.classList.add('is-resizing')

    const onMove = (moveEvent: PointerEvent) => {
      const ratio =
        node.direction === 'row'
          ? (moveEvent.clientX - rect.left) / rect.width
          : (moveEvent.clientY - rect.top) / rect.height
      resizeSplit(node.id, ratio)
    }
    const onUp = () => {
      setDragging(false)
      document.body.classList.remove('is-resizing')
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  return (
    <div
      ref={containerRef}
      className={cx('split', node.direction === 'row' ? 'split-row' : 'split-col')}
    >
      <div className="split-cell" style={{ flexGrow: node.ratio }}>
        <PaneTree {...rest} node={node.children[0]} />
      </div>
      <div
        className={cx(
          'split-divider',
          node.direction === 'row' ? 'divider-col' : 'divider-row',
          dragging && 'is-dragging'
        )}
        onPointerDown={handlePointerDown}
        role="separator"
        aria-orientation={node.direction === 'row' ? 'vertical' : 'horizontal'}
      />
      <div className="split-cell" style={{ flexGrow: 1 - node.ratio }}>
        <PaneTree {...rest} node={node.children[1]} />
      </div>
    </div>
  )
}

function SessionPane({
  tabId,
  node,
  activeSessionId,
  tabActive,
  settings,
  multi,
  onRequestMenu
}: Props & { node: LeafNode }) {
  const pane = node.pane
  const focusPane = useAppStore((s) => s.focusPane)
  const closeSession = useAppStore((s) => s.closeSession)
  const reconnect = useAppStore((s) => s.reconnect)

  const dock = useAppStore((s) => s.dock)
  const findSessionId = useAppStore((s) => s.findSessionId)
  const closeFind = useAppStore((s) => s.closeFind)
  const [filesVisited, setFilesVisited] = useState(false)
  const [dropSide, setDropSide] = useState<DockSide | null>(null)
  const isActive = tabActive && pane.sessionId === activeSessionId

  // ---- 拖拽吸附：把标签/分屏拖到本分屏的某一侧即可并排 ----
  const handleDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes(DRAG_MIME)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    const rect = event.currentTarget.getBoundingClientRect()
    setDropSide(
      resolveDockSide(
        event.clientX - rect.left,
        event.clientY - rect.top,
        rect.width,
        rect.height
      )
    )
  }

  const handleDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node)) return
    setDropSide(null)
  }

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setDropSide(null)
    const raw = event.dataTransfer.getData(DRAG_MIME)
    if (!raw) return
    // 关键：吸附方向直接按落点计算，不依赖 dragover 写入的 state
    // （否则在同一帧内 dragover→drop 时 React 还没重渲染，会拿到过期的 null）
    const rect = event.currentTarget.getBoundingClientRect()
    const side = resolveDockSide(
      event.clientX - rect.left,
      event.clientY - rect.top,
      rect.width,
      rect.height
    )
    try {
      const payload = JSON.parse(raw) as DragPayload
      dock({
        sourceTabId: payload.tabId,
        sourceSessionId: payload.sessionId,
        targetTabId: tabId,
        targetSessionId: pane.sessionId,
        side
      })
    } catch {
      /* 非法负载直接忽略 */
    }
  }

  const startPaneDrag = (event: React.DragEvent<HTMLElement>) => {
    // 标题栏里的按钮不触发拖拽
    if ((event.target as HTMLElement).closest('button')) {
      event.preventDefault()
      return
    }
    const payload: DragPayload = { tabId, sessionId: pane.sessionId }
    event.dataTransfer.setData(DRAG_MIME, JSON.stringify(payload))
    event.dataTransfer.effectAllowed = 'move'
  }

  useEffect(() => {
    if (pane.mode === 'files') setFilesVisited(true)
  }, [pane.mode])

  return (
    <div
      className={cx(
        'pane-leaf',
        isActive && 'is-active',
        multi && 'is-multi',
        dropSide && 'is-drop-target'
      )}
      onMouseDown={() => focusPane(tabId, pane.sessionId)}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {(multi || pane.kind === 'local') && (
        <div className="pane-head" draggable onDragStart={startPaneDrag}>
          <span className={cx('pane-dot', `status-${pane.status}`)} style={multi && pane.color ? { background: pane.color } : undefined} />
          <span className="pane-title">{pane.title}</span>
          <span className="pane-head-actions">
            <button
              className="icon-btn tiny"
              title="关闭分屏"
              onClick={(event) => {
                event.stopPropagation()
                void closeSession(pane.sessionId)
              }}
            >
              <IconClose />
            </button>
          </span>
        </div>
      )}

      {dropSide && <div className="drop-hint" data-side={dropSide} />}

      <div className="pane-view" data-show={pane.mode === 'terminal'}>
        <TerminalView
          sessionId={pane.sessionId}
          active={isActive && pane.mode === 'terminal'}
          settings={settings}
          onContextMenu={(event) =>
            onRequestMenu?.({
              x: event.clientX,
              y: event.clientY,
              sessionId: pane.sessionId
            })
          }
        />
      </div>

      {findSessionId === pane.sessionId && (
        <TerminalSearchBar sessionId={pane.sessionId} onClose={closeFind} />
      )}

      <div className="pane-view" data-show={pane.mode === 'files'}>
        {filesVisited &&
          (pane.kind === 'ssh' ? (
            <FilesPanel
              sessionId={pane.sessionId}
              active={isActive && pane.mode === 'files'}
            />
          ) : (
            <LocalFilesPanel active={isActive && pane.mode === 'files'} />
          ))}
      </div>

      {(pane.status === 'error' || pane.status === 'closed') && (
        <div className="pane-banner">
          <span className="pane-banner-text">
            {pane.status === 'error' ? pane.message || '连接失败' : pane.message || '会话已断开'}
          </span>
          <div className="pane-banner-actions">
            <button className="btn btn-ghost" onClick={() => void reconnect(pane.sessionId)}>
              重新连接
            </button>
            <button className="btn btn-ghost" onClick={() => void closeSession(pane.sessionId)}>
              关闭
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

import { useEffect, useRef, useState } from 'react'
import type { AppSettings } from '@shared/types'
import type { LeafNode, PaneNode, SplitNode } from '../pane-tree'
import {
  DRAG_MIME,
  resolveDockSide,
  type DockSide,
  type DragPayload
} from '../pane-dock'
import { getTerminal } from '../terminal-registry'
import { reconnectDelay, shouldAutoReconnect } from '../reconnect-policy'
import { useAppStore } from '../store'
import { cx } from '../utils'
import { TerminalView } from './TerminalView'
import { FilesPanel } from './FilesPanel'
import { LocalFilesPanel } from './LocalFilesPanel'
import { TerminalSearchBar } from './TerminalSearchBar'
import type { TerminalMenuTarget } from './TerminalContextMenu'
import { IconClose } from '../icons'

/** 自动重连的退避间隔（毫秒）；数组长度即最大重试次数 */
const AUTO_RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 8000]

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

  // ---- 断线重连 ----
  const overlayRef = useRef<HTMLDivElement>(null)
  const [retry, setRetry] = useState(0)
  const [countdown, setCountdown] = useState<number | null>(null)
  const disconnected = pane.status === 'closed' || pane.status === 'error'
  /**
   * 哪些断开值得自动重连。
   *
   * **用户主动退出绝不重连**——敲完 exit 又被连上，比手动点还烦。
   * 认证失败和主机指纹变更也不重试：只会反复失败、反复弹窗。
   */
  const retriable = shouldAutoReconnect(
    pane.status,
    pane.closeReason,
    retry,
    AUTO_RECONNECT_DELAYS.length
  )
  // 「本来能重连，但次数用完了」：和「根本不该重连」要区分开，文案不同
  const exhausted =
    disconnected &&
    retry >= AUTO_RECONNECT_DELAYS.length &&
    shouldAutoReconnect(pane.status, pane.closeReason, 0, Number.MAX_SAFE_INTEGER)

  // 连上后重置计数
  useEffect(() => {
    if (pane.status === 'ready') {
      setRetry(0)
      setCountdown(null)
    }
  }, [pane.status])

  // 退避重连：1s → 2s → 4s → 8s → 8s
  useEffect(() => {
    if (!retriable || exhausted) {
      setCountdown(null)
      return
    }
    const delay = reconnectDelay(AUTO_RECONNECT_DELAYS, retry)
    setCountdown(Math.ceil(delay / 1000))
    const tick = window.setInterval(() => {
      setCountdown((value) => (value && value > 1 ? value - 1 : value))
    }, 1000)
    const timer = window.setTimeout(() => {
      setRetry((value) => value + 1)
      void reconnect(pane.sessionId)
    }, delay)
    return () => {
      window.clearInterval(tick)
      window.clearTimeout(timer)
      setCountdown(null)
    }
    // reconnect 来自 store，签名稳定；不放进依赖避免每次渲染重装定时器
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retriable, exhausted, retry, pane.sessionId])

  // 断开时把焦点交给覆盖层（否则按键会被 xterm 吃掉），恢复后还给终端
  const wasDisconnected = useRef(false)
  useEffect(() => {
    if (disconnected) {
      wasDisconnected.current = true
      overlayRef.current?.focus()
    } else if (wasDisconnected.current) {
      wasDisconnected.current = false
      getTerminal(pane.sessionId)?.focus()
    }
  }, [disconnected, pane.sessionId])

  const manualReconnect = (): void => {
    if (pane.status === 'connecting') return
    setRetry(0)
    void reconnect(pane.sessionId)
  }

  /** 断开原因的中文说明（比 message 更稳定，message 可能是空） */
  const reasonText = ((): string => {
    switch (pane.closeReason) {
      case 'user-exit':
        return '会话已正常退出'
      case 'network':
        return '网络连接中断'
      case 'auth':
        return '认证失败（口令或密钥不被接受）'
      case 'hostkey':
        return '主机指纹与记录不一致'
      default:
        return pane.message || '连接已断开'
    }
  })()

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

      {disconnected && (
        <div
          className="pane-overlay"
          ref={overlayRef}
          tabIndex={-1}
          role="dialog"
          aria-label="连接已断开"
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              manualReconnect()
            }
          }}
        >
          <div className="pane-overlay-card">
            <div
              className={cx('pane-overlay-title', pane.status === 'error' && 'is-error')}
            >
              {pane.closeReason === 'user-exit'
                ? '会话已退出'
                : pane.status === 'error'
                  ? '连接失败'
                  : '连接已断开'}
            </div>
            <div className="pane-overlay-reason">{reasonText}</div>
            {retriable && !exhausted && countdown !== null && (
              <div className="pane-overlay-hint">
                {countdown} 秒后自动重连（第 {retry + 1}/{AUTO_RECONNECT_DELAYS.length} 次）
              </div>
            )}
            {exhausted && (
              <div className="pane-overlay-hint">
                已重试 {AUTO_RECONNECT_DELAYS.length} 次仍未成功
              </div>
            )}
            {!retriable && (
              <div className="pane-overlay-hint">
                {pane.closeReason === 'hostkey'
                  ? '请先处理主机指纹，再手动连接'
                  : pane.closeReason === 'auth'
                    ? '请检查口令 / 密钥后重试'
                    : '按 Enter 重新打开'}
              </div>
            )}
            <div className="pane-overlay-actions">
              <button className="btn btn-primary" onClick={manualReconnect}>
                {pane.closeReason === 'user-exit' ? '重新打开' : '重新连接'}
              </button>
              <button
                className="btn btn-ghost"
                onClick={() => void closeSession(pane.sessionId)}
              >
                关闭
              </button>
            </div>
            {/* 可自动重连时提示 Enter；不可重连时上面的说明已经写过了，不重复 */}
            {retriable && <div className="pane-overlay-enter">按 Enter 立即重连</div>}
          </div>
        </div>
      )}
    </div>
  )
}

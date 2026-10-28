import { SESSION_STATUS_TEXT } from '@shared/types'
import { useState } from 'react'
import { useAppStore, tabPaneCount } from '../store'
import { DRAG_MIME, type DragPayload } from '../pane-dock'
import { findLeaf, firstLeaf } from '../pane-tree'
import { cx } from '../utils'
import {
  IconClose,
  IconCode,
  IconFolder,
  IconSplitDown,
  IconSplitRight,
  IconTerminal
} from '../icons'

interface Props {
  onToggleSnippets: () => void
  snippetsOpen: boolean
}

/** 标签栏：多会话切换 + 分屏操作 + 终端/文件视图切换 */
export function TabBar({ onToggleSnippets, snippetsOpen }: Props) {
  const tabs = useAppStore((s) => s.tabs)
  const activeTabId = useAppStore((s) => s.activeTabId)
  const setActiveTab = useAppStore((s) => s.setActiveTab)
  const closeTab = useAppStore((s) => s.closeTab)
  const setPaneMode = useAppStore((s) => s.setPaneMode)
  const splitPane = useAppStore((s) => s.splitPane)
  const moveTab = useAppStore((s) => s.moveTab)

  const activeTab = tabs.find((tab) => tab.id === activeTabId)
  const activePane = activeTab ? findLeaf(activeTab.root, activeTab.activeSessionId)?.pane : null
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null)

  return (
    <div className="tabbar">
      <div className="tab-list">
        {tabs.map((tab) => {
          const head = firstLeaf(tab.root).pane
          const paneCount = tabPaneCount(tab)
          return (
            <div
              key={tab.id}
              className={cx(
                'tab',
                tab.id === activeTabId && 'is-active',
                head.status === 'error' && 'has-error',
                draggingTabId === tab.id && 'is-dragging'
              )}
              draggable
              onDragStart={(event) => {
                // 拖标签 = 整标签吸附到别的分屏（拖到自己的内容区会被忽略）
                const payload: DragPayload = { tabId: tab.id }
                event.dataTransfer.setData(DRAG_MIME, JSON.stringify(payload))
                event.dataTransfer.effectAllowed = 'move'
                setDraggingTabId(tab.id)
              }}
              onDragEnd={() => setDraggingTabId(null)}
              onDragOver={(event) => {
                if (!event.dataTransfer.types.includes(DRAG_MIME)) return
                event.preventDefault()
                event.dataTransfer.dropEffect = 'move'
              }}
              onDrop={(event) => {
                const raw = event.dataTransfer.getData(DRAG_MIME)
                if (!raw) return
                event.preventDefault()
                event.stopPropagation()
                try {
                  const payload = JSON.parse(raw) as DragPayload
                  if (payload.tabId !== tab.id) moveTab(payload.tabId, tab.id)
                } catch {
                  /* 非法负载忽略 */
                }
              }}
              onClick={() => setActiveTab(tab.id)}
              onAuxClick={(event) => {
                if (event.button === 1) void closeTab(tab.id)
              }}
              title={`${head.subtitle} · ${SESSION_STATUS_TEXT[head.status] ?? ''}`}
            >
              <span
                className={cx('tab-dot', `status-${head.status}`)}
                style={head.color && head.status === 'ready' ? { background: head.color } : undefined}
              />
              <span className="tab-title">{head.title}</span>
              {paneCount > 1 && <span className="tab-badge">{paneCount}</span>}
              <button
                className="tab-close"
                title="关闭标签页"
                onClick={(event) => {
                  event.stopPropagation()
                  void closeTab(tab.id)
                }}
              >
                <IconClose />
              </button>
            </div>
          )
        })}
      </div>

      <div className="tabbar-actions">
        <div className="mode-switch">
          <button
            className={cx('icon-btn', activePane?.mode === 'terminal' && 'is-active')}
            disabled={!activePane}
            title="终端"
            onClick={() => activePane && setPaneMode(activePane.sessionId, 'terminal')}
          >
            <IconTerminal />
          </button>
          <button
            className={cx('icon-btn', activePane?.mode === 'files' && 'is-active')}
            disabled={!activePane}
            title="文件面板"
            onClick={() => activePane && setPaneMode(activePane.sessionId, 'files')}
          >
            <IconFolder />
          </button>
        </div>

        <button
          className="icon-btn"
          disabled={!activeTab}
          title="向右分屏"
          onClick={() => void splitPane('row')}
        >
          <IconSplitRight />
        </button>
        <button
          className="icon-btn"
          disabled={!activeTab}
          title="向下分屏"
          onClick={() => void splitPane('column')}
        >
          <IconSplitDown />
        </button>

        <button
          className={cx('icon-btn', snippetsOpen && 'is-active')}
          title="命令片段"
          onClick={onToggleSnippets}
        >
          <IconCode />
        </button>
      </div>
    </div>
  )
}

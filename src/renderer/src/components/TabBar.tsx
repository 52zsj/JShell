import { SESSION_STATUS_TEXT } from '@shared/types'
import { useEffect, useState } from 'react'
import { useAppStore, tabPaneCount } from '../store'
import { DRAG_MIME, type DragPayload } from '../pane-dock'
import { findLeaf, firstLeaf, leaves } from '../pane-tree'
import { cx } from '../utils'
import {
  IconClose,
  IconCloseAll,
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
  const inputSyncEnabled = useAppStore((s) => s.inputSyncEnabled)
  const inputSyncSessions = useAppStore((s) => s.inputSyncSessions)

  useEffect(() => {
    if (tabs.length === 0) setConfirmCloseAll(false)
  }, [tabs.length])

  const activeTab = tabs.find((tab) => tab.id === activeTabId)
  const activePane = activeTab ? findLeaf(activeTab.root, activeTab.activeSessionId)?.pane : null
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null)
  const [confirmCloseAll, setConfirmCloseAll] = useState(false)

  // 点空白处 / Esc 收起确认气泡
  useEffect(() => {
    if (!confirmCloseAll) return
    const onDown = (event: MouseEvent) => {
      if (!(event.target as HTMLElement).closest('.close-all-wrap')) setConfirmCloseAll(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setConfirmCloseAll(false)
    }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [confirmCloseAll])

  return (
    <div className="tabbar">
      <div className="tab-list">
        {tabs.map((tab, index) => {
          const head = firstLeaf(tab.root).pane
          // 这个标签里有几个分屏真的在收广播（只算已连接、已勾选的；分屏关了就不算）
          const syncPanes = inputSyncEnabled
            ? leaves(tab.root).filter(
                (node) =>
                  node.pane.status === 'ready' &&
                  (inputSyncSessions.length === 0 || inputSyncSessions.includes(node.pane.sessionId))
              ).length
            : 0
          const inSync = syncPanes > 0
          const paneCount = tabPaneCount(tab)
          return (
            <div
              key={tab.id}
              className={cx(
                'tab',
                tab.id === activeTabId && 'is-active',
                head.status === 'error' && 'has-error',
                draggingTabId === tab.id && 'is-dragging',
                inSync && 'is-batch-target'
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
              {inputSyncEnabled && index < 9 && (
                <span className="tab-batch-index" title="批量编辑序号">
                  {index + 1}
                </span>
              )}
              <span className="tab-title">{head.title}</span>
              {inSync && (
                <span
                  className="tab-batch-dot"
                  title={
                    syncPanes > 1
                      ? `批量编辑：本标签有 ${syncPanes} 个分屏会收到输入`
                      : '批量编辑：这个终端也会收到输入'
                  }
                />
              )}
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
        {/* 一键关闭：就地确认，不弹系统对话框 —— 这个动作频繁且意图明确，
            系统模态框反而打断节奏；同时就地确认也能被自动化测试点到 */}
        <div className="close-all-wrap">
          <button
            className="icon-btn"
            disabled={tabs.length === 0}
            title="关闭全部标签（含所有分屏）"
            onClick={() => setConfirmCloseAll((prev) => !prev)}
          >
            <IconCloseAll />
          </button>
          {confirmCloseAll && tabs.length > 0 && (
            <div className="close-all-pop">
              <p>
                关闭全部 <strong>{tabs.length}</strong> 个标签？
                <em>所有分屏会话都会断开</em>
              </p>
              <div className="close-all-actions">
                <button className="btn btn-ghost tiny" onClick={() => setConfirmCloseAll(false)}>
                  取消
                </button>
                <button
                  className="btn danger tiny"
                  onClick={() => {
                    setConfirmCloseAll(false)
                    void useAppStore.getState().closeAllTabs()
                  }}
                >
                  关闭全部
                </button>
              </div>
            </div>
          )}
        </div>
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

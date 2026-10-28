import { useEffect, useMemo, useState } from 'react'
import { SESSION_STATUS_TEXT, type HostProfile } from '@shared/types'
import { useAppStore, tabPaneCount, type TerminalTab } from './store'
import { findLeaf, firstLeaf } from './pane-tree'
import { serializeTabs } from './layout'
import { cx, errorMessage, platformLabel } from './utils'
import { findAction, formatBinding, resolveBindings } from './shortcuts'
import { getFocusedSession, getTerminal } from './terminal-registry'
import { Sidebar } from './components/Sidebar'
import { TabBar } from './components/TabBar'
import { PaneTree } from './components/PaneTree'
import { HostEditor } from './components/HostEditor'
import { SettingsDialog } from './components/SettingsDialog'
import { SyncDialog } from './components/SyncDialog'
import { SnippetPanel } from './components/SnippetPanel'
import {
  TerminalContextMenu,
  type TerminalMenuTarget
} from './components/TerminalContextMenu'
import { HostKeyDialog } from './components/HostKeyDialog'
import { RsyncWizard } from './components/RsyncWizard'
import { IconArrowRight, IconKey, IconLaptop, IconSettings, IconSync, IconTerminal } from './icons'

function StatusBar() {
  const tabs = useAppStore((s) => s.tabs)
  const activeTabId = useAppStore((s) => s.activeTabId)
  const transfers = useAppStore((s) => s.transfers)
  const info = useAppStore((s) => s.info)

  const tab = tabs.find((item) => item.id === activeTabId)
  const pane = tab ? findLeaf(tab.root, tab.activeSessionId)?.pane : null
  const running = transfers.filter((task) => task.status === 'running')
  const panes = tab ? tabPaneCount(tab) : 0

  return (
    <footer className="statusbar">
      <div className="status-left">
        {pane ? (
          <>
            <span className={cx('status-dot', `status-${pane.status}`)} />
            <span className="mono">{pane.subtitle}</span>
            <span className="status-label">{SESSION_STATUS_TEXT[pane.status]}</span>
            {panes > 1 && <span className="status-label">· {panes} 个分屏</span>}
          </>
        ) : (
          <span className="status-label">就绪</span>
        )}
      </div>
      <div className="status-right">
        {running.map((task) => (
          <span key={task.id} className="transfer">
            <span className="transfer-name">
              {task.direction === 'upload' ? '↑' : '↓'} {task.name}
            </span>
            <span className="transfer-bar">
              <span
                style={{
                  width: `${task.total ? Math.min(100, (task.transferred / task.total) * 100) : 0}%`
                }}
              />
            </span>
            <button
              className="transfer-cancel"
              title="取消传输"
              onClick={(event) => {
                event.stopPropagation()
                void window.jshell.sftp.cancel(task.id)
              }}
            >
              ×
            </button>
          </span>
        ))}
        <span className="mono dim">
          {platformLabel(info?.platform)} · v{info?.version ?? '0.0.0'}
          {info?.portable ? ' · 便携版' : ''}
        </span>
      </div>
    </footer>
  )
}

function EmptyState({ onCreateHost, onLocal }: { onCreateHost: () => void; onLocal: () => void }) {
  const shells = useAppStore((s) => s.shells)
  const shellName = shells?.shells.find((item) => item.isDefault)?.name ?? '终端'

  return (
    <div className="empty-state">
      <div className="empty-mark">&gt;_</div>
      <h1>JShell</h1>
      <p>本地优先的 SSH 终端工作台，无账号、无云端依赖。</p>
      <div className="empty-actions">
        <button className="btn btn-primary" onClick={onLocal}>
          <IconLaptop />
          打开 {shellName}
        </button>
        <button className="btn btn-ghost" onClick={onCreateHost}>
          新建 SSH 主机
          <IconArrowRight />
        </button>
      </div>
      <ul className="empty-hints">
        <li>
          <IconTerminal /> 本地终端自动识别系统 shell，SSH 与本地会话统一管理
        </li>
        <li>
          <IconArrowRight /> 分屏：⌘/Ctrl + D 向右、⌘/Ctrl + Shift + D 向下
        </li>
        <li>
          <IconKey /> 密码 / 私钥 / ssh-agent，凭据本地加密
        </li>
        <li>
          <IconSettings /> 全部快捷键可在设置中重新绑定
        </li>
      </ul>
    </div>
  )
}

export default function App() {
  const ready = useAppStore((s) => s.ready)
  const bootError = useAppStore((s) => s.bootError)
  const tabs = useAppStore((s) => s.tabs)
  const activeTabId = useAppStore((s) => s.activeTabId)
  const settings = useAppStore((s) => s.settings)
  const info = useAppStore((s) => s.info)
  const toasts = useAppStore((s) => s.toasts)
  const bootstrap = useAppStore((s) => s.bootstrap)
  const dismissToast = useAppStore((s) => s.dismissToast)

  const [editor, setEditor] = useState<{ host?: HostProfile; clone?: boolean } | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [rsyncOpen, setRsyncOpen] = useState(false)
  const [snippetsOpen, setSnippetsOpen] = useState(false)
  const [syncOpen, setSyncOpen] = useState(false)
  const [menu, setMenu] = useState<TerminalMenuTarget | null>(null)

  const platform = info?.platform ?? 'darwin'
  const isMac = platform === 'darwin'
  const bindings = useMemo(() => resolveBindings(settings.keybindings), [settings.keybindings])

  useEffect(() => {
    void bootstrap()
  }, [bootstrap])

  // 任意弹窗关闭后把焦点还给当前终端：模态框卸载后焦点会落回 <body>，
  // 键盘输入进不了 xterm，用户会以为「关掉设置后终端不能用了」。
  const modalOpen = Boolean(editor || settingsOpen || rsyncOpen || snippetsOpen || syncOpen || menu)
  useEffect(() => {
    if (modalOpen) return
    const timer = window.setTimeout(() => {
      const state = useAppStore.getState()
      const tab = state.tabs.find((t) => t.id === state.activeTabId)
      const sessionId = tab?.activeSessionId
      if (sessionId) getTerminal(sessionId)?.focus()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [modalOpen])

  // 布局持久化：标签/分屏变化后合并 600ms 再落盘（只存结构，不存终端内容）
  useEffect(() => {
    if (!ready) return
    const timer = window.setTimeout(() => {
      void window.jshell.layout.save(serializeTabs(tabs)).catch(() => undefined)
    }, 600)
    return () => window.clearTimeout(timer)
  }, [tabs, ready])

  // 托盘 / 系统菜单发来的命令：与界面内操作走同一套 store 动作
  useEffect(() => {
    window.jshell.app.onCommand((command) => {
      const state = useAppStore.getState()
      switch (command) {
        case 'new-local':
          void state.openLocal()
          break
        case 'new-host':
          setEditor({})
          break
        case 'settings':
        case 'about':
          setSettingsOpen(true)
          break
        case 'check-update':
          setSettingsOpen(true)
          void state.checkUpdate()
          break
        case 'open-logs':
          void window.jshell.app
            .openLogs()
            .catch((err) => state.pushToast(errorMessage(err), 'error'))
          break
        default:
          break
      }
    })
    return () => window.jshell.app.unsubscribeCommand()
  }, [])

  // 终端剪贴板：菜单快捷键按焦点路由后回投到这里执行
  useEffect(() => {
    window.jshell.clipboard.onCommand(({ action, text }) => {
      const state = useAppStore.getState()
      const tab = state.tabs.find((t) => t.id === state.activeTabId)
      // 优先用焦点所在终端，取不到时回退到当前选中分屏
      const sessionId = getFocusedSession() ?? tab?.activeSessionId ?? null
      if (!sessionId) return
      const term = getTerminal(sessionId)
      if (!term) return
      if (action === 'copy') {
        const selection = term.getSelection()
        if (!selection) return
        void window.jshell.clipboard
          .writeText(selection)
          .catch((err) => state.pushToast(errorMessage(err), 'error'))
      } else if (action === 'selectAll') {
        term.selectAll()
      } else if (text) {
        term.paste(text)
      }
    })
    return () => window.jshell.clipboard.unsubscribe()
  }, [])

  // 全局快捷键：走可配置的绑定表，未命中则交还给终端 / 输入框
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      // 有弹窗时不吃全局快捷键：否则在「编辑主机」表单里按 ⌘N 会再叠一层弹窗
      if (document.querySelector('.modal-mask, .mini-modal-mask')) return

      // 焦点在输入控件时同样不触发；xterm 的隐藏 textarea 例外，那是终端的输入通道
      const target = event.target as HTMLElement | null
      const isFormControl =
        !!target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      if (isFormControl && !target.classList.contains('xterm-helper-textarea')) return

      const state = useAppStore.getState()
      const tab: TerminalTab | undefined = state.tabs.find((item) => item.id === state.activeTabId)

      // ⌘/Ctrl + 1..9 切换标签（固定绑定，避免与自定义冲突）
      const onlyMod = isMac
        ? event.metaKey && !event.ctrlKey
        : event.ctrlKey && !event.metaKey
      if (onlyMod && !event.shiftKey && !event.altKey && /^[1-9]$/.test(event.key)) {
        const target = state.tabs[Number(event.key) - 1]
        if (target) {
          event.preventDefault()
          state.setActiveTab(target.id)
        }
        return
      }

      const action = findAction(bindings, event, isMac)
      if (!action) return
      event.preventDefault()

      switch (action) {
        case 'session.local':
          void state.openLocal()
          break
        case 'session.host':
          setEditor({})
          break
        case 'pane.splitRight':
          void state.splitPane('row')
          break
        case 'pane.splitDown':
          void state.splitPane('column')
          break
        case 'pane.close':
          if (tab) void state.closeSession(tab.activeSessionId)
          break
        case 'pane.next':
          state.cyclePane(1)
          break
        case 'pane.prev':
          state.cyclePane(-1)
          break
        case 'pane.toggleFiles':
          state.togglePaneFiles()
          break
        case 'files.path': {
          const input = document.querySelector<HTMLInputElement>('.files-path-input')
          if (input) {
            input.focus()
            input.select()
          }
          break
        }
        case 'pane.find': {
          const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId)
          const leaf = activeTab ? findLeaf(activeTab.root, activeTab.activeSessionId) : null
          if (leaf) state.openFind(leaf.pane.sessionId)
          break
        }
        case 'tab.close':
          if (tab) void state.closeTab(tab.id)
          break
        case 'tab.reopen':
          state.reopenClosedTab()
          break
        case 'snippets.toggle':
          setSnippetsOpen((prev) => !prev)
          break
        case 'settings.open':
          setSettingsOpen(true)
          break
        default:
          break
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [bindings, isMac])

  if (!ready) {
    return (
      <div className="app-loading">
        {bootError ? (
          <>
            <p>启动失败：{bootError}</p>
            <button className="btn btn-primary" onClick={() => void bootstrap()}>
              重试
            </button>
          </>
        ) : (
          '正在加载本地配置…'
        )}
      </div>
    )
  }

  const activeTab = tabs.find((tab) => tab.id === activeTabId)
  const activePane = activeTab ? findLeaf(activeTab.root, activeTab.activeSessionId)?.pane : null

  return (
    <div className="app" data-platform={platform}>
      <header className="titlebar">
        <div className="titlebar-left">
          <span className="titlebar-sub">
            {activeTab ? `JShell — ${firstLeaf(activeTab.root).pane.title}` : 'SSH / 终端管理工作台'}
          </span>
        </div>
        <div className="titlebar-actions">
          <button className="btn btn-ghost" onClick={() => void useAppStore.getState().openLocal()}>
            <IconLaptop />
            本地终端
          </button>
          <button className="btn btn-ghost" onClick={() => setEditor({})}>
            新建主机
          </button>
          <button
            className="btn btn-ghost"
            onClick={() => setRsyncOpen(true)}
            title="文件传输：在本机与服务器之间传文件（rsync，支持断点续传与重试）"
          >
            <IconSync />
            文件传输
          </button>
          <button
            className="icon-btn"
            title={`设置 (${formatBinding(bindings['settings.open'], isMac)})`}
            onClick={() => setSettingsOpen(true)}
          >
            <IconSettings />
          </button>
        </div>
      </header>

      <div className="app-body">
        <Sidebar
          onCreate={() => setEditor({})}
          onEdit={(host) => setEditor({ host })}
          onClone={(host) => setEditor({ host, clone: true })}
          onOpenLocal={(shellPath) => void useAppStore.getState().openLocal(shellPath)}
        />

        <main className="workspace">
          <TabBar
            onToggleSnippets={() => setSnippetsOpen((prev) => !prev)}
            snippetsOpen={snippetsOpen}
          />

          <div className="panes">
            {tabs.length === 0 && (
              <EmptyState
                onCreateHost={() => setEditor({})}
                onLocal={() => void useAppStore.getState().openLocal()}
              />
            )}

            {tabs.map((tab) => (
              <div key={tab.id} className="tab-pane" data-active={tab.id === activeTabId}>
                <PaneTree
                  tabId={tab.id}
                  node={tab.root}
                  activeSessionId={tab.activeSessionId}
                  tabActive={tab.id === activeTabId}
                  settings={settings}
                  multi={tabPaneCount(tab) > 1}
                  onRequestMenu={setMenu}
                />
              </div>
            ))}
          </div>

          <StatusBar />
        </main>

        {snippetsOpen && <SnippetPanel onClose={() => setSnippetsOpen(false)} />}
      </div>

      {editor && <HostEditor host={editor.host} clone={editor.clone} onClose={() => setEditor(null)} />}
      {settingsOpen && (
        <SettingsDialog
          isMac={isMac}
          bindings={bindings}
          onClose={() => setSettingsOpen(false)}
          onOpenSync={() => {
            setSettingsOpen(false)
            setSyncOpen(true)
          }}
        />
      )}
      {syncOpen && <SyncDialog onClose={() => setSyncOpen(false)} />}
      {menu && <TerminalContextMenu target={menu} onClose={() => setMenu(null)} />}
      {rsyncOpen && (
        <RsyncWizard
          onClose={() => setRsyncOpen(false)}
          defaultHostId={activePane?.kind === 'ssh' ? activePane.hostId : undefined}
        />
      )}
      <HostKeyDialog />

      <div className="toasts">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={cx('toast', `toast-${toast.kind}`)}
            onClick={() => dismissToast(toast.id)}
          >
            {toast.text}
          </div>
        ))}
      </div>
    </div>
  )
}

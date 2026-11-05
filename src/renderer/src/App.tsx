import { useEffect, useMemo, useState } from 'react'
import { SESSION_STATUS_TEXT, type HostProfile } from '@shared/types'
import { useAppStore, tabPaneCount, type TerminalTab } from './store'
import { findLeaf, firstLeaf } from './pane-tree'
import { serializeTabs } from './layout'
import { cx, errorMessage, platformLabel, modKey } from './utils'
import { findAction, formatBinding, matchClipboardAction, resolveBindings } from './shortcuts'
import { getTerminal } from './terminal-registry'
import {
  activeTerminal,
  copyTerminalSelection,
  hasTerminalSelection,
  pasteIntoTerminal,
  selectAllTerminal
} from './terminal-clipboard'
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
import { InputSyncControl } from './components/InputSyncControl'
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
        <InputSyncControl />
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
  const info = useAppStore((s) => s.info)
  const isMac = (info?.platform ?? 'darwin') === 'darwin'
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
          <IconArrowRight /> 分屏：{modKey(isMac)} + D 向右、{modKey(isMac)} + Shift + D 向下
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

  const inputSyncEnabled = useAppStore((s) => s.inputSyncEnabled)
  const platform = info?.platform ?? 'darwin'
  const isMac = platform === 'darwin'
  const bindings = useMemo(
    () => resolveBindings(settings.keybindings, isMac),
    [settings.keybindings, isMac]
  )

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
      // 与键盘触发共用同一份实现，避免「菜单能复制、快捷键不能」这类语义分叉
      if (action === 'copy') copyTerminalSelection()
      else if (action === 'selectAll') selectAllTerminal()
      else if (text) {
        const term = activeTerminal()
        if (term) term.paste(text)
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
          // 同样要 stopPropagation：否则终端还会把 Ctrl+数字 当作控制字符发给 shell
          event.stopPropagation()
          state.setActiveTab(target.id)
        }
        return
      }

      // 剪贴板：平台惯例不同（mac ⌘C / Windows Ctrl+C 有选区才复制），单独处理。
      // 必须在 xterm 之前拿到事件 —— 见下方 capture 监听的说明。
      const clipboard = matchClipboardAction(event, isMac, hasTerminalSelection())
      if (clipboard) {
        event.preventDefault()
        event.stopPropagation()
        if (clipboard === 'copy') copyTerminalSelection()
        else if (clipboard === 'paste') pasteIntoTerminal()
        else selectAllTerminal()
        return
      }

      const action = findAction(bindings, event, isMac)
      if (!action) return
      event.preventDefault()
      // 关键：必须 stopPropagation，否则 xterm 仍会把这个键发给 shell。
      // 例如 Windows 上 Ctrl+Shift+D 若只 preventDefault，分屏会开、shell 那边也可能收到控制字符。
      event.stopPropagation()

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
    /*
     * 必须用 **capture 阶段**，不能用默认的冒泡。
     *
     * xterm 的键盘处理（Keyboard.ts → _keyDown → evaluateKeyboardEvent）对
     * 「Ctrl + 字母」这类它认得的组合会调用 `cancel(event, true)`，而 cancel 的实现是
     * `preventDefault() + stopPropagation()`：
     *
     *   · macOS 上 ⌘ 组合会先命中 `_isThirdLevelShift()` 提前 return，从不 cancel
     *     → 事件能冒泡到 window，所以 ⌘ 系快捷键一直是好的；
     *   · Windows / Linux 上所有 Ctrl+字母（以及多数 Ctrl+Shift+字母）都会被 cancel
     *     → 事件到不了 window，冒泡监听的全局快捷键就**全部失效**，
     *       而 shell 那头照样收到了控制字符（Ctrl+D 变成 EOF）。
     *
     * 这正是「同样的快捷键 mac 能用、Windows 全废」的根因。capture 阶段先于
     * textarea 上的监听执行，命中后 stopPropagation，xterm 就不会再处理这个键。
     */
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
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
    <div
      className="app"
      data-platform={platform}
      data-input-sync={inputSyncEnabled ? 'on' : 'off'}
    >
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

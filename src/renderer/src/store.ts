import { create } from 'zustand'
import type { AutoSyncState } from '@shared/sync'
import type {
  AppInfo,
  AppSettings,
  AppTheme,
  HostDraft,
  HostKeyMismatch,
  HostProfile,
  PersistedTab,
  SessionEvent,
  ShellsResult,
  Snippet,
  TransferTask,
  UpdateCheckResult
} from '@shared/types'
import {
  countLeaves,
  findLeaf,
  firstLeaf,
  leaf,
  leaves,
  mapLeaves,
  removeLeaf,
  replaceLeaf,
  setSplitRatio,
  type PaneMode,
  type PaneNode,
  type PaneState
} from './pane-tree'
import { restoreTabs, serializeTabs } from './layout'
import { dockTabs, type DockRequest } from './pane-dock'
import { disposeTerminal, pushTerminalData } from './terminal-registry'
import { errorMessage } from './utils'

export interface TerminalTab {
  id: string
  /** 分屏布局树；单标签页时就是一个叶子节点 */
  root: PaneNode
  /** 当前聚焦的分屏（sessionId） */
  activeSessionId: string
}

export interface Toast {
  id: string
  kind: 'info' | 'success' | 'error'
  text: string
}

/** 初始 PTY 尺寸；终端挂载后会立刻 fit 并 resize 到真实尺寸 */
const INITIAL_SIZE = { cols: 100, rows: 30 }

interface AppState {
  ready: boolean
  /** 启动失败原因（IPC 或配置异常），用于展示自救页而不是永久 loading */
  bootError: string | null
  info: AppInfo | null
  shells: ShellsResult | null
  hosts: HostProfile[]
  settings: AppSettings
  snippets: Snippet[]
  tabs: TerminalTab[]
  activeTabId: string | null
  transfers: TransferTask[]
  toasts: Toast[]
  /** 正在显示搜索条的分屏（sessionId） */
  findSessionId: string | null
  /** 主机指纹变更时弹出的确认信息 */
  hostKeyPrompt: HostKeyMismatch | null
  /** 最近一次更新检查结果（内部渠道为 disabled） */
  updateResult: UpdateCheckResult | null
  updateChecking: boolean
  /** 最近关闭的标签（最多 5 个，用于重开） */
  closedTabs: PersistedTab[]
  /** 左侧目录树是否展开（跟随当前选中的 SSH 会话） */
  treeOpen: boolean
  treeHeight: number
  /** 每个会话的当前工作目录（由主进程解析 OSC 7 上报） */
  cwdBySession: Record<string, string>
  /** 自动同步的运行状态（主进程推送，界面只读） */
  autoSync: AutoSyncState | null

  bootstrap: () => Promise<void>
  setAutoSync: (state: AutoSyncState) => void
  /** 自动同步在后台应用了远端变更：刷新主机/片段/设置 */
  handleAutoSync: (state: AutoSyncState) => Promise<void>
  handleEvent: (event: SessionEvent) => void

  openHost: (hostId: string) => Promise<void>
  openLocal: (shellPath?: string) => Promise<void>
  splitPane: (direction: 'row' | 'column') => Promise<void>
  closeSession: (sessionId: string) => Promise<void>
  closeTab: (tabId: string) => Promise<void>
  reconnect: (sessionId: string) => Promise<void>
  focusPane: (tabId: string, sessionId: string) => void
  /** 终端自身获得焦点时同步「当前分屏」，保证高亮与实际输入一致 */
  focusSession: (sessionId: string) => void
  setActiveTab: (tabId: string) => void
  moveTab: (fromId: string, toId: string) => void
  reopenClosedTab: () => void
  setPaneMode: (sessionId: string, mode: PaneMode) => void
  togglePaneFiles: () => void
  /** 终端上方的目录树 Dock：开 / 关 */
  toggleTree: () => void
  setTreeHeight: (height: number) => void
  cyclePane: (step: 1 | -1) => void
  resizeSplit: (splitId: string, ratio: number) => void
  /** 拖拽吸附：把标签或单个分屏并到目标分屏的某一侧 */
  dock: (request: DockRequest) => void

  reloadHosts: () => Promise<void>
  reloadSnippets: () => Promise<void>
  /** 同步包导入后重新读取设置（会同步应用主题） */
  reloadSettings: () => Promise<void>
  saveHost: (draft: HostDraft) => Promise<void>
  removeHost: (hostId: string) => Promise<void>
  updateSettings: (patch: Partial<AppSettings>) => Promise<void>
  /** 仅更新本地状态（即时预览），不落盘；配合节流后的 updateSettings 使用 */
  previewSettings: (patch: Partial<AppSettings>) => void
  openFind: (sessionId: string) => void
  closeFind: () => void
  /** 信任新指纹并重连（指纹变更弹窗里的「信任」按钮） */
  trustHostKey: () => Promise<void>
  dismissHostKeyPrompt: () => void
  saveSnippet: (input: { id?: string; name: string; command: string; alias?: string }) => Promise<void>
  removeSnippet: (id: string) => Promise<void>
  pushToast: (text: string, kind?: Toast['kind']) => void
  dismissToast: (id: string) => void
  /** 检查更新（内部渠道不发请求，直接提示未配置） */
  checkUpdate: () => Promise<void>
}

/** 把 theme 设置落到 <html data-theme>，system 模式跟随系统外观 */
export function applyTheme(mode: AppTheme): void {
  const resolved =
    mode === 'system'
      ? window.matchMedia('(prefers-color-scheme: light)').matches
        ? 'light'
        : 'dark'
      : mode
  document.documentElement.dataset.theme = resolved
}

let subscribed = false
let autoSubscribed = false

export const useAppStore = create<AppState>()((set, get) => {
  /** 找到某个会话所在的分屏（跨所有标签页） */
  const locate = (sessionId: string): { tab: TerminalTab; pane: PaneState } | null => {
    for (const tab of get().tabs) {
      const found = findLeaf(tab.root, sessionId)
      if (found) return { tab, pane: found.pane }
    }
    return null
  }

  /** 更新某个分屏的状态（不重建终端实例，避免历史丢失） */
  /** 会话关掉后把它的 cwd 记录一并删掉，否则这个对象只增不减 */
  const forgetCwd = (sessionIds: string[]): void => {
    set((state) => {
      const present = sessionIds.filter((id) => id in state.cwdBySession)
      if (present.length === 0) return state
      const next = { ...state.cwdBySession }
      for (const id of present) delete next[id]
      return { cwdBySession: next }
    })
  }

  const patchPane = (sessionId: string, patch: Partial<PaneState>): void => {
    set((state) => ({
      tabs: state.tabs.map((tab) => {
        if (!findLeaf(tab.root, sessionId)) return tab
        return {
          ...tab,
          root: mapLeaves(tab.root, (node) =>
            node.pane.sessionId === sessionId
              ? { ...node, pane: { ...node.pane, ...patch } }
              : node
          )
        }
      })
    }))
  }

  const rememberClosed = (tab: TerminalTab): void => {
    set((state) => ({
      closedTabs: [...state.closedTabs, serializeTabs([tab])[0]].slice(-5)
    }))
  }

  const removeTab = (tabId: string): void => {
    const { tabs, activeTabId } = get()
    const index = tabs.findIndex((tab) => tab.id === tabId)
    if (index === -1) return
    const nextTabs = tabs.filter((tab) => tab.id !== tabId)
    const nextActive =
      activeTabId === tabId
        ? (nextTabs[Math.min(index, nextTabs.length - 1)]?.id ?? null)
        : activeTabId
    set({ tabs: nextTabs, activeTabId: nextActive })
  }

  /** 关闭一个分屏对应的主进程会话（忽略已断开的情况） */
  const closeSessionInMain = async (sessionId: string): Promise<void> => {
    await window.jshell.sessions.close(sessionId).catch(() => undefined)
  }

  return {
    ready: false,
    bootError: null,
    info: null,
    shells: null,
    hosts: [],
    autoSync: null,
    settings: {
      theme: 'dark',
      terminalTheme: 'one-dark',
      fontFamily: 'monospace',
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
      hostKeyPolicy: 'tofu',
      sidebarWidth: 264,
      localShell: '',
      keybindings: {},
      launchAtLogin: false,
      startMinimized: false,
      closeToTray: true,
      notifications: true,
      showLocalShells: true,
      hostDeleteButton: true,
      hostDeleteConfirm: true,
      hiddenLocalShells: [],
      autoFollowCwd: true,
      keepaliveEnabled: true,
      keepaliveIntervalSeconds: 60,
      keepaliveCountMax: 3
    },
    snippets: [],
    tabs: [],
    activeTabId: null,
    transfers: [],
    toasts: [],
    findSessionId: null,
    hostKeyPrompt: null,
    updateResult: null,
    updateChecking: false,
    closedTabs: [],
    treeOpen: true,
    treeHeight: 260,
    cwdBySession: {},

    async bootstrap() {
      try {
        const [hosts, settings, snippets, info, shells, layout, autoSync] = await Promise.all([
          window.jshell.hosts.list(),
          window.jshell.settings.get(),
          window.jshell.snippets.list(),
          window.jshell.app.info(),
          window.jshell.app.shells(),
          window.jshell.layout.get(),
          window.jshell.autoSync.get()
        ])

        applyTheme(settings.theme)
        window
          .matchMedia('(prefers-color-scheme: light)')
          .addEventListener('change', () => applyTheme(get().settings.theme))

        if (!subscribed) {
          subscribed = true
          window.jshell.events.subscribe((event) => get().handleEvent(event))
        }

        set({ autoSync })
        if (!autoSubscribed) {
          autoSubscribed = true
          window.jshell.autoSync.onStatus((state) => void get().handleAutoSync(state))
        }

        let restored: ReturnType<typeof restoreTabs> = []
        try {
          restored = layout.length > 0 ? restoreTabs(layout, hosts, () => crypto.randomUUID()) : []
        } catch (err) {
          // 坏布局不能让应用停在加载页：丢弃并继续启动
          console.error('布局恢复失败', err)
        }

        set({
          hosts,
          settings,
          snippets,
          info,
          shells,
          tabs: restored,
          activeTabId: restored[0]?.id ?? null,
          bootError: null,
          ready: true
        })
      } catch (err) {
        set({ bootError: errorMessage(err), ready: false })
      }
    },

    handleEvent(event) {
      if (event.type === 'cwd') {
        // 关闭「目录树自动跟随」后不再更新 cwd：目录树保持当前浏览位置，
        // 与终端目录彻底解耦（重新开启、且本会话已注入 hook 时会恢复跟随）。
        if (!get().settings.autoFollowCwd) return
        set((state) => ({ cwdBySession: { ...state.cwdBySession, [event.sessionId]: event.cwd } }))
        return
      }

      if (event.type === 'data') {
        // 高频路径：不进入 React 状态，直接写 xterm
        pushTerminalData(event.sessionId, event.data)
        return
      }

      if (event.type === 'status') {
        patchPane(event.sessionId, {
          status: event.status,
          message: event.message,
          // 只在断开时记原因；重连失败/成功时清掉旧原因，避免残留
          closeReason: event.status === 'closed' || event.status === 'error' ? event.reason : undefined
        })
        if (event.status === 'error' && event.message) {
          get().pushToast(event.message, 'error')
        }
        return
      }

      if (event.type === 'hostkey') {
        set({
          hostKeyPrompt: {
            sessionId: event.sessionId,
            host: event.host,
            port: event.port,
            algorithm: event.algorithm,
            known: event.known,
            actual: event.actual
          }
        })
        return
      }

      if (event.type === 'transfer') {
        const task = event.task
        set((state) => {
          const exists = state.transfers.some((t) => t.id === task.id)
          const next = exists
            ? state.transfers.map((t) => (t.id === task.id ? { ...t, ...task } : t))
            : [...state.transfers, task]
          return { transfers: next.slice(-4) }
        })
        if (task.status !== 'running') {
          setTimeout(() => {
            set((state) => ({ transfers: state.transfers.filter((t) => t.id !== task.id) }))
          }, 4000)
        }
      }
    },

    async openHost(hostId) {
      const host = get().hosts.find((h) => h.id === hostId)
      if (!host) return

      const sessionId = crypto.randomUUID()
      const pane: PaneState = {
        sessionId,
        kind: 'ssh',
        mode: 'terminal',
        status: 'connecting',
        title: host.name || host.host,
        subtitle: `${host.username}@${host.host}:${host.port}`,
        hostId,
        color: host.color
      }
      const tab: TerminalTab = {
        id: crypto.randomUUID(),
        root: leaf(pane),
        activeSessionId: sessionId
      }
      set((state) => ({ tabs: [...state.tabs, tab], activeTabId: tab.id }))

      try {
        await window.jshell.sessions.open(hostId, INITIAL_SIZE, sessionId)
      } catch (err) {
        const message = errorMessage(err)
        patchPane(sessionId, { status: 'error', message })
        get().pushToast(message, 'error')
      }
    },

    async openLocal(shellPath) {
      const sessionId = crypto.randomUUID()
      const detected = get().shells
      const target =
        shellPath || get().settings.localShell || detected?.defaultShell || ''
      const name = target
        ? (target.split(/[\\/]/).pop() ?? '终端').replace(/\.exe$/i, '')
        : '终端'

      const pane: PaneState = {
        sessionId,
        kind: 'local',
        mode: 'terminal',
        status: 'connecting',
        title: name,
        subtitle: '本地终端',
        shellPath: target || undefined
      }
      const tab: TerminalTab = {
        id: crypto.randomUUID(),
        root: leaf(pane),
        activeSessionId: sessionId
      }
      set((state) => ({ tabs: [...state.tabs, tab], activeTabId: tab.id }))

      try {
        const result = await window.jshell.sessions.openLocal(INITIAL_SIZE, sessionId, shellPath)
        patchPane(sessionId, {
          title: result.title,
          subtitle: result.subtitle,
          shellPath: result.shellPath
        })
      } catch (err) {
        const message = errorMessage(err)
        patchPane(sessionId, { status: 'error', message })
        get().pushToast(message, 'error')
      }
    },

    async splitPane(direction) {
      const { tabs, activeTabId } = get()
      const tab = tabs.find((t) => t.id === activeTabId)
      if (!tab) return
      const current = findLeaf(tab.root, tab.activeSessionId)
      if (!current) return

      const source = current.pane
      const sessionId = crypto.randomUUID()
      const pane: PaneState = {
        ...source,
        sessionId,
        status: 'connecting',
        message: undefined,
        mode: 'terminal'
      }
      const split: PaneNode = {
        type: 'split',
        id: crypto.randomUUID(),
        direction,
        ratio: 0.5,
        children: [current, leaf(pane)]
      }

      set((state) => ({
        tabs: state.tabs.map((t) =>
          t.id === tab.id
            ? {
                ...t,
                root: replaceLeaf(t.root, current.pane.sessionId, split),
                activeSessionId: sessionId
              }
            : t
        )
      }))

      try {
        if (source.kind === 'ssh' && source.hostId) {
          await window.jshell.sessions.open(source.hostId, INITIAL_SIZE, sessionId)
        } else {
          await window.jshell.sessions.openLocal(INITIAL_SIZE, sessionId, source.shellPath)
        }
      } catch (err) {
        const message = errorMessage(err)
        patchPane(sessionId, { status: 'error', message })
        get().pushToast(message, 'error')
      }
    },

    async closeSession(sessionId) {
      const found = locate(sessionId)
      if (!found) return
      await closeSessionInMain(sessionId)

      disposeTerminal(sessionId)
      forgetCwd([sessionId])
      if (get().findSessionId === sessionId) set({ findSessionId: null })

      const nextRoot = removeLeaf(found.tab.root, sessionId)
      if (!nextRoot) {
        rememberClosed(found.tab)
        removeTab(found.tab.id)
        return
      }

      const nextActive =
        found.tab.activeSessionId === sessionId
          ? firstLeaf(nextRoot).pane.sessionId
          : found.tab.activeSessionId

      set((state) => ({
        tabs: state.tabs.map((t) =>
          t.id === found.tab.id ? { ...t, root: nextRoot, activeSessionId: nextActive } : t
        )
      }))
    },

    async closeTab(tabId) {
      const tab = get().tabs.find((t) => t.id === tabId)
      if (!tab) return
      const sessionIds = leaves(tab.root).map((node) => node.pane.sessionId)
      await Promise.all(sessionIds.map((sessionId) => closeSessionInMain(sessionId)))
      for (const sessionId of sessionIds) disposeTerminal(sessionId)
      forgetCwd(sessionIds)
      rememberClosed(tab)
      removeTab(tabId)
    },

    async reconnect(sessionId) {
      const found = locate(sessionId)
      if (!found) return
      const { pane } = found
      await closeSessionInMain(sessionId)
      // 这段 await 期间用户可能已经把这个分屏关掉了。
      // 不复检就会在主进程里新建一个会话，而渲染层已没有对应的 pane 去接它的输出。
      if (!locate(sessionId)) return
      patchPane(sessionId, { status: 'connecting', message: undefined })

      try {
        if (pane.kind === 'ssh' && pane.hostId) {
          await window.jshell.sessions.open(pane.hostId, INITIAL_SIZE, sessionId)
        } else {
          await window.jshell.sessions.openLocal(INITIAL_SIZE, sessionId, pane.shellPath)
        }
      } catch (err) {
        // 失败才提示；成功不打扰
        const message = errorMessage(err)
        patchPane(sessionId, { status: 'error', message })
        get().pushToast(message, 'error')
      }
    },


    focusPane(tabId, sessionId) {
      set((state) => ({
        activeTabId: tabId,
        tabs: state.tabs.map((t) => (t.id === tabId ? { ...t, activeSessionId: sessionId } : t))
      }))
    },

    focusSession(sessionId) {
      const found = locate(sessionId)
      if (!found) return
      if (found.tab.activeSessionId === sessionId && get().activeTabId === found.tab.id) return
      set((state) => ({
        activeTabId: found.tab.id,
        tabs: state.tabs.map((t) =>
          t.id === found.tab.id ? { ...t, activeSessionId: sessionId } : t
        )
      }))
    },

    setActiveTab(tabId) {
      set({ activeTabId: tabId })
    },

    moveTab(fromId, toId) {
      if (fromId === toId) return
      set((state) => {
        const from = state.tabs.findIndex((tab) => tab.id === fromId)
        const to = state.tabs.findIndex((tab) => tab.id === toId)
        if (from < 0 || to < 0) return state
        const next = [...state.tabs]
        const [moved] = next.splice(from, 1)
        next.splice(to, 0, moved)
        return { tabs: next }
      })
    },

    reopenClosedTab() {
      const closed = get().closedTabs.at(-1)

      // 没有可重开的标签时，若当前分屏已结束，就地静默重连
      if (!closed) {
        const { tabs, activeTabId } = get()
        const tab = tabs.find((item) => item.id === activeTabId)
        const node = tab ? findLeaf(tab.root, tab.activeSessionId) : null
        if (node && (node.pane.status === 'closed' || node.pane.status === 'error')) {
          void get().reconnect(node.pane.sessionId)
          return
        }
        get().pushToast('没有可重新打开的标签', 'info')
        return
      }

      const restored = restoreTabs([closed], get().hosts, () => crypto.randomUUID())[0]
      set((state) => ({
        closedTabs: state.closedTabs.slice(0, -1),
        tabs: restored ? [...state.tabs, restored] : state.tabs,
        activeTabId: restored ? restored.id : state.activeTabId
      }))
      if (!restored) {
        get().pushToast('该标签对应的主机已删除，无法重开', 'error')
        return
      }
      // 恢复出来的分屏是 closed 占位：立即静默重连，不让用户再点一次「重新连接」
      for (const node of leaves(restored.root)) void get().reconnect(node.pane.sessionId)
    },

    setPaneMode(sessionId, mode) {
      patchPane(sessionId, { mode })
      const found = locate(sessionId)
      if (found) {
        set((state) => ({
          tabs: state.tabs.map((t) =>
            t.id === found.tab.id ? { ...t, activeSessionId: sessionId } : t
          )
        }))
      }
    },

    toggleTree() {
      set((state) => ({ treeOpen: !state.treeOpen }))
    },

    setTreeHeight(height) {
      set({ treeHeight: Math.max(150, Math.min(520, Math.round(height))) })
    },

    togglePaneFiles() {
      const { tabs, activeTabId } = get()
      const tab = tabs.find((t) => t.id === activeTabId)
      if (!tab) return
      const node = findLeaf(tab.root, tab.activeSessionId)
      if (!node) return
      patchPane(node.pane.sessionId, { mode: node.pane.mode === 'terminal' ? 'files' : 'terminal' })
    },

    cyclePane(step) {
      const { tabs, activeTabId } = get()
      const tab = tabs.find((t) => t.id === activeTabId)
      if (!tab) return
      const list = leaves(tab.root)
      if (list.length < 2) return
      const index = list.findIndex((node) => node.pane.sessionId === tab.activeSessionId)
      const next = list[(index + step + list.length) % list.length]
      set((state) => ({
        tabs: state.tabs.map((t) =>
          t.id === tab.id ? { ...t, activeSessionId: next.pane.sessionId } : t
        )
      }))
    },

    resizeSplit(splitId, ratio) {
      const { tabs, activeTabId } = get()
      const tab = tabs.find((t) => t.id === activeTabId)
      if (!tab) return
      set((state) => ({
        tabs: state.tabs.map((t) =>
          t.id === tab.id ? { ...t, root: setSplitRatio(t.root, splitId, ratio) } : t
        )
      }))
    },

    dock(request) {
      const result = dockTabs(get().tabs, request, () => crypto.randomUUID())
      if (!result) return
      set({ tabs: result.tabs, activeTabId: result.activeTabId })
    },

    async reloadHosts() {
      const hosts = await window.jshell.hosts.list()
      set({ hosts })
    },

    async reloadSnippets() {
      const snippets = await window.jshell.snippets.list()
      set({ snippets })
    },

    setAutoSync(state) {
      set({ autoSync: state })
    },

    async handleAutoSync(state) {
      const previous = get().autoSync?.lastSyncedAt ?? 0
      set({ autoSync: state })
      // 只有真的同步过才刷新：主进程的 running / pending 状态变化不需要重读配置
      if ((state.lastSyncedAt ?? 0) > previous) {
        await Promise.all([get().reloadHosts(), get().reloadSnippets(), get().reloadSettings()])
      }
    },

    async reloadSettings() {
      const settings = await window.jshell.settings.get()
      set({ settings })
      applyTheme(settings.theme)
    },

    async saveHost(draft) {
      const saved = await window.jshell.hosts.save(draft)
      await get().reloadHosts()
      get().pushToast(`已保存主机「${saved.name}」`, 'success')
    },

    async removeHost(hostId) {
      await window.jshell.hosts.remove(hostId)
      set((state) => ({ hosts: state.hosts.filter((h) => h.id !== hostId) }))
    },

    async updateSettings(patch) {
      const next = await window.jshell.settings.update(patch)
      set({ settings: next })
      if (patch.theme) applyTheme(next.theme)
    },

    previewSettings(patch) {
      set((state) => ({ settings: { ...state.settings, ...patch } }))
      if (patch.theme) applyTheme(patch.theme)
    },

    openFind(sessionId) {
      set({ findSessionId: sessionId })
      get().focusSession(sessionId)
    },

    closeFind() {
      set({ findSessionId: null })
    },

    async trustHostKey() {
      const prompt = get().hostKeyPrompt
      if (!prompt) return
      set({ hostKeyPrompt: null })
      try {
        await window.jshell.hosts.trustKey(
          prompt.host,
          prompt.port,
          prompt.algorithm,
          prompt.actual
        )
        await get().reconnect(prompt.sessionId)
      } catch (err) {
        get().pushToast(errorMessage(err), 'error')
      }
    },

    dismissHostKeyPrompt() {
      set({ hostKeyPrompt: null })
    },

    async checkUpdate() {
      if (get().updateChecking) return
      set({ updateChecking: true })
      try {
        const result = await window.jshell.update.check()
        set({ updateResult: result })
        if (result.status === 'available') {
          get().pushToast(result.message ?? '发现新版本', 'success')
        } else if (result.status === 'error') {
          get().pushToast(result.message ?? '检查更新失败', 'error')
        } else {
          get().pushToast(result.message ?? '当前已是最新版本', 'info')
        }
      } catch (err) {
        get().pushToast(`检查更新失败：${errorMessage(err)}`, 'error')
      } finally {
        set({ updateChecking: false })
      }
    },

    async saveSnippet(input) {
      const snippet = await window.jshell.snippets.save(input)
      set((state) => {
        const exists = state.snippets.some((s) => s.id === snippet.id)
        return {
          snippets: exists
            ? state.snippets.map((s) => (s.id === snippet.id ? snippet : s))
            : [...state.snippets, snippet]
        }
      })
    },

    async removeSnippet(id) {
      await window.jshell.snippets.remove(id)
      set((state) => ({ snippets: state.snippets.filter((s) => s.id !== id) }))
    },

    pushToast(text, kind = 'info') {
      const id = crypto.randomUUID()
      set((state) => ({ toasts: [...state.toasts, { id, kind, text }] }))
      setTimeout(() => get().dismissToast(id), 3000)
    },

    dismissToast(id) {
      set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }))
    }
  }
})

/** 供组件使用的派生查询 */
export function tabPaneCount(tab: TerminalTab): number {
  return countLeaves(tab.root)
}

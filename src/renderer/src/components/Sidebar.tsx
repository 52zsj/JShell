import { useMemo, useState } from 'react'
import type { HostProfile } from '@shared/types'
import { useAppStore } from '../store'
import { errorMessage } from '../utils'
import {
  IconChevronDown,
  IconChevronRight,
  IconClose,
  IconEdit,
  IconSearch,
  IconServer,
  IconTerminal,
  IconTrash
} from '../icons'
import { findLeaf } from '../pane-tree'
import { HostContextMenu, type HostMenuTarget } from './HostContextMenu'
import { SidebarTree } from './SidebarTree'

interface Props {
  onCreate: () => void
  onEdit: (host: HostProfile) => void
  onClone: (host: HostProfile) => void
  onOpenLocal: (shellPath?: string) => void
}

/** 「本机」分组在折叠状态里用的键，避免和用户分组名冲突 */
const LOCAL_GROUP_KEY = '__jshell-local__'

/**
 * 左侧导航：本机终端 + 主机列表。
 * 本机 shell 由主进程探测（/etc/shells 或 cmd/PowerShell），点击即开一个本地标签页。
 */
export function Sidebar({ onCreate, onEdit, onClone, onOpenLocal }: Props) {
  const hosts = useAppStore((s) => s.hosts)
  const shells = useAppStore((s) => s.shells)
  const openHost = useAppStore((s) => s.openHost)
  const removeHost = useAppStore((s) => s.removeHost)
  const pushToast = useAppStore((s) => s.pushToast)
  const showLocalShells = useAppStore((s) => s.settings.showLocalShells)
  const deleteButton = useAppStore((s) => s.settings.hostDeleteButton)
  const confirmDelete = useAppStore((s) => s.settings.hostDeleteConfirm)
  const hiddenShells = useAppStore((s) => s.settings.hiddenLocalShells)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const tabs = useAppStore((s) => s.tabs)
  const activeTabId = useAppStore((s) => s.activeTabId)
  const version = useAppStore((s) => s.info?.version ?? '0.0.0')
  const [keyword, setKeyword] = useState('')
  const [menu, setMenu] = useState<HostMenuTarget | null>(null)
  /** 已折叠的分组（主机按 group，本机用 LOCAL_GROUP_KEY）；互不影响，允许多个同时展开/折叠 */
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  const term = keyword.trim().toLowerCase()

  const localShells = useMemo(() => {
    if (!shells || !showLocalShells) return []
    const visible = shells.shells.filter((shell) => !hiddenShells.includes(shell.path))
    if (!term) return visible
    return visible.filter((shell) =>
      `${shell.name} ${shell.label} ${shell.path} 本机 local`.toLowerCase().includes(term)
    )
  }, [shells, term, showLocalShells, hiddenShells])

  /** 当前选中的 SSH 会话：目录树跟着它走 */
  const activePane = useMemo(() => {
    const tab = tabs.find((item) => item.id === activeTabId)
    return tab ? (findLeaf(tab.root, tab.activeSessionId)?.pane ?? null) : null
  }, [tabs, activeTabId])
  const sshPane = activePane?.kind === 'ssh' && activePane.status === 'ready' ? activePane : null

  const hideShell = (shellPath: string): void => {
    void updateSettings({ hiddenLocalShells: [...new Set([...hiddenShells, shellPath])] }).catch(
      (err) => pushToast(errorMessage(err), 'error')
    )
    pushToast('已隐藏该终端，可在「设置 → 终端」恢复', 'info')
  }

  const grouped = useMemo(() => {
    const filtered = hosts.filter((host) => {
      if (!term) return true
      const text = `${host.name} ${host.host} ${host.username} ${host.group ?? ''}`.toLowerCase()
      return text.includes(term)
    })

    const map = new Map<string, HostProfile[]>()
    for (const host of filtered) {
      const key = host.group || '未分组'
      const list = map.get(key) ?? []
      list.push(host)
      map.set(key, list)
    }
    return [...map.entries()]
  }, [hosts, term])

  const groupKeys = useMemo(() => {
    const keys = new Set(grouped.map(([group]) => group))
    if (localShells.length > 0) keys.add(LOCAL_GROUP_KEY)
    return keys
  }, [grouped, localShells])

  const toggleGroup = (key: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const expandAll = (): void => setCollapsed(new Set())
  const collapseAll = (): void => setCollapsed(new Set(groupKeys))

  const handleDelete = async (host: HostProfile) => {
    if (confirmDelete) {
      const ok = await window.jshell.dialog.confirm({
        title: '删除主机',
        message: `确定删除「${host.name || host.host}」？`,
        detail: '仅删除本地保存的配置与凭据，不影响远端服务器。',
        danger: true
      })
      if (!ok) return
    }
    try {
      await removeHost(host.id)
      pushToast('已删除主机', 'success')
    } catch (err) {
      pushToast(errorMessage(err), 'error')
    }
  }

  const copyAddress = async (host: HostProfile) => {
    try {
      await navigator.clipboard.writeText(`${host.username}@${host.host}:${host.port}`)
      pushToast('已复制主机地址', 'success')
    } catch (err) {
      pushToast(errorMessage(err), 'error')
    }
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <div className="brand">
          <span className="brand-mark">&gt;_</span>
          <span className="brand-name">JShell</span>
        </div>
      </div>

      <div className="search-box">
        <IconSearch />
        <input
          className="search-input"
          placeholder={showLocalShells ? '搜索主机 / 本地终端' : '搜索主机'}
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
        />
      </div>

      <div className="host-toolbar">
        <button className="host-toolbar-btn" title="展开全部分组" onClick={expandAll}>
          全部展开
        </button>
        <button className="host-toolbar-btn" title="折叠全部分组" onClick={collapseAll}>
          全部折叠
        </button>
      </div>

      <div className="host-list">
        {localShells.length > 0 && (
          <section className="host-group">
            <button
              className="host-group-title"
              onClick={() => toggleGroup(LOCAL_GROUP_KEY)}
              title={collapsed.has(LOCAL_GROUP_KEY) ? '展开' : '折叠'}
            >
              {collapsed.has(LOCAL_GROUP_KEY) ? <IconChevronRight /> : <IconChevronDown />}
              <span className="host-group-label">本机</span>
              <span className="host-group-count">{localShells.length}</span>
            </button>
            {!collapsed.has(LOCAL_GROUP_KEY) && localShells.map((shell) => (
              <div
                key={shell.path}
                className="host-row is-local"
                onClick={() => onOpenLocal(shell.path)}
                title={`打开本地终端：${shell.path}`}
              >
                <span className="host-dot" style={{ background: 'var(--accent)' }} />
                <span className="host-meta">
                  <span className="host-name">
                    {shell.label}
                    {shell.isDefault && <span className="host-tag">默认</span>}
                  </span>
                  <span className="host-sub">{shell.path}</span>
                </span>
                <span className="host-actions">
                  <button
                    className="icon-btn tiny"
                    title="隐藏此终端（可在设置中恢复）"
                    onClick={(e) => {
                      e.stopPropagation()
                      hideShell(shell.path)
                    }}
                  >
                    <IconClose />
                  </button>
                  <span className="host-enter">
                    <IconTerminal />
                  </span>
                </span>
              </div>
            ))}
          </section>
        )}

        {grouped.length === 0 && hosts.length > 0 && localShells.length === 0 && (
          <div className="sidebar-empty">
            <IconServer />
            <p>没有匹配的主机</p>
          </div>
        )}

        {grouped.map(([group, list]) => (
          <section key={group} className="host-group">
            <button
              className="host-group-title"
              onClick={() => toggleGroup(group)}
              title={collapsed.has(group) ? '展开' : '折叠'}
            >
              {collapsed.has(group) ? <IconChevronRight /> : <IconChevronDown />}
              <span className="host-group-label">{group}</span>
              <span className="host-group-count">{list.length}</span>
            </button>
            {!collapsed.has(group) && list.map((host) => (
              <div
                key={host.id}
                className="host-row"
                onClick={() => void openHost(host.id)}
                onContextMenu={(event) => {
                  event.preventDefault()
                  setMenu({ host, x: event.clientX, y: event.clientY })
                }}
                title={`${host.username}@${host.host}:${host.port}`}
              >
                <span className="host-dot" style={{ background: host.color || 'var(--text-dim)' }} />
                <span className="host-meta">
                  <span className="host-name">{host.name || host.host}</span>
                  <span className="host-sub">
                    {host.username}@{host.host}
                  </span>
                </span>
                <span className="host-actions">
                  <button
                    className="icon-btn tiny"
                    title="编辑"
                    onClick={(e) => {
                      e.stopPropagation()
                      onEdit(host)
                    }}
                  >
                    <IconEdit />
                  </button>
                  {deleteButton && (
                    <button
                      className="icon-btn tiny danger"
                      title="删除"
                      onClick={(e) => {
                        e.stopPropagation()
                        void handleDelete(host)
                      }}
                    >
                      <IconTrash />
                    </button>
                  )}
                </span>
              </div>
            ))}
          </section>
        ))}

        {hosts.length === 0 && localShells.length === 0 && !term && (
          <div className="sidebar-empty">
            <IconServer />
            <p>还没有主机</p>
            <button className="btn btn-primary" onClick={onCreate}>
              添加第一台主机
            </button>
          </div>
        )}
      </div>

      {sshPane && <SidebarTree sessionId={sshPane.sessionId} />}

      {menu && (
        <HostContextMenu
          target={menu}
          onClose={() => setMenu(null)}
          onOpen={() => void openHost(menu.host.id)}
          onEdit={() => onEdit(menu.host)}
          onClone={() => onClone(menu.host)}
          onCopy={() => void copyAddress(menu.host)}
          onDelete={() => void handleDelete(menu.host)}
        />
      )}

      <footer className="sidebar-foot">
        <span>{hosts.length} 台主机</span>
        <span className="mono">v{version}</span>
      </footer>
    </aside>
  )
}

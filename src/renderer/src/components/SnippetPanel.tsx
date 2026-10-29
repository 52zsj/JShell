import { useState } from 'react'
import { useAppStore } from '../store'
import { errorMessage } from '../utils'
import { IconClose, IconCode, IconPlus, IconTrash, IconEdit, IconClipboard } from '../icons'
import { getFocusedSession, getTerminal } from '../terminal-registry'

interface Props {
  onClose: () => void
}

/**
 * 命令片段抽屉。
 *
 * 三件事：
 *  - 点击片段：把命令发到**当前聚焦的会话**（等价于用户键入并回车）
 *  - 复制按钮：把命令复制到剪贴板
 *  - 编辑按钮：改名称 / 命令 / 触发词
 *
 * 触发词（alias）用来做终端里的补全：输入 `gps` 按 Tab 补成 `git push`。
 */
export function SnippetPanel({ onClose }: Props) {
  const snippets = useAppStore((s) => s.snippets)
  const tabs = useAppStore((s) => s.tabs)
  const activeTabId = useAppStore((s) => s.activeTabId)
  const saveSnippet = useAppStore((s) => s.saveSnippet)
  const removeSnippet = useAppStore((s) => s.removeSnippet)
  const pushToast = useAppStore((s) => s.pushToast)

  const [name, setName] = useState('')
  const [command, setCommand] = useState('')
  const [alias, setAlias] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [formOpen, setFormOpen] = useState(false)

  /**
   * 找到当前该往哪个会话发。
   *
   * 注意：tabId 和 sessionId 是两回事。早期这里直接传了 activeTabId，
   * 主进程按 sessionId 找不到会话就静默失败——点击片段「什么也没发生」。
   */
  const resolveSessionId = (): string | null => {
    const focused = getFocusedSession()
    if (focused) return focused
    const tab = tabs.find((item) => item.id === activeTabId)
    return tab?.activeSessionId ?? null
  }

  /**
   * 把命令**填进**终端，不代为回车。
   *
   * 一来避免误触（点一下就把命令执行了），二来有些命令执行前用户想改个参数。
   * 填完聚焦终端，用户自己回车。
   */
  const fill = (text: string): void => {
    const sessionId = resolveSessionId()
    if (!sessionId) {
      pushToast('请先打开一个会话', 'error')
      return
    }
    window.jshell.sessions.write(sessionId, text)
    getTerminal(sessionId)?.focus()
    pushToast('已填入终端，按回车执行', 'success')
  }

  const copy = async (text: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
      pushToast('已复制到剪贴板', 'success')
    } catch (err) {
      pushToast(errorMessage(err), 'error')
    }
  }

  const openCreate = (): void => {
    setEditingId(null)
    setName('')
    setCommand('')
    setAlias('')
    setFormOpen(true)
  }

  const openEdit = (id: string): void => {
    const snippet = snippets.find((item) => item.id === id)
    if (!snippet) return
    setEditingId(snippet.id)
    setName(snippet.name)
    setCommand(snippet.command)
    setAlias(snippet.alias ?? '')
    setFormOpen(true)
  }

  const submit = async (): Promise<void> => {
    if (!command.trim()) {
      pushToast('命令内容不能为空', 'error')
      return
    }
    try {
      await saveSnippet({ id: editingId ?? undefined, name, command, alias })
      setFormOpen(false)
      setEditingId(null)
      setName('')
      setCommand('')
      setAlias('')
      pushToast(editingId ? '片段已更新' : '片段已添加', 'success')
    } catch (err) {
      pushToast(errorMessage(err), 'error')
    }
  }

  const remove = async (id: string): Promise<void> => {
    try {
      await removeSnippet(id)
      pushToast('片段已删除', 'success')
    } catch (err) {
      pushToast(errorMessage(err), 'error')
    }
  }

  return (
    <aside className="snippet-panel">
      <header className="snippet-head">
        <span className="snippet-title">
          <IconCode />
          命令片段
        </span>
        <div className="snippet-head-actions">
          <button className="icon-btn tiny" title="新增" onClick={openCreate}>
            <IconPlus />
          </button>
          <button className="icon-btn tiny" title="关闭" onClick={onClose}>
            <IconClose />
          </button>
        </div>
      </header>

      {formOpen && (
        <div className="snippet-form">
          <input
            className="input"
            placeholder="片段名称（可选）"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <textarea
            className="input mono"
            rows={3}
            placeholder="命令内容，例如：docker compose ps"
            value={command}
            onChange={(e) => setCommand(e.target.value)}
          />
          <input
            className="input mono"
            placeholder="触发词（可选）：输入它按 Tab 补全成上面的命令"
            value={alias}
            onChange={(e) => setAlias(e.target.value)}
          />
          <div className="snippet-form-actions">
            <button
              className="btn btn-ghost"
              onClick={() => {
                setFormOpen(false)
                setEditingId(null)
              }}
            >
              取消
            </button>
            <button className="btn btn-primary" onClick={() => void submit()}>
              {editingId ? '保存修改' : '添加'}
            </button>
          </div>
        </div>
      )}

      <div className="snippet-list">
        {snippets.length === 0 && (
          <p className="snippet-empty">还没有片段，点右上角 + 添加常用命令。</p>
        )}
        {snippets.map((snippet) => (
          <div key={snippet.id} className="snippet-item">
            <button
              className="snippet-send"
              onClick={() => fill(snippet.command)}
              title="填入当前会话（不自动执行）"
            >
              <span className="snippet-name">{snippet.name}</span>
              {snippet.alias && <span className="snippet-alias">{snippet.alias}</span>}
              <code className="snippet-cmd">{snippet.command}</code>
            </button>
            <button
              className="icon-btn tiny"
              title="复制到剪贴板"
              onClick={() => void copy(snippet.command)}
            >
              <IconClipboard />
            </button>
            <button className="icon-btn tiny" title="编辑片段" onClick={() => openEdit(snippet.id)}>
              <IconEdit />
            </button>
            <button
              className="icon-btn tiny danger"
              title="删除片段"
              onClick={() => void remove(snippet.id)}
            >
              <IconTrash />
            </button>
          </div>
        ))}
      </div>
    </aside>
  )
}

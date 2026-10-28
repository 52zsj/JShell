import { useState } from 'react'
import { useAppStore } from '../store'
import { errorMessage } from '../utils'
import { IconClose, IconCode, IconPlus, IconTrash } from '../icons'

interface Props {
  onClose: () => void
}

/**
 * 命令片段抽屉。
 * 点击片段会把命令写入当前激活会话（等价于用户键入并回车）。
 */
export function SnippetPanel({ onClose }: Props) {
  const snippets = useAppStore((s) => s.snippets)
  const activeTabId = useAppStore((s) => s.activeTabId)
  const saveSnippet = useAppStore((s) => s.saveSnippet)
  const removeSnippet = useAppStore((s) => s.removeSnippet)
  const pushToast = useAppStore((s) => s.pushToast)

  const [name, setName] = useState('')
  const [command, setCommand] = useState('')
  const [adding, setAdding] = useState(false)

  const send = (text: string) => {
    if (!activeTabId) {
      pushToast('请先打开一个会话', 'error')
      return
    }
    void window.jshell.sessions.write(activeTabId, `${text}\r`)
  }

  const submit = async () => {
    if (!command.trim()) return
    try {
      await saveSnippet({ name, command })
      setName('')
      setCommand('')
      setAdding(false)
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
          <button className="icon-btn tiny" title="新增" onClick={() => setAdding((v) => !v)}>
            <IconPlus />
          </button>
          <button className="icon-btn tiny" title="关闭" onClick={onClose}>
            <IconClose />
          </button>
        </div>
      </header>

      {adding && (
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
          <div className="snippet-form-actions">
            <button className="btn btn-ghost" onClick={() => setAdding(false)}>
              取消
            </button>
            <button className="btn btn-primary" onClick={() => void submit()}>
              保存
            </button>
          </div>
        </div>
      )}

      <div className="snippet-list">
        {snippets.length === 0 && <p className="snippet-empty">还没有片段，点右上角 + 添加常用命令。</p>}
        {snippets.map((snippet) => (
          <div key={snippet.id} className="snippet-item">
            <button className="snippet-send" onClick={() => send(snippet.command)} title="发送到当前会话">
              <span className="snippet-name">{snippet.name}</span>
              <code className="snippet-cmd">{snippet.command}</code>
            </button>
            <button
              className="icon-btn tiny danger"
              title="删除片段"
              onClick={() => void removeSnippet(snippet.id)}
            >
              <IconTrash />
            </button>
          </div>
        ))}
      </div>
    </aside>
  )
}

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { HostProfile } from '@shared/types'

export interface HostMenuTarget {
  host: HostProfile
  x: number
  y: number
}

interface Props {
  target: HostMenuTarget
  onClose: () => void
  onOpen: () => void
  onEdit: () => void
  onClone: () => void
  onCopy: () => void
  onDelete: () => void
}

/** 主机列表右键菜单：补上「删除」等低频但必要的入口 */
export function HostContextMenu({ target, onClose, onOpen, onEdit, onClone, onCopy, onDelete }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: target.x, top: target.y })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const left = Math.min(target.x, window.innerWidth - rect.width - 8)
    const top = Math.min(target.y, window.innerHeight - rect.height - 8)
    setPos({ left: Math.max(8, left), top: Math.max(8, top) })
  }, [target.x, target.y])

  useEffect(() => {
    const close = (): void => onClose()
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('click', close)
    window.addEventListener('keydown', onKey)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('blur', close)
    }
  }, [onClose])

  const run = (action: () => void) => () => {
    onClose()
    action()
  }

  return (
    <div
      ref={ref}
      className="context-menu host-menu"
      style={{ left: pos.left, top: pos.top }}
      onClick={(event) => event.stopPropagation()}
    >
      <button className="context-item" onClick={run(onOpen)}>
        打开
        <span className="context-hint mono">{target.host.username}@{target.host.host}</span>
      </button>
      <button className="context-item" onClick={run(onEdit)}>
        编辑主机
      </button>
      <button className="context-item" onClick={run(onClone)}>
        克隆配置
      </button>
      <button className="context-item" onClick={run(onCopy)}>
        复制地址
      </button>
      <div className="context-divider" />
      <button className="context-item is-danger" onClick={run(onDelete)}>
        删除主机
      </button>
    </div>
  )
}

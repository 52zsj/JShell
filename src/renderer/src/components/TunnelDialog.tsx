import { useEffect, useState } from 'react'
import type { TunnelRuntimeInfo } from '@shared/types'
import { useAppStore } from '../store'
import { useModalDrag } from '../use-modal-drag'
import { cx, errorMessage } from '../utils'
import { IconClose } from '../icons'

interface Props {
  sessionId: string
  /** 会话标题，用于告诉用户这条隧道建在哪台机器上 */
  sessionLabel: string
  onClose: () => void
}

/**
 * 端口转发（SSH 本地转发 -L）面板。
 *
 * 只做 -L：本机监听一个端口，连接通过既有 SSH 通道送到远端目标。
 * 覆盖「连不上内网数据库 / 管理面板」这类最常见的场景，且不需要额外授权流程。
 *
 * 规则会持久化（store.tunnels），但**会话断开时监听会被主进程自动停掉** ——
 * 隧道依附于 SSH 连接，连接没了留着监听端口没有意义。
 */
export function TunnelDialog({ sessionId, sessionLabel, onClose }: Props) {
  const tunnels = useAppStore((s) => s.tunnels)
  const loadTunnels = useAppStore((s) => s.loadTunnels)
  const startTunnel = useAppStore((s) => s.startTunnel)
  const stopTunnel = useAppStore((s) => s.stopTunnel)
  const removeTunnel = useAppStore((s) => s.removeTunnel)
  const pushToast = useAppStore((s) => s.pushToast)

  const [bindPort, setBindPort] = useState('5432')
  const [destHost, setDestHost] = useState('127.0.0.1')
  const [destPort, setDestPort] = useState('5432')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const drag = useModalDrag()

  useEffect(() => {
    void loadTunnels().catch(() => undefined)
  }, [loadTunnels])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const mine = tunnels.filter((t) => t.sessionId === sessionId || !t.sessionId)

  const parsePort = (value: string): number => {
    const port = Number(value.trim())
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('端口必须是 1–65535 的整数')
    }
    return port
  }

  const create = async (): Promise<void> => {
    setError(null)
    setBusy(true)
    try {
      const port = parsePort(bindPort)
      const remotePort = parsePort(destPort)
      const host = destHost.trim()
      if (!host) throw new Error('目标主机不能为空')
      await startTunnel(sessionId, {
        bindHost: '127.0.0.1',
        bindPort: port,
        destHost: host,
        destPort: remotePort
      })
      pushToast(`已开始监听 127.0.0.1:${port}`, 'success')
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const toggle = async (tunnel: TunnelRuntimeInfo): Promise<void> => {
    setError(null)
    try {
      if (tunnel.status === 'listening') {
        await stopTunnel(tunnel.id)
      } else {
        // 带上原 id：重启同一条规则，而不是又建出一条
        await startTunnel(sessionId, {
          id: tunnel.id,
          bindHost: tunnel.bindHost,
          bindPort: tunnel.bindPort,
          destHost: tunnel.destHost,
          destPort: tunnel.destPort
        })
      }
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  return (
    <div className="modal-mask">
      <div
        className="modal tunnel-modal is-draggable"
        ref={drag.modalRef}
        style={drag.style}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="modal-head" {...drag.handleProps}>
          <h2>端口转发</h2>
          <button type="button" className="icon-btn" onClick={onClose} title="关闭">
            <IconClose />
          </button>
        </header>

        <div className="modal-body">
          <p className="notice">
            本地转发（<code>-L</code>）：本机监听一个端口，连接经这台 SSH 送到远端目标。
            连接断开时监听会自动停止。
          </p>
          <div className="tunnel-session">
            <span className="status-label">会话</span>
            <span className="mono">{sessionLabel}</span>
          </div>

          <div className="tunnel-form">
            <label className="field port">
              <span>本地端口</span>
              <input
                className="input"
                inputMode="numeric"
                value={bindPort}
                onChange={(event) => setBindPort(event.target.value)}
                placeholder="5432"
              />
            </label>
            <span className="tunnel-arrow">→</span>
            <label className="field grow">
              <span>目标地址</span>
              <input
                className="input"
                value={destHost}
                onChange={(event) => setDestHost(event.target.value)}
                placeholder="127.0.0.1 / db.internal"
              />
            </label>
            <label className="field port">
              <span>目标端口</span>
              <input
                className="input"
                inputMode="numeric"
                value={destPort}
                onChange={(event) => setDestPort(event.target.value)}
                placeholder="5432"
              />
            </label>
            <button className="btn btn-primary" disabled={busy} onClick={() => void create()}>
              {busy ? '启动中…' : '启动'}
            </button>
          </div>

          {error && <p className="form-error">{error}</p>}

          <div className="tunnel-list">
            <div className="tunnel-list-head">
              <span>本会话的规则</span>
              <span className="status-label">{mine.length} 条</span>
            </div>
            {mine.length === 0 && <div className="tunnel-empty">还没有规则，填上面的端口即可新建。</div>}
            {mine.map((tunnel) => (
              <div className="tunnel-row" key={tunnel.id}>
                <span
                  className={cx(
                    'status-dot',
                    tunnel.status === 'listening' ? 'status-ready' : 'status-closed'
                  )}
                />
                <span className="mono tunnel-rule">
                  {tunnel.bindHost}:{tunnel.bindPort} → {tunnel.destHost}:{tunnel.destPort}
                </span>
                <span className="status-label">
                  {tunnel.status === 'listening' ? '监听中' : '已停止'}
                </span>
                <button className="btn btn-ghost tiny" onClick={() => void toggle(tunnel)}>
                  {tunnel.status === 'listening' ? '停止' : '启动'}
                </button>
                <button
                  className="btn btn-ghost tiny danger"
                  onClick={() => void removeTunnel(tunnel.id)}
                >
                  删除
                </button>
              </div>
            ))}
          </div>
        </div>

        <footer className="modal-foot">
          <span className="notice grow">
            用法示例：连着数据库服务器时，本地端口 5432 → <code>127.0.0.1:5432</code>，
            然后本机客户端连 <code>127.0.0.1:5432</code> 即可。
          </span>
          <button className="btn" onClick={onClose}>
            关闭
          </button>
        </footer>
      </div>
    </div>
  )
}

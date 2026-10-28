import { randomUUID } from 'node:crypto'
import net from 'node:net'
import type { SessionEvent, TunnelConfig, TunnelRuntimeInfo } from '../../shared/types'
import type { SessionManager } from './session-manager'
import type { StoreService } from './store'

interface ActiveTunnel {
  cfg: TunnelConfig
  server: net.Server
  sockets: Set<net.Socket>
}

/**
 * 端口转发（MVP 实现本地转发 -L；remote / dynamic 已在类型层预留）。
 *
 * 数据流：
 *   本地应用 -> net.Socket(127.0.0.1:bindPort) -> SSH forwardOut(destHost:destPort) -> 目标服务
 *
 * 之所以先只做 -L：它对「连不上内网数据库 / 管理面板」的场景覆盖最好，
 * 且完全复用既有 SSH 连接，无需额外端口与授权流程。
 */
export class TunnelManager {
  private readonly active = new Map<string, ActiveTunnel>()
  private readonly sessions: SessionManager
  private readonly store: StoreService
  private readonly emit: (event: SessionEvent) => void

  constructor(sessions: SessionManager, store: StoreService, emit: (event: SessionEvent) => void) {
    this.sessions = sessions
    this.store = store
    this.emit = emit
  }

  async start(
    sessionId: string,
    input: Omit<TunnelConfig, 'id' | 'enabled'> & { id?: string }
  ): Promise<TunnelRuntimeInfo> {
    const session = this.sessions.requireSsh(sessionId)
    if (input.kind !== 'local') {
      throw new Error('当前版本仅支持本地转发（-L），远程/动态转发为后续版本预留')
    }

    const id = input.id ?? randomUUID()
    if (this.active.has(id)) return this.toInfo(this.active.get(id)!.cfg, 'listening')

    const cfg: TunnelConfig = { ...input, id, sessionId, enabled: true }
    const sockets = new Set<net.Socket>()
    const server = net.createServer((socket) => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
      socket.on('error', () => socket.destroy())

      // 通过 SSH 通道把本地连接桥接到远端目标
      try {
        session.getClient().forwardOut('127.0.0.1', 0, cfg.destHost, cfg.destPort, (err, stream) => {
          if (err) {
            socket.destroy()
            return
          }
          socket.pipe(stream).pipe(socket)
          stream.on('close', () => socket.destroy())
          stream.on('error', () => socket.destroy())
        })
      } catch {
        socket.destroy()
      }
    })
    // 运行期错误（端口被占用后的异常、句柄错误）不能让进程崩掉
    server.on('error', () => {
      this.stop(id)
    })

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => reject(err)
      server.once('error', onError)
      server.listen(cfg.bindPort, cfg.bindHost, () => {
        server.off('error', onError)
        resolve()
      })
    })

    this.active.set(id, { cfg, server, sockets })
    this.store.saveTunnel(cfg)
    const info = this.toInfo(cfg, 'listening')
    this.emit({ type: 'tunnel', tunnel: { id, sessionId, status: 'listening' } })
    return info
  }

  stop(tunnelId: string): void {
    const entry = this.active.get(tunnelId)
    if (!entry) return
    for (const socket of entry.sockets) socket.destroy()
    entry.server.close()
    this.active.delete(tunnelId)
    this.emit({ type: 'tunnel', tunnel: { id: tunnelId, sessionId: entry.cfg.sessionId ?? '', status: 'closed' } })
  }

  /** 会话断开时按 sessionId 停掉全部转发 */
  stopBySession(sessionId: string): void {
    for (const [id, entry] of this.active) {
      if (entry.cfg.sessionId === sessionId) this.stop(id)
    }
  }

  stopAll(): void {
    for (const id of [...this.active.keys()]) this.stop(id)
  }

  private toInfo(cfg: TunnelConfig, status: TunnelRuntimeInfo['status']): TunnelRuntimeInfo {
    return { ...cfg, status }
  }
}

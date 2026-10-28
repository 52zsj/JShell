import fs from 'node:fs'
import type { OpenSessionResult, SessionEvent } from '../../shared/types'
import { FlowControl } from './flow-control'
import { LocalSession } from './local-session'
import { log } from './logger'
import { detectShells } from './shells'
import { SshSession } from './ssh-session'
import type { StoreService } from './store'
import type { TerminalSession } from './types'

/**
 * 会话管理器：主进程内所有会话（SSH / 本地 PTY）的唯一入口。
 *
 * 职责：
 *  - 创建 / 索引 / 销毁会话；
 *  - 把会话事件（数据、状态）统一向上抛给 IPC 层；
 *  - 对外区分能力：只有 SSH 会话才有 SFTP / 端口转发（requireSsh）。
 */
export class SessionManager {
  private readonly sessions = new Map<string, TerminalSession>()
  /** 每个会话一个流控账本：渲染端确认了多少、还欠多少 */
  private readonly flows = new Map<string, FlowControl>()
  private readonly store: StoreService
  private readonly emit: (event: SessionEvent) => void
  private flowTimer?: NodeJS.Timeout

  constructor(store: StoreService, emit: (event: SessionEvent) => void) {
    this.store = store
    this.emit = emit
    this.startFlowWatchdog()
  }

  // ------------------------------------------------------------- 输出流控

  private flowOf(sessionId: string): FlowControl | null {
    const session = this.sessions.get(sessionId)
    if (!session) return null
    let flow = this.flows.get(sessionId)
    if (!flow) {
      flow = new FlowControl(
        { pause: () => session.pause(), resume: () => session.resume() },
        {
          onStall: () =>
            log.warn(`会话 ${sessionId} 的输出确认长时间未到达，已强制恢复（可能是终端已关闭）`)
        }
      )
      this.flows.set(sessionId, flow)
    }
    return flow
  }

  /** 主进程推出一块终端输出后记账，超过高水位会暂停该会话的数据源 */
  noteOutput(sessionId: string, chars: number): void {
    this.flowOf(sessionId)?.onOutput(chars)
  }

  /** 渲染进程解析完一块输出后的回执 */
  ack(sessionId: string, chars: number): void {
    this.flows.get(sessionId)?.onAck(chars)
  }

  /** 看门狗：1 秒一次，兜住「暂停后 ack 再也不来」的情况，避免会话永久卡死 */
  private startFlowWatchdog(): void {
    this.flowTimer = setInterval(() => {
      for (const flow of this.flows.values()) flow.tick()
    }, 1000)
    this.flowTimer.unref?.()
  }

  dispose(): void {
    if (this.flowTimer) clearInterval(this.flowTimer)
    this.flowTimer = undefined
    this.flows.clear()
  }

  // ---------------------------------------------------------------- SSH

  /**
   * 新建 SSH 会话并立即返回 sessionId，握手在后台继续。
   * 由渲染进程先生成 sessionId 再发起连接，可彻底避免「事件早于标签页创建」的竞态。
   */
  async openSsh(
    hostId: string,
    size: { cols: number; rows: number },
    sessionId: string
  ): Promise<OpenSessionResult> {
    const host = this.store.getHost(hostId)
    if (!host) throw new Error('主机不存在')
    if (this.sessions.has(sessionId)) throw new Error('会话 id 冲突，请重试')

    const session = new SshSession(sessionId, host, {
      store: this.store,
      emit: this.emit,
      hostKeyPolicy: this.store.getSettings().hostKeyPolicy
    })
    this.sessions.set(sessionId, session)
    this.store.touchHost(hostId)

    // 后台握手，错误已由会话自身以 status 事件上报
    void session.connect(size).catch(() => undefined)

    return {
      sessionId,
      kind: 'ssh',
      title: session.title,
      subtitle: session.subtitle,
      hostId
    }
  }

  // -------------------------------------------------------------- 本地终端

  /** 新建本地终端；shellPath 缺省时用设置里的值，再缺省则自动探测 */
  async openLocal(
    size: { cols: number; rows: number },
    sessionId: string,
    shellPath?: string
  ): Promise<OpenSessionResult> {
    if (this.sessions.has(sessionId)) throw new Error('会话 id 冲突，请重试')

    const configured = this.store.getSettings().localShell
    const target = shellPath || configured || detectShells().defaultShell

    if (/[\\/]/.test(target) && !fs.existsSync(target)) {
      throw new Error(`本地 shell 不存在：${target}，请在设置中重新选择`)
    }

    const session = new LocalSession(sessionId, target, { emit: this.emit })
    this.sessions.set(sessionId, session)
    session.start(size)

    return {
      sessionId,
      kind: 'local',
      title: session.title,
      subtitle: session.subtitle,
      shellPath: target
    }
  }

  // ---------------------------------------------------------------- 查询

  get(sessionId: string): TerminalSession | undefined {
    return this.sessions.get(sessionId)
  }

  require(sessionId: string): TerminalSession {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error('会话不存在或已关闭')
    return session
  }

  /** 需要 SFTP / 端口转发时使用：本地终端会给出明确提示而不是 TypeError */
  requireSsh(sessionId: string): SshSession {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error('会话不存在或已关闭')
    if (!(session instanceof SshSession)) throw new Error('本地终端不支持该操作，请对 SSH 会话使用')
    return session
  }

  // ---------------------------------------------------------------- 销毁

  close(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.close()
    this.sessions.delete(sessionId)
    // 流控账本随会话一起丢弃，避免 Map 长期持有已关闭会话
    this.flows.delete(sessionId)
  }

  closeAll(): void {
    for (const session of this.sessions.values()) session.close()
    this.sessions.clear()
  }
}

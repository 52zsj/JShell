import fs from 'node:fs'
import type { OpenSessionResult, SessionEvent } from '../../shared/types'
import { FlowControl } from './flow-control'
import { LocalSession } from './local-session'
import { log } from './logger'
import { WSL_SHELL_PREFIX } from '../../shared/types'
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
  /**
   * 渲染层在会话建好之前就测完尺寸发来的 resize。
   *
   * 时序问题：TerminalView 一挂载就会 fit 并立刻发 resize，而会话创建走的是
   * `await sessions.open(...)`，主进程这时还没把会话放进表里。以前这种 resize
   * 被 `?.` 静默丢掉 —— PTY 停在初始 100×30，界面却是真实尺寸（比如 40 行），
   * 于是「内容只占到屏幕 3/4、光标卡在中部、回车也拉不回来」。
   * 现在先暂存，建会话时直接用它作为初始尺寸（一次到位，也不会让 ConPTY 白重绘一次）。
   */
  private readonly pendingSize = new Map<string, { cols: number; rows: number }>()
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

    // 后台握手，错误已由会话自身以 status 事件上报。
    // 尺寸优先用渲染层已经量好的——它比建会话更早完成测量。
    void session.connect(this.initialSize(sessionId, size)).catch(() => undefined)

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
    const target = shellPath || configured || detectShells({ includeWsl: false }).defaultShell

    // WSL 条目是 `wsl://发行版` 的伪路径，不是真实文件，跳过存在性校验
    if (!target.startsWith(WSL_SHELL_PREFIX) && /[\\/]/.test(target) && !fs.existsSync(target)) {
      throw new Error(`本地 shell 不存在：${target}，请在设置中重新选择`)
    }

    const session = new LocalSession(sessionId, target, { emit: this.emit })
    this.sessions.set(sessionId, session)
    const localSize = this.initialSize(sessionId, size)
    session.start(localSize)
    // 记一条尺寸日志：终端「内容只占屏幕一部分、光标卡在中间」时，
    // 对齐这里的 cols×rows 与界面实际行数就能立刻判断是不是 PTY 尺寸没跟上
    log.info(`本地终端已创建：${target} ${localSize.cols}x${localSize.rows}`)

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

  /** 渲染层请求改变尺寸；会话还没建好时先记下来，建好后立刻应用 */
  resize(sessionId: string, cols: number, rows: number): void {
    const session = this.sessions.get(sessionId)
    if (!session) {
      this.pendingSize.set(sessionId, { cols, rows })
      return
    }
    session.resize(cols, rows)
  }

  /** 取会话的初始尺寸：优先用渲染层已经量好的，避免先按 100×30 建屏再重建 */
  private initialSize(
    sessionId: string,
    fallback: { cols: number; rows: number }
  ): { cols: number; rows: number } {
    const pending = this.pendingSize.get(sessionId)
    if (!pending) return fallback
    this.pendingSize.delete(sessionId)
    return pending
  }

  close(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.close()
    this.sessions.delete(sessionId)
    // 流控账本随会话一起丢弃，避免 Map 长期持有已关闭会话
    this.flows.delete(sessionId)
    this.pendingSize.delete(sessionId)
  }

  /**
   * 只把已结束的会话从表里摘掉，不再调用 close()。
   *
   * 会话自己断开时（远端 exit、网络断、shell 退出）对象已经关过了，
   * 但它仍被 Map 强引用着，连带 client（内含连接时的口令/私钥）、
   * 已关闭的 stream 和流控账本一起常驻。这里只负责摘表。
   */
  forget(sessionId: string): void {
    this.sessions.delete(sessionId)
    this.flows.delete(sessionId)
  }

  closeAll(): void {
    for (const session of this.sessions.values()) session.close()
    this.sessions.clear()
    // 账本跟着一起清，避免残留条目被每秒 tick 白跑
    this.flows.clear()
    this.pendingSize.clear()
  }
}

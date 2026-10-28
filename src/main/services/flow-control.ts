/**
 * 终端输出的信用流控（背压）。
 *
 * 为什么需要：主进程把 PTY 输出以 IPC 推给渲染进程，渲染进程用 xterm 解析。
 * 远端 `cat 大文件` 或本地 `yes` 这类命令的输出速度可以远超 xterm 的解析速度，
 * 而 IPC 推送是没有反馈的单向通道 —— 结果是消息堆在渲染进程里，内存持续上涨。
 *
 * 做法：渲染进程每解析完一块就回一个 ack，主进程按「未确认字符数」记账；
 * 超过高水位就暂停数据源（SSH 通道 / pty 句柄），回落到低水位再恢复。
 *
 * 为什么不直接丢数据：终端输出是用户可见内容，丢一条就可能错乱整个界面状态，
 * 所以选「让生产者慢下来」而不是「丢消费者的数据」。
 */

export interface FlowControlHooks {
  /** 暂停数据源：SSH 走 stream.pause()，本地走 pty.pause() */
  pause: () => void
  resume: () => void
}

export interface FlowControlOptions {
  /** 高水位：未确认字符超过它就暂停 */
  high?: number
  /** 低水位：回落到它以下就恢复 */
  low?: number
  /** 看门狗：暂停后多久没有任何 ack 就强制恢复 */
  stallMs?: number
  /** 触发看门狗时回调（用于记日志） */
  onStall?: () => void
}

export const DEFAULT_HIGH = 1024 * 1024
export const DEFAULT_LOW = 256 * 1024
/**
 * 看门狗阈值：渲染端连续这么久没有回执就认定它已经卡死/销毁。
 * 放宽到 8 秒而不是 3 秒——渲染层短时间繁忙（重绘、GC）不该被误判，
 * 真卡死时多等几秒也只是少保护几秒，不会丢数据。
 */
export const DEFAULT_STALL_MS = 8000

export class FlowControl {
  private readonly high: number
  private readonly low: number
  private readonly stallMs: number
  private readonly hooks: FlowControlHooks
  private readonly onStall?: () => void

  private outstanding = 0
  private paused = false
  private lastAckAt = Date.now()

  constructor(hooks: FlowControlHooks, options: FlowControlOptions = {}) {
    this.hooks = hooks
    this.high = options.high ?? DEFAULT_HIGH
    this.low = options.low ?? DEFAULT_LOW
    this.stallMs = options.stallMs ?? DEFAULT_STALL_MS
    this.onStall = options.onStall
  }

  /** 主进程刚推出去一块数据（now 可注入，便于测试） */
  onOutput(chars: number, now = Date.now()): void {
    if (chars <= 0) return
    this.outstanding += chars
    if (!this.paused && this.outstanding >= this.high) {
      this.paused = true
      this.lastAckAt = now
      this.hooks.pause()
    }
  }

  /** 渲染进程解析完一块后回执（now 可注入，便于测试） */
  onAck(chars: number, now = Date.now()): void {
    if (chars > 0) this.outstanding = Math.max(0, this.outstanding - chars)
    this.lastAckAt = now
    if (this.paused && this.outstanding <= this.low) {
      this.paused = false
      this.hooks.resume()
    }
  }

  /**
   * 看门狗：暂停状态迟迟收不到 ack（渲染进程崩溃/终端已销毁/ack 丢失），
   * 说明这笔账再也对不平了。强制恢复，否则会话会永久卡住——比内存涨更糟。
   * 返回是否发生了强制恢复，便于调用方记录。
   */
  tick(now = Date.now()): boolean {
    if (!this.paused) return false
    if (now - this.lastAckAt < this.stallMs) return false
    this.outstanding = 0
    this.paused = false
    this.lastAckAt = now
    this.onStall?.()
    this.hooks.resume()
    return true
  }

  get isPaused(): boolean {
    return this.paused
  }

  get pending(): number {
    return this.outstanding
  }
}

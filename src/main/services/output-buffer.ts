/**
 * 输出聚合缓冲。
 *
 * SSH / PTY 的数据都是高频小包（`cat` 大文件时每个 TCP 包都会触发一次 data），
 * 若逐包走 IPC，主进程与渲染进程的序列化开销会成为瓶颈。
 * 这里按「8ms（约一帧）或 64KB」聚合后再向上抛，用户无感知，IPC 次数可降 1~2 个数量级。
 */
const FLUSH_INTERVAL_MS = 8
const FLUSH_THRESHOLD = 64 * 1024

export class OutputBuffer {
  private pending = ''
  private timer?: NodeJS.Timeout
  private disposed = false
  private readonly emit: (data: string) => void

  constructor(emit: (data: string) => void) {
    this.emit = emit
  }

  push(text: string): void {
    if (!text || this.disposed) return
    this.pending += text
    if (this.pending.length >= FLUSH_THRESHOLD) {
      this.flush()
      return
    }
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), FLUSH_INTERVAL_MS)
    }
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    if (!this.pending) return
    const data = this.pending
    this.pending = ''
    this.emit(data)
  }

  dispose(): void {
    this.flush()
    this.disposed = true
  }
}

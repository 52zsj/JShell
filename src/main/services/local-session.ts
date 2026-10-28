import os from 'node:os'
import path from 'node:path'
import * as pty from 'node-pty'
import { mapErrorToChinese } from '../../shared/errors'
import type { SessionEvent, SessionStatus } from '../../shared/types'
import { OutputBuffer } from './output-buffer'
import { buildEnv, shellArgs } from './shells'
import type { TerminalSession } from './types'

export interface LocalSessionDeps {
  emit: (event: SessionEvent) => void
}

/**
 * 本地终端会话（node-pty）。
 *
 * 与 SshSession 对外表现一致：写输入、改窗口尺寸、抛 status/data 事件，
 * 因此渲染层不需要区分「这是 SSH 还是本地 shell」，只有文件面板依赖 SSH。
 *
 * 实现说明：
 *  - node-pty 1.1 起提供 N-API 预编译产物（darwin/win32），无需按 Electron ABI 重建；
 *    Linux 下 npm install 会走源码编译，CI 需要 gcc + python3（ubuntu-latest 自带）。
 *  - 启动登录 shell（-l），并注入 TERM/COLORTERM，保证颜色与 vim/htop 正常。
 */
export class LocalSession implements TerminalSession {
  readonly id: string
  readonly kind = 'local' as const
  readonly shellPath: string
  readonly title: string
  readonly subtitle: string

  private readonly deps: LocalSessionDeps
  private readonly output: OutputBuffer
  private proc?: pty.IPty
  private lastSize = { cols: 80, rows: 24 }
  private closed = false
  private closing = false

  constructor(id: string, shellPath: string, deps: LocalSessionDeps) {
    this.id = id
    this.shellPath = shellPath
    this.deps = deps
    this.title = path.basename(shellPath).replace(/\.exe$/i, '') || '终端'
    this.subtitle = `本地 · ${os.homedir()}`
    this.output = new OutputBuffer((data) =>
      this.deps.emit({ type: 'data', sessionId: this.id, data })
    )
  }

  private emitStatus(status: SessionStatus, message?: string): void {
    this.deps.emit({ type: 'status', sessionId: this.id, status, message })
  }

  start(size: { cols: number; rows: number }): void {
    this.lastSize = size
    this.emitStatus('connecting')

    try {
      const proc = pty.spawn(this.shellPath, shellArgs(this.shellPath), {
        name: 'xterm-256color',
        cols: size.cols,
        rows: size.rows,
        cwd: os.homedir(),
        env: buildEnv()
      })
      this.proc = proc

      proc.onData((data) => this.output.push(data))
      proc.onExit(({ exitCode, signal }) => {
        this.output.dispose()
        this.closed = true
        // 用户主动关闭时不重复上报，避免关闭分屏后弹一条「进程已退出」
        if (!this.closing) {
          this.emitStatus('closed', signal ? `进程被信号 ${signal} 终止` : `进程已退出（code ${exitCode}）`)
        }
      })

      this.emitStatus('ready')
    } catch (err) {
      this.closed = true
      this.emitStatus(
        'error',
        `无法启动本地终端（${this.shellPath}）：${mapErrorToChinese(err, '启动失败')}`
      )
    }
  }

  write(data: string): void {
    if (!this.proc || this.closed) return
    this.proc.write(data)
  }

  /** 背压：暂停读取 pty，管道写满后子进程会自然阻塞（等同于终端自身的流控） */
  pause(): void {
    if (!this.proc || this.closed) return
    try {
      this.proc.pause()
    } catch {
      /* 进程已退出时忽略 */
    }
  }

  resume(): void {
    if (!this.proc || this.closed) return
    try {
      this.proc.resume()
    } catch {
      /* 进程已退出时忽略 */
    }
  }

  resize(cols: number, rows: number): void {
    this.lastSize = { cols, rows }
    if (!this.proc || this.closed) return
    try {
      this.proc.resize(Math.max(2, cols), Math.max(1, rows))
    } catch {
      /* 进程刚退出时 resize 可能失败，忽略 */
    }
  }

  close(): void {
    if (this.closed) return
    this.closing = true
    try {
      this.proc?.kill()
    } catch {
      /* 已退出 */
    }
    this.output.dispose()
    this.closed = true
  }

  get size(): { cols: number; rows: number } {
    return this.lastSize
  }
}

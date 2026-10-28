/** 主进程内所有会话（SSH / 本地 PTY）共同实现的最小接口 */
export interface TerminalSession {
  readonly id: string
  readonly kind: 'ssh' | 'local'
  /** 标签页标题，例如 prod-web-01 或 zsh */
  readonly title: string
  /** 副标题，例如 deploy@10.0.0.1:22 或 本地 · /Users/jay */
  readonly subtitle: string
  write(data: string): void
  resize(cols: number, rows: number): void
  close(): void
  /** 输出背压：渲染端跟不上时暂停数据源 */
  pause(): void
  resume(): void
}

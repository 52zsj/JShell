import { app, dialog, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { LOG_KEEP_DAYS, SIZE_CHECK_EVERY, pruneOldLogs, rotateIfTooLarge } from './log-files'

type LogLevel = 'info' | 'warn' | 'error'

const LEVEL_TEXT: Record<LogLevel, string> = {
  info: '信息',
  warn: '警告',
  error: '错误'
}

/**
 * 轻量文件日志。
 *
 * 目的：桌面端出问题时用户能拿到一份可读的中文日志（而不是让用户去开 DevTools）。
 * 只写本地文件，不做任何上报；内容不包含口令、私钥、终端输出。
 */
class Logger {
  private dirCache: string | null = null
  /** 距上次体积检查已写入的行数 */
  private linesSinceCheck = SIZE_CHECK_EVERY

  getDir(): string {
    if (this.dirCache) return this.dirCache
    const dir = path.join(app.getPath('userData'), 'logs')
    fs.mkdirSync(dir, { recursive: true })
    this.dirCache = dir
    return dir
  }

  private file(): string {
    const now = new Date()
    const pad = (value: number): string => String(value).padStart(2, '0')
    const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
    return path.join(this.getDir(), `jshell-${day}.log`)
  }

  private static stamp(): string {
    const now = new Date()
    const pad = (value: number): string => String(value).padStart(2, '0')
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(
      now.getHours()
    )}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
  }

  private static detail(extra: unknown): string {
    if (extra === undefined) return ''
    if (extra instanceof Error) return ` | ${extra.stack ?? extra.message}`
    if (typeof extra === 'string') return ` | ${extra}`
    try {
      return ` | ${JSON.stringify(extra)}`
    } catch {
      return ` | ${String(extra)}`
    }
  }

  private write(level: LogLevel, message: string, extra?: unknown): void {
    const line = `[${Logger.stamp()}] [${LEVEL_TEXT[level]}] ${message}${Logger.detail(extra)}\n`
    // 控制台保留一份，方便开发期直接观察
    if (level === 'error') console.error(line.trimEnd())
    else if (level === 'warn') console.warn(line.trimEnd())
    else console.log(line.trimEnd())

    try {
      const file = this.file()
      // 体积检查不必每行都做：5MB 内一行日志改变不了什么，statSync 反而是主线程开销
      if (++this.linesSinceCheck >= SIZE_CHECK_EVERY) {
        this.linesSinceCheck = 0
        rotateIfTooLarge(file)
      }
      fs.appendFileSync(file, line, { mode: 0o600 })
    } catch {
      /* 日志写失败不应影响主流程（例如磁盘只读） */
    }
  }

  info(message: string, extra?: unknown): void {
    this.write('info', message, extra)
  }

  warn(message: string, extra?: unknown): void {
    this.write('warn', message, extra)
  }

  error(message: string, extra?: unknown): void {
    this.write('error', message, extra)
  }
}

export const log = new Logger()

/** 启动时清一次过期日志，避免长期使用无限增长 */
export function pruneLogsOnStartup(): void {
  const removed = pruneOldLogs(log.getDir())
  if (removed > 0) log.info(`已清理 ${removed} 个过期日志文件（保留 ${LOG_KEEP_DAYS} 天）`)
}

/** 用系统文件管理器打开日志目录 */
export async function openLogDir(): Promise<void> {
  const message = await shell.openPath(log.getDir())
  if (message) throw new Error(`无法打开日志目录：${message}`)
}

/** 兜底捕获主进程未处理异常，避免应用静默退出后无从排查 */
export function installProcessHandlers(): void {
  process.on('uncaughtException', (err) => {
    log.error('主进程未捕获异常', err)
    try {
      dialog.showErrorBox('JShell 发生异常', `${err.message}\n\n日志目录：${log.getDir()}`)
    } catch {
      /* 界面尚未就绪时只写日志 */
    }
    app.exit(1)
  })
  process.on('unhandledRejection', (reason) => {
    log.error('主进程未处理的 Promise 拒绝', reason)
  })
}

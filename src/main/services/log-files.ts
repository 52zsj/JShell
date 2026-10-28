import fs from 'node:fs'
import path from 'node:path'

/**
 * 日志文件的纯文件系统操作（不依赖 electron，便于单测）。
 *
 * 为什么不放在 logger.ts 里：那个模块顶部就 import electron，
 * 在 node --test 环境下解析不到 `app`，整条链路都测不了。
 */

/** 单文件上限：超过后重命名为 .1，重新开始 */
export const MAX_LOG_BYTES = 5 * 1024 * 1024
/** 日志保留天数：每天一个文件，不设上限的话用一年能攒出几个 G */
export const LOG_KEEP_DAYS = 14
/** 每写这么多行才做一次体积检查，避免每行都 statSync */
export const SIZE_CHECK_EVERY = 64

/** 只认自己写出来的按天日志：jshell-YYYY-MM-DD.log 与轮转后的 .1/.2 */
const LOG_NAME = /^jshell-\d{4}-\d{2}-\d{2}\.log(\.\d+)?$/

/**
 * 清理过期日志，返回删除的文件数。
 * 任何一步失败都跳过该文件——清理日志不该影响主流程。
 */
export function pruneOldLogs(dir: string, keepDays = LOG_KEEP_DAYS, now = Date.now()): number {
  let removed = 0
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return 0
  }
  for (const name of names) {
    if (!LOG_NAME.test(name)) continue
    const full = path.join(dir, name)
    try {
      if (now - fs.statSync(full).mtimeMs > keepDays * 24 * 60 * 60 * 1000) {
        fs.rmSync(full, { force: true })
        removed++
      }
    } catch {
      /* 单个文件失败继续 */
    }
  }
  return removed
}

/**
 * 超限就把当前日志轮转成 `.1`（覆盖旧的 `.1`）。
 * 返回是否发生了轮转，便于调用方决定是否需要额外处理。
 */
export function rotateIfTooLarge(file: string, maxBytes = MAX_LOG_BYTES): boolean {
  try {
    if (fs.statSync(file).size <= maxBytes) return false
    fs.renameSync(file, `${file}.1`)
    return true
  } catch {
    return false
  }
}

import fs from 'node:fs'
import path from 'node:path'
import { SYNC_AUTO_FILE } from '../../shared/sync'

/** 旧版本自动同步写成 jshell-auto-1 … jshell-auto-45 这类副本 */
const LEGACY_AUTO = /^jshell-auto-.+\.jshellsync$/i

/**
 * 清理旧版本在同步目录里堆出的自动同步副本。
 *
 * 只删 `jshell-auto-<...>.jshellsync`（我们自己的旧命名），
 * 不碰 `jshell-auto.jshellsync` 本体，也不碰用户手动导出的包。
 */
export function cleanupLegacyBundles(dir: string): number {
  let removed = 0
  let names: string[] = []
  try {
    names = fs.readdirSync(dir)
  } catch {
    return 0
  }
  for (const name of names) {
    if (name === SYNC_AUTO_FILE || !LEGACY_AUTO.test(name)) continue
    try {
      fs.rmSync(path.join(dir, name), { force: true })
      removed += 1
    } catch {
      /* 删不掉就算了，下次再试 */
    }
  }
  return removed
}

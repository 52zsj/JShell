import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * `~/.ssh/config` 解析。
 *
 * 只取「能直接连」的信息：别名、HostName、User、Port、IdentityFile。
 * 刻意**不**做完整实现：
 *  - 忽略通配符块（`Host *`）——它们通常是全局默认值，导进来会变成一堆假主机；
 *  - 忽略 Match 块（条件匹配，导进来没有意义）；
 *  - 不做 Host/Include 的递归展开以外的语法（ProxyCommand 之类无法映射到应用的连接方式）。
 *
 * 取值遵循 ssh 自己的规则：**同一个块内，先出现的值生效**（first obtained value）。
 */

export interface SshConfigHost {
  /** 配置里的别名，也就是 `ssh <alias>` 的写法 */
  alias: string
  host: string
  port: number
  username: string
  /** 私钥绝对路径（已展开 ~）；没有则说明走 agent */
  identityFile?: string
}

/** 没有 User 时 ssh 用本机用户名，这里保持一致 */
function localUser(): string {
  try {
    return os.userInfo().username
  } catch {
    return 'root'
  }
}

export function expandHome(value: string, home = os.homedir()): string {
  if (value === '~') return home
  if (value.startsWith('~/')) return path.join(home, value.slice(2))
  return value
}

interface Block {
  aliases: string[]
  hostName?: string
  user?: string
  port?: number
  identityFile?: string
}

/**
 * 解析配置文本。纯函数：不读文件、不看环境（本机用户名可注入），便于单测。
 */
export function parseSshConfig(text: string, fallbackUser = localUser()): SshConfigHost[] {
  const blocks: Block[] = []
  let current: Block | null = null
  /** 进入 Match 块后忽略后续选项，直到下一个 Host */
  let capturing = false

  const flush = (): void => {
    if (!current || current.aliases.length === 0) {
      current = null
      return
    }
    blocks.push(current)
    current = null
  }

  for (const rawLine of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, '').trim()
    if (!line || line.startsWith('#')) continue

    const match = line.match(/^(\S+)\s*(.*)$/)
    if (!match) continue
    const keyword = match[1].toLowerCase()
    const value = match[2].trim()

    if (keyword === 'host') {
      flush()
      capturing = true
      // `Host a b c` 一次可以给多个别名；带通配符的直接跳过
      const aliases = value
        .split(/\s+/)
        .map((alias) => alias.trim())
        .filter((alias) => alias && !/[*?]/.test(alias))
      current = { aliases }
      continue
    }

    if (keyword === 'match') {
      flush()
      capturing = false
      continue
    }

    if (!capturing || !current) continue

    if (keyword === 'hostname' && current.hostName === undefined && value) {
      current.hostName = value
    } else if (keyword === 'user' && current.user === undefined && value) {
      current.user = value
    } else if (keyword === 'port' && current.port === undefined && value) {
      const port = Number(value)
      if (Number.isInteger(port) && port > 0 && port <= 65535) current.port = port
    } else if (keyword === 'identityfile' && current.identityFile === undefined && value) {
      current.identityFile = expandHome(value.replace(/^"(.*)"$/, '$1'))
    }
  }
  flush()

  const seen = new Set<string>()
  const result: SshConfigHost[] = []
  for (const block of blocks) {
    for (const alias of block.aliases) {
      if (seen.has(alias)) continue
      seen.add(alias)
      result.push({
        alias,
        host: block.hostName ?? alias,
        port: block.port ?? 22,
        username: block.user ?? fallbackUser,
        identityFile: block.identityFile
      })
    }
  }
  return result
}

/**
 * 读配置并展开 `Include`（最多 3 层、忽略通配符）。
 *
 * 没装 ssh 或没有配置时返回空数组而不是抛错 —— 这是「导入」按钮的常见初态。
 */
export function readSshConfigHosts(
  file = path.join(os.homedir(), '.ssh', 'config')
): { hosts: SshConfigHost[]; files: string[] } {
  const files: string[] = []
  const chunks: string[] = []

  const walk = (target: string, depth: number): void => {
    if (depth > 3 || files.includes(target)) return
    let text = ''
    try {
      text = fs.readFileSync(target, 'utf8')
    } catch {
      return
    }
    files.push(target)
    chunks.push(text)

    // Include 相对路径相对于当前文件所在目录；带通配符的跳过
    for (const line of text.split(/\r?\n/)) {
      const match = line.replace(/\s+#.*$/, '').trim().match(/^include\s+(.+)$/i)
      if (!match) continue
      for (const raw of match[1].split(/\s+/)) {
        if (!raw || /[*?]/.test(raw)) continue
        const resolved = expandHome(raw)
        walk(path.isAbsolute(resolved) ? resolved : path.join(path.dirname(target), resolved), depth + 1)
      }
    }
  }

  walk(file, 0)
  if (files.length === 0) return { hosts: [], files }
  return { hosts: parseSshConfig(chunks.join('\n')), files }
}

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ShellInfo, ShellsResult } from '../../shared/types'

/**
 * 本地 shell 自动识别。
 *
 * 识别顺序（保证「开箱即用」）：
 *  - macOS / Linux：$SHELL → 常见路径（zsh/bash/fish/sh）→ /etc/shells 中其余可交互 shell
 *  - Windows：%ComSpec%（cmd.exe）→ Windows PowerShell → PowerShell 7（pwsh）
 *
 * 只保留真实存在且可执行的路径，避免选中一个点开就报错的 shell。
 */

const ALLOWED_UNIX = /^(zsh|bash|fish|sh|dash|ksh|tcsh|csh|nu|elvish|pwsh)$/i

const UNIX_PREFERRED = ['/bin/zsh', '/bin/bash', '/usr/bin/fish', '/bin/sh']

function isExecutable(file: string): boolean {
  try {
    const stat = fs.statSync(file)
    if (!stat.isFile()) return false
    fs.accessSync(file, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

function detectUnix(): ShellsResult {
  const candidates: string[] = []
  const add = (value?: string) => {
    if (value && !candidates.includes(value)) candidates.push(value)
  }

  add(process.env.SHELL)
  for (const shell of UNIX_PREFERRED) add(shell)

  // /etc/shells 是系统登记的合法登录 shell 列表
  try {
    for (const line of fs.readFileSync('/etc/shells', 'utf8').split('\n')) {
      const entry = line.trim()
      if (!entry || entry.startsWith('#')) continue
      add(entry)
    }
  } catch {
    /* 某些精简系统没有该文件，忽略 */
  }

  const shells: ShellInfo[] = []
  const seen = new Set<string>()

  for (const candidate of candidates) {
    let resolved = candidate
    try {
      resolved = fs.realpathSync(candidate)
    } catch {
      continue
    }
    if (!isExecutable(resolved)) continue

    const name = path.basename(resolved).replace(/\.exe$/i, '')
    if (!ALLOWED_UNIX.test(name)) continue
    if (seen.has(resolved)) continue
    seen.add(resolved)

    shells.push({
      path: resolved,
      name,
      label: name,
      isDefault: shells.length === 0
    })
  }

  // 兜底：极端精简环境（如 distroless）至少保证 sh 可用
  if (shells.length === 0 && isExecutable('/bin/sh')) {
    shells.push({ path: '/bin/sh', name: 'sh', label: 'sh', isDefault: true })
  }

  return { defaultShell: shells[0]?.path ?? '/bin/sh', shells }
}

function findOnPath(name: string): string | undefined {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
  for (const dir of dirs) {
    const candidate = path.join(dir, name)
    if (fs.existsSync(candidate)) return candidate
  }
  return undefined
}

function detectWindows(): ShellsResult {
  const systemRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows'
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files'
  const candidates: Array<{ path: string; label: string }> = []

  const add = (candidate: string | undefined, label: string): void => {
    if (candidate && fs.existsSync(candidate) && !candidates.some((item) => item.path.toLowerCase() === candidate.toLowerCase())) {
      candidates.push({ path: candidate, label })
    }
  }

  const comspec = process.env.ComSpec || path.join(systemRoot, 'System32', 'cmd.exe')
  add(comspec, '命令提示符 (cmd)')
  add(
    path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    'Windows PowerShell'
  )
  add(path.join(programFiles, 'PowerShell', '7', 'pwsh.exe'), 'PowerShell 7')
  add(findOnPath('pwsh.exe'), 'PowerShell 7')

  if (candidates.length === 0) candidates.push({ path: 'cmd.exe', label: '命令提示符 (cmd)' })

  const shells: ShellInfo[] = candidates.map((item, index) => ({
    path: item.path,
    name: path.basename(item.path).replace(/\.exe$/i, ''),
    label: item.label,
    isDefault: index === 0
  }))

  return { defaultShell: shells[0].path, shells }
}

export function detectShells(): ShellsResult {
  const result = process.platform === 'win32' ? detectWindows() : detectUnix()
  return result
}

/** 本地终端启动参数：登录 shell 以加载用户 profile */
export function shellArgs(shellPath: string): string[] {
  const name = path.basename(shellPath).replace(/\.exe$/i, '').toLowerCase()
  if (process.platform === 'win32') {
    if (name === 'powershell' || name === 'pwsh') return ['-NoLogo']
    return []
  }
  // zsh / bash / fish 都支持 -l（作为登录 shell 启动），确保 PATH 与 alias 生效
  if (['zsh', 'bash', 'fish', 'ksh', 'tcsh', 'csh', 'dash', 'sh'].includes(name)) return ['-l']
  return []
}

/** 组装 PTY 环境变量：过滤 undefined，并补上终端能力声明 */
export function buildEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value
  }
  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'
  env.LANG = env.LANG || 'en_US.UTF-8'
  env.PWD = os.homedir()
  return env
}

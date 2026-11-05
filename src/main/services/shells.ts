import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { WSL_SHELL_PREFIX, type ShellInfo, type ShellsResult } from '../../shared/types'

/**
 * 本地 shell 自动识别。
 *
 * 识别顺序（保证「开箱即用」）：
 *  - macOS / Linux：$SHELL → 常见路径（zsh/bash/fish/sh）→ /etc/shells 中其余可交互 shell
 *  - Windows：%ComSpec%（cmd.exe）→ Windows PowerShell → PowerShell 7（pwsh）
 *             → 已安装的 WSL 发行版（每个发行版一个入口，直接进 Linux shell，不经过 cmd）
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

function detectWindows(includeWsl: boolean): ShellsResult {
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

  // WSL 发行版：每个发行版一个入口，直接起 Linux shell（不必先开 cmd 再敲 wsl）
  const wsl = includeWsl ? findWslExecutable() : undefined
  if (wsl) {
    for (const distro of listWslDistros(wsl)) {
      const virtualPath = `${WSL_SHELL_PREFIX}${distro}`
      if (candidates.some((item) => item.path === virtualPath)) continue
      // 伪路径，不能用 existsSync 校验，所以直接 push
      candidates.push({ path: virtualPath, label: `WSL · ${distro}` })
    }
  }

  if (candidates.length === 0) candidates.push({ path: 'cmd.exe', label: '命令提示符 (cmd)' })

  const shells: ShellInfo[] = candidates.map((item, index) => ({
    path: item.path,
    name: path.basename(item.path).replace(/\.exe$/i, ''),
    label: item.label,
    isDefault: index === 0
  }))

  return { defaultShell: shells[0].path, shells }
}

/**
 * 从 `wsl.exe -l -q` 的输出里解析发行版名。
 *
 * 坑：这条命令的输出是 **UTF-16LE**，按 UTF-8 读会得到一堆 `U\0b\0u\0n\0t\0u\0`。
 * 这里同时兼容两种：先看 BOM，再看奇数字节里 0 的占比。
 */
export function parseWslDistros(raw: Buffer): string[] {
  if (raw.length === 0) return []
  const head = raw.subarray(0, Math.min(raw.length, 256))
  const hasBom = raw[0] === 0xff && raw[1] === 0xfe
  let zeroHighBytes = 0
  for (let i = 1; i < head.length; i += 2) {
    if (head[i] === 0) zeroHighBytes += 1
  }
  const isUtf16 = hasBom || zeroHighBytes > Math.floor(head.length / 4)
  const text = isUtf16 ? raw.toString('utf16le') : raw.toString('utf8')

  const distros: string[] = []
  for (const line of text.split(/\r?\n/)) {
    const name = line.replace(/[\uFEFF\u0000]/g, '').trim()
    if (!name) continue
    // 没有安装发行版时，wsl 会往 stdout 里吐一句提示
    if (/^Windows Subsystem for Linux/i.test(name)) continue
    if (!distros.includes(name)) distros.push(name)
  }
  return distros
}

let wslCache: { at: number; list: string[] } | null = null
/** 读发行版列表会拉起 LxssManager（冷启动可能要一两秒），缓存一下，别每次开终端都等 */
const WSL_CACHE_MS = 60_000

function listWslDistros(wslPath: string): string[] {
  const now = Date.now()
  if (wslCache && now - wslCache.at < WSL_CACHE_MS) return wslCache.list

  let list: string[] = []
  try {
    const raw = execFileSync(wslPath, ['-l', '-q'], {
      timeout: 2_000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore']
    })
    list = parseWslDistros(raw)
  } catch (err) {
    // 没有安装任何发行版、或 WSL 功能未启用时，这里会失败——当作「没有 WSL」即可
    const stdout = (err as { stdout?: Buffer }).stdout
    list = stdout ? parseWslDistros(stdout) : []
  }
  wslCache = { at: now, list }
  return list
}

function findWslExecutable(): string | undefined {
  const systemRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows'
  return [path.join(systemRoot, 'System32', 'wsl.exe'), findOnPath('wsl.exe')].find(
    (item): item is string => Boolean(item) && fs.existsSync(item as string)
  )
}

/**
 * 把 shell 的「路径」（可能是 `wsl://Ubuntu` 这种伪路径）翻译成真正要 spawn 的命令。
 *
 * WSL 的 `--cd ~` 是必须的：不传的话 WSL 会继承 Windows 侧的工作目录
 * （安装目录 `C:\\Program Files\\JShell` → `/mnt/c/Program Files/JShell`），
 * 一开终端就停在一个奇怪的地方。传了就直接进 Linux 家目录。
 */
export function resolveLocalCommand(target: string): { file: string; args: string[] } {
  if (target.startsWith(WSL_SHELL_PREFIX)) {
    const distro = target.slice(WSL_SHELL_PREFIX.length)
    return {
      file: findWslExecutable() ?? 'wsl.exe',
      args: ['-d', distro, '--cd', '~']
    }
  }
  return { file: target, args: shellArgs(target) }
}

/**
 * @param options.includeWsl 是否枚举 WSL 发行版。调用 `wsl.exe` 是同步子进程（冷启动可能几百毫秒），
 *   只在「给侧边栏/设置页列 shell」时需要；取默认 shell 时关掉，避免每次开本地终端都等它。
 */
export function detectShells(options: { includeWsl?: boolean } = {}): ShellsResult {
  const includeWsl = options.includeWsl !== false
  const result = process.platform === 'win32' ? detectWindows(includeWsl) : detectUnix()
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

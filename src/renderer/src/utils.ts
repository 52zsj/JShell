/** 字节数转人类可读，用于文件列表与传输进度 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / 1024 ** i
  return `${value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`
}

/** 时间戳 -> 2026-10-23 17:32 */
export function formatDateTime(ts: number): string {
  if (!ts) return '-'
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 拼接远端路径（统一使用 POSIX 语义） */
export function joinRemote(dir: string, name: string): string {
  if (dir === '/') return `/${name}`
  return `${dir.replace(/\/+$/, '')}/${name}`
}

/** 取远端路径的父目录 */
export function parentRemote(dir: string): string {
  if (dir === '/' || !dir) return '/'
  const trimmed = dir.replace(/\/+$/, '')
  const idx = trimmed.lastIndexOf('/')
  return idx <= 0 ? '/' : trimmed.slice(0, idx)
}

/** 把长路径拆成面包屑片段 */
export function splitRemote(dir: string): Array<{ name: string; path: string }> {
  const parts = dir.split('/').filter(Boolean)
  const crumbs: Array<{ name: string; path: string }> = [{ name: '/', path: '/' }]
  let acc = ''
  for (const part of parts) {
    acc += `/${part}`
    crumbs.push({ name: part, path: acc })
  }
  return crumbs
}

const isWindowsPath = (value: string): boolean =>
  /^[A-Za-z]:[\\/]/.test(value) || (value.includes('\\') && !value.startsWith('/'))

export function localSep(dir: string): string {
  return isWindowsPath(dir) ? '\\' : '/'
}

export function localJoin(dir: string, name: string): string {
  if (!dir) return name
  const sep = localSep(dir)
  return dir.endsWith(sep) ? `${dir}${name}` : `${dir}${sep}${name}`
}

export function localParent(dir: string): string {
  const sep = localSep(dir)
  const trimmed = dir.replace(/[\\/]+$/, '')
  const index = trimmed.lastIndexOf(sep)
  if (index < 0) return dir
  const parent = trimmed.slice(0, index)
  if (/^[A-Za-z]:$/.test(parent)) return parent + sep
  return parent || sep
}

/** 本地路径面包屑（Windows 盘符作为根） */
export function localCrumbs(dir: string): Array<{ name: string; path: string }> {
  const win = isWindowsPath(dir)
  const sep = win ? '\\' : '/'
  const normalized = dir.replace(/[\\/]/g, sep)
  const root = win ? normalized.slice(0, 3) : '/'
  const rest = win ? normalized.slice(3) : normalized.slice(1)
  const crumbs = [{ name: root, path: root }]
  let acc = root
  for (const part of rest.split(sep).filter(Boolean)) {
    acc = acc.endsWith(sep) ? `${acc}${part}` : `${acc}${sep}${part}`
    crumbs.push({ name: part, path: acc })
  }
  return crumbs
}

export function cx(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ')
}

export function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  // Electron 会把主进程异常包成 "Error invoking remote method 'x': Error: 真实信息"，
  // 界面只展示后半段，避免把 IPC 通道名暴露给用户
  return raw.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, '')
}

/** 平台标识的中文展示名（界面内不出现 darwin / win32 这类内部标识） */
export function platformLabel(platform?: string): string {
  switch (platform) {
    case 'darwin':
      return 'macOS'
    case 'win32':
      return 'Windows'
    case 'linux':
      return 'Linux'
    default:
      return '未知平台'
  }
}

/** ISO 构建时间 -> 2026-10-23 20:50（无效值原样返回） */
export function formatBuildTime(value?: string): string {
  if (!value) return '未记录'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return formatDateTime(date.getTime())
}

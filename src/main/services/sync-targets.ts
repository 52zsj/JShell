import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SYNC_SUBDIR, type SyncTarget } from '../../shared/sync'

/**
 * 同步位置探测。
 *
 * 关键取舍：**不绑定任何云服务，只做“发现”**。
 * 用户在系统里装了哪个网盘，这里就把那个文件夹列出来当快捷入口；
 * 一个都没装也完全不影响使用——「保存到任意文件」和「复制到剪贴板」始终可用。
 *
 * 不调用任何云 API，不读取云端内容，只判断目录是否存在。
 */

interface Candidate {
  id: string
  label: string
  kind: SyncTarget['kind']
  /** 绝对路径；undefined 表示该平台不适用 */
  dir: string | undefined
}

function expandHome(home: string, relative: string): string {
  return path.join(home, relative)
}

/** 目录最近修改时间（毫秒）：网盘客户端同步/下载时会更新，可用来判断哪个网盘在活跃使用 */
function mtimeOf(dir: string): number {
  try {
    return fs.statSync(dir).mtimeMs
  } catch {
    return 0
  }
}

function isDirectory(target: string | undefined): target is string {
  if (!target) return false
  try {
    return fs.statSync(target).isDirectory()
  } catch {
    return false
  }
}

/**
 * macOS 的「云盘」都挂在 ~/Library/CloudStorage 下，目录名带账号后缀，
 * 因此需要扫一层目录按前缀识别。
 */
function scanCloudStorage(home: string): Array<{ kind: SyncTarget['kind']; label: string; dir: string }> {
  const root = path.join(home, 'Library', 'CloudStorage')
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }
  const found: Array<{ kind: SyncTarget['kind']; label: string; dir: string }> = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = path.join(root, entry.name)
    const name = entry.name.toLowerCase()
    if (name.startsWith('onedrive')) {
      found.push({ kind: 'onedrive', label: 'OneDrive', dir })
    } else if (name.startsWith('dropbox')) {
      found.push({ kind: 'dropbox', label: 'Dropbox', dir })
    } else if (name.startsWith('googledrive')) {
      found.push({ kind: 'gdrive', label: 'Google 云端硬盘', dir })
    }
  }
  return found
}

function candidates(home: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): Candidate[] {
  const list: Candidate[] = []
  const push = (id: string, label: string, kind: SyncTarget['kind'], dir?: string): void => {
    list.push({ id, label, kind, dir })
  }

  if (platform === 'darwin') {
    push('icloud', 'iCloud 云盘', 'icloud', expandHome(home, 'Library/Mobile Documents/com~apple~CloudDocs'))
  }
  if (platform === 'win32') {
    push('icloud', 'iCloud 云盘', 'icloud', expandHome(home, 'iCloudDrive'))
  }

  // OneDrive 会通过环境变量暴露当前登录账号的目录，优先用它（可能不在用户主目录下）
  push('onedrive', 'OneDrive', 'onedrive', env.OneDrive || env.OneDriveConsumer || expandHome(home, 'OneDrive'))
  push('dropbox', 'Dropbox', 'dropbox', expandHome(home, 'Dropbox'))
  push('gdrive', 'Google 云端硬盘', 'gdrive', expandHome(home, 'Google Drive'))
  push('gdrive-alt', 'Google 云端硬盘', 'gdrive', expandHome(home, 'GoogleDrive'))
  push('nutstore', '坚果云', 'nutstore', expandHome(home, 'Nutstore Files'))
  push('nutstore-alt', '坚果云', 'nutstore', expandHome(home, 'Nutstore'))
  push('baidu', '百度网盘', 'baidu', expandHome(home, 'BaiduNetdiskDownload'))
  push('nextcloud', 'Nextcloud', 'other', expandHome(home, 'Nextcloud'))

  return list
}

/**
 * 返回本机真实存在的同步目录。
 * 同一目录被多个候选命中时只保留第一个，避免重复项。
 */
export function detectSyncTargets(options?: {
  home?: string
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
}): SyncTarget[] {
  const home = options?.home ?? os.homedir()
  const platform = options?.platform ?? process.platform
  const env = options?.env ?? process.env

  const seen = new Set<string>()
  const result: SyncTarget[] = []

  const add = (target: SyncTarget): void => {
    const resolved = path.resolve(target.dir)
    if (seen.has(resolved) || !isDirectory(resolved)) return
    seen.add(resolved)
    result.push({ ...target, dir: resolved, mtimeMs: mtimeOf(resolved) })
  }

  for (const item of candidates(home, platform, env)) {
    if (!item.dir) continue
    add({ id: item.id, label: item.label, kind: item.kind, dir: item.dir })
  }

  if (platform === 'darwin') {
    for (const item of scanCloudStorage(home)) {
      add({ id: `cloud-${item.kind}-${seen.size}`, label: item.label, kind: item.kind, dir: item.dir })
    }
  }

  return result
}

/**
 * 把渲染层传来的 targetId 解析成真实目录。
 * 渲染层永远拿到的是 id，不是路径——防止被注入后用任意路径读写磁盘。
 */
export function resolveTargetDir(targets: SyncTarget[], targetId: string): string {
  const hit = targets.find((item) => item.id === targetId)
  if (!hit) throw new Error('未知的同步位置，请重新打开面板')
  return hit.dir
}

/** 同步包在云盘里的固定落点：`<云盘>/JShell/` */
export function syncFolderPath(targetDir: string): string {
  return path.join(targetDir, SYNC_SUBDIR)
}

export function ensureSyncFolder(targetDir: string): string {
  const dir = syncFolderPath(targetDir)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

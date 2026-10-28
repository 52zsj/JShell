import { DEVICE_LOCAL_SETTINGS, type DiffEntry, type DiffReport, type SyncBundlePayload, type SyncImportMode } from '../../shared/sync'
import type { HostProfile, Snippet, TunnelConfig } from '../../shared/types'
import type { Snapshot } from './sync-merge'

/**
 * 覆盖前检测（纯函数）。
 *
 * 为什么单独一层：导入/同步一旦改成「远端直接覆盖本地」，用户就没机会在事后反悔。
 * 所以必须把「会覆盖掉什么」在动手之前算清楚——哪些是本机没有的，哪些是本机较新却被覆盖的，
 * 哪些是本机独有、会随替换一起消失的。
 *
 * 这一层不读写磁盘、不碰加密，只吃两份快照，所以自动同步（P1）可以直接复用同一份报告。
 */

const MAX_ENTRIES = 200

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

function num(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function sameHost(local: HostProfile, remote: Partial<HostProfile>): boolean {
  return (
    local.name === text(remote.name, 120) &&
    local.host === text(remote.host, 255) &&
    local.port === num(remote.port, 22) &&
    local.username === text(remote.username, 120) &&
    local.authType === (remote.authType ?? 'password') &&
    (local.privateKeyPath ?? '') === text(remote.privateKeyPath, 500) &&
    (local.proxyJump ?? '') === text(remote.proxyJump, 64) &&
    (local.group ?? '') === text(remote.group, 80) &&
    (local.color ?? '') === text(remote.color, 32)
  )
}

function sameSnippet(local: Snippet, remote: Partial<Snippet>): boolean {
  return local.name === text(remote.name, 80) && local.command === text(remote.command, 4000)
}

function sameTunnel(local: TunnelConfig, remote: Partial<TunnelConfig>): boolean {
  return (
    local.kind === (remote.kind ?? 'local') &&
    local.bindHost === text(remote.bindHost, 255) &&
    local.bindPort === num(remote.bindPort, 0) &&
    local.destHost === text(remote.destHost, 255) &&
    local.destPort === num(remote.destPort, 0)
  )
}

/**
 * 计算「如果把 remote 应用到 local 会发生什么」。
 * 只在 remote 真的带了某个分区时才比对那个分区，避免把「包里没有」误报成「本机将被清空」。
 */
export function diffBundle(local: Snapshot, remote: SyncBundlePayload, mode: SyncImportMode): DiffReport {
  const entries: DiffEntry[] = []
  const counts = { add: 0, update: 0, delete: 0, same: 0 }
  const risky = { overwriteNewer: 0, deleteLocal: 0 }
  let settingsChanged = false

  const push = (entry: DiffEntry): void => {
    counts[entry.action] += 1
    // 合并模式下本机较新就不会被覆盖，因此只有覆盖/替换才算风险
    if (entry.action === 'update' && entry.localNewer && mode !== 'merge') risky.overwriteNewer += 1
    if (entry.action === 'delete') risky.deleteLocal += 1
    entries.push(entry)
  }

  // ------------------------------------------------------------------ 主机
  if (Array.isArray(remote.hosts)) {
    const localById = new Map(local.hosts.map((host) => [host.id, host]))
    const remoteIds = new Set<string>()
    for (const raw of remote.hosts.slice(0, 1000)) {
      const item = raw as Partial<HostProfile>
      if (!item || typeof item !== 'object') continue
      const id = text(item.id, 64)
      const host = text(item.host, 255)
      const username = text(item.username, 120)
      if (!id || !host || !username) continue
      remoteIds.add(id)

      const label = text(item.name, 120) || host
      const detail = `${username}@${host}:${num(item.port, 22)}`
      const existing = localById.get(id)
      if (!existing) {
        push({ kind: 'host', id, label, detail, action: 'add' })
        continue
      }
      if (sameHost(existing, item)) {
        push({ kind: 'host', id, label, detail, action: 'same' })
        continue
      }
      const localNewer = (existing.updatedAt ?? 0) > num(item.updatedAt, 0)
      // 合并模式下本机更新就轮不到包里的旧版本；覆盖模式则照盖，但标记为风险项
      if (localNewer && mode === 'merge') {
        push({ kind: 'host', id, label, detail, action: 'same' })
        continue
      }
      push({ kind: 'host', id, label, detail, action: 'update', localNewer })
    }
    if (mode === 'replace') {
      for (const host of local.hosts) {
        if (remoteIds.has(host.id)) continue
        push({
          kind: 'host',
          id: host.id,
          label: host.name,
          detail: `${host.username}@${host.host}:${host.port}`,
          action: 'delete'
        })
      }
    }
  }

  // ------------------------------------------------------------------ 片段
  if (Array.isArray(remote.snippets)) {
    const localById = new Map(local.snippets.map((snippet) => [snippet.id, snippet]))
    const remoteIds = new Set<string>()
    for (const raw of remote.snippets.slice(0, 1000)) {
      const item = raw as Partial<Snippet>
      if (!item || typeof item !== 'object') continue
      const id = text(item.id, 64)
      const command = text(item.command, 4000)
      if (!id || !command) continue
      remoteIds.add(id)
      const label = text(item.name, 80) || command.slice(0, 24)
      const existing = localById.get(id)
      if (!existing) {
        push({ kind: 'snippet', id, label, action: 'add' })
      } else if (sameSnippet(existing, item)) {
        push({ kind: 'snippet', id, label, action: 'same' })
      } else {
        push({ kind: 'snippet', id, label, action: 'update' })
      }
    }
    if (mode === 'replace') {
      for (const snippet of local.snippets) {
        if (remoteIds.has(snippet.id)) continue
        push({ kind: 'snippet', id: snippet.id, label: snippet.name, action: 'delete' })
      }
    }
  }

  // ------------------------------------------------------------ 端口转发
  if (Array.isArray(remote.tunnels)) {
    const localById = new Map(local.tunnels.map((tunnel) => [tunnel.id, tunnel]))
    const remoteIds = new Set<string>()
    for (const raw of remote.tunnels.slice(0, 200)) {
      const item = raw as Partial<TunnelConfig>
      if (!item || typeof item !== 'object') continue
      const id = text(item.id, 64)
      const destHost = text(item.destHost, 255)
      if (!id || !destHost) continue
      remoteIds.add(id)
      const label = `${num(item.bindPort, 0)} → ${destHost}:${num(item.destPort, 0)}`
      const existing = localById.get(id)
      if (!existing) {
        push({ kind: 'tunnel', id, label, action: 'add' })
      } else if (sameTunnel(existing, item)) {
        push({ kind: 'tunnel', id, label, action: 'same' })
      } else {
        push({ kind: 'tunnel', id, label, action: 'update' })
      }
    }
    if (mode === 'replace') {
      for (const tunnel of local.tunnels) {
        if (remoteIds.has(tunnel.id)) continue
        push({
          kind: 'tunnel',
          id: tunnel.id,
          label: `${tunnel.bindPort} → ${tunnel.destHost}:${tunnel.destPort}`,
          action: 'delete'
        })
      }
    }
  }

  // ------------------------------------------------------------ 主机指纹
  if (remote.knownHosts && typeof remote.knownHosts === 'object') {
    for (const [key, value] of Object.entries(remote.knownHosts)) {
      if (typeof value !== 'string' || !value) continue
      const existing = local.knownHosts[key]
      if (!existing) {
        push({ kind: 'knownHost', id: key, label: key, action: 'add' })
      } else if (existing !== value) {
        // 合并模式保留本机记录，等价于没有变化；覆盖模式才会改掉信任记录
        push(
          mode === 'merge'
            ? { kind: 'knownHost', id: key, label: key, action: 'same' }
            : { kind: 'knownHost', id: key, label: key, action: 'update', localNewer: true }
        )
      } else {
        push({ kind: 'knownHost', id: key, label: key, action: 'same' })
      }
    }
  }

  // ------------------------------------------------------------------ 设置
  if (remote.settings && typeof remote.settings === 'object') {
    const incoming = { ...(remote.settings as Record<string, unknown>) }
    for (const key of DEVICE_LOCAL_SETTINGS) delete incoming[key]
    for (const [key, value] of Object.entries(incoming)) {
      const current = (local.settings as unknown as Record<string, unknown>)[key]
      if (JSON.stringify(current) !== JSON.stringify(value)) {
        settingsChanged = true
        break
      }
    }
    if (settingsChanged) {
      // 设置不逐项列，只给一条汇总，避免把检测清单淹没
      push({ kind: 'settings', id: 'settings', label: '偏好设置', action: 'update' })
    }
  }

  // 变更优先展示：删除 > 会被覆盖的新改动 > 覆盖 > 新增 > 无变化
  const weight = (entry: DiffEntry): number => {
    if (entry.action === 'delete') return 0
    if (entry.action === 'update' && entry.localNewer) return 1
    if (entry.action === 'update') return 2
    if (entry.action === 'add') return 3
    return 4
  }
  entries.sort((a, b) => weight(a) - weight(b))

  return {
    mode,
    entries: entries.slice(0, MAX_ENTRIES),
    counts,
    risky,
    settingsChanged
  }
}

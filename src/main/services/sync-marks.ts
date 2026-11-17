import type { HostProfile, Snippet, TunnelConfig } from '../../shared/types'
import type { SyncBundlePayload } from '../../shared/sync'
import type { Snapshot } from './sync-merge'

/**
 * 冲突检测（三方比较）。
 *
 * 只有「本机改过」+「云端也改过」+「两边不一样」才算冲突；单边改动照常应用。
 * 判断依据是本机保存的「上次同步后的指纹」：没有这份基线，任何覆盖都只能靠猜。
 */
export type SyncMarks = Record<string, string>

export interface ConflictItem {
  kind: 'hosts' | 'snippets' | 'tunnels'
  id: string
  label: string
  /** 本机/云端的修改时间，界面上用来告诉用户"谁更新" */
  localAt: number
  remoteAt: number
}

function hostFingerprint(host: HostProfile): string {
  return JSON.stringify([
    host.name,
    host.host,
    host.port,
    host.username,
    host.authType,
    host.privateKeyPath ?? '',
    host.proxyJump ?? '',
    host.group ?? '',
    host.color ?? ''
  ])
}

function snippetFingerprint(snippet: Snippet): string {
  return JSON.stringify([snippet.name, snippet.command])
}

function tunnelFingerprint(tunnel: TunnelConfig): string {
  return JSON.stringify([
    tunnel.kind,
    tunnel.bindHost,
    tunnel.bindPort,
    tunnel.destHost,
    tunnel.destPort,
    tunnel.enabled !== false
  ])
}

/** 同步成功后的基线快照：只记 id → 指纹，不含内容 */
export function buildMarks(snapshot: Snapshot): SyncMarks {
  const marks: SyncMarks = {}
  for (const host of snapshot.hosts) marks[`hosts:${host.id}`] = hostFingerprint(host)
  for (const snippet of snapshot.snippets) marks[`snippets:${snippet.id}`] = snippetFingerprint(snippet)
  for (const tunnel of snapshot.tunnels) marks[`tunnels:${tunnel.id}`] = tunnelFingerprint(tunnel)
  return marks
}

/** 找出「两边都改过、且改得不一样」的条目；没有基线时不判冲突（首次同步不该被拦） */
export function findConflicts(
  local: Snapshot,
  remote: SyncBundlePayload,
  marks: SyncMarks
): ConflictItem[] {
  if (Object.keys(marks).length === 0) return []
  const conflicts: ConflictItem[] = []

  const check = (
    kind: ConflictItem['kind'],
    localItem: { id: string; updatedAt?: number } | undefined,
    remoteItem: { id: string; updatedAt?: number },
    label: string,
    localFp: string,
    remoteFp: string
  ): void => {
    if (!localItem) return
    if (localFp === remoteFp) return
    const mark = marks[`${kind}:${remoteItem.id}`]
    if (!mark) return
    if (localFp === mark || remoteFp === mark) return
    conflicts.push({
      kind,
      id: remoteItem.id,
      label,
      localAt: localItem.updatedAt ?? 0,
      remoteAt: remoteItem.updatedAt ?? 0
    })
  }

  if (Array.isArray(remote.hosts)) {
    const byId = new Map(local.hosts.map((host) => [host.id, host]))
    for (const raw of remote.hosts) {
      const localHost = byId.get(raw.id)
      if (!localHost) continue
      check(
        'hosts',
        localHost,
        raw,
        localHost.name || localHost.host,
        hostFingerprint(localHost),
        hostFingerprint(raw)
      )
    }
  }

  if (Array.isArray(remote.snippets)) {
    const byId = new Map(local.snippets.map((snippet) => [snippet.id, snippet]))
    for (const raw of remote.snippets) {
      const localSnippet = byId.get(raw.id)
      if (!localSnippet) continue
      check(
        'snippets',
        localSnippet,
        raw,
        localSnippet.name,
        snippetFingerprint(localSnippet),
        snippetFingerprint(raw)
      )
    }
  }

  if (Array.isArray(remote.tunnels)) {
    const byId = new Map(local.tunnels.map((tunnel) => [tunnel.id, tunnel]))
    for (const raw of remote.tunnels) {
      const localTunnel = byId.get(raw.id)
      if (!localTunnel) continue
      check(
        'tunnels',
        localTunnel,
        raw,
        `${localTunnel.bindHost}:${localTunnel.bindPort}`,
        tunnelFingerprint(localTunnel),
        tunnelFingerprint(raw)
      )
    }
  }

  return conflicts
}

/** 给界面用的一句话摘要；条目多时只列前几个 */
export function summarizeConflicts(conflicts: ConflictItem[]): string {
  const names = conflicts.slice(0, 3).map((item) => item.label).join('、')
  const more = conflicts.length > 3 ? ` 等 ${conflicts.length} 项` : ''
  return `本机与云端都改过：${names}${more}。未做任何改动，请选择合并方式。`
}

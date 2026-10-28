import { app } from 'electron'
import os from 'node:os'
import type { SyncBundleMeta, SyncBundlePayload, SyncScope } from '../../shared/sync'
import { pickPortableSettings } from './sync-merge'
import type { StoreService } from './store'

/**
 * 按勾选范围从本机快照装配同步包。
 * 手动导出与自动同步共用这一份实现，避免两边字段悄悄跑偏
 * （例如一边剔了设备私有设置、另一边忘了）。
 */
export function composeLocalBundle(
  store: StoreService,
  scopes: SyncScope[]
): { payload: SyncBundlePayload; meta: SyncBundleMeta } {
  const snapshot = store.snapshot()
  const set = new Set(scopes)
  const payload: SyncBundlePayload = {}

  if (set.has('hosts')) payload.hosts = snapshot.hosts
  if (set.has('snippets')) payload.snippets = snapshot.snippets
  if (set.has('settings')) payload.settings = pickPortableSettings(snapshot.settings)
  if (set.has('tunnels')) {
    payload.tunnels = snapshot.tunnels.map((tunnel) => ({ ...tunnel, sessionId: undefined }))
  }
  if (set.has('knownHosts')) payload.knownHosts = snapshot.knownHosts
  if (set.has('credentials')) {
    // 凭据只对本次真正带上的主机有意义，避免把无关主机的密码也解出来
    const ids = (payload.hosts ?? snapshot.hosts).map((host) => host.id)
    const credentials = store.exportCredentials(ids)
    if (Object.keys(credentials).length > 0) payload.credentials = credentials
  }

  const meta: SyncBundleMeta = {
    appVersion: app.getVersion(),
    deviceName: os.hostname().slice(0, 80) || '未知设备',
    platform: process.platform,
    createdAt: new Date().toISOString(),
    scopes: scopes.filter((scope) => scope !== 'credentials' || Boolean(payload.credentials)),
    counts: {
      hosts: payload.hosts?.length ?? 0,
      snippets: payload.snippets?.length ?? 0,
      tunnels: payload.tunnels?.length ?? 0,
      knownHosts: payload.knownHosts ? Object.keys(payload.knownHosts).length : 0,
      credentials: payload.credentials ? Object.keys(payload.credentials).length : 0
    },
    hasCredentials: Boolean(payload.credentials)
  }

  return { payload, meta }
}

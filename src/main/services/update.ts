import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { ReleaseChannel, ReleaseInfo, UpdateCheckResult } from '../../shared/types'
import { compareVersions, isSafeReleaseUrl } from '../../shared/version'
import { log } from './logger'

/**
 * 更新检查（预留扩展点）。
 *
 * 设计目标：内部渠道默认「完全不联网」，将来开放公测下载时只改构建元信息即可启用，
 * 不需要改渲染层、不需要重新设计打包流程。
 *
 *  - 内部渠道（channel = internal）或未配置 updateUrl：直接返回 disabled，不发任何请求；
 *  - 公开渠道（channel = public）：GET `${updateUrl}/latest.json`，只带 Accept 头，
 *    不带机器码 / 用户标识 / 使用统计，符合「默认不对外上报」的约束。
 *
 * 之所以不直接引入 electron-updater：内部渠道用不到自动下载安装，先保留检查能力，
 * 将来若需要静默更新，可在同一 Provider 接口下替换实现。
 */

const CACHE_MS = 10 * 60 * 1000
const REQUEST_TIMEOUT_MS = 8000

interface LatestManifest {
  version: string
  notes?: string
  url?: string
  publishedAt?: string
}

export interface UpdateProvider {
  readonly id: string
  readonly label: string
  check(currentVersion: string): Promise<UpdateCheckResult>
}

let metaCache: ReleaseInfo | null = null
let checkCache: { at: number; result: UpdateCheckResult } | null = null

const FALLBACK_META: ReleaseInfo = {
  productName: 'JShell',
  version: app.getVersion(),
  channel: 'internal',
  updateUrl: '',
  buildTime: '',
  homepage: ''
}

function readMetaFile(file: string): Partial<ReleaseInfo> | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<ReleaseInfo>
    return raw && typeof raw === 'object' ? raw : null
  } catch {
    return null
  }
}

/**
 * 读取打包时写入的发布元信息。
 * 打包版在 resources/release-meta.json；开发模式读 build/release-meta.json。
 */
export function loadReleaseInfo(): ReleaseInfo {
  if (metaCache) return metaCache
  const candidates = [
    path.join(process.resourcesPath, 'release-meta.json'),
    path.join(app.getAppPath(), 'build', 'release-meta.json')
  ]
  let meta: Partial<ReleaseInfo> | null = null
  for (const file of candidates) {
    meta = readMetaFile(file)
    if (meta) break
  }
  const channel: ReleaseChannel = meta?.channel === 'public' ? 'public' : 'internal'
  metaCache = {
    ...FALLBACK_META,
    ...meta,
    // 版本号始终以应用自身为准，避免元信息与 package.json 不一致时误导用户
    version: app.getVersion(),
    channel,
    updateUrl: typeof meta?.updateUrl === 'string' ? meta.updateUrl.trim() : '',
    buildTime: typeof meta?.buildTime === 'string' ? meta.buildTime : ''
  }
  return metaCache
}

class DisabledProvider implements UpdateProvider {
  readonly id = 'disabled'
  readonly label = '内部渠道'

  async check(currentVersion: string): Promise<UpdateCheckResult> {
    return {
      status: 'disabled',
      currentVersion,
      checkedAt: Date.now(),
      message: '当前为内部渠道，未配置更新检查地址。'
    }
  }
}

class HttpManifestProvider implements UpdateProvider {
  readonly id = 'http-manifest'
  readonly label = '更新清单'

  constructor(private readonly baseUrl: string) {}

  async check(currentVersion: string): Promise<UpdateCheckResult> {
    try {
      const url = new URL(`${this.baseUrl.replace(/\/+$/, '')}/latest.json`)
      const response = await fetch(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      })
      if (!response.ok) {
        throw new Error(`服务返回 ${response.status}`)
      }
      const text = await response.text()
      if (text.length > 512 * 1024) throw new Error('更新清单过大')
      const manifest = JSON.parse(text) as LatestManifest
      if (!manifest || typeof manifest.version !== 'string' || !manifest.version.trim()) {
        throw new Error('更新清单格式不正确')
      }

      const latestVersion = manifest.version.trim()
      if (compareVersions(latestVersion, currentVersion) <= 0) {
        return {
          status: 'up-to-date',
          currentVersion,
          latestVersion,
          checkedAt: Date.now(),
          message: '当前已是最新版本。'
        }
      }

      const safeUrl = manifest.url && isSafeReleaseUrl(manifest.url) ? manifest.url : undefined
      return {
        status: 'available',
        currentVersion,
        latestVersion,
        notes:
          typeof manifest.notes === 'string' ? manifest.notes.slice(0, 4000) : undefined,
        url: safeUrl,
        checkedAt: Date.now(),
        message: `发现新版本 ${latestVersion}`
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.warn('检查更新失败', message)
      return {
        status: 'error',
        currentVersion,
        checkedAt: Date.now(),
        message: `检查更新失败：${message}`
      }
    }
  }
}

function createProvider(meta: ReleaseInfo): UpdateProvider {
  if (meta.channel !== 'public') return new DisabledProvider()
  if (!isSafeReleaseUrl(meta.updateUrl)) return new DisabledProvider()
  return new HttpManifestProvider(meta.updateUrl)
}

/** 检查更新：内部渠道直接返回 disabled（零网络请求） */
export async function checkForUpdates(force = false): Promise<UpdateCheckResult> {
  const meta = loadReleaseInfo()
  const currentVersion = app.getVersion()

  if (!force && checkCache && Date.now() - checkCache.at < CACHE_MS) {
    return checkCache.result
  }

  const result = await createProvider(meta).check(currentVersion)
  checkCache = { at: Date.now(), result }
  log.info(`更新检查结果：${result.status}${result.latestVersion ? `（${result.latestVersion}）` : ''}`)
  return result
}

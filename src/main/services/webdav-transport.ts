import { SYNC_AUTO_FILE, SYNC_MAX_BYTES } from '../../shared/sync'
import type { SyncTransport } from './sync-transport'

/** 单次 WebDAV 请求的超时；后台同步不该无限挂起 */
const TIMEOUT_MS = 15_000
const DEFAULT_POLL_MS = 15_000

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

/**
 * WebDAV 目录地址规范化。
 *
 * 只接受 https：同步包即使加密，凭据与元信息也不该走明文；
 * 例外是回环地址（自建在 localhost 的场景，以及本地测试）。
 */
export function normalizeWebdavUrl(input: string): string {
  const raw = (input ?? '').trim()
  if (!raw) throw new Error('请填写 WebDAV 目录地址')

  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error('WebDAV 地址格式不对，例如 https://dav.example.com/jshell')
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('WebDAV 只支持 http(s) 地址')
  }
  if (parsed.protocol === 'http:' && !LOOPBACK.has(parsed.hostname)) {
    throw new Error('WebDAV 请使用 https（仅本机回环地址允许 http）')
  }

  parsed.search = ''
  parsed.hash = ''
  const path = parsed.pathname.replace(/\/+$/, '')
  return `${parsed.origin}${path}`
}

export interface WebdavTransportOptions {
  /** 目录地址（normalizeWebdavUrl 之后） */
  url: string
  username?: string
  password?: string
  pollMs?: number
}

interface RequestOptions {
  username?: string
  password?: string
}

function authHeaders(options: RequestOptions): Record<string, string> {
  if (!options.username) return {}
  const token = Buffer.from(`${options.username}:${options.password ?? ''}`, 'utf8').toString(
    'base64'
  )
  return { Authorization: `Basic ${token}` }
}

function failFor(status: number, action: string): never {
  if (status === 401) throw new Error('WebDAV 认证失败：用户名或密码不正确')
  if (status === 403) throw new Error('WebDAV 拒绝访问：该账号没有这个目录的权限')
  if (status === 404) throw new Error(`WebDAV 路径不存在（${action}）`)
  if (status === 507) throw new Error('WebDAV 空间不足，无法写入同步包')
  if (status >= 500) throw new Error(`WebDAV 服务器错误（HTTP ${status}）`)
  throw new Error(`${action}失败（HTTP ${status}）`)
}

async function send(
  url: string,
  method: string,
  init: RequestInit & RequestOptions = {}
): Promise<Response> {
  const headers = { ...authHeaders(init), ...(init.headers as Record<string, string> | undefined) }
  try {
    return await fetch(url, {
      method,
      headers,
      body: init.body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'follow'
    })
  } catch (err) {
    const error = err as Error
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      throw new Error('WebDAV 请求超时（15 秒），请检查地址与网络')
    }
    throw new Error(`无法连接 WebDAV：${error.message}`)
  }
}

/**
 * WebDAV 传输：Nextcloud / 坚果云 / Synology / Apache mod_dav 等通用。
 *
 * 与 SFTP 同样的取舍：没有变更通知，靠 ETag / Last-Modified 轮询；
 * 写文件用 PUT，天然整体覆盖，不需要临时文件。
 */
export function createWebdavTransport(options: WebdavTransportOptions): SyncTransport {
  const base = normalizeWebdavUrl(options.url)
  const fileUrl = `${base}/${SYNC_AUTO_FILE}`
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS
  const creds: RequestOptions = { username: options.username, password: options.password }

  const metaOf = async (): Promise<{ etag: string; size: number } | null> => {
    let response = await send(fileUrl, 'HEAD', creds)
    // 少数服务器不允许 HEAD，退化成 GET 只看响应头
    if (response.status === 405 || response.status === 501) {
      response = await send(fileUrl, 'GET', { ...creds, headers: { Range: 'bytes=0-0' } })
    }
    if (response.status === 404) return null
    if (!response.ok) failFor(response.status, '读取文件信息')
    const etag = response.headers.get('etag') ?? ''
    const modified = response.headers.get('last-modified') ?? ''
    const length = response.headers.get('content-length') ?? ''
    return { etag: `${etag}|${modified}|${length}`, size: Number(length) || 0 }
  }

  return {
    kind: 'webdav',
    label: base,

    async exists(): Promise<boolean> {
      return (await metaOf()) !== null
    },

    async read(): Promise<string | null> {
      const response = await send(fileUrl, 'GET', creds)
      if (response.status === 404) return null
      if (!response.ok) failFor(response.status, '读取同步包')
      const declared = Number(response.headers.get('content-length') ?? '0')
      if (declared > SYNC_MAX_BYTES) throw new Error('同步包超过 20MB，已跳过')
      const text = await response.text()
      if (Buffer.byteLength(text, 'utf8') > SYNC_MAX_BYTES) {
        throw new Error('同步包超过 20MB，已跳过')
      }
      return text
    },

    async write(text: string): Promise<void> {
      const response = await send(fileUrl, 'PUT', {
        ...creds,
        headers: { 'Content-Type': 'application/octet-stream' },
        body: text
      })
      if (!response.ok && response.status !== 204) failFor(response.status, '写入同步包')
    },

    watch(onChange: () => void): () => void {
      let lastKey = ''
      let timer: NodeJS.Timeout | undefined
      let stopped = false

      const poll = async (): Promise<void> => {
        if (stopped) return
        try {
          const meta = await metaOf()
          if (!meta) {
            lastKey = ''
            return
          }
          // 请求期间可能已经被 unwatch：停止后不要再回调，否则会重新装上定时器
          if (!stopped && lastKey && meta.etag !== lastKey) onChange()
          lastKey = meta.etag
        } catch {
          // 网络抖动/认证临时失效：等下一轮，不在这里刷错误
        }
      }

      void poll()
      timer = setInterval(() => void poll(), pollMs)
      // 轮询只是后台检查，不应阻止进程退出
      timer.unref?.()
      return () => {
        stopped = true
        if (timer) clearInterval(timer)
      }
    },

    async test(): Promise<string> {
      // 建目录：201 新建，405/301 表示已存在
      const mkcol = await send(base, 'MKCOL', creds)
      if (![201, 204, 301, 302, 405].includes(mkcol.status)) {
        failFor(mkcol.status, '创建远端目录')
      }

      const probe = `${base}/.jshell-write-test`
      const put = await send(probe, 'PUT', { ...creds, body: 'ok' })
      if (!put.ok && put.status !== 204) failFor(put.status, '写入探针文件')
      try {
        await send(probe, 'DELETE', creds)
      } catch {
        /* 删除失败不影响结论 */
      }
      return `WebDAV 可读写：${base}`
    },

    async dispose(): Promise<void> {
      /* 无长连接需要释放 */
    }
  }
}

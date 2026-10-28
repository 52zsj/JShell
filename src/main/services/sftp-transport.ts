import path from 'node:path'
import type { SFTPWrapper, Stats } from 'ssh2'
import { SYNC_AUTO_FILE, SYNC_MAX_BYTES } from '../../shared/sync'
import type { HostProfile } from '../../shared/types'
import { connectSsh, type SshConnection } from './ssh-connect'
import type { StoreService } from './store'
import type { SyncTransport } from './sync-transport'

/** SFTP 没有文件监视接口，只能轮询；15 秒在「够快」和「别扰民」之间 */
const DEFAULT_POLL_MS = 15_000
/** 一轮同步结束后保持连接的时间，避免 read/write 各自重连 */
const IDLE_CLOSE_MS = 20_000

export interface SftpTransportOptions {
  host: HostProfile
  dir: string
  store: StoreService
  pollMs?: number
  /**
   * 测试注入点：跳过真实 SSH 连接，直接给一个 SFTP 会话。
   * 生产路径永远不传，保持「连接由 connectSsh 统一建立」的单一入口。
   */
  openSftp?: () => Promise<SFTPWrapper>
}

/**
 * 把用户输入的远端目录整理成稳定的 posix 路径。
 * 允许：`/srv/jshell`、`~/jshell`、`~`；拒绝空值。
 */
export function normalizeRemoteDir(input: string): string {
  const raw = (input ?? '').trim()
  if (!raw) throw new Error('请填写远端目录')

  const isHome = raw === '~' || raw.startsWith('~/')
  if (!isHome && !raw.startsWith('/')) {
    throw new Error('远端目录请填绝对路径，例如 /home/me/jshell 或 ~/jshell')
  }

  // 先掐掉首尾斜杠再统一归一化，避免 `~//a/` 这类输入留下多余分隔符
  const body = (isHome ? raw.slice(1) : raw).replace(/^\/+/, '').replace(/\/+$/, '')
  const normalized = path.posix.normalize(body ? `/${body}` : '/')
  return isHome ? (normalized === '/' ? '~' : `~${normalized}`) : normalized
}

function statOf(sftp: SFTPWrapper, target: string): Promise<Stats | null> {
  return new Promise((resolve, reject) => {
    sftp.stat(target, (err, stats) => {
      if (err) {
        // SFTP v3 的 ENOENT 是数字 2，ssh2 的类型声明里却写成 string
        const code = (err as { code?: string | number }).code
        if (code === 2 || code === 'ENOENT' || /no such file/i.test(err.message)) return resolve(null)
        return reject(err)
      }
      resolve(stats)
    })
  })
}

function readRemoteFile(sftp: SFTPWrapper, target: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    sftp.readFile(target, (err, data) => (err ? reject(err) : resolve(data)))
  })
}

function writeRemoteFile(sftp: SFTPWrapper, target: string, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.writeFile(target, Buffer.from(text, 'utf8'), { mode: 0o600 }, (err) =>
      err ? reject(err) : resolve()
    )
  })
}

function renameRemote(sftp: SFTPWrapper, from: string, to: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.rename(from, to, (err) => (err ? reject(err) : resolve()))
  })
}

function unlinkRemote(sftp: SFTPWrapper, target: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.unlink(target, (err) => (err ? reject(err) : resolve()))
  })
}

function mkdirRemote(sftp: SFTPWrapper, target: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.mkdir(target, (err) => (err ? reject(err) : resolve()))
  })
}

function realpathRemote(sftp: SFTPWrapper, target: string): Promise<string> {
  return new Promise((resolve, reject) => {
    sftp.realpath(target, (err, resolved) => (err ? reject(err) : resolve(resolved)))
  })
}

/** 逐级创建远端目录（SFTP 没有 mkdir -p） */
async function ensureRemoteDir(sftp: SFTPWrapper, dir: string): Promise<void> {
  if (dir === '/' || dir === '~') return
  const segments = dir.split('/').filter(Boolean)
  let current = dir.startsWith('/') ? '' : '.'
  for (const segment of segments) {
    current = `${current}/${segment}`
    const stats = await statOf(sftp, current)
    if (stats) {
      if (!stats.isDirectory()) throw new Error(`远端路径不是目录：${current}`)
      continue
    }
    try {
      await mkdirRemote(sftp, current)
    } catch (err) {
      // 并发或权限问题：再 stat 一次，确实是目录就继续
      const again = await statOf(sftp, current)
      if (!again?.isDirectory()) {
        throw new Error(`无法创建远端目录 ${current}：${(err as Error).message}`)
      }
    }
  }
}

async function resolveRemoteDir(sftp: SFTPWrapper, dir: string): Promise<string> {
  const normalized = normalizeRemoteDir(dir)
  if (!normalized.startsWith('~')) return normalized
  const home = await realpathRemote(sftp, '.')
  const rest = normalized.slice(1).replace(/^\/?/, '')
  return rest ? path.posix.join(home, rest) : home
}

/**
 * SFTP 传输：把同步包直接推到用户自己的服务器。
 *
 * 复用主机的地址/认证/跳板机配置，与会话层同一套凭据；
 * 指纹校验是只读的——后台任务不会偷偷把新指纹写进信任库。
 */
export function createSftpTransport(options: SftpTransportOptions): SyncTransport {
  const { host, store } = options
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS
  let session: SshConnection | null = null
  let sftp: SFTPWrapper | null = null
  let idleTimer: NodeJS.Timeout | undefined
  let cachedDir: string | null = null

  const closeSession = (): void => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = undefined
    cachedDir = null
    const wrapper = sftp
    sftp = null
    try {
      if (typeof wrapper?.end === 'function') wrapper.end()
    } catch {
      /* 已关闭 */
    }
    session?.close()
    session = null
  }

  const touch = (): void => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => closeSession(), IDLE_CLOSE_MS)
    // 后台同步不该拖住进程退出：定时器只负责收连接，不负责保活
    idleTimer.unref?.()
  }

  const getSftp = async (): Promise<SFTPWrapper> => {
    if (sftp) {
      touch()
      return sftp
    }
    if (options.openSftp) {
      const injected = await options.openSftp()
      sftp = injected
      touch()
      return injected
    }
    const conn = await connectSsh(host, store)
    session = conn
    const wrapper = await new Promise<SFTPWrapper>((resolve, reject) => {
      conn.client.sftp((err, value) => (err ? reject(err) : resolve(value)))
    })
    sftp = wrapper
    wrapper.on?.('close', () => {
      sftp = null
      session?.close()
      session = null
      cachedDir = null
    })
    touch()
    return wrapper
  }

  const dirOf = async (wrapper: SFTPWrapper): Promise<string> => {
    if (cachedDir) return cachedDir
    cachedDir = await resolveRemoteDir(wrapper, options.dir)
    return cachedDir
  }

  const fileOf = async (wrapper: SFTPWrapper): Promise<string> =>
    path.posix.join(await dirOf(wrapper), SYNC_AUTO_FILE)

  return {
    kind: 'sftp',
    label: `${host.name} → ${options.dir}`,

    async exists(): Promise<boolean> {
      const wrapper = await getSftp()
      const stats = await statOf(wrapper, await fileOf(wrapper))
      return Boolean(stats?.isFile())
    },

    async read(): Promise<string | null> {
      const wrapper = await getSftp()
      const stats = await statOf(wrapper, await fileOf(wrapper))
      if (!stats?.isFile()) return null
      if (stats.size > SYNC_MAX_BYTES) throw new Error('同步包超过 20MB，已跳过')
      const buffer = await readRemoteFile(wrapper, await fileOf(wrapper))
      return buffer.toString('utf8')
    },

    async write(text: string): Promise<void> {
      const wrapper = await getSftp()
      const dir = await dirOf(wrapper)
      await ensureRemoteDir(wrapper, dir)
      const target = path.posix.join(dir, SYNC_AUTO_FILE)
      const tmp = `${target}.tmp`
      await writeRemoteFile(wrapper, tmp, text)
      try {
        await renameRemote(wrapper, tmp, target)
      } catch {
        // 标准 SFTP v3 的 rename 不允许覆盖已存在的目标，先删再改名
        try {
          await unlinkRemote(wrapper, target)
        } catch {
          /* 目标本来就不存在 */
        }
        await renameRemote(wrapper, tmp, target)
      }
      touch()
    },

    watch(onChange: () => void): () => void {
      let lastKey = ''
      let timer: NodeJS.Timeout | undefined
      let stopped = false

      const poll = async (): Promise<void> => {
        if (stopped) return
        try {
          const wrapper = await getSftp()
          const stats = await statOf(wrapper, await fileOf(wrapper))
          if (!stats?.isFile()) {
            lastKey = ''
            return
          }
          const key = `${stats.mtime}:${stats.size}`
          if (lastKey && key !== lastKey) onChange()
          lastKey = key
        } catch {
          // 网络抖动/服务器暂时不可达：下一次轮询再试，不在这里刷错误
        }
      }

      // 首次只记录基线，不触发同步
      void poll()
      timer = setInterval(() => void poll(), pollMs)
      timer.unref?.()

      return () => {
        stopped = true
        if (timer) clearInterval(timer)
      }
    },

    async test(): Promise<string> {
      const wrapper = await getSftp()
      const dir = await dirOf(wrapper)
      await ensureRemoteDir(wrapper, dir)
      const probe = path.posix.join(dir, '.jshell-write-test')
      await writeRemoteFile(wrapper, probe, 'ok')
      try {
        await unlinkRemote(wrapper, probe)
      } catch {
        /* 删除失败不影响结论 */
      }
      return `SFTP 可读写：${host.name} → ${dir}`
    },

    async dispose(): Promise<void> {
      closeSession()
    }
  }
}

import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { posix } from 'node:path'
import type { SFTPWrapper } from 'ssh2'
import type { FileEntry, TextFile } from '../../shared/types'
import type { SessionManager } from './session-manager'

/** 把 ssh2 的 node 风格回调包成 Promise */
function call<T>(fn: (cb: (err: Error | null | undefined, result?: T) => void) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    fn((err, result) => (err ? reject(err) : resolve(result as T)))
  })
}

/** 下载/上传的临时后缀：写成临时文件再原子改名，避免失败时破坏目标文件 */
const PART_SUFFIX = '.jshell-part'

/** 内置编辑器的大小上限：超过则建议下载后用本地编辑器 */
export const MAX_TEXT_BYTES = 2 * 1024 * 1024

/** 粗判二进制：前 8 KB 出现 NUL 即视为非文本 */
function looksBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8192).includes(0)
}

/**
 * 远端名称校验。
 * 渲染层已做一次校验，这里是 IPC 信任边界上的第二道防线：
 * 拒绝空名、`.`/`..`、路径分隔符与控制字符，避免一次重命名把文件写到别的目录。
 */
export function assertSafeName(name: string): void {
  if (!name || name === '.' || name === '..') throw new Error('名称无效')
  if (name.length > 255) throw new Error('名称过长（最多 255 个字符）')
  if (/[/\\\0]/.test(name)) throw new Error('名称不能包含 / 或 \\')
}

/** 原子替换目标文件；Windows 下 rename 可能因目标存在而失败，退化为先删后改名 */
async function replaceFile(from: string, to: string): Promise<void> {
  try {
    await fs.promises.rename(from, to)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'EEXIST' && code !== 'EPERM' && code !== 'EACCES') throw err
    await fs.promises.rm(to, { force: true })
    await fs.promises.rename(from, to)
  }
}

/**
 * SFTP 文件服务。
 *
 * 说明：所有方法都以 sessionId 作为第一参数，SFTP 通道按会话懒加载并复用，
 * 因此文件面板与终端标签页共享同一条 SSH 连接，不会额外消耗服务器连接数。
 */
export class SftpService {
  private readonly sessions: SessionManager

  constructor(sessions: SessionManager) {
    this.sessions = sessions
  }

  private async sftpOf(sessionId: string): Promise<SFTPWrapper> {
    // 只有 SSH 会话有 SFTP 子系统；本地终端会在这里抛出可读错误
    return this.sessions.requireSsh(sessionId).sftp()
  }

  /** 远端默认目录（一般即登录用户 home） */
  async home(sessionId: string): Promise<string> {
    const sftp = await this.sftpOf(sessionId)
    const real = await call<string>((cb) => sftp.realpath('.', cb))
    return real
  }

  async list(sessionId: string, dirPath: string): Promise<FileEntry[]> {
    const sftp = await this.sftpOf(sessionId)
    const raw = await call<Array<{ filename: string; attrs: import('ssh2').Stats }>>((cb) =>
      sftp.readdir(dirPath, cb)
    )

    const entries: FileEntry[] = raw.map((item) => {
      const attrs = item.attrs
      const type = attrs.isDirectory()
        ? 'dir'
        : attrs.isSymbolicLink()
          ? 'link'
          : attrs.isFile()
            ? 'file'
            : 'other'
      return {
        name: item.filename,
        path: posix.join(dirPath, item.filename),
        type,
        size: attrs.size,
        mtime: (attrs.mtime ?? 0) * 1000,
        mode: attrs.mode
      }
    })

    // 目录优先，其次按名称自然序（忽略大小写）
    return entries.sort((a, b) => {
      if ((a.type === 'dir') !== (b.type === 'dir')) return a.type === 'dir' ? -1 : 1
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
    })
  }

  /** 逐级创建目录，已存在则跳过 */
  async mkdir(sessionId: string, dirPath: string): Promise<void> {
    const sftp = await this.sftpOf(sessionId)
    const absolute = dirPath.startsWith('/')
    const parts = dirPath.split('/').filter(Boolean)
    let current = absolute ? '' : '.'

    for (const part of parts) {
      current = current === '' ? `/${part}` : posix.join(current, part)
      // 先 stat：已存在则跳过（并区分"同名目录"与"同名文件"），
      // 不能靠 mkdir 的报错文案判断，SSH 服务端对"已存在"和"无权限"都只回 Failure
      const existing = await call<import('ssh2').Stats>((cb) => sftp.stat(current, cb)).catch(
        () => undefined
      )
      if (existing) {
        if (!existing.isDirectory()) throw new Error(`${current} 已存在且不是目录`)
        continue
      }
      await call<void>((cb) => sftp.mkdir(current, cb))
    }
  }

  async rename(sessionId: string, from: string, to: string): Promise<void> {
    const sftp = await this.sftpOf(sessionId)
    await call<void>((cb) => sftp.rename(from, to, cb))
  }

  /** 删除（目录递归删除，带深度保护） */
  async remove(sessionId: string, target: string, isDir: boolean, depth = 0): Promise<void> {
    const sftp = await this.sftpOf(sessionId)
    if (depth > 32) throw new Error('目录层级过深，已中止删除')

    if (!isDir) {
      await call<void>((cb) => sftp.unlink(target, cb))
      return
    }

    const children = await this.list(sessionId, target)
    for (const child of children) {
      await this.remove(sessionId, child.path, child.type === 'dir', depth + 1)
    }
    await call<void>((cb) => sftp.rmdir(target, cb))
  }

  async exists(sessionId: string, remotePath: string): Promise<boolean> {
    const sftp = await this.sftpOf(sessionId)
    return call<import('ssh2').Stats>((cb) => sftp.stat(remotePath, cb)).then(
      () => true,
      () => false
    )
  }

  async statSize(sessionId: string, remotePath: string): Promise<number> {
    const sftp = await this.sftpOf(sessionId)
    const stats = await call<import('ssh2').Stats>((cb) => sftp.stat(remotePath, cb))
    return stats.size
  }

  /**
   * 下载：远端 -> 本地。
   * 采用流式管道 + 进度回调，避免把大文件读进内存。
   */
  async download(
    sessionId: string,
    remotePath: string,
    localPath: string,
    onProgress: (transferred: number, total: number) => void,
    signal?: AbortSignal
  ): Promise<void> {
    const sftp = await this.sftpOf(sessionId)
    const total = await this.statSize(sessionId, remotePath).catch(() => 0)
    // 先写 .part：中途失败只会留下临时文件，用户原有的同名文件不会被破坏
    const partPath = `${localPath}${PART_SUFFIX}`

    try {
      await new Promise<void>((resolve, reject) => {
        const source = sftp.createReadStream(remotePath)
        const target = fs.createWriteStream(partPath)
        let transferred = 0
        let settled = false
        const onAbort = (): void => {
          const err = new Error('传输已取消')
          err.name = 'AbortError'
          fail(err)
        }
        const fail = (err: Error) => {
          if (settled) return
          settled = true
          signal?.removeEventListener('abort', onAbort)
          source.destroy()
          target.destroy()
          fs.promises.unlink(partPath).catch(() => undefined)
          reject(err)
        }
        if (signal?.aborted) {
          onAbort()
          return
        }
        signal?.addEventListener('abort', onAbort, { once: true })

        source.on('data', (chunk: Buffer) => {
          transferred += chunk.length
          onProgress(transferred, total)
        })
        source.on('error', fail)
        target.on('error', fail)
        target.on('close', () => {
          if (settled) return
          settled = true
          signal?.removeEventListener('abort', onAbort)
          onProgress(transferred, total || transferred)
          resolve()
        })
        source.pipe(target)
      })

      await replaceFile(partPath, localPath)
    } catch (err) {
      fs.promises.unlink(partPath).catch(() => undefined)
      throw err
    }
  }

  /**
   * 上传：本地 -> 远端。
   * 同样先写远端临时文件再改名，避免中途失败把已有文件截断成半截内容。
   * 优先用 OpenSSH 的 posix-rename 扩展（原子覆盖），不支持时退化为普通 rename。
   */
  async upload(
    sessionId: string,
    localPath: string,
    remotePath: string,
    onProgress: (transferred: number, total: number) => void,
    signal?: AbortSignal
  ): Promise<void> {
    const sftp = await this.sftpOf(sessionId)
    const total = fs.statSync(localPath).size
    const remotePart = `${remotePath}${PART_SUFFIX}`

    try {
      await new Promise<void>((resolve, reject) => {
        const source = fs.createReadStream(localPath)
        const target = sftp.createWriteStream(remotePart)
        let transferred = 0
        let settled = false
        const onAbort = (): void => {
          const err = new Error('传输已取消')
          err.name = 'AbortError'
          fail(err)
        }
        const fail = (err: Error) => {
          if (settled) return
          settled = true
          signal?.removeEventListener('abort', onAbort)
          source.destroy()
          target.destroy()
          reject(err)
        }
        if (signal?.aborted) {
          onAbort()
          return
        }
        signal?.addEventListener('abort', onAbort, { once: true })

        source.on('data', (chunk: string | Buffer) => {
          transferred += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length
          onProgress(transferred, total)
        })
        source.on('error', fail)
        target.on('error', fail)
        target.on('close', () => {
          if (settled) return
          settled = true
          signal?.removeEventListener('abort', onAbort)
          onProgress(transferred, total)
          resolve()
        })
        source.pipe(target)
      })

      // posix-rename 是原子覆盖；服务端不支持时再退回普通 rename
      await call<void>((cb) => sftp.ext_openssh_rename(remotePart, remotePath, cb)).catch(() =>
        call<void>((cb) => sftp.rename(remotePart, remotePath, cb))
      )
    } catch (err) {
      // 失败时清掉临时文件，目标文件保持原样
      await call<void>((cb) => sftp.unlink(remotePart, cb)).catch(() => undefined)
      throw err
    }
  }
  // -------------------------------------------------------------- 文本编辑

  /** 读取文本文件（供内置编辑器）；超过上限或二进制直接拒绝 */
  async readText(sessionId: string, remotePath: string): Promise<TextFile> {
    const sftp = await this.sftpOf(sessionId)
    const stats = await call<import('ssh2').Stats>((cb) => sftp.stat(remotePath, cb))
    if (stats.isDirectory()) throw new Error('目录不能作为文本文件打开')
    if (stats.size > MAX_TEXT_BYTES) {
      throw new Error(`文件过大（${(stats.size / 1024 / 1024).toFixed(1)} MB），请下载后使用本地编辑器打开`)
    }
    const buf = await call<Buffer>((cb) => sftp.readFile(remotePath, cb))
    if (looksBinary(buf)) throw new Error('该文件不是文本文件，无法内置编辑')
    return { text: buf.toString('utf8'), size: buf.length, truncated: false }
  }

  /** 保存文本：先写临时文件再原子覆盖，失败不破坏原文件，保留原权限位 */
  async writeText(sessionId: string, remotePath: string, text: string): Promise<void> {
    const sftp = await this.sftpOf(sessionId)
    const buf = Buffer.from(text, 'utf8')
    if (buf.length > MAX_TEXT_BYTES) throw new Error('内容超过 2 MB，无法保存')

    const stats = await call<import('ssh2').Stats>((cb) => sftp.stat(remotePath, cb))
    if (stats.isDirectory()) throw new Error('目标不是文件')

    const temp = `${remotePath}.jshell-save-${randomUUID().slice(0, 8)}`
    try {
      await call<void>((cb) => sftp.writeFile(temp, buf, { mode: stats.mode }, cb))
      await call<void>((cb) => sftp.ext_openssh_rename(temp, remotePath, cb)).catch(() =>
        call<void>((cb) => sftp.rename(temp, remotePath, cb))
      )
    } catch (err) {
      await call<void>((cb) => sftp.unlink(temp, cb)).catch(() => undefined)
      throw err
    }
  }

}

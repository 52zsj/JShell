import fs from 'node:fs'
import path from 'node:path'
import { SYNC_AUTO_FILE, SYNC_MAX_BYTES, type SyncTransportKind } from '../../shared/sync'

/**
 * 同步传输层。
 *
 * 自动同步只关心四件事：**读一个文件、写一个文件、文件变了叫我、关掉**。
 * 把这几件事抽出来后，SFTP / WebDAV 只是换一个实现，
 * 上层的检测、合并、去抖、状态机完全不用动。
 *
 * 所有 IO 都是异步的：SFTP 天然异步，文件夹实现也跟着统一，
 * 免得上层出现「有的 await 有的不 await」的半吊子写法。
 */
export interface SyncTransport {
  readonly kind: SyncTransportKind
  readonly label: string
  exists(): Promise<boolean>
  read(): Promise<string | null>
  write(text: string): Promise<void>
  /** 返回取消监听的函数 */
  watch(onChange: () => void): () => void
  /** 自检：目录可写、能读到文件；返回一句人类可读的结果 */
  test(): Promise<string>
  dispose(): Promise<void>
}

/**
 * 文件夹传输（iCloud / OneDrive / Dropbox / 坚果云 / 任意本地目录都走这里，
 * 因为它们在文件系统层面就是普通文件夹）。
 */
export function createFolderTransport(dir: string): SyncTransport {
  const file = path.join(dir, SYNC_AUTO_FILE)

  const exists = async (): Promise<boolean> => {
    try {
      return fs.statSync(file).isFile()
    } catch {
      return false
    }
  }

  return {
    kind: 'folder',
    label: dir,

    exists,

    async read(): Promise<string | null> {
      let stat: fs.Stats
      try {
        stat = fs.statSync(file)
      } catch {
        return null
      }
      if (!stat.isFile()) return null
      if (stat.size > SYNC_MAX_BYTES) throw new Error('同步包超过 20MB，已跳过')
      return fs.readFileSync(file, 'utf8')
    },

    async write(text: string): Promise<void> {
      fs.mkdirSync(dir, { recursive: true })
      // 原子写：先写临时文件再 rename，避免云盘客户端读到半个文件
      const tmp = `${file}.tmp`
      fs.writeFileSync(tmp, text, { mode: 0o600 })
      fs.renameSync(tmp, file)
    },

    watch(onChange: () => void): () => void {
      let watcher: fs.FSWatcher
      /**
       * 事件里的 filename 并不总是可靠：macOS 上偶发为 null，重命名还会连发两次。
       * 所以再核对一次「目标文件的 mtime + size」——只有签名变了才算真的变了。
       */
      const signature = (): string => {
        try {
          const stat = fs.statSync(file)
          return `${stat.mtimeMs}:${stat.size}`
        } catch {
          return ''
        }
      }
      let last = signature()

      try {
        fs.mkdirSync(dir, { recursive: true })
        watcher = fs.watch(dir, { persistent: false }, (_event, filename) => {
          // 能拿到文件名时先做一次廉价过滤，避免同目录其它文件触发 stat
          if (filename && String(filename) !== SYNC_AUTO_FILE) return
          const next = signature()
          if (next === last) return
          last = next
          onChange()
        })
      } catch {
        return () => undefined
      }
      watcher.on('error', () => {
        /* 目录被移除/权限变化时静默失效，下次启停会重建 */
      })
      return () => {
        try {
          watcher.close()
        } catch {
          /* 已经关闭 */
        }
      }
    },

    async test(): Promise<string> {
      fs.mkdirSync(dir, { recursive: true })
      const probe = path.join(dir, '.jshell-write-test')
      fs.writeFileSync(probe, 'ok')
      fs.unlinkSync(probe)
      return `目录可读写：${dir}`
    },

    async dispose(): Promise<void> {
      /* 文件夹没有需要释放的资源 */
    }
  }
}

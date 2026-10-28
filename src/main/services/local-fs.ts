import { shell } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { FileEntry, TextFile } from '../../shared/types'
import { assertSafeName, MAX_TEXT_BYTES } from './sftp'

function assertSafeTarget(target: string): string {
  const resolved = path.resolve(target)
  if (resolved === path.parse(resolved).root) throw new Error('不允许操作磁盘根目录')
  if (resolved === path.resolve(os.homedir())) throw new Error('不允许直接操作用户主目录')
  return resolved
}

/** 本地文件系统：只服务本地终端分屏，删除走系统回收站 */
export class LocalFsService {
  home(): string {
    return os.homedir()
  }

  async list(dir: string): Promise<FileEntry[]> {
    const target = path.resolve(dir || os.homedir())
    const items = await fs.promises.readdir(target, { withFileTypes: true })
    const entries: FileEntry[] = []
    for (const item of items) {
      const full = path.join(target, item.name)
      try {
        const stat = await fs.promises.lstat(full)
        const type = stat.isDirectory()
          ? 'dir'
          : stat.isSymbolicLink()
            ? 'link'
            : stat.isFile()
              ? 'file'
              : 'other'
        entries.push({
          name: item.name,
          path: full,
          type,
          size: stat.size,
          mtime: stat.mtimeMs,
          mode: stat.mode
        })
      } catch {
        /* 权限不足的条目跳过，避免整页失败 */
      }
    }
    return entries.sort((a, b) => {
      if ((a.type === 'dir') !== (b.type === 'dir')) return a.type === 'dir' ? -1 : 1
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
    })
  }

  async mkdir(target: string): Promise<void> {
    assertSafeName(path.basename(target))
    await fs.promises.mkdir(assertSafeTarget(target))
  }

  async rename(from: string, to: string): Promise<void> {
    assertSafeName(path.basename(to))
    const source = assertSafeTarget(from)
    const dest = assertSafeTarget(to)
    if (path.dirname(source) !== path.dirname(dest)) throw new Error('只允许在同一目录内重命名')
    await fs.promises.rename(source, dest)
  }

  async remove(target: string): Promise<void> {
    // 回收站对文件与目录都适用，避免误删不可恢复
    await shell.trashItem(assertSafeTarget(target))
  }

  reveal(target: string): void {
    shell.showItemInFolder(path.resolve(target))
  }

  /** 读取文本文件（供内置编辑器） */
  async readText(target: string): Promise<TextFile> {
    const file = path.resolve(target)
    const stats = await fs.promises.stat(file)
    if (!stats.isFile()) throw new Error('请选择文件而不是目录')
    if (stats.size > MAX_TEXT_BYTES) {
      throw new Error(`文件过大（${(stats.size / 1024 / 1024).toFixed(1)} MB），请用系统编辑器打开`)
    }
    const buf = await fs.promises.readFile(file)
    if (buf.subarray(0, 8192).includes(0)) throw new Error('该文件不是文本文件，无法内置编辑')
    return { text: buf.toString('utf8'), size: buf.length, truncated: false }
  }

  /** 保存文本：先写临时文件再原子覆盖，保留原权限位 */
  async writeText(target: string, text: string): Promise<void> {
    const file = assertSafeTarget(target)
    const buf = Buffer.from(text, 'utf8')
    if (buf.length > MAX_TEXT_BYTES) throw new Error('内容超过 2 MB，无法保存')

    const stats = await fs.promises.stat(file)
    const temp = `${file}.jshell-save-${process.pid}`
    try {
      await fs.promises.writeFile(temp, buf, { mode: stats.mode })
      await fs.promises.rename(temp, file)
    } catch (err) {
      await fs.promises.rm(temp, { force: true }).catch(() => undefined)
      throw err
    }
  }
}

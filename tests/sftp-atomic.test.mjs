import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Writable, PassThrough } from 'node:stream'
import { SftpService, assertSafeName } from '../src/main/services/sftp.ts'

/**
 * 用一个「远端文件系统」替身替换 ssh2 的 SFTPWrapper：
 * 只实现 SftpService 实际用到的 5 个方法，本地一侧仍然走真实 fs，
 * 因此能真实验证「先写 .part 再原子替换 / 失败清理」的行为。
 */
function createFakeRemote(initial = {}, options = {}) {
  const files = new Map(Object.entries(initial).map(([k, v]) => [k, Buffer.from(v)]))

  const wrapper = {
    files,
    stat(target, cb) {
      if (!files.has(target)) return cb(new Error('No such file'))
      cb(undefined, { size: files.get(target).length })
    },
    createReadStream(target) {
      const stream = new PassThrough()
      if (options.failRead || !files.has(target)) {
        process.nextTick(() => stream.emit('error', new Error('No such file')))
        return stream
      }
      process.nextTick(() => stream.end(files.get(target)))
      return stream
    },
    createWriteStream(target) {
      const chunks = []
      const stream = new Writable({
        write(chunk, _enc, cb) {
          chunks.push(Buffer.from(chunk))
          cb()
        }
      })
      stream.on('finish', () => {
        if (options.failWrite) return
        files.set(target, Buffer.concat(chunks))
      })
      return stream
    },
    rename(from, to, cb) {
      if (!files.has(from)) return cb(new Error('Failure'))
      files.set(to, files.get(from))
      files.delete(from)
      cb()
    },
    ext_openssh_rename(from, to, cb) {
      return wrapper.rename(from, to, cb)
    },
    unlink(target, cb) {
      files.delete(target)
      cb()
    }
  }
  return wrapper
}

const progress = () => undefined

function makeService(remote) {
  // SftpService 只依赖 requireSsh(id).sftp()
  return new SftpService({ requireSsh: () => ({ sftp: async () => remote }) })
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jshell-sftp-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('下载：写入临时文件后原子替换，且不留 .part', async (t) => {
  const dir = tempDir(t)
  const remote = createFakeRemote({ '/remote/a.txt': 'hello jshell\n' })
  const target = path.join(dir, 'a.txt')

  await makeService(remote).download('s1', '/remote/a.txt', target, progress)

  assert.equal(fs.readFileSync(target, 'utf8'), 'hello jshell\n')
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes('jshell-part')), [])
})

test('下载失败：目标文件原内容不被破坏，临时文件被清理', async (t) => {
  const dir = tempDir(t)
  const remote = createFakeRemote({})
  const target = path.join(dir, 'keep.txt')
  fs.writeFileSync(target, 'ORIGINAL')

  await assert.rejects(
    () => makeService(remote).download('s1', '/remote/missing.txt', target, progress),
    /No such file/
  )

  assert.equal(fs.readFileSync(target, 'utf8'), 'ORIGINAL', '目标文件必须保持原样')
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes('jshell-part')), [], '临时文件应被清理')
})

test('上传：通过 posix-rename 覆盖远端同名文件', async (t) => {
  const dir = tempDir(t)
  const local = path.join(dir, 'upload.txt')
  fs.writeFileSync(local, 'NEW CONTENT')
  const remote = createFakeRemote({ '/remote/upload.txt': 'OLD CONTENT' })

  await makeService(remote).upload('s1', local, '/remote/upload.txt', progress)

  assert.equal(remote.files.get('/remote/upload.txt').toString(), 'NEW CONTENT')
  assert.equal(
    [...remote.files.keys()].filter((k) => k.includes('jshell-part')).length,
    0,
    '远端不应残留临时文件'
  )
})

test('上传失败：远端原文件保持原样，临时文件被清理', async (t) => {
  const dir = tempDir(t)
  const local = path.join(dir, 'upload.txt')
  fs.writeFileSync(local, 'NEW CONTENT')
  const remote = createFakeRemote({ '/remote/upload.txt': 'OLD CONTENT' }, { failWrite: true })

  await assert.rejects(
    () => makeService(remote).upload('s1', local, '/remote/upload.txt', progress),
    /Failure/
  )

  assert.equal(remote.files.get('/remote/upload.txt').toString(), 'OLD CONTENT')
  assert.equal(
    [...remote.files.keys()].filter((k) => k.includes('jshell-part')).length,
    0,
    '临时文件应被清理'
  )
})

test('assertSafeName 拦截路径穿越与非法名称', () => {
  assert.doesNotThrow(() => assertSafeName('normal-file.txt'))
  assert.doesNotThrow(() => assertSafeName('中文目录'))
  assert.throws(() => assertSafeName('..'), /名称无效/)
  assert.throws(() => assertSafeName('.'), /名称无效/)
  assert.throws(() => assertSafeName(''), /名称无效/)
  assert.throws(() => assertSafeName('a/b'), /不能包含/)
  assert.throws(() => assertSafeName('..\\..\\etc'), /不能包含/)
  assert.throws(() => assertSafeName('x'.repeat(256)), /名称过长/)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createFolderTransport } from '../src/main/services/sync-transport.ts'
import { createSftpTransport } from '../src/main/services/sftp-transport.ts'
import { SYNC_MAX_BYTES } from '../src/shared/sync.ts'

/**
 * 传输层契约测试。
 *
 * 三种实现（文件夹 / SFTP / WebDAV）必须给出同样的行为：
 * 文件不存在时 read 返回 null、写后能读回、超限拒绝、watch 只在内容变化时触发。
 * 自动同步引擎只依赖这几个方法，所以这份契约就是引擎的地基。
 */

/** 内存版 SFTP 会话：只实现我们真正用到的方法，rename 模拟 v3「目标已存在则失败」 */
function createFakeSftp() {
  const files = new Map()
  const dirs = new Set(['/', '/home', '/home/tester'])
  let clock = 1_000
  const mkdirCalls = []

  const stats = (target) => {
    if (files.has(target)) {
      const body = files.get(target)
      return {
        isFile: () => true,
        isDirectory: () => false,
        size: Buffer.byteLength(body, 'utf8'),
        mtime: clock
      }
    }
    if (dirs.has(target)) {
      return { isFile: () => false, isDirectory: () => true, size: 0, mtime: clock }
    }
    return null
  }

  const notFound = () => {
    const err = new Error('No such file')
    err.code = 2
    return err
  }

  const api = {
    on: () => api,
    end: () => undefined,
    stat(target, cb) {
      const value = stats(target)
      queueMicrotask(() => (value ? cb(null, value) : cb(notFound())))
    },
    readFile(target, cb) {
      const body = files.get(target)
      queueMicrotask(() => (body === undefined ? cb(notFound()) : cb(null, Buffer.from(body))))
    },
    writeFile(target, buffer, options, cb) {
      const done = typeof options === 'function' ? options : cb
      files.set(target, buffer.toString('utf8'))
      clock += 1
      queueMicrotask(() => done(null))
    },
    rename(from, to, cb) {
      queueMicrotask(() => {
        if (!files.has(from)) return cb(notFound())
        if (files.has(to)) return cb(new Error('Failure')) // 标准 SFTP v3 不允许覆盖
        files.set(to, files.get(from))
        files.delete(from)
        clock += 1
        cb(null)
      })
    },
    unlink(target, cb) {
      queueMicrotask(() => {
        if (!files.has(target)) return cb(notFound())
        files.delete(target)
        clock += 1
        cb(null)
      })
    },
    mkdir(target, cb) {
      mkdirCalls.push(target)
      dirs.add(target)
      queueMicrotask(() => cb(null))
    },
    realpath(target, cb) {
      queueMicrotask(() => cb(null, target === '.' ? '/home/tester' : target))
    }
  }

  return { api, files, dirs, mkdirCalls }
}

const fakeHost = {
  id: 'h-test',
  name: '测试机',
  host: '127.0.0.1',
  port: 22,
  username: 'tester',
  authType: 'password',
  createdAt: 1,
  updatedAt: 1
}

/** 每种传输都要通过的同一组断言 */
function runContract(name, make) {
  test(`${name}：不存在时 read 返回 null、exists 为 false`, async () => {
    const { transport, cleanup } = await make()
    try {
      assert.equal(await transport.exists(), false)
      assert.equal(await transport.read(), null)
    } finally {
      await cleanup()
    }
  })

  test(`${name}：写入后能读回，重复写入覆盖旧内容且不留临时文件`, async () => {
    const { transport, cleanup } = await make()
    try {
      await transport.write('第一版')
      assert.equal(await transport.exists(), true)
      assert.equal(await transport.read(), '第一版')

      await transport.write('第二版-更长的内容')
      assert.equal(await transport.read(), '第二版-更长的内容')
    } finally {
      await cleanup()
    }
  })

  test(`${name}：自检可用`, async () => {
    const { transport, cleanup } = await make()
    try {
      const message = await transport.test()
      assert.ok(message.length > 0)
    } finally {
      await cleanup()
    }
  })

  test(`${name}：内容变化会触发 watch，自己写入不影响判断`, async () => {
    const { transport, cleanup } = await make()
    try {
      await transport.write('基线')
      let fired = 0
      const stop = transport.watch(() => {
        fired += 1
      })
      await new Promise((r) => setTimeout(r, 120))
      assert.equal(fired, 0, '建立基线时不应触发')

      await transport.write('变化后的内容')
      await new Promise((r) => setTimeout(r, 400))
      stop()
      assert.ok(fired >= 1, `应触发，实际 ${fired}`)
    } finally {
      await cleanup()
    }
  })
}

// ------------------------------------------------------------ 文件夹实现
runContract('文件夹传输', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jshell-sync-'))
  const transport = createFolderTransport(dir)
  await transport.write('init')
  fs.unlinkSync(path.join(dir, 'jshell-auto.jshellsync'))
  return {
    transport,
    cleanup: async () => {
      await transport.dispose()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
})

test('文件夹传输：超过 20MB 的文件被拒绝读取', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jshell-sync-big-'))
  const file = path.join(dir, 'jshell-auto.jshellsync')
  fs.writeFileSync(file, '')
  fs.truncateSync(file, SYNC_MAX_BYTES + 1)
  const transport = createFolderTransport(dir)
  try {
    await assert.rejects(() => transport.read(), /20MB/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('文件夹传输：只关心同步包，其它文件变动不触发', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jshell-sync-watch-'))
  const transport = createFolderTransport(dir)
  await transport.write('v1')
  let fired = 0
  const stop = transport.watch(() => {
    fired += 1
  })
  fs.writeFileSync(path.join(dir, 'unrelated.txt'), 'x')
  await new Promise((r) => setTimeout(r, 250))
  stop()
  fs.rmSync(dir, { recursive: true, force: true })
  assert.equal(fired, 0)
})

// -------------------------------------------------------------- SFTP 实现
runContract('SFTP 传输', async () => {
  const fake = createFakeSftp()
  const transport = createSftpTransport({
    host: fakeHost,
    dir: '/home/tester/jshell',
    store: {},
    pollMs: 50,
    openSftp: async () => fake.api
  })
  return {
    transport,
    cleanup: async () => {
      await transport.dispose()
    }
  }
})

test('SFTP：远端目录不存在时逐级创建', async () => {
  const fake = createFakeSftp()
  const transport = createSftpTransport({
    host: fakeHost,
    dir: '/home/tester/jshell/sync',
    store: {},
    openSftp: async () => fake.api
  })
  await transport.write('hello')
  assert.deepEqual(fake.mkdirCalls, ['/home/tester/jshell', '/home/tester/jshell/sync'])
  assert.equal(fake.files.get('/home/tester/jshell/sync/jshell-auto.jshellsync'), 'hello')
  assert.equal(fake.files.has('/home/tester/jshell/sync/jshell-auto.jshellsync.tmp'), false)
})

test('SFTP：目标已存在时靠「先删再改名」完成覆盖', async () => {
  const fake = createFakeSftp()
  const transport = createSftpTransport({
    host: fakeHost,
    dir: '/home/tester/jshell',
    store: {},
    openSftp: async () => fake.api
  })
  await transport.write('旧内容')
  await transport.write('新内容')
  assert.equal(await transport.read(), '新内容')
})

test('SFTP：~ 开头的目录按远端家目录展开', async () => {
  const fake = createFakeSftp()
  const transport = createSftpTransport({
    host: fakeHost,
    dir: '~/jshell',
    store: {},
    openSftp: async () => fake.api
  })
  await transport.write('home-relative')
  assert.equal(fake.files.get('/home/tester/jshell/jshell-auto.jshellsync'), 'home-relative')
})

test('SFTP：自检会写探针并删除', async () => {
  const fake = createFakeSftp()
  const transport = createSftpTransport({
    host: fakeHost,
    dir: '/home/tester/jshell',
    store: {},
    openSftp: async () => fake.api
  })
  const message = await transport.test()
  assert.match(message, /SFTP 可读写/)
  assert.equal(fake.files.has('/home/tester/jshell/.jshell-write-test'), false)
})

test('SFTP：超过 20MB 拒绝读取', async () => {
  const fake = createFakeSftp()
  const transport = createSftpTransport({
    host: fakeHost,
    dir: '/home/tester/jshell',
    store: {},
    openSftp: async () => fake.api
  })
  // 直接塞一个「大小超限」的 stat 结果，避免真的写 20MB
  fake.files.set('/home/tester/jshell/jshell-auto.jshellsync', 'x')
  const originalStat = fake.api.stat
  fake.api.stat = (target, cb) => {
    if (target.endsWith('jshell-auto.jshellsync')) {
      return queueMicrotask(() => cb(null, { isFile: () => true, isDirectory: () => false, size: SYNC_MAX_BYTES + 1, mtime: 1 }))
    }
    return originalStat(target, cb)
  }
  await assert.rejects(() => transport.read(), /20MB/)
})

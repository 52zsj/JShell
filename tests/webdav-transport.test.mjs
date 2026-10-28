import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createWebdavTransport, normalizeWebdavUrl } from '../src/main/services/webdav-transport.ts'

const USER = 'me'
const PASS = 'secret'

/** 极简 WebDAV：只实现我们用到的方法（HEAD/GET/PUT/MKCOL/DELETE） */
function startServer() {
  const files = new Map()
  const created = []
  const server = http.createServer((req, res) => {
    const auth = req.headers.authorization ?? ''
    const expected = `Basic ${Buffer.from(`${USER}:${PASS}`).toString('base64')}`
    if (auth !== expected) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="dav"' })
      res.end()
      return
    }
    const url = new URL(req.url, 'http://127.0.0.1')

    if (req.method === 'MKCOL') {
      created.push(url.pathname)
      res.writeHead(201)
      res.end()
      return
    }
    if (req.method === 'PUT') {
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8')
        files.set(url.pathname, body)
        res.writeHead(201, { ETag: `"${body.length}"` })
        res.end()
      })
      return
    }
    if (req.method === 'DELETE') {
      files.delete(url.pathname)
      res.writeHead(204)
      res.end()
      return
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      const body = files.get(url.pathname)
      if (body === undefined) {
        res.writeHead(404)
        res.end()
        return
      }
      res.writeHead(200, {
        ETag: `"${body.length}"`,
        'Content-Length': Buffer.byteLength(body, 'utf8'),
        'Content-Type': 'application/octet-stream'
      })
      res.end(req.method === 'HEAD' ? undefined : body)
      return
    }
    res.writeHead(405)
    res.end()
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      resolve({
        url: `http://127.0.0.1:${port}/dav/jshell`,
        files,
        created,
        close: () => new Promise((done) => server.close(done))
      })
    })
  })
}

test('地址规范化：只接受 https，回环地址允许 http，去掉尾斜杠', () => {
  assert.equal(normalizeWebdavUrl('https://dav.example.com/dav/jshell/'), 'https://dav.example.com/dav/jshell')
  assert.equal(normalizeWebdavUrl('  https://dav.example.com  '), 'https://dav.example.com')
  assert.equal(normalizeWebdavUrl('http://127.0.0.1:8080/dav'), 'http://127.0.0.1:8080/dav')
  assert.equal(normalizeWebdavUrl('http://localhost:8080/dav'), 'http://localhost:8080/dav')
  assert.throws(() => normalizeWebdavUrl('http://dav.example.com/x'), /https/)
  assert.throws(() => normalizeWebdavUrl('ftp://dav.example.com/x'), /http\(s\)/)
  assert.throws(() => normalizeWebdavUrl(''), /请填写/)
  assert.throws(() => normalizeWebdavUrl('not a url'), /格式不对/)
})

test('写入后能读回，未写入时 read 返回 null', async () => {
  const server = await startServer()
  try {
    const transport = createWebdavTransport({
      url: server.url,
      username: USER,
      password: PASS,
      pollMs: 60_000
    })
    assert.equal(await transport.exists(), false)
    assert.equal(await transport.read(), null)

    await transport.write('hello-dav')
    assert.equal(await transport.exists(), true)
    assert.equal(await transport.read(), 'hello-dav')
    assert.equal(server.files.get('/dav/jshell/jshell-auto.jshellsync'), 'hello-dav')
  } finally {
    await server.close()
  }
})

test('口令错误时给出明确提示', async () => {
  const server = await startServer()
  try {
    const transport = createWebdavTransport({
      url: server.url,
      username: USER,
      password: 'wrong',
      pollMs: 60_000
    })
    await assert.rejects(() => transport.read(), /认证失败/)
  } finally {
    await server.close()
  }
})

test('测试连接会建目录、写探针并清理', async () => {
  const server = await startServer()
  try {
    const transport = createWebdavTransport({
      url: server.url,
      username: USER,
      password: PASS,
      pollMs: 60_000
    })
    const message = await transport.test()
    assert.match(message, /WebDAV 可读写/)
    assert.ok(server.created.includes('/dav/jshell'))
    assert.equal(server.files.has('/dav/jshell/.jshell-write-test'), false)
  } finally {
    await server.close()
  }
})

test('远程内容变化会触发 watch 回调', async () => {
  const server = await startServer()
  try {
    const transport = createWebdavTransport({
      url: server.url,
      username: USER,
      password: PASS,
      pollMs: 50
    })
    await transport.write('v1')
    let fired = 0
    const stop = transport.watch(() => {
      fired += 1
    })
    // 等基线建立
    await new Promise((r) => setTimeout(r, 150))
    assert.equal(fired, 0)

    await transport.write('v2-different-length')
    await new Promise((r) => setTimeout(r, 300))
    stop()
    assert.ok(fired >= 1, `watch 应触发，实际 ${fired}`)
  } finally {
    await server.close()
  }
})

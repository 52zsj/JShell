import test from 'node:test'
import assert from 'node:assert/strict'
import { errorMessage, formatBytes, joinRemote, localCrumbs, localJoin, localParent, parentRemote, splitRemote } from '../src/renderer/src/utils.ts'

test('formatBytes 覆盖 B/KB/MB 与 0', () => {
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(512), '512 B')
  assert.equal(formatBytes(1536), '1.5 KB')
  assert.equal(formatBytes(1024 * 1024 * 3), '3.0 MB')
})

test('joinRemote 处理根目录与多余斜杠', () => {
  assert.equal(joinRemote('/', 'etc'), '/etc')
  assert.equal(joinRemote('/home/deploy/', 'app'), '/home/deploy/app')
})

test('parentRemote 处理根目录边界', () => {
  assert.equal(parentRemote('/'), '/')
  assert.equal(parentRemote('/home'), '/')
  assert.equal(parentRemote('/home/deploy'), '/home')
})

test('splitRemote 生成可点击面包屑', () => {
  assert.deepEqual(splitRemote('/home/deploy'), [
    { name: '/', path: '/' },
    { name: 'home', path: '/home' },
    { name: 'deploy', path: '/home/deploy' }
  ])
})


test('localJoin / localParent 兼容两个平台', () => {
  assert.equal(localJoin('/Users/jay', 'proj'), '/Users/jay/proj')
  assert.equal(localParent('/Users/jay/proj'), '/Users/jay')
  assert.equal(localJoin('C:\\Users', 'jay'), 'C:\\Users\\jay')
  assert.equal(localParent('C:\\Users\\jay'), 'C:\\Users')
})

test('localCrumbs 处理 POSIX 与 Windows 盘符', () => {
  assert.deepEqual(localCrumbs('/Users/jay').map((c) => c.name), ['/', 'Users', 'jay'])
  assert.deepEqual(localCrumbs('C:\\Users\\jay').map((c) => c.name), ['C:\\', 'Users', 'jay'])
})

test('errorMessage 去掉 Electron IPC 包装前缀', () => {
  assert.equal(
    errorMessage(new Error("Error invoking remote method 'sftp:read-text': Error: 该文件不是文本文件")),
    '该文件不是文本文件'
  )
  assert.equal(errorMessage(new Error('普通错误')), '普通错误')
  assert.equal(errorMessage('字符串错误'), '字符串错误')
})

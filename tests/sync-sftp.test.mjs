import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeRemoteDir } from '../src/main/services/sftp-transport.ts'

test('绝对路径去掉结尾斜杠并折叠重复分隔符', () => {
  assert.equal(normalizeRemoteDir('/srv/jshell/'), '/srv/jshell')
  assert.equal(normalizeRemoteDir('/srv//jshell'), '/srv/jshell')
  assert.equal(normalizeRemoteDir('  /srv/jshell  '), '/srv/jshell')
  assert.equal(normalizeRemoteDir('/'), '/')
})

test('支持 ~ 与 ~/xxx', () => {
  assert.equal(normalizeRemoteDir('~'), '~')
  assert.equal(normalizeRemoteDir('~/jshell'), '~/jshell')
  assert.equal(normalizeRemoteDir('~//jshell/'), '~/jshell')
  assert.equal(normalizeRemoteDir('~/'), '~')
})

test('相对路径被拒绝，避免落到服务器未知的当前目录', () => {
  assert.throws(() => normalizeRemoteDir('jshell'), /绝对路径/)
  assert.throws(() => normalizeRemoteDir('./jshell'), /绝对路径/)
})

test('空值被拒绝', () => {
  assert.throws(() => normalizeRemoteDir(''), /请填写远端目录/)
  assert.throws(() => normalizeRemoteDir('   '), /请填写远端目录/)
})

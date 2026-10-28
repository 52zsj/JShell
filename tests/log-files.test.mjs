import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  LOG_KEEP_DAYS,
  pruneOldLogs,
  rotateIfTooLarge
} from '../src/main/services/log-files.ts'

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jshell-log-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function writeWithAge(file, content, daysAgo) {
  fs.writeFileSync(file, content)
  const when = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000)
  fs.utimesSync(file, when, when)
}

test('清理：超过保留天数的日志被删，未过期的保留', (t) => {
  const dir = tempDir(t)
  writeWithAge(path.join(dir, 'jshell-2020-01-01.log'), 'old', LOG_KEEP_DAYS + 5)
  writeWithAge(path.join(dir, 'jshell-2099-01-01.log'), 'fresh', 0)

  const removed = pruneOldLogs(dir)

  assert.equal(removed, 1)
  assert.deepEqual(fs.readdirSync(dir).sort(), ['jshell-2099-01-01.log'])
})

test('清理：轮转出来的 .1 文件同样会被清理', (t) => {
  const dir = tempDir(t)
  writeWithAge(path.join(dir, 'jshell-2020-01-01.log.1'), 'old rotated', LOG_KEEP_DAYS + 1)
  writeWithAge(path.join(dir, 'jshell-2020-01-01.log'), 'old', LOG_KEEP_DAYS + 1)

  assert.equal(pruneOldLogs(dir), 2)
  assert.deepEqual(fs.readdirSync(dir), [])
})

test('清理：不碰非本应用的文件', (t) => {
  const dir = tempDir(t)
  writeWithAge(path.join(dir, 'notes.txt'), 'x', LOG_KEEP_DAYS + 100)
  writeWithAge(path.join(dir, 'jshell-backup.log'), 'x', LOG_KEEP_DAYS + 100)
  writeWithAge(path.join(dir, 'jshell-2020-01-01.txt'), 'x', LOG_KEEP_DAYS + 100)

  assert.equal(pruneOldLogs(dir), 0)
  assert.equal(fs.readdirSync(dir).length, 3)
})

test('清理：目录不存在时安静返回 0', () => {
  assert.equal(pruneOldLogs(path.join(os.tmpdir(), 'jshell-not-exist-dir-xyz')), 0)
})

test('轮转：超过上限改名为 .1，未超过保持原样', (t) => {
  const dir = tempDir(t)
  const file = path.join(dir, 'jshell-2099-01-01.log')

  fs.writeFileSync(file, 'small')
  assert.equal(rotateIfTooLarge(file, 16), false)
  assert.deepEqual(fs.readdirSync(dir), ['jshell-2099-01-01.log'])

  fs.writeFileSync(file, 'x'.repeat(32))
  assert.equal(rotateIfTooLarge(file, 16), true)
  assert.deepEqual(fs.readdirSync(dir).sort(), ['jshell-2099-01-01.log.1'])
  assert.equal(fs.readFileSync(`${file}.1`, 'utf8').length, 32)
})

test('轮转：连续两次超限只保留最近一份 .1', (t) => {
  const dir = tempDir(t)
  const file = path.join(dir, 'jshell-2099-01-01.log')

  fs.writeFileSync(file, 'a'.repeat(32))
  rotateIfTooLarge(file, 16)
  fs.writeFileSync(file, 'b'.repeat(32))
  rotateIfTooLarge(file, 16)

  // 轮转是「改名」而非「复制」：第二次轮转后当前日志又被搬走，只剩最新的 .1，
  // 下一行日志由 appendFileSync 重新创建
  assert.deepEqual(fs.readdirSync(dir).sort(), ['jshell-2099-01-01.log.1'])
  assert.equal(fs.readFileSync(`${file}.1`, 'utf8'), 'b'.repeat(32))
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/**
 * 回归保护：SSH 会话的「输出监听」必须先于「是否注入目录 hook」的分支注册。
 *
 * 0.5.4 曾在这里踩坑：关闭「目录树自动跟随」时提前 return，把 stream.on('data') /
 * stderr / close 三个监听也一起跳过，导致终端没有任何输出、也无法交互。
 * 这里通过源码顺序做一条廉价但有效的守卫。
 */
const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '../src/main/services/ssh-session.ts'), 'utf8')

test('ssh-session：数据 / stderr / close 监听先于 autoFollowCwd 分支注册', () => {
  const dataAt = source.indexOf("stream.on('data'")
  const stderrAt = source.indexOf("stream.stderr.on('data'")
  const closeAt = source.indexOf("stream.on('close'")
  const flagAt = source.indexOf('getSettings().autoFollowCwd')

  assert.ok(dataAt > 0, "未找到 stream.on('data')")
  assert.ok(stderrAt > 0, "未找到 stream.stderr.on('data')")
  assert.ok(closeAt > 0, "未找到 stream.on('close')")
  assert.ok(flagAt > 0, '未找到 autoFollowCwd 判断')

  assert.ok(dataAt < flagAt, "stream.on('data') 必须在 autoFollowCwd 判断之前")
  assert.ok(stderrAt < flagAt, "stream.stderr.on('data') 必须在 autoFollowCwd 判断之前")
  assert.ok(closeAt < flagAt, "stream.on('close') 必须在 autoFollowCwd 判断之前")
})

test('ssh-session：autoFollowCwd 分支内不得出现裸 return 提前退出 connect', () => {
  // 取 autoFollowCwd 判断到 connect 方法结束之间的一小段，确认没有 `return` 语句
  // （允许 setTimeout 回调里的 `if (this.closed) return`，那不会跳过监听注册）。
  const flagAt = source.indexOf('getSettings().autoFollowCwd')
  const window = source.slice(flagAt, flagAt + 400)
  const selfReturn = /if\s*\(\s*!\s*this\.deps\.store\.getSettings\(\)\.autoFollowCwd\s*\)\s*return/
  assert.equal(selfReturn.test(window), false, '关闭自动跟随时不能提前 return 跳过监听注册')
})

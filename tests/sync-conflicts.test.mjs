import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { buildMarks, findConflicts, summarizeConflicts } from '../src/main/services/sync-marks.ts'
import { cleanupLegacyBundles } from '../src/main/services/sync-legacy-files.ts'

const host = (id, name, updatedAt) => ({
  id,
  name,
  host: `${id}.example.com`,
  port: 22,
  username: 'ops',
  authType: 'agent',
  createdAt: 1,
  updatedAt
})

const snapshot = (hosts) => ({ hosts, snippets: [], tunnels: [], settings: {}, knownHosts: {} })

// ---------------------------------------------------------------- 冲突判定

test('只有单边改过：不算冲突（照常应用）', () => {
  const base = snapshot([host('h1', 'web', 100)])
  const marks = buildMarks(base)

  // 本机改了、云端没改
  const localOnly = snapshot([host('h1', 'web-renamed', 200)])
  assert.deepEqual(findConflicts(localOnly, { hosts: [host('h1', 'web', 100)] }, marks), [])

  // 云端改了、本机没改
  assert.deepEqual(findConflicts(base, { hosts: [host('h1', 'web-cloud', 300)] }, marks), [])
})

test('两边都改且不一样：判为冲突', () => {
  const base = snapshot([host('h1', 'web', 100)])
  const marks = buildMarks(base)
  const conflicts = findConflicts(
    snapshot([host('h1', 'web-local', 200)]),
    { hosts: [host('h1', 'web-cloud', 300)] },
    marks
  )
  assert.equal(conflicts.length, 1)
  assert.equal(conflicts[0].id, 'h1')
  assert.equal(conflicts[0].kind, 'hosts')
  assert.equal(conflicts[0].label, 'web-local')
})

test('两边改成一样：不算冲突', () => {
  const base = snapshot([host('h1', 'web', 100)])
  const marks = buildMarks(base)
  const same = snapshot([host('h1', 'web-new', 200)])
  assert.deepEqual(findConflicts(same, { hosts: [host('h1', 'web-new', 200)] }, marks), [])
})

test('没有基线（首次同步）时不拦任何东西', () => {
  const conflicts = findConflicts(
    snapshot([host('h1', 'web-local', 200)]),
    { hosts: [host('h1', 'web-cloud', 300)] },
    {}
  )
  assert.deepEqual(conflicts, [])
})

test('云端新增的条目不算冲突（本机没有 = 纯新增）', () => {
  const marks = buildMarks(snapshot([]))
  assert.deepEqual(findConflicts(snapshot([]), { hosts: [host('h9', 'new', 10)] }, marks), [])
})

test('冲突摘要只列前三个名字', () => {
  const marks = buildMarks(snapshot([host('a', 'a', 1), host('b', 'b', 1), host('c', 'c', 1), host('d', 'd', 1)]))
  const conflicts = findConflicts(
    snapshot([host('a', 'a2', 2), host('b', 'b2', 2), host('c', 'c2', 2), host('d', 'd2', 2)]),
    { hosts: [host('a', 'a3', 3), host('b', 'b3', 3), host('c', 'c3', 3), host('d', 'd3', 3)] },
    marks
  )
  const text = summarizeConflicts(conflicts)
  assert.ok(text.includes('等 4 项'), text)
  assert.ok(!text.includes('未做任何改动') === false)
})

// ---------------------------------------------------------------- 旧版多文件清理

test('清理旧版副本：只删 jshell-auto-<n>，保留本体与其它文件', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jshell-clean-'))
  const files = [
    'jshell-auto.jshellsync',
    'jshell-auto-2.jshellsync',
    'jshell-auto-37.jshellsync',
    'jshell-manual.jshellsync',
    'readme.txt'
  ]
  for (const name of files) fs.writeFileSync(path.join(dir, name), 'x')

  const removed = cleanupLegacyBundles(dir)
  assert.equal(removed, 2)
  const left = fs.readdirSync(dir).sort()
  assert.deepEqual(left, ['jshell-auto.jshellsync', 'jshell-manual.jshellsync', 'readme.txt'])
  fs.rmSync(dir, { recursive: true, force: true })
})

test('目录不存在时返回 0，不抛错', () => {
  assert.equal(cleanupLegacyBundles('/nonexistent/jshell/dir'), 0)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { acceptanceSequence, matchSuggestion } from '../src/renderer/src/snippet-suggest.ts'

const snippet = (id, { name = id, command, alias } = {}) => ({
  id,
  name,
  command,
  alias,
  createdAt: 0
})

test('输入触发词能匹配到对应命令', () => {
  const list = [snippet('s1', { command: 'git push', alias: 'gps' })]
  const hit = matchSuggestion(list, 'gps')
  assert.ok(hit)
  assert.equal(hit.full, 'git push')
  assert.equal(hit.typed, 'gps')
})

test('触发词前缀也会命中（输入到一半）', () => {
  const list = [snippet('s1', { command: 'git push', alias: 'gps' })]
  const hit = matchSuggestion(list, 'gp')
  assert.ok(hit)
  assert.equal(hit.full, 'git push')
})

test('触发词后多打的字符会保留在命令后面', () => {
  const list = [snippet('s1', { command: 'git push', alias: 'gps' })]
  const hit = matchSuggestion(list, 'gps --force')
  assert.ok(hit)
  assert.equal(hit.full, 'git push --force')
})

test('没有触发词时，命令前缀也能补全', () => {
  const list = [snippet('s1', { command: 'docker compose ps' })]
  const hit = matchSuggestion(list, 'docker comp')
  assert.ok(hit)
  assert.equal(hit.full, 'docker compose ps')
})

test('输入完整命令时不再提示', () => {
  const list = [snippet('s1', { command: 'git push' })]
  assert.equal(matchSuggestion(list, 'git push'), null)
})

test('多个触发词时取更长的那个', () => {
  const list = [
    snippet('s1', { command: 'git status', alias: 'g' }),
    snippet('s2', { command: 'git push', alias: 'gps' })
  ]
  const hit = matchSuggestion(list, 'gps')
  assert.ok(hit)
  assert.equal(hit.full, 'git push')
})

test('触发词命中优先于命令前缀命中', () => {
  const list = [
    snippet('s1', { command: 'git status' }),
    snippet('s2', { command: 'git push --force', alias: 'gps' })
  ]
  const hit = matchSuggestion(list, 'gps')
  assert.ok(hit)
  assert.equal(hit.full, 'git push --force')
})

test('空输入不匹配', () => {
  assert.equal(matchSuggestion([snippet('s1', { command: 'ls' })], ''), null)
  assert.equal(matchSuggestion([snippet('s1', { command: 'ls' })], '   '), null)
})

test('接受补全时先退格删掉已输入的内容，再写补全后的整行', () => {
  const list = [snippet('s1', { command: 'git push', alias: 'gps' })]
  const hit = matchSuggestion(list, 'gps')
  assert.ok(hit)
  assert.equal(acceptanceSequence(hit), '\u007f\u007f\u007fgit push')
})

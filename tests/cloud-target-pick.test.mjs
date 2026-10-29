import test from 'node:test'
import assert from 'node:assert/strict'
import { pickDefaultTarget } from '../src/shared/sync.ts'

const target = (id, mtimeMs) => ({
  id,
  label: id,
  dir: `/tmp/${id}`,
  kind: 'other',
  mtimeMs
})

test('没有检测到任何网盘时返回 undefined', () => {
  assert.equal(pickDefaultTarget([]), undefined)
})

test('只检测到一个时直接选中它', () => {
  const only = target('dropbox', 0)
  assert.equal(pickDefaultTarget([only]), only)
})

test('上次用过的仍然存在时优先用它', () => {
  const old = target('dropbox', 100)
  const recent = target('onedrive', 999)
  assert.equal(pickDefaultTarget([old, recent], 'dropbox'), old)
})

test('上次用过的已不存在时退回按最近活动排序', () => {
  const old = target('dropbox', 100)
  const recent = target('onedrive', 999)
  assert.equal(pickDefaultTarget([old, recent], 'gone'), recent)
})

test('多个网盘且没有历史选择时取最近活动的', () => {
  const a = target('a', 10)
  const b = target('b', 50)
  const c = target('c', 30)
  assert.equal(pickDefaultTarget([a, b, c]), b)
})

test('所有网盘都没有活动信息时不乱猜，返回 undefined', () => {
  assert.equal(pickDefaultTarget([target('a', 0), target('b', 0)]), undefined)
})

test('缺少 mtimeMs 的旧数据也能按有值的排序', () => {
  const noInfo = { id: 'x', label: 'x', dir: '/tmp/x', kind: 'other' }
  const withInfo = target('y', 500)
  assert.equal(pickDefaultTarget([noInfo, withInfo]), withInfo)
})

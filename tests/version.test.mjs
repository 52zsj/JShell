import test from 'node:test'
import assert from 'node:assert/strict'
import { compareVersions, isSafeReleaseUrl, parseVersion } from '../src/shared/version.ts'

test('按数值比较，而不是字符串字典序', () => {
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1)
  assert.equal(compareVersions('0.2.0', '0.2.0'), 0)
  assert.equal(compareVersions('0.2.1', '0.2.0'), 1)
  assert.equal(compareVersions('0.1.9', '0.2.0'), -1)
})

test('支持 v 前缀与不足三段的版本号', () => {
  assert.equal(compareVersions('v1.2', '1.2.0'), 0)
  assert.equal(compareVersions('1.2', '1.2.1'), -1)
})

test('正式版高于同号预发布版', () => {
  assert.equal(compareVersions('1.0.0', '1.0.0-beta.1'), 1)
  assert.equal(compareVersions('1.0.0-beta.1', '1.0.0'), -1)
  assert.equal(compareVersions('1.0.0-beta.2', '1.0.0-beta.1'), 1)
  assert.equal(compareVersions('1.0.0-beta.10', '1.0.0-beta.9'), 1)
  assert.equal(compareVersions('1.0.0-beta', '1.0.0-beta.1'), -1)
})

test('非法片段按 0 处理，不抛异常', () => {
  assert.deepEqual(parseVersion('1.x.3'), { core: [1, 0, 3], pre: '' })
  assert.equal(compareVersions('', '0.0.0'), 0)
})

test('更新链接只允许 https', () => {
  assert.equal(isSafeReleaseUrl('https://dl.example.com/jshell/latest.json'), true)
  assert.equal(isSafeReleaseUrl('http://dl.example.com/latest.json'), false)
  assert.equal(isSafeReleaseUrl('file:///etc/passwd'), false)
  assert.equal(isSafeReleaseUrl('javascript:alert(1)'), false)
  assert.equal(isSafeReleaseUrl(''), false)
})

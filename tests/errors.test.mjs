import test from 'node:test'
import assert from 'node:assert/strict'
import { mapErrorToChinese } from '../src/shared/errors.ts'

test('按 errno 映射', () => {
  assert.equal(mapErrorToChinese(Object.assign(new Error('x'), { code: 'ENOENT' })), '文件或目录不存在')
  assert.equal(mapErrorToChinese(Object.assign(new Error('x'), { code: 'EACCES' })), '没有访问权限')
})

test('ssh2 常见错误映射', () => {
  assert.match(mapErrorToChinese(new Error('All configured authentication methods failed')), /认证失败/)
  assert.match(mapErrorToChinese(new Error('Host key verification failed')), /指纹/)
  assert.match(mapErrorToChinese(new Error('Encrypted private key detected')), /口令/)
})

test('未知英文错误回落为中文提示，不泄露原文', () => {
  const text = mapErrorToChinese(new Error('weird internal failure'))
  assert.match(text, /操作失败/)
  assert.equal(text.includes('weird'), false)
})

test('已经是中文的错误原样返回', () => {
  assert.equal(mapErrorToChinese(new Error('主机不存在')), '主机不存在')
})

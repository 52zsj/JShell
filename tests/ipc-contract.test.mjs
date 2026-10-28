import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { IPC } from '../src/shared/ipc.ts'

/**
 * IPC 通道接线检查。
 *
 * 通道常量、主进程注册/推送、preload 暴露/订阅是三个必须同步的地方——
 * 少一处不会编译报错，只会在运行时「点了没反应」。这里用静态检查把这类疏漏挡住。
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function readTree(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...readTree(full))
    else if (entry.name.endsWith('.ts')) out.push(fs.readFileSync(full, 'utf8'))
  }
  return out
}

const mainAll = readTree(path.join(root, 'src/main')).join('\n')
const ipcSource = fs.readFileSync(path.join(root, 'src/main/ipc.ts'), 'utf8')
const preloadSource = fs.readFileSync(path.join(root, 'src/preload/index.ts'), 'utf8')

const entries = Object.entries(IPC)

/** 主进程主动推送的通道（不需要 handler 注册，但必须真的 send 过） */
const pushed = (key) => mainAll.includes(`send(IPC.${key}`)

test('通道值不重复', () => {
  const values = entries.map(([, value]) => value)
  assert.equal(new Set(values).size, values.length, '存在重复的通道字符串')
})

test('每个通道名符合 <域>:<动作> 约定', () => {
  for (const [key, value] of entries) {
    assert.match(value, /^[a-z-]+:[a-z-]+$/, `${key} = ${value}`)
  }
})

test('每个通道都在主进程被引用（注册或推送）', () => {
  const missing = entries
    .filter(([key]) => !ipcSource.includes(`IPC.${key}`) && !pushed(key))
    .map(([key, value]) => `${key} (${value})`)
  assert.deepEqual(missing, [], `主进程未引用的通道：${missing.join(', ')}`)
})

test('请求型通道都在 ipc.ts 注册了 handler', () => {
  const missing = entries
    .filter(([key]) => !key.startsWith('evt'))
    .filter(([key]) => !pushed(key))
    .filter(([key]) => !ipcSource.includes(`IPC.${key}`))
    .map(([key, value]) => `${key} (${value})`)
  assert.deepEqual(missing, [], `未注册的请求通道：${missing.join(', ')}`)
})

test('所有通道都在 preload 暴露或订阅', () => {
  const missing = entries
    .filter(([key]) => !preloadSource.includes(`IPC.${key}`))
    .map(([key, value]) => `${key} (${value})`)
  assert.deepEqual(missing, [], `preload 未引用的通道：${missing.join(', ')}`)
})

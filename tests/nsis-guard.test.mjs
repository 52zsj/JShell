import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * NSIS 片段守卫。
 *
 * 真实踩过的坑：`build/installer.nsh` 里写了中文 `DetailPrint`，
 * makensis 在 codepage 1252 下转换失败并断言退出（strlist.cpp:131），
 * 导致 Windows 打包整个失败——而 macOS 上开发完全无感。
 *
 * 所以这里强制该文件只能是 ASCII：注释一律用英文。
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const nshPath = path.join(root, 'build/installer.nsh')

test('installer.nsh 只能是 ASCII（含中文会让 makensis 断言失败）', () => {
  const raw = fs.readFileSync(nshPath)
  const offenders = []
  let line = 1
  for (let i = 0; i < raw.length; i++) {
    const byte = raw[i]
    if (byte === 0x0a) {
      line++
      continue
    }
    if (byte > 0x7f) {
      offenders.push({ line, byte: '0x' + byte.toString(16) })
      if (offenders.length >= 3) break
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `build/installer.nsh 含非 ASCII 字节（第 ${offenders.map((o) => o.line).join('/')} 行），请改成英文注释/字符串`
  )
})

test('installer.nsh 不使用未定义的 NSIS 常量', () => {
  const source = fs.readFileSync(nshPath, 'utf8')
  // $COMMONPROGRAMS 这类常量并不存在（electron-builder 模板用的是 $SMPROGRAMS），
  // 写了只会得到 warning 6000，但容易让人误以为清理生效了
  assert.equal(
    /\$COMMONPROGRAMS/.test(source),
    false,
    'installer.nsh 使用了不存在的 $COMMONPROGRAMS，开始菜单应使用 $SMPROGRAMS'
  )
})

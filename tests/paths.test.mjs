import test from 'node:test'
import assert from 'node:assert/strict'
import { cleanDisplayPath, expandUserPath } from '../src/shared/paths.ts'

const mac = { home: '/Users/jay', platform: 'darwin', env: {} }
const win = {
  home: 'C:\\Users\\Jay',
  platform: 'win32',
  env: { USERPROFILE: 'C:\\Users\\Jay', HOMEDRIVE: 'C:' }
}

test('macOS：展开 ~ 与 ~/xxx', () => {
  assert.equal(expandUserPath('~', mac), '/Users/jay')
  assert.equal(expandUserPath('~/.ssh/id_ed25519', mac), '/Users/jay/.ssh/id_ed25519')
})

test('macOS：保留合法文件名里的反斜杠，不做分隔符转换', () => {
  assert.equal(expandUserPath('~/keys/a\\b.pem', mac), '/Users/jay/keys/a\\b.pem')
})

test('Windows：展开 ~ 为反斜杠路径', () => {
  assert.equal(expandUserPath('~/keys/id_ed25519', win), 'C:\\Users\\Jay\\keys\\id_ed25519')
  assert.equal(expandUserPath('~', win), 'C:\\Users\\Jay')
})

test('Windows：支持 %USERPROFILE% 且大小写不敏感', () => {
  assert.equal(
    expandUserPath('%USERPROFILE%\\.ssh\\id_ed25519', win),
    'C:\\Users\\Jay\\.ssh\\id_ed25519'
  )
  assert.equal(
    expandUserPath('%userprofile%\\keys\\a.pem', win),
    'C:\\Users\\Jay\\keys\\a.pem'
  )
})

test('Windows：混合分隔符统一为反斜杠', () => {
  assert.equal(expandUserPath('C:/Users/Jay/keys/a.pem', win), 'C:\\Users\\Jay\\keys\\a.pem')
})

test('未知环境变量保持原样，不静默变成空路径', () => {
  assert.equal(expandUserPath('%NOPE%\\a.pem', win), '%NOPE%\\a.pem')
})

test('空输入返回空串（避免误把空路径当成主目录）', () => {
  assert.equal(expandUserPath('', mac), '')
  assert.equal(expandUserPath('   ', win), '')
})

test('cleanDisplayPath：两平台都不留重复/结尾分隔符', () => {
  assert.equal(cleanDisplayPath('/Users/jay/data/', 'darwin'), '/Users/jay/data')
  assert.equal(cleanDisplayPath('/Users//jay', 'darwin'), '/Users/jay')
  assert.equal(cleanDisplayPath('C:\\Users\\Jay\\data\\', 'win32'), 'C:\\Users\\Jay\\data')
  assert.equal(cleanDisplayPath('C:\\Users\\\\Jay', 'win32'), 'C:\\Users\\Jay')
})

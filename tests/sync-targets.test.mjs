import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  detectSyncTargets,
  ensureSyncFolder,
  resolveTargetDir,
  syncFolderPath
} from '../src/main/services/sync-targets.ts'

function tempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jshell-home-'))
  return dir
}

test('没有任何云盘时返回空列表，不影响其它落地方式', () => {
  const home = tempHome()
  assert.deepEqual(detectSyncTargets({ home, platform: 'linux', env: {} }), [])
})

test('能同时发现多个云盘目录（不绑定单一服务）', () => {
  const home = tempHome()
  fs.mkdirSync(path.join(home, 'Dropbox'))
  fs.mkdirSync(path.join(home, 'Nutstore Files'))
  fs.mkdirSync(path.join(home, 'OneDrive'))
  fs.mkdirSync(path.join(home, 'Google Drive'))

  const targets = detectSyncTargets({ home, platform: 'linux', env: {} })
  const kinds = targets.map((item) => item.kind).sort()
  assert.deepEqual(kinds, ['dropbox', 'gdrive', 'nutstore', 'onedrive'])
  for (const target of targets) {
    assert.equal(path.isAbsolute(target.dir), true)
    assert.ok(fs.existsSync(target.dir))
  }
})

test('同一目录被多个候选命中时只出现一次', () => {
  const home = tempHome()
  fs.mkdirSync(path.join(home, 'GoogleDrive'))
  const targets = detectSyncTargets({ home, platform: 'linux', env: {} })
  const gdrive = targets.filter((item) => item.kind === 'gdrive')
  assert.equal(gdrive.length, 1)
})

test('macOS 的 CloudStorage 目录按前缀识别账号', () => {
  const home = tempHome()
  const root = path.join(home, 'Library', 'CloudStorage')
  fs.mkdirSync(path.join(root, 'OneDrive-公司账号'), { recursive: true })
  fs.mkdirSync(path.join(root, 'Dropbox'), { recursive: true })
  fs.mkdirSync(path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs'), {
    recursive: true
  })

  const targets = detectSyncTargets({ home, platform: 'darwin', env: {} })
  const kinds = targets.map((item) => item.kind)
  assert.ok(kinds.includes('icloud'))
  assert.ok(kinds.includes('onedrive'))
  assert.ok(kinds.includes('dropbox'))
})

test('Windows 上的 OneDrive 环境变量优先于默认目录', () => {
  const home = tempHome()
  const custom = path.join(home, 'D 盘同步', 'OneDrive')
  fs.mkdirSync(custom, { recursive: true })
  const targets = detectSyncTargets({ home, platform: 'win32', env: { OneDrive: custom } })
  assert.equal(targets.find((item) => item.kind === 'onedrive').dir, path.resolve(custom))
})

test('未知 targetId 直接拒绝，渲染层无法借 id 读写任意路径', () => {
  const home = tempHome()
  fs.mkdirSync(path.join(home, 'Dropbox'))
  const targets = detectSyncTargets({ home, platform: 'linux', env: {} })
  assert.throws(() => resolveTargetDir(targets, '../../etc'), /未知的同步位置/)
  assert.equal(resolveTargetDir(targets, targets[0].id), path.resolve(path.join(home, 'Dropbox')))
})

test('同步包固定落在 <云盘>/JShell 子目录', () => {
  const home = tempHome()
  fs.mkdirSync(path.join(home, 'Dropbox'))
  const [target] = detectSyncTargets({ home, platform: 'linux', env: {} })
  assert.equal(syncFolderPath(target.dir), path.join(target.dir, 'JShell'))
  const dir = ensureSyncFolder(target.dir)
  assert.ok(fs.existsSync(dir))
})

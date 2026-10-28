import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_SETTINGS } from '../src/shared/settings.ts'
import { diffBundle } from '../src/main/services/sync-diff.ts'

function local(overrides = {}) {
  return {
    hosts: [
      {
        id: 'h1',
        name: '本机主机',
        host: '10.0.0.1',
        port: 22,
        username: 'root',
        authType: 'password',
        group: '内网',
        createdAt: 100,
        updatedAt: 500
      }
    ],
    snippets: [{ id: 's1', name: '磁盘', command: 'df -h', createdAt: 100 }],
    settings: { ...DEFAULT_SETTINGS, theme: 'dark' },
    tunnels: [],
    knownHosts: { '10.0.0.1:22:ssh-ed25519': 'SHA256:local' },
    ...overrides
  }
}

const remoteHost = (overrides = {}) => ({
  id: 'h1',
  name: '同步包主机',
  host: '10.0.0.1',
  port: 22,
  username: 'root',
  authType: 'password',
  group: '内网',
  createdAt: 100,
  updatedAt: 200,
  ...overrides
})

test('本机没有的主机被识别为新增', () => {
  const report = diffBundle(local(), { hosts: [remoteHost({ id: 'h2' })] }, 'overwrite')
  const entry = report.entries.find((item) => item.id === 'h2')
  assert.equal(entry.action, 'add')
  assert.equal(report.counts.add, 1)
  assert.equal(report.risky.overwriteNewer, 0)
})

test('内容不同但本机更新：覆盖模式标记为风险项', () => {
  const report = diffBundle(local(), { hosts: [remoteHost()] }, 'overwrite')
  const entry = report.entries.find((item) => item.id === 'h1')
  assert.equal(entry.action, 'update')
  assert.equal(entry.localNewer, true)
  assert.equal(report.risky.overwriteNewer, 1)
})

test('合并模式下本机更新则视为无变化（不会被覆盖）', () => {
  const report = diffBundle(local(), { hosts: [remoteHost()] }, 'merge')
  const entry = report.entries.find((item) => item.id === 'h1')
  assert.equal(entry.action, 'same')
  assert.equal(report.risky.overwriteNewer, 0)
})

test('合并模式下远端更新才会覆盖', () => {
  const report = diffBundle(local(), { hosts: [remoteHost({ updatedAt: 900 })] }, 'merge')
  const entry = report.entries.find((item) => item.id === 'h1')
  assert.equal(entry.action, 'update')
  assert.equal(entry.localNewer, false)
})

test('内容完全相同不产生变更', () => {
  const same = remoteHost({ name: '本机主机', updatedAt: 500 })
  const report = diffBundle(local(), { hosts: [same] }, 'overwrite')
  assert.equal(report.counts.same, 1)
  assert.equal(report.counts.update, 0)
})

test('替换模式会列出本机独有的条目为删除', () => {
  const report = diffBundle(local(), { hosts: [remoteHost({ id: 'h2' })] }, 'replace')
  const deleted = report.entries.filter((item) => item.action === 'delete')
  assert.equal(deleted.length, 1)
  assert.equal(deleted[0].id, 'h1')
  assert.equal(report.risky.deleteLocal, 1)
  // 片段分区没出现在包里，就不该被算成删除
  assert.equal(report.entries.filter((item) => item.kind === 'snippet').length, 0)
})

test('覆盖模式不会删除本机独有的主机', () => {
  const report = diffBundle(local(), { hosts: [remoteHost({ id: 'h2' })] }, 'overwrite')
  assert.equal(report.counts.delete, 0)
  assert.equal(report.risky.deleteLocal, 0)
})

test('指纹冲突：合并保留本机，覆盖才改', () => {
  const payload = { knownHosts: { '10.0.0.1:22:ssh-ed25519': 'SHA256:remote' } }
  const merge = diffBundle(local(), payload, 'merge')
  assert.equal(merge.entries.find((item) => item.kind === 'knownHost').action, 'same')

  const overwrite = diffBundle(local(), payload, 'overwrite')
  assert.equal(overwrite.entries.find((item) => item.kind === 'knownHost').action, 'update')
})

test('设置变化只给一条汇总', () => {
  const report = diffBundle(local(), { settings: { theme: 'light' } }, 'overwrite')
  assert.equal(report.settingsChanged, true)
  const settingsEntries = report.entries.filter((item) => item.kind === 'settings')
  assert.equal(settingsEntries.length, 1)
  assert.equal(settingsEntries[0].action, 'update')
})

test('设置没变化时不产生条目', () => {
  const report = diffBundle(local(), { settings: { theme: 'dark' } }, 'overwrite')
  assert.equal(report.settingsChanged, false)
  assert.equal(report.entries.length, 0)
})

test('设备私有设置被忽略，不算变更', () => {
  const report = diffBundle(
    local(),
    { settings: { sidebarWidth: 999, localShell: '/bin/bash', hiddenLocalShells: ['/bin/x'] } },
    'overwrite'
  )
  assert.equal(report.settingsChanged, false)
})

test('空包不产生任何变更', () => {
  const report = diffBundle(local(), {}, 'overwrite')
  assert.equal(report.entries.length, 0)
  assert.deepEqual(report.counts, { add: 0, update: 0, delete: 0, same: 0 })
})

test('删除项排在最前面，其次是被覆盖的新改动', () => {
  const payload = {
    hosts: [remoteHost({ id: 'h2' }), remoteHost()],
    snippets: [{ id: 's9', name: '新片段', command: 'ls', createdAt: 1 }]
  }
  const report = diffBundle(local(), payload, 'replace')
  const actions = report.entries.map((item) => item.action)
  assert.equal(actions[0], 'delete')
  assert.equal(actions[1], 'update')
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_SETTINGS } from '../src/shared/settings.ts'
import { buildPreview, mergeBundle, pickPortableSettings } from '../src/main/services/sync-merge.ts'

const makeId = () => 'generated-id'

function local(overrides = {}) {
  return {
    hosts: [
      {
        id: 'h1',
        name: '本机 A',
        host: '10.0.0.1',
        port: 22,
        username: 'root',
        authType: 'password',
        createdAt: 100,
        updatedAt: 100
      }
    ],
    snippets: [{ id: 's1', name: '磁盘', command: 'df -h', createdAt: 100 }],
    settings: { ...DEFAULT_SETTINGS, theme: 'dark', sidebarWidth: 300, localShell: '/bin/zsh' },
    tunnels: [],
    knownHosts: {},
    ...overrides
  }
}

test('合并新增主机并保留稳定 id（跳板机关系依赖它）', () => {
  const remote = {
    hosts: [
      {
        id: 'h2',
        name: '跳板',
        host: '10.0.0.2',
        port: 22,
        username: 'ops',
        authType: 'password',
        createdAt: 200,
        updatedAt: 200
      },
      {
        id: 'h3',
        name: '内网',
        host: '10.0.0.3',
        port: 2222,
        username: 'root',
        authType: 'key',
        privateKeyPath: '/keys/id_ed25519',
        proxyJump: 'h2',
        createdAt: 200,
        updatedAt: 200
      }
    ]
  }
  const outcome = mergeBundle(local(), remote, { mode: 'merge', makeId })
  assert.equal(outcome.stats.hosts, 2)
  const byId = new Map(outcome.next.hosts.map((h) => [h.id, h]))
  assert.equal(byId.get('h2').id, 'h2')
  assert.equal(byId.get('h3').proxyJump, 'h2')
  assert.equal(outcome.warnings.length, 0)
})

test('跳板机缺失时降级为直连并告警，不静默连错机器', () => {
  const remote = {
    hosts: [
      {
        id: 'h9',
        name: '孤立主机',
        host: '10.0.0.9',
        port: 22,
        username: 'root',
        authType: 'password',
        proxyJump: 'missing',
        createdAt: 1,
        updatedAt: 1
      }
    ]
  }
  const outcome = mergeBundle(local(), remote, { mode: 'merge', makeId })
  assert.equal(outcome.next.hosts.find((h) => h.id === 'h9').proxyJump, undefined)
  assert.match(outcome.warnings.join(), /跳板机不在本次同步范围内/)
})

test('同 id 冲突按 updatedAt 较新者胜，且保留本机 lastUsedAt', () => {
  const remote = {
    hosts: [
      {
        id: 'h1',
        name: '改名后',
        host: '10.0.0.1',
        port: 22,
        username: 'root',
        authType: 'password',
        createdAt: 100,
        updatedAt: 500
      }
    ]
  }
  const base = local()
  base.hosts[0].lastUsedAt = 999
  const outcome = mergeBundle(base, remote, { mode: 'merge', makeId })
  const hit = outcome.next.hosts.find((h) => h.id === 'h1')
  assert.equal(hit.name, '改名后')
  assert.equal(hit.lastUsedAt, 999)
  assert.equal(outcome.conflicts.hosts, 1)
  assert.equal(outcome.stats.hosts, 0)
})

test('远端较旧时不覆盖本机', () => {
  const remote = {
    hosts: [
      {
        id: 'h1',
        name: '旧名字',
        host: '10.0.0.1',
        port: 22,
        username: 'root',
        authType: 'password',
        createdAt: 50,
        updatedAt: 50
      }
    ]
  }
  const outcome = mergeBundle(local(), remote, { mode: 'merge', makeId })
  assert.equal(outcome.next.hosts.find((h) => h.id === 'h1').name, '本机 A')
  assert.equal(outcome.conflicts.hosts, 0)
})

test('片段按 id 更新，同命令不重复堆积', () => {
  const remote = {
    snippets: [
      { id: 's1', name: '磁盘占用', command: 'df -h', createdAt: 100 },
      { name: '内存', command: 'free -m' },
      { name: '重复命令', command: 'df -h' }
    ]
  }
  const outcome = mergeBundle(local(), remote, { mode: 'merge', makeId })
  const commands = outcome.next.snippets.map((s) => s.command)
  assert.deepEqual(commands, ['df -h', 'free -m'])
  assert.equal(outcome.next.snippets[0].name, '磁盘占用')
  assert.equal(outcome.stats.snippets, 1)
})

test('端口转发导入时清空会话绑定', () => {
  const remote = {
    tunnels: [
      {
        id: 't1',
        sessionId: 'session-on-other-machine',
        kind: 'local',
        bindHost: '127.0.0.1',
        bindPort: 8080,
        destHost: '127.0.0.1',
        destPort: 80,
        enabled: true
      }
    ]
  }
  const outcome = mergeBundle(local(), remote, { mode: 'merge', makeId })
  assert.equal(outcome.next.tunnels[0].sessionId, undefined)
  assert.equal(outcome.stats.tunnels, 1)
})

test('指纹冲突保留本机记录并给出告警', () => {
  const base = local({ knownHosts: { '10.0.0.1:22:ssh-ed25519': 'SHA256:local' } })
  const remote = {
    knownHosts: {
      '10.0.0.1:22:ssh-ed25519': 'SHA256:remote',
      '10.0.0.2:22:ssh-ed25519': 'SHA256:new'
    }
  }
  const outcome = mergeBundle(base, remote, { mode: 'merge', makeId })
  assert.equal(outcome.next.knownHosts['10.0.0.1:22:ssh-ed25519'], 'SHA256:local')
  assert.equal(outcome.next.knownHosts['10.0.0.2:22:ssh-ed25519'], 'SHA256:new')
  assert.equal(outcome.stats.knownHosts, 1)
  assert.match(outcome.warnings.join(), /主机指纹与本地记录不一致/)
})

test('设置合并不覆盖设备私有字段', () => {
  const base = local()
  base.settings.hiddenLocalShells = ['/bin/fish']
  const remote = {
    settings: {
      theme: 'light',
      fontSize: 15,
      sidebarWidth: 500,
      localShell: '/bin/bash',
      hiddenLocalShells: ['/bin/bash'],
      launchAtLogin: true
    }
  }
  const outcome = mergeBundle(base, remote, { mode: 'merge', makeId })
  assert.equal(outcome.next.settings.theme, 'light')
  assert.equal(outcome.next.settings.fontSize, 15)
  // 设备私有：始终以本机为准
  assert.equal(outcome.next.settings.sidebarWidth, 300)
  assert.equal(outcome.next.settings.localShell, '/bin/zsh')
  assert.deepEqual(outcome.next.settings.hiddenLocalShells, ['/bin/fish'])
  assert.equal(outcome.next.settings.launchAtLogin, false)
  assert.equal(outcome.stats.settings, true)
})

test('替换模式按包内容整体替换，未包含的分区保留本机', () => {
  const base = local()
  base.settings.sidebarWidth = 280
  const remote = {
    hosts: [
      {
        id: 'h5',
        name: '另一台',
        host: '10.0.0.5',
        port: 22,
        username: 'root',
        authType: 'password',
        createdAt: 1,
        updatedAt: 1
      }
    ]
  }
  const outcome = mergeBundle(base, remote, { mode: 'replace', makeId })
  assert.deepEqual(outcome.next.hosts.map((h) => h.id), ['h5'])
  // 包里没带片段 → 保留本机
  assert.deepEqual(outcome.next.snippets.map((s) => s.id), ['s1'])
  assert.equal(outcome.next.settings.sidebarWidth, 280)
})

test('格式不完整的主机被跳过并计入告警', () => {
  const remote = {
    hosts: [
      { id: 'bad1', name: '没有地址', port: 22, username: 'root' },
      { id: 'bad2', host: '1.1.1.1', port: 22 },
      {
        id: 'ok',
        host: '1.1.1.2',
        port: 70000,
        username: 'root',
        authType: 'password',
        createdAt: 1,
        updatedAt: 1
      }
    ]
  }
  const outcome = mergeBundle(local(), remote, { mode: 'merge', makeId })
  assert.equal(outcome.stats.hosts, 0)
  assert.match(outcome.warnings.join(), /跳过 3 条格式不完整的主机记录/)
})

test('凭据只保留本次真正导入的主机', () => {
  const remote = {
    hosts: [
      {
        id: 'h7',
        name: '有密码',
        host: '10.0.0.7',
        port: 22,
        username: 'root',
        authType: 'password',
        createdAt: 1,
        updatedAt: 1
      }
    ],
    credentials: {
      h7: { password: 'secret' },
      ghost: { password: 'should-be-dropped' }
    }
  }
  const outcome = mergeBundle(local(), remote, { mode: 'merge', makeId })
  assert.deepEqual(Object.keys(outcome.credentials), ['h7'])
  assert.equal(outcome.credentials.h7.password, 'secret')
})

test('预览包含主机清单与冲突计数', () => {
  const remote = {
    hosts: [
      {
        id: 'h1',
        name: '改名后',
        host: '10.0.0.1',
        port: 22,
        username: 'root',
        authType: 'password',
        createdAt: 100,
        updatedAt: 900
      }
    ],
    snippets: [{ id: 's1', name: 'x', command: 'ls', createdAt: 1 }],
    knownHosts: { a: 'b' }
  }
  const outcome = mergeBundle(local(), remote, { mode: 'merge', makeId })
  const preview = buildPreview(remote, outcome)
  assert.equal(preview.hosts[0].name, '改名后')
  assert.equal(preview.snippets, 1)
  assert.equal(preview.knownHosts, 1)
  assert.equal(preview.conflicts.hosts, 1)
})

test('导出设置时剔除设备私有字段', () => {
  const portable = pickPortableSettings({ ...DEFAULT_SETTINGS, theme: 'light', sidebarWidth: 320 })
  assert.equal(portable.theme, 'light')
  assert.equal('sidebarWidth' in portable, false)
  assert.equal('localShell' in portable, false)
  assert.equal('hiddenLocalShells' in portable, false)
  assert.equal('launchAtLogin' in portable, false)
})

test('覆盖模式：即便远端更旧也照盖，但保留本机 lastUsedAt', () => {
  const base = local()
  base.hosts[0].lastUsedAt = 777
  const remote = {
    hosts: [
      {
        id: 'h1',
        name: '同步包里的旧名字',
        host: '10.0.0.1',
        port: 22,
        username: 'root',
        authType: 'password',
        createdAt: 1,
        updatedAt: 1
      }
    ]
  }
  const outcome = mergeBundle(base, remote, { mode: 'overwrite', makeId })
  const hit = outcome.next.hosts.find((h) => h.id === 'h1')
  assert.equal(hit.name, '同步包里的旧名字')
  assert.equal(hit.lastUsedAt, 777)
  assert.equal(outcome.stats.hosts, 0)
})

test('覆盖模式：本机独有的主机不会被删掉', () => {
  const remote = {
    hosts: [
      {
        id: 'h2',
        name: '新增',
        host: '10.0.0.2',
        port: 22,
        username: 'root',
        authType: 'password',
        createdAt: 1,
        updatedAt: 1
      }
    ]
  }
  const outcome = mergeBundle(local(), remote, { mode: 'overwrite', makeId })
  assert.deepEqual(outcome.next.hosts.map((h) => h.id).sort(), ['h1', 'h2'])
})

test('覆盖模式：指纹也按远端覆盖，并给出提示', () => {
  const base = local({ knownHosts: { '10.0.0.1:22:ssh-ed25519': 'SHA256:local' } })
  const remote = { knownHosts: { '10.0.0.1:22:ssh-ed25519': 'SHA256:remote' } }
  const outcome = mergeBundle(base, remote, { mode: 'overwrite', makeId })
  assert.equal(outcome.next.knownHosts['10.0.0.1:22:ssh-ed25519'], 'SHA256:remote')
  assert.match(outcome.warnings.join(), /已被同步包覆盖/)
})

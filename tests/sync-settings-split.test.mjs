import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_SETTINGS } from '../src/shared/settings.ts'
import {
  DEVICE_LOCAL_SETTINGS,
  SYNCABLE_SETTINGS
} from '../src/shared/sync.ts'
import { mergeBundle, pickPortableSettings } from '../src/main/services/sync-merge.ts'

/** 本机快照：本机独有的值与通用值都设成"非默认"，便于判断谁被改写 */
function localSnapshot() {
  return {
    hosts: [],
    snippets: [],
    tunnels: [],
    knownHosts: {},
    settings: {
      ...DEFAULT_SETTINGS,
      theme: 'dark',
      fontSize: 13,
      closeToTray: false,
      sidebarWidth: 300,
      localShell: '/bin/zsh',
      hiddenLocalShells: ['/bin/fish'],
      launchAtLogin: true,
      startMinimized: true
    }
  }
}

// ---------------------------------------------------------------- 分类本身

test('可同步项与本机项互不重叠，且覆盖全部已知设置', () => {
  const portable = Object.keys(SYNCABLE_SETTINGS)
  const local = [...DEVICE_LOCAL_SETTINGS]
  const overlap = portable.filter((key) => local.includes(key))
  assert.deepEqual(overlap, [], `同时出现在两边：${overlap.join(',')}`)

  const known = new Set([...portable, ...local])
  const missing = Object.keys(DEFAULT_SETTINGS).filter((key) => !known.has(key))
  assert.deepEqual(missing, [], `没有分类的设置项：${missing.join(',')}`)
})

// ---------------------------------------------------------------- 导出裁剪

test('导出时只带白名单字段：本机项与未知字段都被丢掉', () => {
  const portable = pickPortableSettings({
    theme: 'light',
    fontSize: 15,
    sidebarWidth: 999,
    localShell: '/bin/bash',
    hiddenLocalShells: ['/bin/ksh'],
    launchAtLogin: false,
    startMinimized: false,
    someFutureSetting: 'oops'
  })
  assert.equal(portable.theme, 'light')
  assert.equal(portable.fontSize, 15)
  for (const key of DEVICE_LOCAL_SETTINGS) {
    assert.equal(key in portable, false, `${key} 不该出现在导出结果里`)
  }
  assert.equal('someFutureSetting' in portable, false)
})

// ---------------------------------------------------------------- 合并

test('导入时本机独有的设置原样保留，通用设置才被更新', () => {
  const local = localSnapshot()
  const outcome = mergeBundle(
    local,
    {
      settings: {
        theme: 'light',
        fontSize: 16,
        // 恶意/异常包试图改本机配置：必须无效
        sidebarWidth: 1024,
        localShell: 'C:\\Windows\\System32\\cmd.exe',
        hiddenLocalShells: [],
        launchAtLogin: false,
        startMinimized: false
      }
    },
    { mode: 'overwrite' }
  )

  assert.equal(outcome.next.settings.theme, 'light')
  assert.equal(outcome.next.settings.fontSize, 16)

  assert.equal(outcome.next.settings.sidebarWidth, 300)
  assert.equal(outcome.next.settings.localShell, '/bin/zsh')
  assert.deepEqual(outcome.next.settings.hiddenLocalShells, ['/bin/fish'])
  assert.equal(outcome.next.settings.launchAtLogin, true)
  assert.equal(outcome.next.settings.startMinimized, true)
})

test('未知字段不会混进设置对象', () => {
  const outcome = mergeBundle(
    localSnapshot(),
    { settings: { theme: 'light', evilField: 'x' } },
    { mode: 'overwrite' }
  )
  assert.equal('evilField' in outcome.next.settings, false)
})

test('包里的设置只含本机项时，等于什么都没改', () => {
  const local = localSnapshot()
  const outcome = mergeBundle(
    local,
    { settings: { sidebarWidth: 1024, localShell: 'x', launchAtLogin: false } },
    { mode: 'overwrite' }
  )
  assert.deepEqual(outcome.next.settings, local.settings)
})

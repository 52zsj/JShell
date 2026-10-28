/**
 * 启动耗时基准（开发用）。
 *
 * 阶段拆解：
 *   T1 进程启动 → CDP 可连接        （Chromium/Electron 引导）
 *   T2 → 页面 DOMContentLoaded       （HTML/CSS/JS 解析）
 *   T3 → 应用可交互（.app 渲染完成）  （首屏渲染 + store.bootstrap 首轮 IPC）
 *
 * 每个阶段都取多次运行的中位数，减少系统噪声影响。
 *
 * 用法：
 *   npm run build && node scripts/measure-startup.mjs [--runs=5]
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const ROOT = path.resolve(import.meta.dirname, '..')
const RUNS = Number(process.argv.find((a) => a.startsWith('--runs='))?.split('=')[1] ?? 5)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const median = (arr) => {
  const s = [...arr].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

async function openSocket(url) {
  const ws = new WebSocket(url)
  let nextId = 1
  const pending = new Map()
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m.result)
      pending.delete(m.id)
    }
  })
  await new Promise((r) => ws.addEventListener('open', r))
  return {
    send: (method, params = {}) =>
      new Promise((resolve) => {
        const id = nextId++
        pending.set(id, resolve)
        ws.send(JSON.stringify({ id, method, params }))
      }),
    close: () => ws.close()
  }
}

/** 单次启动测量 */
async function once(runIndex) {
  const port = 9400 + runIndex
  const profile = `/tmp/jshell-startup-${runIndex}`
  fs.rmSync(profile, { recursive: true, force: true })

  // --app=<path> 时测打包版；否则测开发构建
  const appPath = process.argv.find((a) => a.startsWith('--app='))?.split('=').slice(1).join('=')
  const electron = appPath
    ? path.join(appPath, 'Contents/MacOS/JShell')
    : path.join(ROOT, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
  const appArgs = appPath
    ? [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`]
    : [path.join(ROOT, 'out/main/index.js'), `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`]
  const t0 = performance.now()
  const child = spawn(
    electron,
    appArgs,
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, NODE_OPTIONS: undefined }, stdio: 'ignore' }
  )

  let cdpAt = 0
  let page
  for (let i = 0; i < 200; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
      const target = list.find((t) => t.type === 'page' && t.url.includes('index.html'))
      if (target) {
        cdpAt = performance.now()
        page = target
        break
      }
    } catch {
      /* 未就绪 */
    }
    await wait(50)
  }
  if (!page) {
    child.kill()
    throw new Error('启动超时：CDP 未就绪')
  }

  const tab = await openSocket(page.webSocketDebuggerUrl)
  await tab.send('Runtime.enable')

  // 等待应用可交互：.app 存在且侧边栏渲染出来
  let interactiveAt = 0
  for (let i = 0; i < 400; i++) {
    const r = await tab.send('Runtime.evaluate', {
      expression: `!!document.querySelector('.app') && !!document.querySelector('.sidebar')`,
      returnByValue: true
    })
    if (r.result?.value) {
      interactiveAt = performance.now()
      break
    }
    await wait(25)
  }

  const nav = await tab.send('Runtime.evaluate', {
    expression: `(() => {
      const n = performance.getEntriesByType('navigation')[0]
      if (!n) return null
      return {
        domContentLoaded: Math.round(n.domContentLoadedEventEnd),
        loadEnd: Math.round(n.loadEventEnd),
        responseEnd: Math.round(n.responseEnd)
      }
    })()`,
    returnByValue: true
  })

  await tab.send('Performance.enable')
  const { metrics } = await tab.send('Performance.getMetrics')
  const pick = (n) => metrics.find((x) => x.name === n)?.value ?? 0

  tab.close()
  child.kill()
  await wait(600)

  return {
    cdpMs: Math.round(cdpAt - t0),
    interactiveMs: Math.round(interactiveAt - t0),
    domContentLoadedMs: nav.result?.value?.domContentLoaded ?? null,
    loadEndMs: nav.result?.value?.loadEnd ?? null,
    taskMs: Math.round(pick('TaskDuration') * 1000),
    scriptMs: Math.round(pick('ScriptDuration') * 1000)
  }
}

async function main() {
  const runs = []
  for (let i = 0; i < RUNS; i++) {
    const r = await once(i)
    runs.push(r)
    console.log(
      `第 ${i + 1} 次：CDP ${r.cdpMs}ms | 可交互 ${r.interactiveMs}ms | DOMContentLoaded ${r.domContentLoadedMs}ms | 主线程任务 ${r.taskMs}ms`
    )
  }

  const pick = (k) => runs.map((r) => r[k]).filter((v) => typeof v === 'number')
  console.log('\n中位数：')
  console.log(`  Electron 引导（spawn → CDP）: ${median(pick('cdpMs'))}ms`)
  console.log(`  页面加载（DOMContentLoaded） : ${median(pick('domContentLoadedMs'))}ms`)
  console.log(`  可交互（.app 渲染完成）      : ${median(pick('interactiveMs'))}ms`)
  console.log(`  渲染线程主任务               : ${median(pick('taskMs'))}ms`)
  console.log(`  其中脚本执行                 : ${median(pick('scriptMs'))}ms`)
}

main().catch((err) => {
  console.error('测量失败：', err.message)
  process.exit(1)
})

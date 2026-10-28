/**
 * 内存测量脚本（开发用，可重复执行做前后对比）。
 *
 * 场景：
 *   1. baseline   —— 空载
 *   2. 6 terminals —— 点「本地终端」开 6 个标签，各灌 4 万行输出（填满 scrollback）
 *   3. closed     —— 全部关闭后（看是否回落到基线附近，判断有无泄漏）
 *
 * 指标：
 *   - RSS 总量（`ps` 汇总本 profile 下所有 Electron 进程）
 *   - 按类型拆分：main / renderer / gpu（CDP SystemInfo.getProcessInfo + ps）
 *   - 渲染进程 JS 堆、DOM 节点数、事件监听器数（CDP Performance.getMetrics）
 *
 * 用法：
 *   npm run build && node scripts/measure-memory.mjs
 */
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const PROFILE = '/tmp/jshell-mem-profile'
const PORT = 9333
const ROOT = path.resolve(import.meta.dirname, '..')
const TABS = Number(process.argv.find((a) => a.startsWith('--tabs='))?.split('=')[1] ?? 6)
const LINES = 40_000

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

function rssByPid() {
  const out = execFileSync('ps', ['-eo', 'pid=,rss=,command='], { encoding: 'utf8' })
  const map = new Map()
  let total = 0
  for (const line of out.split('\n')) {
    if (!line.includes(PROFILE) || line.includes('measure-memory')) continue
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (!m) continue
    const mb = Math.round(Number(m[2]) / 1024)
    map.set(Number(m[1]), mb)
    total += mb
  }
  return { map, total }
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

async function connect() {
  for (let i = 0; i < 60; i++) {
    try {
      const version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()
      const targetList = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
      const page = targetList.find((t) => t.type === 'page' && t.url.includes('index.html'))
      if (page && version.webSocketDebuggerUrl) {
        const browser = await openSocket(version.webSocketDebuggerUrl)
        const tab = await openSocket(page.webSocketDebuggerUrl)
        return { browser, tab }
      }
    } catch {
      /* 未就绪 */
    }
    await wait(500)
  }
  throw new Error('CDP 连接超时')
}

async function metrics({ browser, tab }) {
  await tab.send('Performance.enable')
  const { metrics: m } = await tab.send('Performance.getMetrics')
  const pick = (n) => m.find((x) => x.name === n)?.value ?? 0
  const { map, total } = rssByPid()

  let split = { main: 0, renderer: 0, gpu: 0, other: 0 }
  try {
    const { processInfo } = await browser.send('SystemInfo.getProcessInfo')
    for (const p of processInfo) {
      const kind =
        p.type === 'browser' ? 'main' : p.type === 'renderer' ? 'renderer' : p.type === 'GPU' ? 'gpu' : 'other'
      split[kind] += map.get(p.id) ?? 0
    }
  } catch {
    split = null
  }

  return {
    rss: total,
    split,
    procs: map.size,
    heapMb: +(pick('JSHeapUsedSize') / 1048576).toFixed(1),
    nodes: Math.round(pick('Nodes')),
    listeners: Math.round(pick('JSEventListeners'))
  }
}

async function sample(cdp, label, sink) {
  await wait(2000)
  const r = await metrics(cdp)
  sink.push({ label, ...r })
  return r
}


/** 轮询直到表达式为真（带超时），保证每一步都被真实执行 */
async function poll(cdp, expression, label, timeout = 15000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const r = await cdp.tab.send('Runtime.evaluate', { expression, returnByValue: true })
    if (r.result?.value) return
    await wait(250)
  }
  throw new Error(`等待超时：${label}`)
}

async function typeInto(cdp, text) {
  await cdp.tab.send('Input.insertText', { text })
  await wait(120)
  for (const type of ['keyDown', 'keyUp']) {
    await cdp.tab.send('Input.dispatchKeyEvent', {
      type,
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 36,
      text: type === 'keyDown' ? '\r' : undefined
    })
  }
  await wait(150)
}

function report(rows) {
  console.log(
    '\n' +
      '场景'.padEnd(24) +
      'RSS(MB)'.padStart(9) +
      'main'.padStart(7) +
      'render'.padStart(8) +
      'gpu'.padStart(6) +
      'JS堆'.padStart(7) +
      'DOM'.padStart(8) +
      '监听'.padStart(6)
  )
  console.log('-'.repeat(75))
  for (const r of rows) {
    console.log(
      r.label.padEnd(24) +
        String(r.rss).padStart(9) +
        String(r.split?.main ?? '-').padStart(7) +
        String(r.split?.renderer ?? '-').padStart(8) +
        String(r.split?.gpu ?? '-').padStart(6) +
        String(r.heapMb).padStart(7) +
        String(r.nodes).padStart(8) +
        String(r.listeners).padStart(6)
    )
  }
}

async function main() {
  fs.rmSync(PROFILE, { recursive: true, force: true })
  const electron = path.join(ROOT, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
  const child = spawn(
    electron,
    [path.join(ROOT, 'out/main/index.js'), `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`],
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, NODE_OPTIONS: undefined }, stdio: 'ignore' }
  )

  const rows = []
  let cdp
  try {
    cdp = await connect()
    await wait(3500)
    await sample(cdp, 'baseline 空载', rows)

    for (let i = 0; i < TABS; i++) {
      // 等终端实例数真的增加到 i+1 再继续，避免点击丢失
      await cdp.tab.send('Runtime.evaluate', {
        expression: `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '本地终端')?.click()`,
        userGesture: true
      })
      await poll(cdp, `document.querySelectorAll('.xterm').length >= ${i + 1}`, `第 ${i + 1} 个终端`)
      await cdp.tab.send('Runtime.evaluate', {
        expression: `document.querySelectorAll('.terminal-wrap .xterm-helper-textarea')[${i}]?.focus()`,
        userGesture: true
      })
      // 用唯一标记判断这条命令真的执行完了
      await typeInto(cdp, `seq 1 ${LINES}; echo DONE_${i}`)
      await poll(cdp, `document.body.innerText.includes('DONE_${i}')`, `第 ${i + 1} 个终端输出完成`, 60000)
    }
    await wait(3000)
    await sample(cdp, `${TABS} 个终端（各 ${LINES / 10000} 万行）`, rows)

    for (let i = 0; i < TABS; i++) {
      await cdp.tab.send('Runtime.evaluate', {
        expression: `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', metaKey: true, bubbles: true }))`
      })
      await wait(400)
    }
    await wait(2500)
    const left = await cdp.tab
      .send('Runtime.evaluate', {
        expression: `document.querySelectorAll('.xterm').length`,
        returnByValue: true
      })
      .then((r) => r.result?.value)
    await sample(cdp, `全部关闭（残留 ${left}）`, rows)

    report(rows)
  } finally {
    cdp?.browser.close()
    cdp?.tab.close()
    child.kill()
    await wait(500)
  }
}

main().catch((err) => {
  console.error('测量失败：', err.message)
  process.exit(1)
})

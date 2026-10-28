import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 样式表守卫。
 *
 * 这几条都是真实踩过的坑，写进测试防回归：
 *  1. 图标按钮忘了 `padding: 0`：浏览器对 button 的默认 padding 是 `1px 6px`，
 *     定宽按钮的内容区会被压缩，16px 图标向右溢出，hover 底板与图标错位。
 *  2. `var(--x)` 引用了从未定义的变量：属性整条失效，只能靠 fallback 撑着，换主题就露馅。
 *  3. 同一选择器重复定义且值不同：后一条静默覆盖前一条，语义色被改掉很难察觉。
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const css = fs.readFileSync(path.join(root, 'src/renderer/src/styles.css'), 'utf8')

/** 粗粒度解析：选择器 -> 声明体（只取顶层规则，够用） */
function rules() {
  const out = []
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    out.push({ selector: m[1].trim(), body: m[2] })
  }
  return out
}

/** 取某个选择器的合并声明（同名选择器按出现顺序合并） */
function declOf(selector) {
  return rules()
    .filter((r) => r.selector === selector)
    .map((r) => r.body)
    .join(';')
}

test('图标按钮都重置了 padding（避免 UA 默认 1px 6px 把图标挤偏）', () => {
  // 这些类都是定宽/定高的按钮，内容必须完全由自己控制
  const mustReset = ['.tab-close', '.icon-btn', '.transfer-cancel', '.swatch', '.tree-toggle']
  const offenders = mustReset.filter((sel) => {
    const body = declOf(sel)
    if (!body) return false // 选择器不存在时跳过（改名了另说）
    return !/padding\s*:\s*0/.test(body)
  })
  assert.deepEqual(offenders, [], `以下图标按钮缺少 padding: 0：${offenders.join(', ')}`)
})

test('所有 var(--x) 都在主题里定义过', () => {
  const defined = new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]))
  const used = new Set([...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]))
  const missing = [...used].filter((name) => !defined.has(name))
  assert.deepEqual(missing, [], `以下变量被使用但从未定义：${missing.join(', ')}`)
})

test('同一选择器不重复定义出冲突的背景色（后写覆盖前写最容易出错）', () => {
  const bySelector = new Map()
  for (const { selector, body } of rules()) {
    if (!/^[.\w\s:-]+$/.test(selector)) continue // 跳过 @ 规则、伪元素组合等
    const bg = /background(?:-color)?\s*:\s*([^;]+)/.exec(body)?.[1]?.trim()
    if (!bg) continue
    const list = bySelector.get(selector) ?? []
    list.push(bg)
    bySelector.set(selector, list)
  }
  const conflicts = [...bySelector.entries()]
    .filter(([, list]) => new Set(list).size > 1)
    .map(([selector, list]) => `${selector}: ${list.join(' → ')}`)
  assert.deepEqual(conflicts, [], `同一选择器出现多个不同背景：\n${conflicts.join('\n')}`)
})

test('终端背景不被强制透明（否则深浅主题混搭时文字会看不见）', () => {
  // 终端底色必须由 xterm 主题决定；强加 transparent 会露出应用主题底色
  const bad = [...css.matchAll(/\.xterm-viewport\s*\{[^}]*transparent[^}]*\}/g)].map((m) => m[0])
  assert.deepEqual(bad, [], '不要给 .xterm-viewport 设 transparent，终端背景应由 xterm 主题提供')
})

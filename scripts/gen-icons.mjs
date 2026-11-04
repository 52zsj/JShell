/**
 * 生成应用图标（PNG / ICNS / ICO），零外部依赖。
 *
 * 为什么自己光栅化：项目里没有 sharp / canvas 之类的图形库，而用 Electron 离屏截图
 * 在隐藏窗口下拿不到画面（capturePage 不返回）。这里用**距离场（SDF）+ 超采样**
 * 直接算像素，输出的是按目标尺寸真正绘制的结果，不是把 1024 缩下来的糊图。
 *
 * 两套尺寸约定（这是「启动台里比其他应用大一圈」的根因）：
 *   - macOS：画布 1024，图形 824 居中，四周留 100px 透明边距（Apple HIG）。
 *     满出血的图标在启动台里会明显比系统应用大一圈。
 *   - Windows：不遵循这个留白约定，内容更满，否则和别的图标并排时显得小一号。
 *
 * 小尺寸（16/20/24/32）另有「简化版」参数：边距更小、线条更粗，
 * 否则 16px 下提示符糊成一团 —— Windows 任务栏「看不到图标」正是这个原因。
 *
 * 用法：node scripts/gen-icons.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { execFileSync } from 'node:child_process'

const ROOT = path.resolve(import.meta.dirname, '..')
const BUILD = path.join(ROOT, 'build')
const TMP = path.join(ROOT, 'node_modules/.cache/jshell-icons')

// ---------------------------------------------------------------- PNG 编码

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}

/** RGBA → PNG（每行 filter 0；图标尺寸小，压缩率已经够） */
function encodePng(width, height, rgba) {
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

// ---------------------------------------------------------------- 几何与配色

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)

/** 圆角矩形距离场：<0 在内部 */
function sdRoundRect(x, y, left, top, w, h, r) {
  const cx = left + w / 2
  const cy = top + h / 2
  const qx = Math.abs(x - cx) - (w / 2 - r)
  const qy = Math.abs(y - cy) - (h / 2 - r)
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0))
  return outside + Math.min(Math.max(qx, qy), 0) - r
}

/** 线段距离场 */
function sdSegment(x, y, ax, ay, bx, by) {
  const pax = x - ax
  const pay = y - ay
  const bax = bx - ax
  const bay = by - ay
  const t = clamp01((pax * bax + pay * bay) / (bax * bax + bay * bay))
  return Math.hypot(pax - bax * t, pay - bay * t)
}

/** 距离 → 覆盖率（1px 过渡，配合超采样得到平滑边缘） */
const coverage = (d) => clamp01(0.5 - d)

function mix(a, b, t) {
  const k = clamp01(t)
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k]
}

const hex = (s) => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)]

const COLORS = {
  bgFrom: hex('#205B57'),
  bgMid: hex('#0E2427'),
  bgTo: hex('#040D10'),
  chevFrom: hex('#7CF3CD'),
  chevTo: hex('#2BB894'),
  cursor: hex('#FFFFFF'),
  cursorEdge: hex('#D3EFE7')
}

/** macOS / 通用版：824 图形 + 100 边距 */
const MAIN = {
  margin: 100,
  radius: 190,
  chev: { ax: 340, ay: 356, bx: 486, by: 512, ex: 340, ey: 668, width: 98 },
  cursor: { left: 552, top: 428, w: 132, h: 168, r: 30 },
  sheen: true
}

/** Windows 版：边距压到 60，构图等比放大，和桌面其他图标并排不显小 */
const WINDOWS = {
  margin: 60,
  radius: 208,
  chev: { ax: 323, ay: 324, bx: 484, by: 512, ex: 323, ey: 683, width: 108 },
  cursor: { left: 556, top: 420, w: 145, h: 184, r: 33 },
  sheen: true
}

/** 16/20/24/32 专用简化版：边距 40、线条 136，缩到 16px 还认得出 */
const SMALL = {
  margin: 40,
  radius: 212,
  chev: { ax: 340, ay: 330, bx: 520, by: 512, ex: 340, ey: 694, width: 136 },
  cursor: { left: 600, top: 410, w: 150, h: 204, r: 44 },
  sheen: false
}

/** 在设计坐标系（1024）里算某点的颜色，返回 [r,g,b,a] */
function sample(design, x, y) {
  const m = design.margin
  const side = 1024 - m * 2
  const dPlate = sdRoundRect(x, y, m, m, side, side, design.radius)

  let r = 0
  let g = 0
  let b = 0
  let a = 0

  const aPlate = coverage(dPlate)
  if (aPlate > 0) {
    const t = clamp01(((x - m) / side) * 0.35 + ((y - m) / side) * 0.65)
    let base
    if (design.sheen) {
      base = t < 0.5 ? mix(COLORS.bgFrom, COLORS.bgMid, t / 0.5) : mix(COLORS.bgMid, COLORS.bgTo, (t - 0.5) / 0.5)
      // 左上柔光 + 底部暗角：深色底不至于发死，视线被压到中间的提示符
      const sheenT = clamp01(
        1 - Math.hypot((x - m - side * 0.28) / (side * 0.85), (y - m - side * 0.12) / (side * 0.85))
      )
      const sheen = Math.pow(sheenT, 2) * 0.16
      const shade = 1 - Math.pow(clamp01((y - m) / side), 2.2) * 0.28
      r = (base[0] + (255 - base[0]) * sheen) * shade
      g = (base[1] + (255 - base[1]) * sheen) * shade
      b = (base[2] + (255 - base[2]) * sheen) * shade
    } else {
      base = mix(COLORS.bgFrom, COLORS.bgTo, t)
      r = base[0]
      g = base[1]
      b = base[2]
    }
    a = aPlate
  }

  // 内描边（细高光边），与大图标的边缘处理一致
  if (design.sheen) {
    const ring = Math.abs(dPlate + 3)
    const aRing = clamp01(1.6 - ring) * 0.5 * aPlate
    if (aRing > 0) {
      r += (255 - r) * aRing * 0.2
      g += (255 - g) * aRing * 0.2
      b += (255 - b) * aRing * 0.2
    }
  }

  // 提示符「>」
  const c = design.chev
  const half = c.width / 2
  const dChev =
    Math.min(sdSegment(x, y, c.ax, c.ay, c.bx, c.by), sdSegment(x, y, c.bx, c.by, c.ex, c.ey)) - half
  const aChev = coverage(dChev)
  if (aChev > 0) {
    // 用包围盒归一化：折线起终点 x 相同（ax === ex），直接除会得到 Infinity
    const xMin = Math.min(c.ax, c.bx, c.ex) - half
    const xMax = Math.max(c.ax, c.bx, c.ex) + half
    const yMin = Math.min(c.ay, c.by, c.ey) - half
    const yMax = Math.max(c.ay, c.by, c.ey) + half
    const t = clamp01(((x - xMin) / (xMax - xMin)) * 0.35 + ((y - yMin) / (yMax - yMin)) * 0.65)
    const col = mix(COLORS.chevFrom, COLORS.chevTo, t)
    r = r * (1 - aChev) + col[0] * aChev
    g = g * (1 - aChev) + col[1] * aChev
    b = b * (1 - aChev) + col[2] * aChev
    a = a + aChev * (1 - a)
  }

  // 光标
  const q = design.cursor
  const dCur = sdRoundRect(x, y, q.left, q.top, q.w, q.h, q.r)
  const aCur = coverage(dCur)
  if (aCur > 0) {
    const col = mix(COLORS.cursor, COLORS.cursorEdge, clamp01((y - q.top) / q.h))
    r = r * (1 - aCur) + col[0] * aCur
    g = g * (1 - aCur) + col[1] * aCur
    b = b * (1 - aCur) + col[2] * aCur
    a = a + aCur * (1 - a)
  }

  return [r, g, b, a]
}

/** 按目标尺寸绘制一张图标 */
function renderIcon(design, size) {
  const scale = size / 1024
  const rgba = Buffer.alloc(size * size * 4)
  const SS = size <= 32 ? 4 : 3
  const samples = SS * SS

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS) / scale
          const y = (py + (sy + 0.5) / SS) / scale
          const out = sample(design, x, y)
          r += out[0] * out[3]
          g += out[1] * out[3]
          b += out[2] * out[3]
          a += out[3]
        }
      }
      const i = (py * size + px) * 4
      if (a <= 0) continue
      rgba[i] = Math.round(clamp01(r / a / 255) * 255)
      rgba[i + 1] = Math.round(clamp01(g / a / 255) * 255)
      rgba[i + 2] = Math.round(clamp01(b / a / 255) * 255)
      rgba[i + 3] = Math.round(clamp01(a / samples) * 255)
    }
  }
  return encodePng(size, size, rgba)
}

// ---------------------------------------------------------------- ICO / ICNS

/** ICO：Vista 起允许直接嵌 PNG 帧，支持透明且体积小 */
function writeIco(file, frames) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(frames.length, 4)

  const entries = Buffer.alloc(16 * frames.length)
  let offset = 6 + 16 * frames.length
  frames.forEach((frame, i) => {
    const base = i * 16
    entries[base] = frame.size >= 256 ? 0 : frame.size
    entries[base + 1] = frame.size >= 256 ? 0 : frame.size
    entries.writeUInt16LE(1, base + 4)
    entries.writeUInt16LE(32, base + 6)
    entries.writeUInt32LE(frame.png.length, base + 8)
    entries.writeUInt32LE(offset, base + 12)
    offset += frame.png.length
  })
  fs.writeFileSync(file, Buffer.concat([header, entries, ...frames.map((f) => f.png)]))
}

// ---------------------------------------------------------------- 主流程

fs.mkdirSync(TMP, { recursive: true })

const cache = new Map()
function icon(design, size) {
  const key = `${design.margin}-${size}`
  if (!cache.has(key)) cache.set(key, renderIcon(design, size))
  return cache.get(key)
}

console.log('绘制 1024 主图标…')
const png1024 = icon(MAIN, 1024)
fs.writeFileSync(path.join(BUILD, 'icon.png'), png1024)
fs.writeFileSync(path.join(TMP, 'icon-1024.png'), png1024)

console.log('绘制 ICO 各尺寸…')
const icoSizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
writeIco(
  path.join(BUILD, 'icon.ico'),
  icoSizes.map((size) => ({ size, png: icon(size <= 32 ? SMALL : WINDOWS, size) }))
)
fs.writeFileSync(path.join(TMP, 'icon-win-256.png'), icon(WINDOWS, 256))

console.log('绘制 ICNS 各尺寸…')
const iconset = path.join(TMP, 'JShell.iconset')
fs.rmSync(iconset, { recursive: true, force: true })
fs.mkdirSync(iconset, { recursive: true })
const icnsPlan = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024]
]
for (const [name, size] of icnsPlan) {
  fs.writeFileSync(path.join(iconset, name), icon(size <= 32 ? SMALL : MAIN, size))
}
execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(BUILD, 'icon.icns')])

console.log('绘制托盘图标…')
writeIco(
  path.join(BUILD, 'tray', 'tray-win.ico'),
  [16, 20, 24, 32].map((size) => ({ size, png: icon(SMALL, size) }))
)

// 单尺寸预览，方便肉眼检查小图标
for (const size of [16, 24, 32, 48]) {
  fs.writeFileSync(path.join(TMP, `preview-${size}.png`), icon(size <= 32 ? SMALL : WINDOWS, size))
}

console.log('\n生成完成：')
for (const f of ['icon.png', 'icon.icns', 'icon.ico', 'tray/tray-win.ico']) {
  const full = path.join(BUILD, f)
  console.log(`  build/${f}  ${(fs.statSync(full).size / 1024).toFixed(1)} KB`)
}
console.log(`  预览：${TMP}/preview-*.png`)

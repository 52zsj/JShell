/**
 * 图标资源体检：格式、尺寸、多分辨率完整性。
 *
 * 背景：Windows 的图标问题（任务栏/快捷方式/开始菜单显示 Electron）有两个来源：
 *   1. 打包时跳过了 rcedit，exe 资源根本没写；
 *   2. 图标文件本身尺寸不全，Windows 只能回退到默认图标。
 * 这里把 1 交给 CI 的 exe 版本信息校验，2 由本脚本兜住。
 *
 * 用法：node scripts/check-icons.mjs（CI 与本地都可跑，失败退出码 1）
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const ROOT = path.resolve(import.meta.dirname, '..')
const errors = []
const notes = []

function readIco(file) {
  const buf = fs.readFileSync(file)
  if (buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) {
    throw new Error(`${path.basename(file)} 不是合法 ICO（头标识不对）`)
  }
  const count = buf.readUInt16LE(4)
  const sizes = []
  for (let i = 0; i < count; i++) {
    const off = 6 + i * 16
    sizes.push({
      width: buf[off] === 0 ? 256 : buf[off],
      height: buf[off + 1] === 0 ? 256 : buf[off + 1],
      bpp: buf.readUInt16LE(off + 6),
      bytes: buf.readUInt32LE(off + 8)
    })
  }
  return { count, sizes }
}

function readPngSize(file) {
  const buf = fs.readFileSync(file, { encoding: null }).subarray(0, 24)
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error(`${path.basename(file)} 不是合法 PNG`)
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

function readIcnsTypes(file) {
  const buf = fs.readFileSync(file)
  if (buf.toString('ascii', 0, 4) !== 'icns') throw new Error('icon.icns 不是合法 ICNS')
  const types = []
  let off = 8
  while (off + 8 <= buf.length) {
    const type = buf.toString('ascii', off, off + 4)
    const size = buf.readUInt32BE(off + 4)
    if (size < 8) break
    types.push(type)
    off += size
  }
  return types
}

// 1. Windows 主图标：必须覆盖小图标到大图标
{
  const file = path.join(ROOT, 'build/icon.ico')
  try {
    const { sizes } = readIco(file)
    const set = new Set(sizes.map((s) => s.width))
    const required = [16, 32, 48, 256]
    const missing = required.filter((s) => !set.has(s))
    if (missing.length) errors.push(`build/icon.ico 缺少尺寸：${missing.join(', ')}（Windows 任务栏/快捷方式会退化成默认图标）`)
    if (sizes.some((s) => s.bpp < 32)) errors.push('build/icon.ico 存在非 32 位帧，透明边缘可能发黑')
    notes.push(`icon.ico：${sizes.length} 帧（${sizes.map((s) => s.width).join('/')}），均 ${sizes[0].bpp}bit`)
  } catch (err) {
    errors.push(err.message)
  }
}

// 2. macOS 主图标：需要 512/1024 大图，否则 Dock 会糊
{
  const file = path.join(ROOT, 'build/icon.icns')
  try {
    const types = readIcnsTypes(file)
    const need = ['ic07', 'ic08', 'ic09']
    const missing = need.filter((t) => !types.includes(t))
    if (missing.length) errors.push(`build/icon.icns 缺少帧类型：${missing.join(', ')}`)
    notes.push(`icon.icns：${types.length} 帧（${types.join(' ')}）`)
  } catch (err) {
    errors.push(err.message)
  }
}

// 3. Linux/通用 PNG：electron-builder 建议 512+
{
  const file = path.join(ROOT, 'build/icon.png')
  try {
    const { width, height } = readPngSize(file)
    if (width < 512 || height < 512) errors.push(`build/icon.png 尺寸 ${width}x${height} 偏小，建议 1024`)
    if (width !== height) errors.push('build/icon.png 不是正方形')
    notes.push(`icon.png：${width}x${height}`)
  } catch (err) {
    errors.push(err.message)
  }
}

// 4. 托盘/任务栏小图标
{
  const win = path.join(ROOT, 'build/tray/tray-win.ico')
  try {
    const { sizes } = readIco(win)
    const set = new Set(sizes.map((s) => s.width))
    if (!set.has(16)) errors.push('build/tray/tray-win.ico 缺少 16x16')
    notes.push(`tray-win.ico：${sizes.length} 帧（${sizes.map((s) => s.width).join('/')}）`)
  } catch (err) {
    errors.push(err.message)
  }
  for (const name of ['trayTemplate.png', 'trayTemplate@2x.png']) {
    const file = path.join(ROOT, 'build/tray', name)
    try {
      const { width } = readPngSize(file)
      notes.push(`${name}：${width}px`)
    } catch (err) {
      errors.push(err.message)
    }
  }
}

for (const note of notes) console.log(`  ✓ ${note}`)
if (errors.length) {
  console.error('\n图标资源检查未通过：')
  for (const e of errors) console.error(`  ✗ ${e}`)
  process.exit(1)
}
console.log('\n图标资源检查通过')

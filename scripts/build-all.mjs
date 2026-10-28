#!/usr/bin/env node
/**
 * 一键构建 + 打包脚本（macOS 与 Windows 同等重要）。
 *
 * 用法：
 *   node scripts/build-all.mjs                    # 打包当前平台（安装版 + 便携版）
 *   node scripts/build-all.mjs --mac --win        # 指定平台
 *   node scripts/build-all.mjs --arch arm64,x64   # 指定架构
 *   node scripts/build-all.mjs --skip-build       # 复用已有 out/
 *   node scripts/build-all.mjs --dir              # 只产出免安装目录，用于冒烟验证
 *   node scripts/build-all.mjs --win --docker     # 用 Docker + wine 在 macOS 上打 Windows 包
 *   node scripts/build-all.mjs --win --no-sign-edit  # 无 wine 时跳过 exe 图标/版本资源写入
 *
 * 分发渠道（默认内部渠道，不联网）：
 *   JSHELL_CHANNEL=public JSHELL_UPDATE_URL=https://dl.example.com/jshell \
 *     node scripts/build-all.mjs --mac --win
 *
 * 产物：
 *   macOS  ：JShell-<版本>-<架构>.dmg / .zip / -portable.zip（解压即用）
 *   Windows：JShell-<版本>-x64-setup.exe / -portable.exe
 *
 * 跨平台说明：
 *   - macOS 上打 Windows 包需要 wine；推荐 `--docker`（electronuserland/builder:wine）；
 *   - CI（.github/workflows/release.yml）在原生 runner 上构建，无需 wine/Docker。
 */
import { execFileSync, execSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const has = (flag) => args.includes(flag)

const PLATFORMS = { mac: 'mac', win: 'win', linux: 'linux' }
const platformFlagMap = { '--mac': 'mac', '--win': 'win', '--linux': 'linux' }
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
const version = pkg.version
const releaseDir = path.join(root, 'release', version)

const supported = { darwin: 'mac', win32: 'win', linux: 'linux' }[process.platform]
if (!supported) {
  console.error(`不支持的主机平台: ${process.platform}`)
  process.exit(1)
}

// ---------------------------------------------------------------- 目标平台
let targets
if (has('--all')) {
  // 只覆盖两个一线平台；Linux 需显式 --linux
  targets = ['mac', 'win']
} else {
  const explicit = args.filter((a) => platformFlagMap[a]).map((a) => platformFlagMap[a])
  targets = explicit.length > 0 ? explicit : [supported]
}

// ------------------------------------------------------------------ 架构参数
function argValue(name) {
  const item = args.find((a) => a === name || a.startsWith(`${name}=`))
  if (!item) return undefined
  return item.includes('=') ? item.split('=')[1] : args[args.indexOf(item) + 1]
}

const archValue = argValue('--arch')
const archArgs = (archValue && !archValue.startsWith('--') ? archValue : '')
  .split(',')
  .map((a) => a.trim())
  .filter(Boolean)
  .map((a) => `--${a}`)

// 直接走 CLI 的 JS 入口：Windows 上的 .cmd 不能用 execFileSync 直接执行
const builderCli = path.join(root, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js')

if (!existsSync(builderCli)) {
  console.error('未找到 electron-builder，请先执行 npm install')
  process.exit(1)
}

function step(title) {
  console.log(`\n\x1b[36m▸ ${title}\x1b[0m`)
}

function run(cmd, cmdArgs, options = {}) {
  execFileSync(cmd, cmdArgs, { cwd: root, stdio: 'inherit', env: process.env, ...options })
}

// ------------------------------------------------------- 1. 发布元信息 + 编译
step('生成发布元信息（渠道 / 构建时间）')
if (process.env.JSHELL_CHANNEL === 'public' && !process.env.JSHELL_UPDATE_URL) {
  console.error('公开渠道必须提供 JSHELL_UPDATE_URL')
  process.exit(1)
}
run(process.execPath, [path.join(root, 'scripts', 'make-release-meta.mjs')])

if (!has('--skip-build')) {
  step('类型检查 + 编译（main / preload / renderer）')
  execSync('npm run build', { cwd: root, stdio: 'inherit', env: process.env })
} else {
  console.log('\x1b[33m▸ 跳过编译，复用现有 out/\x1b[0m')
}

// ------------------------------------------------------------- 2. 逐平台打包
const results = []

/** 在 Docker（wine）里构建 Windows 包：适合没有本地 wine 的 macOS 开发机 */
function buildWindowsInDocker() {
  const arch = archArgs[0]?.replace('--', '') || 'x64'
  const dockerArgs = [
    'run',
    '--rm',
    '-v',
    `${root}:/project`,
    '-v',
    'jshell-electron-cache:/root/.cache/electron',
    '-v',
    'jshell-electron-builder-cache:/root/.cache/electron-builder',
    '-w',
    '/project',
    '-e',
    'CSC_IDENTITY_AUTO_DISCOVERY=false',
    '-e',
    'ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/',
    '-e',
    'ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/',
    'electronuserland/builder:wine',
    'bash',
    '-lc',
    `./node_modules/.bin/electron-builder --win --${arch} --publish never`
  ]
  run('docker', dockerArgs)
}

for (const target of targets) {
  step(`打包 ${target}${archArgs.length ? ` (${archArgs.join(' ')})` : ' (默认架构)'}`)
  try {
    if (target === 'win' && has('--docker')) {
      buildWindowsInDocker()
    } else {
      const builderArgs = [`--${PLATFORMS[target]}`, '--publish', 'never']
      if (has('--dir')) builderArgs.push('--dir')
      // 没有 wine 的 macOS/Linux 主机：跳过 rcedit（不写 exe 图标与版本资源），仍可产出可用安装包
      if (target === 'win' && has('--no-sign-edit')) {
        console.log(
          '\x1b[33m⚠ 跳过 rcedit：exe 的图标与版本信息（产品名/文件描述）将保持 Electron 默认值，' +
            '该产物仅用于本地验证，不要对外分发\x1b[0m'
        )
        builderArgs.push('--config.win.signAndEditExecutable=false')
      }
      // 多架构逐个构建：两个 DMG 并行创建会争用同名卷（JShell <版本>），导致 hdiutil detach 失败
      const archList = archArgs.length > 0 ? archArgs : [null]
      for (const arch of archList) {
        run(process.execPath, [builderCli, ...builderArgs, ...(arch ? [arch] : [])])
      }
    }
    results.push({ target, ok: true })
  } catch {
    results.push({ target, ok: false })
  }
}

// ------------------------------------------ 3. macOS 便携版（解压即用 zip）
/** 把安装版 zip 重新打包成便携版：在 .app 同级放入标记文件与中文说明 */
function createMacPortable() {
  if (has('--dir') || process.platform !== 'darwin') return
  // 只打包 Windows 时不需要重新压缩 macOS 便携版
  if (!targets.includes('mac')) return
  if (!existsSync(releaseDir)) return

  const zips = readdirSync(releaseDir).filter(
    (file) => /^JShell-.*\.zip$/.test(file) && !/-portable\.zip$/.test(file)
  )
  if (zips.length === 0) return

  step('生成 macOS 便携版（解压即用）')
  for (const zip of zips) {
    const arch = /-(arm64|x64|universal)\.zip$/.exec(zip)?.[1] ?? 'x64'
    const source = path.join(releaseDir, zip)
    const target = path.join(releaseDir, `JShell-${version}-${arch}-portable.zip`)
    const temp = path.join(os.tmpdir(), `jshell-portable-${arch}-${Date.now()}`)

    try {
      mkdirSync(temp, { recursive: true })
      run('ditto', ['-x', '-k', source, temp])
      writeFileSync(path.join(temp, 'jshell-portable.marker'), `JShell ${version} 便携版\n`, 'utf8')
      writeFileSync(
        path.join(temp, '便携版使用说明.txt'),
        [
          `JShell ${version} 便携版（macOS）`,
          '',
          '1. 把 JShell.app 连同本说明、jshell-portable.marker 一起放在任意目录（U 盘、内网共享目录均可）。',
          '2. 双击 JShell.app 启动；所有配置、密钥与日志都会保存在同级的 JShell-Data 文件夹。',
          '3. 迁移时整目录拷走即可，不写入系统用户目录。',
          '4. 首次打开未签名包：右键点击 JShell.app → 打开；或执行',
          '   xattr -dr com.apple.quarantine JShell.app',
          '5. 不要删除 jshell-portable.marker，否则应用会按安装版处理，把数据写到 ~/Library。',
          ''
        ].join('\n'),
        'utf8'
      )
      try {
        unlinkSync(target)
      } catch {
        /* 目标不存在 */
      }
      run('ditto', ['-c', '-k', '--sequesterRsrc', '.', target], { cwd: temp })
      console.log(`  · ${path.basename(target)}`)
    } catch (err) {
      console.warn(`  便携版生成失败（${zip}）：${err instanceof Error ? err.message : err}`)
    }
  }
}

createMacPortable()

// ------------------------------------- 4. 中文安装说明 + SHA-256 校验值
if (!has('--dir') && existsSync(releaseDir)) {
  step('生成中文安装说明与校验值')
  try {
    run(process.execPath, [path.join(root, 'scripts', 'write-release-notes.mjs')])
  } catch {
    console.warn('  安装说明生成失败，可单独执行 npm run notes 重试')
  }
}

// -------------------------------------------------------------- 5. 结果汇总
console.log('\n' + '─'.repeat(64))
for (const { target, ok } of results) {
  const mark = ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'
  console.log(`${mark} ${target}`)
}

if (existsSync(releaseDir)) {
  console.log(`\n产物目录: ${path.relative(root, releaseDir)}`)
  const files = readdirSync(releaseDir)
    .map((file) => ({ file, full: path.join(releaseDir, file) }))
    .filter(({ full }) => statSync(full).isFile() && statSync(full).size > 1024 * 1024)
    .sort((a, b) => a.file.localeCompare(b.file))
  for (const { file, full } of files) {
    console.log(`  · ${file}  ${(statSync(full).size / 1024 / 1024).toFixed(1)} MB`)
  }
  console.log('\n提示：内部渠道产物未签名，首次打开需按系统提示放行；')
  console.log('      公开下载前请配置 CSC_LINK 与 Apple 公证凭据，详见 docs/06-distribution.md。')
}

if (results.some((r) => !r.ok)) {
  console.log(
    '\n\x1b[33m部分平台构建失败。跨平台打包依赖额外工具链：\n' +
      '  · macOS 上打 Windows 包：加 --docker（需要 Docker Desktop）或本地安装 wine\n' +
      '  · 推荐直接用 CI（.github/workflows/release.yml）在原生 runner 上产出安装包\x1b[0m'
  )
  process.exit(1)
}
console.log('\n\x1b[32m全部完成\x1b[0m')

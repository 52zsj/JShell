import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { PORTABLE_DATA_DIR, PORTABLE_MARKER } from '../../shared/paths'
import { log } from './logger'

export type PortableSource = 'env' | 'portable-exe' | 'marker' | 'none'

export interface PortableState {
  portable: boolean
  /** 解压目录（数据目录的父目录） */
  portableDir?: string
  /** 实际生效的数据目录 */
  dataDir?: string
  source: PortableSource
}

let state: PortableState = { portable: false, source: 'none' }

function hasMarker(dir: string): boolean {
  try {
    return fs.existsSync(path.join(dir, PORTABLE_MARKER))
  } catch {
    return false
  }
}

/** 目录是否真的可写：只读共享盘 / 系统保护目录会在这里被识别出来 */
function ensureWritableDir(dir: string): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true })
    const probe = path.join(dir, `.jshell-write-test-${process.pid}`)
    fs.writeFileSync(probe, 'ok')
    fs.unlinkSync(probe)
    return true
  } catch {
    return false
  }
}

/**
 * 便携版候选目录。
 * macOS：可执行文件在 `X.app/Contents/MacOS/`，标记文件与 `X.app` 同级（即上三级）；
 * Windows：解压版标记与 exe 同级；electron-builder 的 portable 目标会提供
 *          PORTABLE_EXECUTABLE_DIR（真实 exe 所在目录，而非临时解压目录）。
 */
function markerCandidates(): string[] {
  const exeDir = path.dirname(app.getPath('exe'))
  const candidates = [exeDir]
  if (process.platform === 'darwin') candidates.unshift(path.resolve(exeDir, '..', '..', '..'))
  if (app.isPackaged) candidates.push(process.resourcesPath)
  return [...new Set(candidates)]
}

/**
 * 决定数据目录。必须在 app ready 之前调用，否则 setPath('userData') 不生效。
 *
 * 优先级：显式环境变量 > 便携版 exe 目录 > 标记文件 > 系统默认目录。
 * 便携目录不可写时自动回退到系统默认目录，并在日志里说明原因。
 */
/** 旧版本应用名是 jshell（小写），升级后 userData 变成 JShell，这里做一次性迁移 */
function migrateLegacyUserData(): void {
  try {
    const appData = app.getPath('appData')
    const target = app.getPath('userData')
    const legacy = path.join(appData, 'jshell')
    if (legacy === target || !fs.existsSync(legacy) || fs.existsSync(target)) return
    fs.renameSync(legacy, target)
    log.info(`已迁移旧数据目录：${legacy} -> ${target}`)
  } catch (err) {
    log.warn('迁移旧数据目录失败，将使用新的数据目录', err)
  }
}

export function applyPortableDataDir(): PortableState {
  let portableDir: string | undefined
  let source: PortableSource = 'none'

  if (process.env.JSHELL_PORTABLE === '1') {
    portableDir = process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(app.getPath('exe'))
    source = 'env'
  } else if (process.env.PORTABLE_EXECUTABLE_DIR) {
    portableDir = process.env.PORTABLE_EXECUTABLE_DIR
    source = 'portable-exe'
  } else {
    portableDir = markerCandidates().find(hasMarker)
    if (portableDir) source = 'marker'
  }

  if (!portableDir) {
    migrateLegacyUserData()
    state = { portable: false, source: 'none' }
    return state
  }

  const dataDir = path.join(portableDir, PORTABLE_DATA_DIR)
  if (!ensureWritableDir(dataDir)) {
    log.warn(`便携目录不可写，回退到系统默认目录：${dataDir}`)
    state = { portable: false, portableDir, source }
    return state
  }

  app.setPath('userData', dataDir)
  // 会话缓存（localStorage / 缓存文件）也放进便携目录，避免写到 ~/Library
  app.setPath('sessionData', path.join(dataDir, 'session'))
  state = { portable: true, portableDir, dataDir, source }
  return state
}

export function getPortableState(): PortableState {
  return state
}

/** 便携版数据目录说明文案，供设置页展示 */
export function portableHint(): string {
  if (!state.portable) return ''
  return `便携模式：所有配置与会话数据保存在程序目录下的 ${PORTABLE_DATA_DIR} 文件夹。`
}

/**
 * 应用版本号。
 *
 * 打包后 app.getVersion() 就是 package.json 的版本；但开发态（直接跑 out/main/index.js）
 * 它会返回 Electron 自身的版本（例如 45.0.0），状态栏和「关于」里就会显示错。
 * 构建期已把真实版本注入成 __JSHELL_VERSION__，优先用它。
 */
export function appVersion(): string {
  try {
    if (typeof __JSHELL_VERSION__ === 'string' && __JSHELL_VERSION__) return __JSHELL_VERSION__
  } catch {
    /* 未注入（例如单测直接引入本模块）时走兜底 */
  }
  const fromApp = app.getVersion()
  if (app.isPackaged) return fromApp
  // 兜底：读仓库根目录的 package.json，避免开发态显示 Electron 版本
  try {
    const root = path.join(app.getAppPath(), 'package.json')
    const raw = JSON.parse(fs.readFileSync(root, 'utf8')) as { version?: string }
    if (raw.version) return raw.version
  } catch {
    /* 读不到就接受 app.getVersion() */
  }
  return fromApp
}


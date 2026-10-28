/**
 * 跨平台路径工具（纯函数，无 Electron 依赖，可在 Node 单测中直接跑）。
 *
 * Windows 与 macOS 的差异集中在这里处理，业务代码不再各自判断平台：
 *  - `~` / `~/xxx` 展开为当前用户主目录（两个平台都支持这种写法）；
 *  - Windows 额外支持 `%USERPROFILE%` 这类环境变量；
 *  - Windows 下把 `/` 统一成 `\`（资源管理器复制出来的路径常见混合分隔符）；
 *  - POSIX 下**不**把 `\` 当分隔符（反斜杠是合法文件名字符，转换会破坏路径）。
 */

export interface ExpandPathOptions {
  /** 当前用户主目录 */
  home: string
  /** Node 的 process.platform 取值 */
  platform: NodeJS.Platform | string
  /** 用于展开 Windows 环境变量，默认 process.env */
  env?: Record<string, string | undefined>
}

/** 便携版标记文件：与可执行文件（macOS 为 .app）同级即为便携模式 */
export const PORTABLE_MARKER = 'jshell-portable.marker'

/** 便携版数据目录名（解压目录内） */
export const PORTABLE_DATA_DIR = 'JShell-Data'

function isWindows(platform: string): boolean {
  return platform === 'win32'
}

/**
 * 展开用户路径。
 * 非法输入（空串）原样返回，避免把空路径变成主目录而误操作。
 */
export function expandUserPath(input: string, options: ExpandPathOptions): string {
  const { home, platform, env = process.env } = options
  let value = (input ?? '').trim()
  if (!value) return ''

  // Windows 环境变量：%USERPROFILE%\keys\id_ed25519
  if (isWindows(platform)) {
    value = value.replace(/%([^%\\/]+)%/g, (whole, name: string) => {
      const key = Object.keys(env).find((item) => item.toUpperCase() === name.toUpperCase())
      return key && env[key] ? (env[key] as string) : whole
    })
  }

  if (value === '~') {
    value = home
  } else if (value.startsWith('~/') || value.startsWith('~\\')) {
    value = `${home}${isWindows(platform) ? '\\' : '/'}${value.slice(2)}`
  }

  // 只有 Windows 需要统一分隔符；POSIX 的反斜杠是文件名字符，不能动
  if (isWindows(platform)) value = value.replace(/\//g, '\\')

  return value
}

/**
 * 还原可读路径（用于界面展示）。
 * Windows 下把反斜杠转成正斜杠会让用户无法直接复制到资源管理器，因此保持原样；
 * 这里只做多余分隔符与结尾分隔符的清理。
 */
export function cleanDisplayPath(input: string, platform: NodeJS.Platform | string): string {
  if (!input) return ''
  if (isWindows(platform)) {
    return input.replace(/\\{2,}/g, '\\').replace(/([^:\\])\\+$/, '$1')
  }
  return input.replace(/\/{2,}/g, '/').replace(/(.)\/+$/, '$1')
}

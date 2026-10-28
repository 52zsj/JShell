import { app } from 'electron'
import { log } from './logger'

/**
 * 开机自启（登录时启动）。
 *
 * macOS：走系统「登录项」（SMAppService / LoginItems），并请求以隐藏方式启动；
 * Windows：写入当前用户启动项，命令行追加 `--hidden`，避免开机弹窗打扰。
 *
 * 两个平台都用 Electron 的 setLoginItemSettings 封装，避免各自维护注册表/plist。
 */

/** 便携版 exe 每次可能从不同目录启动，必须用真实 exe 路径登记 */
function winEntry(): { path: string; args: string[] } {
  return {
    path: process.env.PORTABLE_EXECUTABLE_FILE || process.execPath,
    args: ['--hidden']
  }
}

export function getLaunchAtLogin(): boolean {
  try {
    if (process.platform === 'darwin') {
      return app.getLoginItemSettings().openAtLogin
    }
    if (process.platform === 'win32') {
      return app.getLoginItemSettings(winEntry()).openAtLogin
    }
    return app.getLoginItemSettings().openAtLogin
  } catch (err) {
    log.warn('读取开机自启状态失败', err)
    return false
  }
}

export function setLaunchAtLogin(enabled: boolean): void {
  try {
    if (process.platform === 'darwin') {
      app.setLoginItemSettings({ openAtLogin: enabled })
    } else if (process.platform === 'win32') {
      const entry = winEntry()
      app.setLoginItemSettings({
        openAtLogin: enabled,
        path: entry.path,
        args: entry.args
      })
    } else {
      app.setLoginItemSettings({ openAtLogin: enabled })
    }
    // 系统可能静默拒绝（策略/权限），写入后必须以系统状态为准
    if (getLaunchAtLogin() !== enabled) {
      throw new Error('系统未接受开机自启设置，请检查系统权限或安全策略')
    }
    log.info(`已${enabled ? '开启' : '关闭'}开机自启`)
  } catch (err) {
    log.error('设置开机自启失败', err)
    throw new Error('无法修改开机自启设置，请检查系统权限后重试')
  }
}

/** 启动时把用户设置同步到系统，防止重装 / 换便携目录后与系统状态脱节 */
export function syncLaunchAtLogin(enabled: boolean): void {
  if (getLaunchAtLogin() === enabled) return
  try {
    setLaunchAtLogin(enabled)
  } catch {
    /* 同步失败不阻塞启动，用户可在设置里手动重试 */
  }
}

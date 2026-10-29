import type { DiffReport } from '../../shared/sync'

/**
 * 自动同步的决策规则（纯函数，便于单测）。
 *
 * 引擎本身要碰 Electron、文件系统与 store，很难直接测；
 * 但真正容易出错的判断都在这里：什么时候该跳过、什么时候该暂停、什么时候可以覆盖。
 */

export type PullDecision =
  /** 内容指纹与上次处理过的一致：自己写出去的文件又触发了 watcher，什么都不做 */
  | 'skip'
  /** 内容不同但本地无需变更：只记账，不写盘 */
  | 'record'
  /** 有变更且无风险：直接应用 */
  | 'apply'
  /** 有风险且开启了暂停：等人工确认 */
  | 'pause'

export interface PullInput {
  remoteHash: string
  lastPulledHash?: string
  report: DiffReport
  pauseOnRisky: boolean
}

export function changedCount(report: DiffReport): number {
  return report.counts.add + report.counts.update + report.counts.delete
}

export function riskyCount(report: DiffReport): number {
  return report.risky.overwriteNewer + report.risky.deleteLocal
}

export function decidePull(input: PullInput): PullDecision {
  if (input.lastPulledHash && input.remoteHash === input.lastPulledHash) return 'skip'
  const changed = changedCount(input.report)
  if (changed === 0) return 'record'
  if (riskyCount(input.report) > 0 && input.pauseOnRisky) return 'pause'
  return 'apply'
}

/** 本机内容与「上次写出去的内容」一致就没必要再写一次，避免自我回声 */
export function shouldPush(
  currentHash: string,
  lastPushedHash?: string,
  remoteExists = true
): boolean {
  // 远端文件被删掉了：内容哈希虽然没变，但同步位置已经没有这个文件，
  // 必须重新写一份回去，否则它会一直缺失（用户手动删文件后遇到的正是这个）
  if (!remoteExists) return true
  return !lastPushedHash || currentHash !== lastPushedHash
}

/** 把 diff 压成一句人话，用于状态栏与通知 */
export function summarizeReport(report: DiffReport): string {
  const risky = riskyCount(report)
  const changed = changedCount(report)
  if (changed === 0) return '已是最新，无需同步'
  const parts = [`将应用 ${changed} 项变更`]
  if (report.risky.overwriteNewer > 0) {
    parts.push(`${report.risky.overwriteNewer} 项本机改动较新会被覆盖`)
  }
  if (report.risky.deleteLocal > 0) {
    parts.push(`${report.risky.deleteLocal} 项本机独有条目会被删除`)
  }
  return risky > 0 ? parts.join('，') : parts[0]
}

/**
 * 推送到同步位置之前，要不要先问人一句。
 *
 * 原则：**破坏性操作由人决定，机器不自己替人做主**。
 *  - 口令对不上：云端那份解不开，本机配置不该去覆盖它 → 交给人
 *  - 云端是明文包而本机有口令：推上去会把云端变成密文，对方设备就读不到了 → 也要问
 */
export type PushGate = 'push' | 'need-password' | 'need-plaintext-confirm'

export interface PushGateInput {
  /** 本机内容是否有变化需要推送 */
  needPush: boolean
  /** 云端是加密包，但本机口令解不开 */
  passwordMismatch: boolean
  /** 本机是否设了口令 */
  password?: string
  /** 云端包是否加密（undefined 表示云端还没有文件） */
  remoteEncrypted?: boolean
  /** 用户已经确认过「允许把云端变成密文」 */
  allowPlaintextUpgrade: boolean
}

export function decidePushGate(input: PushGateInput): PushGate {
  if (input.passwordMismatch) return 'need-password'
  if (
    input.needPush &&
    input.password &&
    input.remoteEncrypted === false &&
    !input.allowPlaintextUpgrade
  ) {
    return 'need-plaintext-confirm'
  }
  return 'push'
}

/**
 * 本机是否「什么都没有」。
 *
 * 只有主机、片段、转发规则都为空才算空——光有偏好设置差异不算，
 * 说明这台机器已经用过了，不该被云端内容整个覆盖。
 */
export function isLocalEmpty(snapshot: {
  hosts?: unknown[]
  snippets?: unknown[]
  tunnels?: unknown[]
}): boolean {
  return (
    (snapshot.hosts?.length ?? 0) === 0 &&
    (snapshot.snippets?.length ?? 0) === 0 &&
    (snapshot.tunnels?.length ?? 0) === 0
  )
}

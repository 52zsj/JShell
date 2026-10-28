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
export function shouldPush(currentHash: string, lastPushedHash?: string): boolean {
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

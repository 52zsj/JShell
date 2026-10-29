import type { SessionCloseReason, SessionStatus } from '@shared/types'

/**
 * 断线后要不要自动重连。
 *
 * 这是「重连」这件事上唯一需要判断的地方，所以抽成纯函数，用单测盯住。
 *
 * 规则（用户拍板）：
 *  - **用户主动退出（敲 exit / 关掉终端）→ 绝不重连**，否则敲完 exit 又被连上
 *  - 认证失败、主机指纹变更 → 不重试：只会反复失败、反复弹窗
 *  - 网络断开、超时、原因未知 → 退避重连
 */
export function shouldAutoReconnect(
  status: SessionStatus,
  reason: SessionCloseReason | undefined,
  retry: number,
  maxRetry: number
): boolean {
  if (status !== 'closed' && status !== 'error') return false
  if (reason === 'user-exit' || reason === 'auth' || reason === 'hostkey') return false
  return retry < maxRetry
}

/** 第 retry 次重试该等多久（毫秒）；数组长度即最大重试次数 */
export function reconnectDelay(delays: readonly number[], retry: number): number {
  if (delays.length === 0) return 0
  return delays[Math.min(Math.max(retry, 0), delays.length - 1)]
}

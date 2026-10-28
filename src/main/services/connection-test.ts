import { mapErrorToChinese } from '../../shared/errors'
import type { ConnectionTestResult, HostDraft, HostProfile } from '../../shared/types'
import { openSshClient } from './ssh-connect'
import type { StoreService } from './store'

function asProfile(draft: HostDraft): HostProfile {
  const now = Date.now()
  return {
    id: draft.id ?? 'test',
    name: draft.name || draft.host,
    host: draft.host.trim(),
    port: draft.port,
    username: draft.username.trim(),
    authType: draft.authType,
    privateKeyPath: draft.privateKeyPath,
    proxyJump: draft.proxyJump,
    group: draft.group,
    color: draft.color,
    createdAt: now,
    updatedAt: now
  }
}

/**
 * 保存前测试连接。
 * 使用草稿里的地址/端口/账号与「尚未保存」的口令建立一次性连接，
 * 不写入主机配置、不记录指纹（指纹校验逻辑在 ssh-connect 里共用）。
 */
export async function testHostConnection(
  draft: HostDraft,
  store: StoreService
): Promise<ConnectionTestResult> {
  const started = Date.now()
  let client: Awaited<ReturnType<typeof openSshClient>> | undefined
  let jump: Awaited<ReturnType<typeof openSshClient>> | undefined

  try {
    if (!draft.host?.trim()) throw new Error('请填写主机地址')
    if (!Number.isInteger(draft.port) || draft.port < 1 || draft.port > 65535) {
      throw new Error('端口需为 1–65535 的整数')
    }
    if (!draft.username?.trim()) throw new Error('请填写用户名')

    const host = asProfile(draft)
    let sock: import('ssh2').ClientChannel | undefined

    if (draft.proxyJump) {
      const jumpHost = store.getHost(draft.proxyJump)
      if (!jumpHost) throw new Error('所选跳板机不存在，请重新选择')
      jump = await openSshClient(jumpHost, store)
      sock = await new Promise<import('ssh2').ClientChannel>((resolve, reject) => {
        jump!.forwardOut('127.0.0.1', 0, host.host, host.port, (err, stream) =>
          err ? reject(err) : resolve(stream)
        )
      })
    }

    client = await openSshClient(
      host,
      store,
      { password: draft.password, passphrase: draft.passphrase },
      sock
    )

    return {
      ok: true,
      message: `连接成功，认证通过（${Date.now() - started} ms）`,
      latencyMs: Date.now() - started
    }
  } catch (err) {
    const message = mapErrorToChinese(err, '连接测试失败')
    return { ok: false, message, latencyMs: 0 }
  } finally {
    try {
      client?.end()
    } catch {
      /* 忽略关闭异常 */
    }
    try {
      jump?.end()
    } catch {
      /* 忽略关闭异常 */
    }
  }
}

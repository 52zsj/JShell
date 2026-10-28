import fs from 'node:fs/promises'
import os from 'node:os'
import { Client } from 'ssh2'
import type { ClientChannel, ConnectConfig } from 'ssh2'
import { expandUserPath } from '../../shared/paths'
import type { HostProfile } from '../../shared/types'
import { fingerprintOf, hostKeyAlgorithm } from './ssh-fingerprint'
import type { StoreService } from './store'

/**
 * SSH 连接装配（连接测试、自动同步等「非会话」用途共用）。
 *
 * 与会话层的区别：这里的指纹校验是**只读**的——
 * 后台任务不应该在用户不知情时把新指纹写进信任库，
 * 只做「已知且不一致就拒绝」，未知则放行（与首次连接的 TOFU 语义一致）。
 */

export interface SshConnectOverride {
  password?: string
  passphrase?: string
}

export const SSH_TIMEOUT_MS = 10_000

export { fingerprintOf } from './ssh-fingerprint'

/** 省略 timeout 时会话用 20s，后台任务用 SSH_TIMEOUT_MS */
export async function buildSshConfig(
  host: HostProfile,
  store: StoreService,
  override: SshConnectOverride = {},
  timeoutMs = SSH_TIMEOUT_MS
): Promise<ConnectConfig> {
  const saved = host.id ? store.getCredentials(host.id) : {}
  const password = override.password || saved.password
  const passphrase = override.passphrase || saved.passphrase

  const cfg: ConnectConfig = {
    host: host.host,
    port: host.port,
    username: host.username,
    readyTimeout: timeoutMs,
    keepaliveInterval: 15_000,
    keepaliveCountMax: 3,
    tryKeyboard: true,
    hostVerifier: (key: Buffer): boolean => {
      if (store.getSettings().hostKeyPolicy === 'ignore') return true
      const fingerprint = fingerprintOf(key)
      const algorithm = hostKeyAlgorithm(key)
      const known =
        store.getKnownHostFingerprint(`${host.host}:${host.port}:${algorithm}`) ??
        store.getKnownHostFingerprint(`${host.host}:${host.port}`)
      return !known || known === fingerprint
    }
  }

  if (host.authType === 'key') {
    if (!host.privateKeyPath) throw new Error('未配置私钥文件')
    const keyPath = expandUserPath(host.privateKeyPath, {
      home: os.homedir(),
      platform: process.platform
    })
    cfg.privateKey = await fs.readFile(keyPath)
    if (passphrase) cfg.passphrase = passphrase
  } else if (host.authType === 'agent') {
    const sock = process.env.SSH_AUTH_SOCK
    if (sock) cfg.agent = sock
    else if (process.platform === 'win32') cfg.agent = '\\\\.\\pipe\\openssh-ssh-agent'
    else throw new Error('未检测到 SSH 代理，请先启动并加载私钥')
  } else {
    if (!password) throw new Error('该主机没有保存密码，请先在主机设置里填写')
    cfg.password = password
  }

  return cfg
}

/** 建立连接并等待 ready（可注入 override 凭据与已建立的跳板通道） */
export async function openSshClient(
  host: HostProfile,
  store: StoreService,
  override: SshConnectOverride = {},
  sock?: ClientChannel
): Promise<Client> {
  const config = await buildSshConfig(host, store, override)
  if (sock) config.sock = sock
  const password = override.password || (host.id ? store.getCredentials(host.id).password : undefined)

  const client = new Client()
  if (password) {
    client.on('keyboard-interactive', (_name, _instructions, _lang, prompts, finish) => {
      finish(prompts.map(() => password))
    })
  }

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('连接超时，请检查网络或防火墙设置')),
      SSH_TIMEOUT_MS
    )
    const fail = (err: Error): void => {
      clearTimeout(timer)
      reject(err)
    }
    client.once('error', fail)
    client.once('ready', () => {
      clearTimeout(timer)
      client.removeListener('error', fail)
      // 握手完成后保留空监听，避免后续 socket 错误冒泡成未捕获异常
      client.on('error', () => undefined)
      resolve()
    })
    client.connect(config)
  })

  return client
}

export interface SshConnection {
  client: Client
  /** 有跳板机时一并返回，关闭时要一起断 */
  jump?: Client
  close(): void
}

/** 建立到主机的连接（自动处理单跳跳板机） */
export async function connectSsh(host: HostProfile, store: StoreService): Promise<SshConnection> {
  let jump: Client | undefined
  let sock: ClientChannel | undefined

  if (host.proxyJump) {
    const jumpHost = store.getHost(host.proxyJump)
    if (!jumpHost) throw new Error('所选跳板机不存在，请重新选择')
    jump = await openSshClient(jumpHost, store, {})
    sock = await new Promise<ClientChannel>((resolve, reject) => {
      jump!.forwardOut('127.0.0.1', 0, host.host, host.port, (err, stream) =>
        err ? reject(err) : resolve(stream)
      )
    })
  }

  try {
    const client = await openSshClient(host, store, {}, sock)
    return {
      client,
      jump,
      close(): void {
        try {
          client.end()
        } catch {
          /* 已断开 */
        }
        try {
          jump?.end()
        } catch {
          /* 已断开 */
        }
      }
    }
  } catch (err) {
    try {
      jump?.end()
    } catch {
      /* 已断开 */
    }
    throw err
  }
}

import fs from 'node:fs/promises'
import os from 'node:os'
import { StringDecoder } from 'node:string_decoder'
import { Client } from 'ssh2'
import type { ClientChannel, ConnectConfig, SFTPWrapper } from 'ssh2'
import { mapErrorToChinese } from '../../shared/errors'
import { expandUserPath } from '../../shared/paths'
import type { HostProfile, SessionEvent, SessionStatus } from '../../shared/types'
import { OscCwdScanner, buildShellIntegrationHook, SHELL_HOOK_MARKER } from './osc-cwd'
import { fingerprintOf, hostKeyAlgorithm } from './ssh-fingerprint'
import { OutputBuffer } from './output-buffer'
import type { StoreService } from './store'
import type { TerminalSession } from './types'

/**
 * 私钥路径展开：统一走 shared/paths。
 * macOS 支持 `~/...`；Windows 额外支持 `%USERPROFILE%\...` 与混合分隔符。
 */
function resolveKeyPath(input: string): string {
  return expandUserPath(input, { home: os.homedir(), platform: process.platform })
}

export interface SshSessionDeps {
  store: StoreService
  emit: (event: SessionEvent) => void
  hostKeyPolicy: 'tofu' | 'ignore'
}

/**
 * 一条 SSH 会话 = 一个 ssh2 Client + 一个交互 shell 通道（可选一个 SFTP 子系统）。
 *
 * 生命周期：
 *   connect() -> 握手 -> 申请 PTY 并打开 shell -> ready
 *   数据：远端 stdout -> StringDecoder -> 合并缓冲 -> onEvent('data') -> xterm.write
 *   输入：xterm.onData -> write() -> stream.write
 *   关闭：stream.close()/client.end() -> onEvent('status: closed')
 */
export class SshSession implements TerminalSession {
  readonly id: string
  readonly kind = 'ssh' as const
  readonly host: HostProfile
  private readonly deps: SshSessionDeps
  private readonly decoder = new StringDecoder('utf8')
  private readonly output: OutputBuffer
  private readonly oscScanner = new OscCwdScanner()
  private lastCwd = ''
  private hookSent = false
  private client?: Client
  private jumpClient?: Client
  private stream?: ClientChannel
  private sftpPromise?: Promise<SFTPWrapper>
  private lastSize = { cols: 80, rows: 24 }
  private status: SessionStatus = 'connecting'
  private closed = false
  /** 用户主动关闭（区别于网络中断）：关闭后不再上报错误，避免关闭标签页时弹提示 */
  private closing = false

  constructor(id: string, host: HostProfile, deps: SshSessionDeps) {
    this.id = id
    this.host = host
    this.deps = deps
    this.output = new OutputBuffer((data) =>
      this.deps.emit({ type: 'data', sessionId: this.id, data })
    )
  }

  /** 标签页标题 / 副标题，供渲染层直接使用 */
  get title(): string {
    return this.host.name || this.host.host
  }

  get subtitle(): string {
    return `${this.host.username}@${this.host.host}:${this.host.port}`
  }

  // ------------------------------------------------------------------ 事件

  private emit(event: SessionEvent): void {
    this.deps.emit(event)
  }

  private emitStatus(status: SessionStatus, message?: string): void {
    this.status = status
    this.emit({ type: 'status', sessionId: this.id, status, message })
  }

  // ------------------------------------------------------------ 连接参数

  private async buildConfigFor(host: HostProfile): Promise<ConnectConfig> {
    const { store, hostKeyPolicy } = this.deps
    const creds = store.getCredentials(host.id)
    const cfg: ConnectConfig = {
      host: host.host,
      port: host.port,
      username: host.username,
      readyTimeout: 20_000,
      keepaliveInterval: 15_000,
      keepaliveCountMax: 3,
      // 部分服务器只开放 keyboard-interactive，这里允许其复用已保存的口令
      tryKeyboard: true,
      hostVerifier: (key: Buffer): boolean => {
        if (hostKeyPolicy === 'ignore') return true
        // 用公钥做 SHA256 指纹（base64 无 padding，等价于 ssh-keygen -lf 的展示形式）
        const fingerprint = fingerprintOf(key)
        const algorithm = hostKeyAlgorithm(key)
        const knownKey = `${host.host}:${host.port}:${algorithm}`
        const legacyKey = `${host.host}:${host.port}`
        // 优先按算法匹配；升级自 v1 时回退到旧的 host:port 记录，避免静默重新 TOFU
        const known = store.getKnownHostFingerprint(knownKey) ?? store.getKnownHostFingerprint(legacyKey)
        if (!known) {
          // TOFU：首次连接即信任并记录，后续指纹变化则拒绝（防中间人）
          store.setKnownHostFingerprint(knownKey, fingerprint)
          return true
        }
        if (known === fingerprint) {
          store.setKnownHostFingerprint(knownKey, fingerprint)
          return true
        }

        // 记录不匹配详情，交给渲染层弹窗决定「信任新指纹」还是放弃连接
        this.emit({
          type: 'hostkey',
          sessionId: this.id,
          host: host.host,
          port: host.port,
          algorithm,
          known,
          actual: fingerprint
        })
        return false
      }
    }

    if (host.authType === 'key') {
      if (!host.privateKeyPath) throw new Error('未配置私钥文件')
      const keyPath = resolveKeyPath(host.privateKeyPath)
      cfg.privateKey = await fs.readFile(keyPath)
      if (creds.passphrase) cfg.passphrase = creds.passphrase
    } else if (host.authType === 'agent') {
      const sock = process.env.SSH_AUTH_SOCK
      if (sock) {
        cfg.agent = sock
      } else if (process.platform === 'win32') {
        // Windows OpenSSH Agent 使用命名管道，不设置 SSH_AUTH_SOCK
        cfg.agent = '\\\\.\\pipe\\openssh-ssh-agent'
      } else {
        throw new Error('未检测到 ssh-agent，请先启动并 ssh-add 私钥')
      }
    } else {
      if (!creds.password) throw new Error('未保存密码，请编辑主机重新填写')
      cfg.password = creds.password
    }

    return cfg
  }

  // ------------------------------------------------------------------ 连接

  /** 建立跳板机连接，并返回一条到目标主机的转发通道 */
  private async openJump(jump: HostProfile): Promise<ClientChannel> {
    const config = await this.buildConfigFor(jump)
    const client = new Client()
    this.jumpClient = client

    client.on('keyboard-interactive', (_name, _instructions, _lang, prompts, finish) => {
      const password = this.deps.store.getCredentials(jump.id).password ?? ''
      finish(prompts.map(() => password))
    })

    return new Promise<ClientChannel>((resolve, reject) => {
      const fail = (err: Error): void => {
        client.end()
        reject(err)
      }
      client.once('error', fail)
      client.once('ready', () => {
        client.forwardOut('127.0.0.1', 0, this.host.host, this.host.port, (err, stream) => {
          if (err) {
            fail(err)
            return
          }
          client.removeListener('error', fail)
          client.on('error', () => undefined)
          resolve(stream)
        })
      })
      client.connect(config)
    })
  }

  async connect(size: { cols: number; rows: number }): Promise<void> {
    this.lastSize = size
    this.emitStatus('connecting')

    let jumpSock: ClientChannel | undefined
    if (this.host.proxyJump) {
      const jump = this.deps.store.getHost(this.host.proxyJump)
      if (!jump) throw new Error('跳板机不存在，请重新选择')
      try {
        jumpSock = await this.openJump(jump)
      } catch (err) {
        if (!this.closing) this.emitStatus('error', `跳板机连接失败：${this.describeError(err as Error)}`)
        this.close()
        throw err
      }
    }

    const client = new Client()
    this.client = client

    let settled = false
    let settle: (err?: Error) => void = () => {}
    const handshake = new Promise<void>((resolve, reject) => {
      settle = (err?: Error) => {
        if (settled) return
        settled = true
        if (err) reject(err)
        else resolve()
      }
    })

    // 服务器要求交互式认证时，直接用已保存的密码应答
    client.on('keyboard-interactive', (_name, _instructions, _lang, prompts, finish) => {
      const password = this.deps.store.getCredentials(this.host.id).password ?? ''
      finish(prompts.map(() => password))
    })

    client.on('ready', () => settle())
    client.on('error', (err: Error & { level?: string }) => {
      settle(err)
      if (this.status === 'ready') {
        // 握手后出现的错误（如网络中断）直接反映到该标签页
        this.emitStatus('error', this.describeError(err))
      }
    })
    client.on('close', () => {
      settle(new Error('SSH 连接在握手完成前被关闭'))
      this.handleClose()
    })

    try {
      const config = await this.buildConfigFor(this.host)
      if (jumpSock) config.sock = jumpSock
      client.connect(config)
    } catch (err) {
      settle(err as Error)
    }

    try {
      await handshake
    } catch (err) {
      if (!this.closing) this.emitStatus('error', this.describeError(err as Error))
      this.close()
      throw err
    }

    // 握手期间用户已经关闭标签页，无需再申请 PTY
    if (this.closed) return

    // 打开交互式 shell（请求 PTY，使远端程序能拿到窗口尺寸与 TERM）
    let stream: ClientChannel
    try {
      stream = await new Promise<ClientChannel>((resolve, reject) => {
        client.shell(
          {
            term: 'xterm-256color',
            cols: this.lastSize.cols,
            rows: this.lastSize.rows
          },
          { env: { LANG: 'en_US.UTF-8', COLORTERM: 'truecolor' } },
          (err, channel) => (err ? reject(err) : resolve(channel))
        )
      })
    } catch (err) {
      const message = this.describeError(err as Error)
      if (!this.closing) this.emitStatus('error', message)
      this.close()
      throw new Error(message)
    }

    this.stream = stream
    this.emitStatus('ready')

    // 必须先接管输出：无论是否注入目录上报 hook，数据 / 关闭监听都要挂上。
    // （此前这里在「关闭自动跟随」时提前 return，把这几个监听也一起跳过了，
    //   结果终端既看不到任何输出、也无法正常交互。）
    stream.on('data', (chunk: Buffer) => this.pushOutput(this.decoder.write(chunk)))
    stream.stderr.on('data', (chunk: Buffer) => this.pushOutput(this.decoder.write(chunk)))
    stream.on('close', () => {
      this.flushOutput()
      this.handleClose()
    })

    // 注入一次 OSC 7 hook：让远端 bash/zsh 在每个提示符前上报当前目录，
    // 目录树据此跟随 cd 实时刷新（幂等，重复连接不会叠加）。
    // 关闭「自动跟随目录」时不注入——目录树退回手动浏览，终端照常可用。
    if (!this.hookSent) {
      this.hookSent = true
      if (this.deps.store.getSettings().autoFollowCwd) {
        // 等登录横幅打印完再注入一次。单条命令、不碰 stty（关回显后若恢复失败，
        // 远端会一直不回显，终端看起来就像死了一样）；命令回显由客户端按标记整行剔除，
        // 末尾的 printf '\r' 让新提示符覆盖旧提示符，登录后只看到一个干净提示符。
        setTimeout(() => {
          if (this.closed) return
          this.oscScanner.suppressEcho(SHELL_HOOK_MARKER)
          this.write(buildShellIntegrationHook() + '\r')
        }, 450)
      }
    }
  }

  /** 把 ssh2 的英文报错翻译成对用户更友好的提示 */
  private describeError(err: Error & { level?: string }): string {
    const msg = err.message || String(err)
    if (/Host key verification failed|hostVerifier/i.test(msg)) {
      return '主机指纹校验失败：远端公钥与本地记录不一致。若确认服务器已重装，请删除该主机后重新添加以重置指纹。'
    }
    if (/ENOTFOUND|getaddrinfo/i.test(msg)) return `无法解析主机名：${this.host.host}`
    if (/ECONNREFUSED/i.test(msg)) return `连接被拒绝：${this.host.host}:${this.host.port}`
    return mapErrorToChinese(err, 'SSH 连接失败')
  }

  // -------------------------------------------------------------- 数据链路

  private pushOutput(text: string): void {
    const { cleaned, cwd } = this.oscScanner.feed(text)
    if (cwd && cwd !== this.lastCwd) {
      this.lastCwd = cwd
      this.emit({ type: 'cwd', sessionId: this.id, cwd })
    }
    if (cleaned) this.output.push(cleaned)
  }

  private flushOutput(): void {
    this.output.flush()
  }

  /** 键盘输入 -> 远端 stdin */
  write(data: string): void {
    if (!this.stream || this.closed) return
    this.stream.write(data)
  }

  /** 窗口尺寸变化 -> 远端 PTY */
  resize(cols: number, rows: number): void {
    this.lastSize = { cols, rows }
    this.stream?.setWindow(rows, cols, 0, 0)
  }

  // ------------------------------------------------------------------ SFTP

  /** 懒加载 SFTP 子系统：同一个连接内复用，避免重复开子通道 */
  async sftp(): Promise<SFTPWrapper> {
    if (!this.client || this.closed) throw new Error('会话已关闭')
    if (!this.sftpPromise) {
      const client = this.client
      this.sftpPromise = new Promise<SFTPWrapper>((resolve, reject) => {
        client.sftp((err, sftp) => (err ? reject(err) : resolve(sftp)))
      })
      // 失败后允许下次重试
      this.sftpPromise.catch(() => {
        this.sftpPromise = undefined
      })
    }
    return this.sftpPromise
  }

  /** 供端口转发使用 */
  getClient(): Client {
    if (!this.client || this.closed) throw new Error('会话已关闭')
    return this.client
  }

  // ------------------------------------------------------------------ 关闭

  private handleClose(): void {
    if (this.closed) return
    this.closed = true
    this.output.dispose()
    this.sftpPromise = undefined
    if (!this.closing) this.emitStatus('closed')
  }

  close(): void {
    if (this.closed) return
    this.closing = true
    try {
      this.stream?.close()
    } catch {
      /* 忽略重复关闭 */
    }
    try {
      this.client?.end()
    } catch {
      /* 忽略重复关闭 */
    }
    try {
      this.jumpClient?.end()
    } catch {
      /* 忽略重复关闭 */
    }
    this.jumpClient = undefined
    this.handleClose()
  }
}

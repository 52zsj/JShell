import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { app } from 'electron'
import type {
  HostProfile,
  RsyncCapability,
  RsyncEndpoint,
  RsyncPlan,
  RsyncProbeResult,
  RsyncTask
} from '../../shared/types'
import { expandUserPath } from '../../shared/paths'
import {
  buildRsyncArgs,
  buildSshCommand,
  parseProgressLine,
  summarizeRsyncError
} from '../../shared/rsync'
import { log } from './logger'
import type { StoreService } from './store'

interface InternalTask {
  task: RsyncTask
  child?: ChildProcess
  canceled: boolean
  tempDir?: string
}

function nowText(): string {
  return new Date().toISOString()
}

/**
 * rsync 同步服务。
 *
 * 只负责「拼参数 + 起进程 + 解析进度 + 重试」，UI 通过 evt:rsync 订阅任务。
 * 服务器之间采用本机中转（A -> 临时目录 -> B），两段都能断点续传，
 * 避免把 B 的凭据交给 A 这种高危做法。
 */
export class RsyncService {
  private readonly store: StoreService
  private readonly emit: (task: RsyncTask) => void
  private readonly tasks = new Map<string, InternalTask>()
  private capability: RsyncCapability | null = null

  constructor(store: StoreService, emit: (task: RsyncTask) => void) {
    this.store = store
    this.emit = emit
  }

  /** 本机没装 rsync 时给出与平台匹配的安装建议，别在 Windows 上只说 brew */
  private installHint(): string {
    if (process.platform === 'win32') {
      return '本机未安装 rsync：Windows 可安装 cwRsync（或 choco install rsync）后重启应用；不装也可用「文件」面板走 SFTP 传输'
    }
    if (process.platform === 'darwin') {
      return '本机未安装 rsync：macOS 可用 brew install rsync'
    }
    return '本机未安装 rsync：Linux 可用 apt install rsync / dnf install rsync'
  }

  check(): Promise<RsyncCapability> {
    if (this.capability) return Promise.resolve(this.capability)
    return new Promise((resolve) => {
      const binary = this.resolveRsyncBinary()
      log.info(`检测本机 rsync：${binary}`)
      execFile(binary, ['--version'], { timeout: 4000 }, (err, stdout) => {
        if (err) {
          log.warn('rsync 检测失败', {
            code: (err as NodeJS.ErrnoException).code,
            message: err.message,
            path: process.env.PATH?.split(path.delimiter).slice(0, 10).join(' | ')
          })
          this.capability = {
            available: false,
            version: '',
            progress2: false,
            appendVerify: false,
            protectArgs: false,
            binary
          }
          resolve(this.capability)
          return
        }
        const first = String(stdout).split('\n')[0] ?? ''
        const version = /(\d+\.\d+(?:\.\d+)?)/.exec(first)?.[1] ?? ''
        log.info(`rsync 版本：${version}`)
        const major = Number(version.split('.')[0] || 0)
        const minor = Number(version.split('.')[1] || 0)
        this.capability = {
          available: true,
          version,
          progress2: major > 3 || (major === 3 && minor >= 1),
          appendVerify: major >= 3,
          protectArgs: major >= 3,
          binary
        }
        resolve(this.capability)
      })
    })
  }

  /** 盘符列表缓存：探测一次即可，避免每次同步都扫一遍（断开的网络盘会阻塞） */
  private drivesCache: string[] | null = null

  /**
   * 枚举 Windows 可用盘符。
   *
   * 从 C 开始（A/B 是软驱位，探测可能卡住），结果缓存复用：
   * 每次 rsync 任务都会调用，重复探测断开的网络映射盘会带来秒级卡顿。
   */
  private enumerateDrives(): string[] {
    if (this.drivesCache) return this.drivesCache
    const drives: string[] = []
    for (let i = 67; i <= 90; i++) {
      const letter = String.fromCharCode(i)
      try {
        if (fs.existsSync(`${letter}:\\`)) drives.push(`${letter}:`)
      } catch {
        /* 不可访问的盘符跳过 */
      }
    }
    this.drivesCache = drives.length > 0 ? drives : ['C:']
    log.info(`检测到盘符：${this.drivesCache.join(', ')}`)
    return this.drivesCache
  }

  /** 解析 rsync 可执行文件：扫描所有盘符的常见安装位置 */
  private resolveRsyncBinary(): string {
    if (process.platform !== 'win32') return 'rsync'
    const candidates: string[] = []
    for (const drive of this.enumerateDrives()) {
      candidates.push(path.join(drive, 'Program Files', 'cwRsync', 'bin', 'rsync.exe'))
      candidates.push(path.join(drive, 'Program Files (x86)', 'cwRsync', 'bin', 'rsync.exe'))
      candidates.push(path.join(drive, 'cwRsync', 'bin', 'rsync.exe'))
    }
    for (const candidate of candidates) {
      try {
        if (fs.existsSync(candidate)) {
          log.info(`使用 rsync：${candidate}`)
          return candidate
        }
      } catch {
        /* 继续尝试 */
      }
    }
    return 'rsync'
  }

  /** 用一条一次性 ssh 命令探测远端 rsync，避免跑到执行页才发现没装 */
  async probe(hostId: string): Promise<RsyncProbeResult> {
    const host = this.store.getHost(hostId)
    if (!host) return { ok: false, message: '主机不存在，请重新选择' }

    const capability = await this.check()
    if (!capability.available) {
      return { ok: false, message: this.installHint() }
    }

    const key = this.keyPathOf(host)
    const args = [
      '-p',
      String(host.port),
      '-o',
      'StrictHostKeyChecking=accept-new',
      '-o',
      'ConnectTimeout=10',
      '-o',
      `UserKnownHostsFile=${this.knownHostsPath()}`
    ]
    if (key) args.push('-i', key)
    args.push(`${host.username}@${host.host}`, 'command -v rsync')

    const secrets = await this.askpass(`probe-${randomUUID()}`, host)
    const sshBinary = this.resolveSshBinary()
    log.info(`SSH 探测：${sshBinary} ${args.join(' ')}`)
    return new Promise<RsyncProbeResult>((resolve) => {
      const child = execFile(
        sshBinary,
        args,
        {
          env: { ...process.env, ...secrets.env },
          timeout: 12_000
        },
        (err, stdout, stderr) => {
          secrets.cleanup()
          // 记录完整错误，便于排查 Windows 环境问题
          if (err) {
            const e = err as NodeJS.ErrnoException & { signal?: string }
            log.warn('SSH 探测失败', {
              code: e.code,
              signal: e.signal,
              message: err.message,
              stderr: String(stderr).slice(0, 500),
              stdout: String(stdout).slice(0, 200)
            })
          }
          // 只要 stdout 里拿到了可执行路径就算成功：
          // 个别服务端 / 跳板会在通道关闭时把退出码写成 255，但命令其实执行成功
          const found =
            String(stdout)
              .split('\n')
              .map((line) => line.trim())
              .filter(Boolean)
              .pop() ?? ''
          if (found && !/^(bash|sh|zsh):/i.test(found)) {
            resolve({ ok: true, path: found, message: `远端已安装 rsync：${found}` })
            return
          }
          // execFile 层面失败（ENOENT = 找不到 ssh）
          const errno = (err as NodeJS.ErrnoException)?.code
          if (errno === 'ENOENT') {
            resolve({
              ok: false,
              message: '找不到 ssh 命令：请确认 Windows OpenSSH 客户端已安装并加入 PATH'
            })
            return
          }
          resolve({
            ok: false,
            message: err
              ? summarizeRsyncError(String(stderr) || err.message)
              : summarizeRsyncError('bash: rsync: 未找到命令')
          })
        }
      )
      // 关闭 stdin：SSH 没有 TTY 时如果 stdin 是 pipe 会一直等输入，
      // 必须关掉才能让它走 SSH_ASKPASS
      child.stdin?.end()
    })
  }

  /** 解析 ssh：优先 cwRsync 自带（与 rsync 配套），再找 Windows OpenSSH，最后 PATH */
  private resolveSshBinary(): string {
    if (process.platform !== 'win32') return 'ssh'

    const candidates: string[] = []
    // 1. cwRsync 自带的 ssh（与 rsync 同目录，配套使用）
    for (const drive of this.enumerateDrives()) {
      candidates.push(path.join(drive, 'Program Files', 'cwRsync', 'bin', 'ssh.exe'))
      candidates.push(path.join(drive, 'Program Files (x86)', 'cwRsync', 'bin', 'ssh.exe'))
      candidates.push(path.join(drive, 'cwRsync', 'bin', 'ssh.exe'))
    }
    // 2. Windows 自带 OpenSSH（备选）
    const sysRoot = process.env.SystemRoot ?? 'C:\\Windows'
    candidates.push(path.join(sysRoot, 'System32', 'OpenSSH', 'ssh.exe'))
    // 3. Git
    candidates.push(path.join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'Git', 'usr', 'bin', 'ssh.exe'))

    for (const candidate of candidates) {
      try {
        if (fs.existsSync(candidate)) {
          log.info(`使用 ssh：${candidate}`)
          return candidate
        }
      } catch {
        /* 继续尝试 */
      }
    }
    log.warn('未找到 ssh.exe，尝试 PATH')
    return 'ssh'
  }

  async start(plan: RsyncPlan): Promise<RsyncTask> {
    const capability = await this.check()
    if (!capability.available) {
      throw new Error(this.installHint())
    }
    this.validate(plan)

    const id = randomUUID()
    const task: RsyncTask = {
      id,
      plan,
      status: 'running',
      percent: -1,
      transferred: 0,
      total: 0,
      speed: '',
      eta: '',
      attempt: 1,
      stage: plan.direction === 'relay' ? '准备中转目录' : '连接中',
      startedAt: Date.now()
    }
    const internal: InternalTask = { task, canceled: false }
    this.tasks.set(id, internal)
    this.publish(internal)

    void this.run(internal, capability).catch((err) => {
      this.finish(internal, 'error', err instanceof Error ? err.message : String(err))
    })

    return task
  }

  cancel(taskId: string): void {
    const internal = this.tasks.get(taskId)
    if (!internal) return
    internal.canceled = true
    internal.child?.kill('SIGTERM')
    this.finish(internal, 'canceled', '已取消')
  }

  private validate(plan: RsyncPlan): void {
    if (!plan || typeof plan !== 'object') throw new Error('同步参数无效')
    const endpointOk = (endpoint?: RsyncEndpoint): boolean =>
      !!endpoint &&
      typeof endpoint.path === 'string' &&
      endpoint.path.trim().length > 0 &&
      (endpoint.kind === 'local' || (endpoint.kind === 'host' && !!endpoint.hostId))
    if (!endpointOk(plan.source) || !endpointOk(plan.target)) throw new Error('请填写源与目标路径')
    if (plan.source.kind === 'local' && plan.target.kind === 'local') {
      throw new Error('源与目标不能都是本机路径')
    }
    if (plan.source.kind === 'host' && plan.target.kind === 'host' && plan.source.hostId === plan.target.hostId) {
      // 同一台机器之间同步用不到中转，直接提示更清楚
      throw new Error('源与目标是同一台主机，请直接在本机操作')
    }
  }

  private publish(internal: InternalTask): void {
    this.emit({ ...internal.task })
  }

  private finish(internal: InternalTask, status: RsyncTask['status'], message?: string): void {
    if (internal.task.status === 'done' || internal.task.status === 'error' || internal.task.status === 'canceled') {
      return
    }
    internal.task.status = status
    internal.task.message = message
    internal.task.finishedAt = Date.now()
    if (status === 'done' && internal.task.percent < 0) internal.task.percent = 100
    this.publish(internal)
    if (internal.tempDir) {
      fs.promises.rm(internal.tempDir, { recursive: true, force: true }).catch(() => undefined)
      internal.tempDir = undefined
    }
  }

  private async run(internal: InternalTask, capability: RsyncCapability): Promise<void> {
    const { plan } = internal.task
    if (plan.direction === 'relay') {
      const tempDir = path.join(app.getPath('temp'), 'jshell-rsync', internal.task.id)
      await fs.promises.mkdir(tempDir, { recursive: true })
      internal.tempDir = tempDir

      const sourceHost = this.hostOf(plan.source)
      const targetHost = this.hostOf(plan.target)
      internal.task.stage = '第 1/2 段：下载到本机中转'
      this.publish(internal)
      await this.runLeg(internal, capability, plan, plan.source, { kind: 'local', path: `${tempDir}/` }, sourceHost)

      internal.task.stage = '第 2/2 段：从中转上传到目标'
      internal.task.percent = -1
      internal.task.transferred = 0
      this.publish(internal)
      await this.runLeg(
        internal,
        capability,
        plan,
        { kind: 'local', path: `${tempDir}/` },
        plan.target,
        targetHost
      )
    } else {
      internal.task.stage = plan.direction === 'upload' ? '上传中' : '下载中'
      this.publish(internal)
      await this.runLeg(
        internal,
        capability,
        plan,
        plan.source,
        plan.target,
        this.hostOf(plan.source.kind === 'host' ? plan.source : plan.target)
      )
    }

    if (internal.canceled) return
    this.finish(internal, 'done')
  }

  private hostOf(endpoint: RsyncEndpoint): HostProfile | null {
    if (endpoint.kind !== 'host' || !endpoint.hostId) return null
    const host = this.store.getHost(endpoint.hostId)
    if (!host) throw new Error('目标主机不存在，请重新选择')
    return host
  }

  /** 单段同步（含重试）；失败抛错由上层收尾 */
  private async runLeg(
    internal: InternalTask,
    capability: RsyncCapability,
    plan: RsyncPlan,
    source: RsyncEndpoint,
    target: RsyncEndpoint,
    host: HostProfile | null
  ): Promise<void> {
    const maxAttempts = Math.max(0, Math.min(5, plan.options.retries)) + 1
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (internal.canceled) return
      internal.task.attempt = attempt
      try {
        await this.spawnRsync(internal, capability, plan, source, target, host)
        return
      } catch (err) {
        if (internal.canceled) return
        if (attempt >= maxAttempts) throw err
        internal.task.status = 'retrying'
        internal.task.message = `第 ${attempt} 次失败，正在重试（${attempt}/${maxAttempts - 1}）`
        this.publish(internal)
        await new Promise((resolve) => setTimeout(resolve, Math.min(8000, 2 ** (attempt - 1) * 800)))
        internal.task.status = 'running'
        this.publish(internal)
      }
    }
  }

  private async spawnRsync(
    internal: InternalTask,
    capability: RsyncCapability,
    plan: RsyncPlan,
    source: RsyncEndpoint,
    target: RsyncEndpoint,
    host: HostProfile | null
  ): Promise<void> {
    const secrets = await this.askpass(internal.task.id, host)

    const args = buildRsyncArgs(plan, {
      capability,
      sshCommand: host ? buildSshCommand(host, this.keyPathOf(host), this.knownHostsPath(), this.resolveSshBinary()) : undefined,
      source: this.specOf(source, host, capability),
      target: this.specOf(target, host, capability)
    })

    const env: NodeJS.ProcessEnv = { ...process.env, ...secrets.env }
    if (capability.progress2) env.LC_ALL = 'C'

    await new Promise<void>((resolve, reject) => {
      let stderr = ''
      let lastEmit = 0
      const child = spawn(capability.binary, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
      internal.child = child

      const onLine = (line: string): void => {
        const parsed = parseProgressLine(line)
        if (!parsed) {
          if (line.trim()) stderr = `${stderr}${line}\n`.slice(-4000)
          return
        }
        internal.task.percent = parsed.percent
        if (parsed.transferred > 0) internal.task.transferred = parsed.transferred
        if (parsed.speed) internal.task.speed = parsed.speed
        if (parsed.eta) internal.task.eta = parsed.eta
        const stamp = Date.now()
        if (stamp - lastEmit > 300) {
          lastEmit = stamp
          this.publish(internal)
        }
      }

      let buffer = ''
      child.stdout?.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8').replace(/\r/g, '\n')
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) onLine(line)
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr = `${stderr}${chunk.toString('utf8')}`.slice(-4000)
      })

      child.on('error', (err) => {
        secrets.cleanup()
        reject(err)
      })
      child.on('close', (code) => {
        if (buffer) onLine(buffer)
        secrets.cleanup()
        internal.child = undefined
        if (internal.canceled) {
          resolve()
          return
        }
        if (code === 0) {
          this.publish(internal)
          resolve()
          return
        }
        const detail = stderr.trim().split('\n').slice(-3).join(' ')
        reject(new Error(this.describeFailure(detail || `rsync 退出码 ${code}`)))
      })
    })
  }

  /** 与用户 ~/.ssh 分离的 known_hosts，首次连接按 accept-new 记录 */
  private knownHostsPath(): string {
    return path.join(app.getPath('userData'), 'known_hosts')
  }

  private keyPathOf(host: HostProfile): string | undefined {
    if (host.authType !== 'key' || !host.privateKeyPath) return undefined
    return expandUserPath(host.privateKeyPath, { home: os.homedir(), platform: process.platform })
  }

  /**
   * Windows 上用 PowerShell 生成一个真正的 askpass.exe。
   * CreateProcess 只能执行 .exe，.cmd/.bat 不行——这是之前一直超时的根因。
   * 生成一次缓存到 tmp 目录，后续直接复用。
   */
  /**
   * 启动后预热 askpass 组件。
   *
   * Windows 首次生成要跑一次 .NET 编译（1~2 秒）。若等到用户点「同步」时才做，
   * 会同步阻塞主线程让界面卡一下。这里在窗口出来之后异步预热，用户基本无感。
   */
  async preheat(): Promise<void> {
    if (process.platform !== 'win32') return
    try {
      await this.check()
      if (!this.capability?.available) return
      const exe = path.join(app.getPath('userData'), 'tmp', 'jshell-askpass.exe')
      if (fs.existsSync(exe)) return
      log.info('预热 askpass 组件')
      await this.buildAskpassExe(exe)
    } catch (err) {
      // 预热失败不影响正常使用，实际调用时还会再试一次并给出明确错误
      log.warn('预热 askpass 失败', err)
    }
  }

  /** 异步编译 askpass.exe（失败抛错，由调用方决定如何提示） */
  private async buildAskpassExe(exe: string): Promise<void> {
    const dir = path.dirname(exe)
    fs.mkdirSync(dir, { recursive: true })
    const csFile = path.join(dir, 'jshell-askpass.cs')
    fs.writeFileSync(
      csFile,
      `using System;
public class Askpass {
    public static void Main() {
        Console.Write(Environment.GetEnvironmentVariable("JSHELL_SSH_PASSWORD") ?? "");
    }
}`
    )

    const script = `Add-Type -Path "${csFile}" -OutputAssembly "${exe}" -OutputType ConsoleApplication`
    try {
      await new Promise<void>((resolve, reject) => {
        execFile(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-Command', script],
          { timeout: 20_000, windowsHide: true },
          (err) => (err ? reject(err) : resolve())
        )
      })
    } catch (err) {
      log.error('生成 askpass.exe 失败', err)
      throw new Error('无法生成 SSH 认证组件，请确认 .NET Framework 可用')
    } finally {
      fs.rmSync(csFile, { force: true })
    }
    if (!fs.existsSync(exe)) throw new Error('askpass.exe 生成失败')
    log.info(`已生成 askpass.exe：${exe}`)
  }

  /** 远端口令 / 私钥口令通过 SSH_ASKPASS 传入，避免出现交互式等待 */
  private async askpass(taskId: string, host: HostProfile | null): Promise<{
    env: NodeJS.ProcessEnv
    cleanup: () => void
  }> {
    if (!host) return { env: {}, cleanup: () => undefined }
    const creds = this.store.getCredentials(host.id)
    const secret = host.authType === 'password' ? creds.password : creds.passphrase
    if (!secret) return { env: {}, cleanup: () => undefined }

    const isWin = process.platform === 'win32'
    let askpassPath: string

    if (isWin) {
      // 必须是真正的 .exe，CreateProcess 不认 .cmd
      askpassPath = path.join(app.getPath('userData'), 'tmp', 'jshell-askpass.exe')
      if (!fs.existsSync(askpassPath)) {
        try {
          await this.buildAskpassExe(askpassPath)
        } catch {
          return { env: {}, cleanup: () => undefined }
        }
      }
    } else {
      const dir = path.join(app.getPath('userData'), 'tmp')
      askpassPath = path.join(dir, `askpass-${taskId}.sh`)
      try {
        fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(askpassPath, '#!/bin/sh\nprintf \'%s\\n\' "$JSHELL_SSH_PASSWORD"\n', { mode: 0o700 })
      } catch {
        return { env: {}, cleanup: () => undefined }
      }
    }

    const env = {
      SSH_ASKPASS: askpassPath,
      SSH_ASKPASS_REQUIRE: 'force',
      ...(isWin ? {} : { DISPLAY: process.env.DISPLAY || ':0' }),
      JSHELL_SSH_PASSWORD: secret
    }
    log.info(`askpass：${askpassPath}`)
    return {
      env,
      cleanup: () => {
        if (!isWin) fs.promises.rm(askpassPath, { force: true }).catch(() => undefined)
      }
    }
  }

  private specOf(
    endpoint: RsyncEndpoint,
    host: HostProfile | null,
    capability: RsyncCapability
  ): string {
    if (endpoint.kind === 'local') return endpoint.path
    if (!host) throw new Error('远端主机不存在')
    // rsync 2.6.9 没有 --protect-args，远端路径要自带引号，否则含空格会被拆开
    const remotePath = capability.protectArgs
      ? endpoint.path
      : `'${endpoint.path.replace(/'/g, "'\\''")}'`
    return `${host.username}@${host.host}:${remotePath}`
  }

  private describeFailure(raw: string): string {
    const message = summarizeRsyncError(raw)
    // 原始输出只进日志，界面上只留结论
    log.warn('rsync 失败', raw.slice(0, 2000))
    return message
  }
}

// 便于日志定位：任务创建时间仅用于排查，不参与 UI
export const rsyncLogStamp = (): string => nowText()

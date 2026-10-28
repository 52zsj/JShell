import type { HostProfile, RsyncCapability, RsyncPlan } from './types'

/** 进度行里的百分比 / 速度 / 剩余时间 */
const PERCENT_RE = /(\d{1,3})%/
const SPEED_RE = /(\d+(?:[.,]\d+)?\s*[KMGTP]?B\/s)/i
const ETA_RE = /(\d+:\d{2}(?::\d{2})?)/
const SIZE_RE = /^\s*([\d.,]+)\s*([KMGTP])?B?\s/i

const UNIT: Record<string, number> = {
  '': 1,
  K: 1024,
  M: 1024 ** 2,
  G: 1024 ** 3,
  T: 1024 ** 4,
  P: 1024 ** 5
}

/** 解析一行 rsync 进度输出（2.6.9 的 --progress 与 3.1+ 的 progress2 都覆盖） */
export function parseProgressLine(
  line: string
): { percent: number; transferred: number; speed: string; eta: string } | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  const percentMatch = PERCENT_RE.exec(trimmed)
  if (!percentMatch) return null

  const percent = Math.min(100, Math.max(0, Number(percentMatch[1])))
  const speed = SPEED_RE.exec(trimmed)?.[1]?.replace(/\s+/g, '') ?? ''
  const afterPercent = trimmed.slice(percentMatch.index + percentMatch[0].length)
  const eta = ETA_RE.exec(afterPercent)?.[1] ?? ''

  let transferred = 0
  const size = SIZE_RE.exec(`${trimmed} `)
  if (size) {
    const value = Number(size[1].replace(/,/g, ''))
    if (Number.isFinite(value)) transferred = Math.round(value * (UNIT[size[2] ?? ''] ?? 1))
  }

  return { percent, transferred, speed, eta }
}

function shellQuote(value: string): string {
  return `"${value.replace(/(["\\$`])/g, '\\$1')}"`
}

/**
 * rsync 的 -e 参数是一次 ssh 调用，需要拼成单行命令。
 *
 * 固定使用 JShell 自己的 known_hosts：避免污染用户的 ~/.ssh/known_hosts，
 * 也避免与用户在终端里已有的记录互相冲突（同一台机器两套指纹会直接失败）。
 */
export function buildSshCommand(host: HostProfile, keyPath?: string, knownHostsPath?: string, sshBinary = 'ssh'): string {
  const parts = [
    sshBinary,
    '-p',
    String(host.port),
    '-o',
    'StrictHostKeyChecking=accept-new',
    '-o',
    'ConnectTimeout=15',
    '-o',
    'ServerAliveInterval=15'
  ]
  if (knownHostsPath) parts.push('-o', `UserKnownHostsFile=${shellQuote(knownHostsPath)}`)
  if (keyPath) parts.push('-i', shellQuote(keyPath))
  return parts.join(' ')
}

export interface RsyncArgContext {
  capability: RsyncCapability
  /** 可选的远端 ssh 命令（本机 <-> 远端时必须提供） */
  sshCommand?: string
  /** 传入的源与目标（已展开成本机路径或 user@host:path） */
  source: string
  target: string
}

/** 构造 rsync 参数；单独导出便于单测 */
export function buildRsyncArgs(plan: RsyncPlan, ctx: RsyncArgContext): string[] {
  const { capability } = ctx
  const args = [
    '-a',
    '--partial',
    capability.appendVerify ? '--append-verify' : '--append',
    '--human-readable'
  ]
  if (capability.progress2) args.push('--info=progress2', '--no-inc-recursive')
  else args.push('--progress')
  // 3.0+ 用 -s 让远端路径不被 shell 二次解析；旧版由调用方给路径加引号
  if (capability.protectArgs) args.push('-s')

  if (plan.options.compress) args.push('-z')
  if (plan.options.deleteExtraneous) args.push('--delete')
  for (const rule of plan.options.exclude.split(/[\n,]/).map((item) => item.trim())) {
    if (rule) args.push('--exclude', rule)
  }
  if (ctx.sshCommand) args.push('-e', ctx.sshCommand)

  args.push(ctx.source, ctx.target)
  return args
}



/**
 * 把 rsync 的原始 stderr 变成一句用户能看懂的中文。
 *
 * rsync 的错误通常是「远端 shell 报错 + 本机 rsync 再包一层 + 一段编译路径」，
 * 直接展示会非常吵；这里只保留结论与下一步动作。
 */
export function summarizeRsyncError(raw: string): string {
  // ssh 首次连接会写一条 known_hosts 提示，它不是错误，先剔掉
  const text = raw
    .replace(/^Warning: Permanently added .*$/gim, '')
    .replace(/^\s*$/gm, '')
    .replace(/\r/g, '\n')
    .replace(/[\t ]+/g, ' ')
    .trim()
  if (!text) return '无法确认远端状态：请检查网络，或在服务器上手动执行 command -v rsync'

  if (/未找到命令|command not found|rsync: not found|bash: rsync/i.test(text)) {
    return '远端未安装 rsync：请在服务器执行 apt install rsync（Debian/Ubuntu）或 yum install rsync（CentOS/RHEL）后重试，也可继续用文件面板上传下载。'
  }
  if (/Permission denied|Authentication failed|Too many authentication failures/i.test(text)) {
    return '认证或权限不足：请检查密码 / 私钥，以及目标目录是否可写。'
  }
  if (/No space left on device/i.test(text)) return '目标磁盘空间不足，请清理后重试。'
  if (/Host key verification failed/i.test(text)) {
    return '主机指纹校验失败：请先在终端里连接一次并确认指纹，再重试同步。'
  }
  if (/Could not resolve hostname|Name or service not known/i.test(text)) {
    return '无法解析主机名：请检查主机地址或 DNS。'
  }
  if (/Connection refused/i.test(text)) return '连接被拒绝：请检查端口与防火墙。'
  if (/Operation timed out|Connection timed out|timed out/i.test(text)) {
    return '连接超时：请检查网络，或把重试次数调高后重试。'
  }
  if (/unknown option|syntax or usage error/i.test(text)) {
    return '本机 rsync 版本过旧，请升级到 3.x（macOS: brew install rsync）。'
  }

  // 兜底：去掉编译路径与堆栈噪音，只留一句
  const cleaned = text
    .replace(/\/?AppleInternal\/[^\s)]*/g, '')
    .replace(/\sat\s+\/?[^\s)]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return `同步失败：${cleaned.slice(0, 180)}`
}

/**
 * 把第三方/系统错误归一化为中文。
 * 只做文本映射，不依赖 Electron，便于单测；原始错误由调用方写日志。
 */
const CODE_TEXT: Record<string, string> = {
  ENOENT: '文件或目录不存在',
  EACCES: '没有访问权限',
  EPERM: '操作被系统拒绝',
  EEXIST: '目标已存在',
  EISDIR: '目标是一个目录',
  ENOTDIR: '路径中包含非目录',
  ENOSPC: '磁盘空间不足',
  EMFILE: '打开的文件过多',
  ECONNREFUSED: '连接被拒绝',
  ECONNRESET: '连接被重置',
  ETIMEDOUT: '连接超时',
  ENOTFOUND: '无法解析主机名',
  EHOSTUNREACH: '主机不可达',
  ENETUNREACH: '网络不可达',
  EPIPE: '连接已断开'
}

const RULES: Array<[RegExp, string]> = [
  [/all configured authentication methods failed/i, '认证失败：请检查用户名、密码、私钥或 ssh-agent'],
  [/host key verification failed|hostdenied|host key.*mismatch/i, '主机公钥校验失败：远端指纹与本地记录不一致'],
  [/encrypted private key|no passphrase/i, '私钥已加密，需要填写正确的私钥口令'],
  [/cannot parse privatekey|failed to parse private key|unsupported key format/i, '无法解析私钥文件，请确认格式正确'],
  [/permission denied/i, '权限不足：远端拒绝访问该路径'],
  [/no such file|not found/i, '文件或目录不存在'],
  [/failure$/i, '远端操作失败：可能是权限或路径问题'],
  [/subsystem.*not.*available|sftp.*not.*support/i, '服务器未启用 SFTP 子系统'],
  [/timed out|timeout/i, '操作超时，请检查网络或主机状态'],
  [/socket.*closed|channel.*closed|eof/i, '连接已断开']
]

export function mapErrorToChinese(err: unknown, fallback = '操作失败'): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  if (code && CODE_TEXT[code]) return CODE_TEXT[code]
  const message = err instanceof Error ? err.message : String(err ?? '')
  for (const [pattern, text] of RULES) {
    if (pattern.test(message)) return text
  }
  return message && /[\u4e00-\u9fa5]/.test(message) ? message : `${fallback}，请查看日志获取详情`
}

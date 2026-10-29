import crypto from 'node:crypto'

/**
 * 同步口令的「指纹」。
 *
 * 为什么需要它：自动同步判断「要不要把本机配置写回远端」时，只看**内容哈希**。
 * 可一旦用户改了口令，内容一个字没变 → 哈希相同 → 判定「没变化」→ **不写**。
 * 结果远端还挂着旧口令加密的包，本机却已经用新口令了 →
 * 下次拉取必然解密失败，把自己锁死。
 *
 * 所以推送判定要额外看「口令有没有变过」。这里只存口令的指纹，不存明文，
 * 用途仅限于判断「需不需要重新写一份」。
 *
 * 固定盐是为了不让指纹能被现成的彩虹表直接命中。
 */
const PASSWORD_TAG_SALT = 'jshell-sync-password-v1:'

/** 口令指纹；没有口令时是空串 */
export function passwordTag(password: string | undefined): string {
  if (!password) return ''
  return crypto.createHash('sha256').update(PASSWORD_TAG_SALT + password).digest('hex').slice(0, 16)
}

/**
 * 口令是否与「上次推送时用的那个」不同。
 *
 * 远端文件不存在时不用管口令一不一致——文件得重建。
 */
export function passwordChanged(
  password: string | undefined,
  lastPushedPasswordTag: string | undefined
): boolean {
  return passwordTag(password) !== (lastPushedPasswordTag ?? '')
}

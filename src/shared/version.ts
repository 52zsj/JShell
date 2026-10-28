/**
 * 版本号比较（纯函数）。
 *
 * 只处理常见的 `1.2.3` / `1.2.3-beta.1` / `v1.2.3` 形式，够当前更新检查使用；
 * 不引入 semver 依赖，避免为一个小功能增加供应链面积。
 */
export function parseVersion(input: string): { core: number[]; pre: string } {
  const value = (input ?? '').trim().replace(/^v/i, '')
  const [corePart, prePart = ''] = value.split('-', 2)
  const core = corePart.split('.').map((item) => {
    const num = Number.parseInt(item, 10)
    return Number.isFinite(num) ? num : 0
  })
  while (core.length < 3) core.push(0)
  return { core: core.slice(0, 3), pre: prePart }
}

/** 返回 1 表示 a 更新，-1 表示 a 更旧，0 表示相同 */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a)
  const right = parseVersion(b)
  for (let i = 0; i < 3; i += 1) {
    if (left.core[i] !== right.core[i]) return left.core[i] > right.core[i] ? 1 : -1
  }
  // 正式版高于同号预发布版：1.0.0 > 1.0.0-beta.1
  if (left.pre === right.pre) return 0
  if (!left.pre) return 1
  if (!right.pre) return -1

  const leftPre = left.pre.split('.')
  const rightPre = right.pre.split('.')
  for (let i = 0; i < Math.max(leftPre.length, rightPre.length); i += 1) {
    const l = leftPre[i]
    const r = rightPre[i]
    if (l === undefined) return -1
    if (r === undefined) return 1
    if (l === r) continue
    const ln = /^\d+$/.test(l)
    const rn = /^\d+$/.test(r)
    if (ln && rn) return Number(l) > Number(r) ? 1 : -1
    if (ln !== rn) return ln ? -1 : 1
    return l > r ? 1 : -1
  }
  return 0
}

/** 只接受 https 链接，避免更新元信息被篡改成 file:// 或自定义协议 */
export function isSafeReleaseUrl(url: string): boolean {
  if (!url) return false
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:'
  } catch {
    return false
  }
}

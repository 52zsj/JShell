import { createHash } from 'node:crypto'

/**
 * 主机指纹的两个纯函数。
 *
 * 会话层（交互连接，指纹不匹配要弹窗）与后台连接层（连接测试、自动同步）
 * 必须算出完全一样的字符串，否则「已知指纹」判定会各说各话。
 */

/**
 * 从 SSH 公钥 blob 中解析算法名（wire format：uint32 长度 + 算法字符串）。
 * 指纹按「主机:端口:算法」分开存：同一台机器可能同时提供 rsa/ed25519，
 * 只按 host:port 记会互相覆盖并误报「指纹不一致」。
 */
export function hostKeyAlgorithm(blob: Buffer): string {
  if (blob.length < 4) return 'unknown'
  const length = blob.readUInt32BE(0)
  if (length <= 0 || length > 64 || 4 + length > blob.length) return 'unknown'
  return blob.subarray(4, 4 + length).toString('ascii')
}

/** 与 `ssh-keygen -lf` 展示一致的 SHA256 指纹（base64 无 padding） */
export function fingerprintOf(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`
}

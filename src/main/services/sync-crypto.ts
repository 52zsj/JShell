import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto'
import {
  MIN_PASSWORD_LENGTH,
  SYNC_FORMAT,
  SYNC_MAGIC,
  SYNC_VERSION,
  type SyncBundleMeta,
  type SyncBundlePayload,
  type SyncEnvelope,
  type SyncKdf
} from '../../shared/sync'

/**
 * 同步包加解密（纯 node:crypto，无第三方依赖）。
 *
 * 方案：scrypt 派生 256 位密钥 → AES-256-GCM 加密整包 JSON。
 * - salt 与 iv 每次随机，同一口令导出两次得到完全不同的密文；
 * - 把 KDF 参数与元信息放进 AAD，任何篡改（含降级 N 以加速爆破）都会导致解密失败；
 * - 不加密时也保留同样的信封结构，只是 payload 明文，便于导入方识别格式。
 */

export class SyncError extends Error {
  /** 可选的错误码，方便调用方区分「口令不对」这类可处理的错误 */
  constructor(message: string, readonly code?: string) {
    super(message)
    this.name = 'SyncError'
  }
}

/** KDF 参数上限：防止恶意文件用超大 N 拖死主进程（scrypt 对内存敏感） */
const KDF_LIMITS = {
  minN: 8192,
  maxN: 2 ** 17,
  minR: 1,
  maxR: 16,
  minP: 1,
  maxP: 4,
  keylen: 32
}

const DEFAULT_KDF = { N: 16384, r: 8, p: 1, keylen: 32 }

/**
 * 稳定序列化：按 key 排序后输出，保证同一份数据在加密端与解密端得到完全相同的字符串。
 * AAD 依赖它——若键顺序不同，合法文件也会验签失败。
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj)
    .filter((key) => obj[key] !== undefined)
    .sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`).join(',')}}`
}

function assertKdf(kdf: SyncKdf): void {
  if (kdf.name !== 'scrypt') throw new SyncError('不支持的密钥派生算法')
  if (!Number.isInteger(kdf.N) || kdf.N < KDF_LIMITS.minN || kdf.N > KDF_LIMITS.maxN) {
    throw new SyncError('同步包的密钥参数不合法')
  }
  if ((kdf.N & (kdf.N - 1)) !== 0) throw new SyncError('同步包的密钥参数不合法')
  if (!Number.isInteger(kdf.r) || kdf.r < KDF_LIMITS.minR || kdf.r > KDF_LIMITS.maxR) {
    throw new SyncError('同步包的密钥参数不合法')
  }
  if (!Number.isInteger(kdf.p) || kdf.p < KDF_LIMITS.minP || kdf.p > KDF_LIMITS.maxP) {
    throw new SyncError('同步包的密钥参数不合法')
  }
  if (kdf.keylen !== KDF_LIMITS.keylen) throw new SyncError('同步包的密钥参数不合法')
  if (Buffer.from(kdf.salt, 'base64').length < 16) throw new SyncError('同步包的盐值不合法')
}

function deriveKey(password: string, kdf: SyncKdf): Buffer {
  return scryptSync(password.normalize('NFKC'), Buffer.from(kdf.salt, 'base64'), kdf.keylen, {
    N: kdf.N,
    r: kdf.r,
    p: kdf.p,
    // maxmem 必须大于 128*N*r，否则 Node 直接抛错
    maxmem: 128 * kdf.N * kdf.r * 2
  })
}

/** 附加认证数据：格式版本 + KDF 参数 + 明文元信息，任何一项被改都会解密失败 */
function buildAad(envelope: Pick<SyncEnvelope, 'version' | 'kdf' | 'meta'>): Buffer {
  const kdf = envelope.kdf
  if (!kdf) throw new SyncError('同步包缺少密钥参数')
  const parts = [
    SYNC_FORMAT,
    String(envelope.version),
    kdf.name,
    String(kdf.N),
    String(kdf.r),
    String(kdf.p),
    String(kdf.keylen),
    kdf.salt,
    stableStringify(envelope.meta)
  ]
  return Buffer.from(parts.join('|'), 'utf8')
}

/** 加密整包。meta 明文保留，便于导入前预览。 */
export function encryptBundle(
  payload: SyncBundlePayload,
  meta: SyncBundleMeta,
  password: string
): SyncEnvelope {
  if (!password) throw new SyncError('加密导出需要设置口令')
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new SyncError(`口令至少 ${MIN_PASSWORD_LENGTH} 位`)
  }

  const kdf: SyncKdf = {
    name: 'scrypt',
    ...DEFAULT_KDF,
    salt: randomBytes(16).toString('base64')
  }
  const iv = randomBytes(12)
  const key = deriveKey(password, kdf)

  const envelope: SyncEnvelope = {
    format: SYNC_FORMAT,
    version: SYNC_VERSION,
    encrypted: true,
    meta,
    kdf,
    cipher: { name: 'aes-256-gcm', iv: iv.toString('base64'), tag: '' }
  }

  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(buildAad(envelope))
  const encrypted = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(payload), 'utf8')),
    cipher.final()
  ])
  envelope.cipher = {
    name: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64')
  }
  envelope.data = encrypted.toString('base64')
  return envelope
}

/** 不加密导出（凭据已被调用方剥离，这里只做兜底检查） */
export function plainBundle(payload: SyncBundlePayload, meta: SyncBundleMeta): SyncEnvelope {
  if (payload.credentials && Object.keys(payload.credentials).length > 0) {
    throw new SyncError('包含密码的同步包必须加密')
  }
  return { format: SYNC_FORMAT, version: SYNC_VERSION, encrypted: false, meta, payload }
}

/** 解密。口令错误与文件损坏都返回同一句提示，避免泄露“口令是否接近正确”。 */
export function decryptBundle(envelope: SyncEnvelope, password: string): SyncBundlePayload {
  if (!envelope.encrypted) {
    if (!envelope.payload) throw new SyncError('同步包内容为空')
    return envelope.payload
  }
  if (!envelope.kdf || !envelope.cipher || !envelope.data) {
    throw new SyncError('同步包内容不完整')
  }
  assertKdf(envelope.kdf)

  const key = deriveKey(password, envelope.kdf)
  const iv = Buffer.from(envelope.cipher.iv, 'base64')
  const tag = Buffer.from(envelope.cipher.tag, 'base64')
  if (iv.length !== 12 || tag.length !== 16) throw new SyncError('同步包内容不完整')

  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAAD(buildAad(envelope))
    decipher.setAuthTag(tag)
    const plain = Buffer.concat([
      decipher.update(Buffer.from(envelope.data, 'base64')),
      decipher.final()
    ])
    return JSON.parse(plain.toString('utf8')) as SyncBundlePayload
  } catch (err) {
    if (err instanceof SyncError) throw err
    throw new SyncError('口令错误或文件已损坏')
  }
}

/** 序列化：首行 magic + 缩进 JSON，便于人工确认文件类型 */
export function serializeBundle(envelope: SyncEnvelope): string {
  return `${SYNC_MAGIC}\n${JSON.stringify(envelope, null, 2)}\n`
}

/**
 * 包内容的指纹（sha256）。
 * 自动同步靠它判断「这份内容我是不是已经处理过」，从而避免
 * 自己写出去的文件又触发一次拉取，形成来回写。
 */
export function contentHash(payload: SyncBundlePayload): string {
  return createHash('sha256').update(stableStringify(payload), 'utf8').digest('hex')
}

export type ParsedSyncText =
  | { legacy: false; envelope: SyncEnvelope }
  | { legacy: true; payload: Record<string, unknown> }

/**
 * 解析同步包文本。
 * 兼容 0.6 之前导出的纯 JSON 配置（没有 magic 行），这样老文件仍然能导入，
 * 而不是逼用户“先用旧版本导出一次”。
 */
export function parseSyncText(text: string): ParsedSyncText {
  const body = text.replace(/^\uFEFF/, '').trimStart()
  if (!body) throw new SyncError('文件内容为空')

  if (!body.startsWith(SYNC_MAGIC)) {
    let raw: unknown
    try {
      raw = JSON.parse(body)
    } catch {
      throw new SyncError('不是有效的 JShell 同步包')
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new SyncError('不是有效的 JShell 同步包')
    }
    return { legacy: true, payload: raw as Record<string, unknown> }
  }

  const json = body.slice(SYNC_MAGIC.length).replace(/^\s+/, '')
  let envelope: SyncEnvelope
  try {
    envelope = JSON.parse(json) as SyncEnvelope
  } catch {
    throw new SyncError('同步包已损坏，无法解析')
  }
  if (envelope.format !== SYNC_FORMAT) throw new SyncError('不是 JShell 同步包')
  if (!Number.isInteger(envelope.version) || envelope.version < 1) {
    throw new SyncError('同步包版本信息缺失')
  }
  if (envelope.version > SYNC_VERSION) {
    throw new SyncError('该同步包由更新版本的 JShell 创建，请先升级应用')
  }
  if (!envelope.meta || typeof envelope.meta !== 'object') {
    throw new SyncError('同步包缺少元信息')
  }
  if (!envelope.encrypted && !envelope.payload) throw new SyncError('同步包内容为空')
  if (envelope.encrypted && !envelope.data) throw new SyncError('同步包内容不完整')
  return { legacy: false, envelope }
}

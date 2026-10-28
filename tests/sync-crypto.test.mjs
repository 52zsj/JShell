import test from 'node:test'
import assert from 'node:assert/strict'
import {
  decryptBundle,
  encryptBundle,
  parseSyncText,
  plainBundle,
  serializeBundle
} from '../src/main/services/sync-crypto.ts'
import { MIN_PASSWORD_LENGTH, passwordStrength } from '../src/shared/sync.ts'

const META = {
  appVersion: '0.6.0',
  deviceName: 'mac-mini',
  platform: 'darwin',
  createdAt: '2026-10-27T04:00:00.000Z',
  scopes: ['hosts', 'snippets'],
  counts: { hosts: 1, snippets: 1, tunnels: 0, knownHosts: 0, credentials: 1 },
  hasCredentials: true
}

const PAYLOAD = {
  hosts: [
    {
      id: 'host-1',
      name: '生产 Web',
      host: '10.0.0.8',
      port: 22,
      username: 'root',
      authType: 'password',
      createdAt: 1,
      updatedAt: 2
    }
  ],
  snippets: [{ id: 's-1', name: '磁盘', command: 'df -h', createdAt: 1 }],
  credentials: { 'host-1': { password: 'p@ss-密码' } }
}

const PASSWORD = 'correct-horse-battery'

test('加密包可以原样解密回来（含中文与特殊字符）', () => {
  const envelope = encryptBundle(PAYLOAD, META, PASSWORD)
  assert.equal(envelope.encrypted, true)
  assert.deepEqual(decryptBundle(envelope, PASSWORD), PAYLOAD)
  // meta 保持明文，便于导入前预览
  assert.equal(envelope.meta.counts.hosts, 1)
  assert.equal(envelope.meta.deviceName, 'mac-mini')
})

test('同一口令两次加密得到不同密文（salt / iv 随机）', () => {
  const a = encryptBundle(PAYLOAD, META, PASSWORD)
  const b = encryptBundle(PAYLOAD, META, PASSWORD)
  assert.notEqual(a.kdf.salt, b.kdf.salt)
  assert.notEqual(a.cipher.iv, b.cipher.iv)
  assert.notEqual(a.data, b.data)
})

test('口令错误时拒绝解密，且不泄露细节', () => {
  const envelope = encryptBundle(PAYLOAD, META, PASSWORD)
  assert.throws(() => decryptBundle(envelope, 'wrong-password'), /口令错误或文件已损坏/)
})

test('密文被篡改一个字节即解密失败（GCM 完整性）', () => {
  const envelope = encryptBundle(PAYLOAD, META, PASSWORD)
  const raw = Buffer.from(envelope.data, 'base64')
  raw[0] ^= 0xff
  assert.throws(
    () => decryptBundle({ ...envelope, data: raw.toString('base64') }, PASSWORD),
    /口令错误或文件已损坏/
  )
})

test('明文元信息被篡改也会失败（AAD 绑定）', () => {
  const envelope = encryptBundle(PAYLOAD, META, PASSWORD)
  const tampered = { ...envelope, meta: { ...envelope.meta, deviceName: 'attacker' } }
  assert.throws(() => decryptBundle(tampered, PASSWORD), /口令错误或文件已损坏/)
})

test('KDF 参数被降级时拒绝解密（防削弱爆破成本）', () => {
  const envelope = encryptBundle(PAYLOAD, META, PASSWORD)
  const weakened = { ...envelope, kdf: { ...envelope.kdf, N: 8192 } }
  assert.throws(() => decryptBundle(weakened, PASSWORD), /口令错误或文件已损坏/)
})

test('恶意超大 KDF 参数在校验阶段就被拒绝（防拖死主进程）', () => {
  const envelope = encryptBundle(PAYLOAD, META, PASSWORD)
  const hostile = { ...envelope, kdf: { ...envelope.kdf, N: 2 ** 22 } }
  assert.throws(() => decryptBundle(hostile, PASSWORD), /密钥参数不合法/)
})

test('非 2 的幂的 N 被拒绝', () => {
  const envelope = encryptBundle(PAYLOAD, META, PASSWORD)
  const hostile = { ...envelope, kdf: { ...envelope.kdf, N: 20000 } }
  assert.throws(() => decryptBundle(hostile, PASSWORD), /密钥参数不合法/)
})

test('口令过短不允许加密导出', () => {
  assert.throws(() => encryptBundle(PAYLOAD, META, 'short'), new RegExp(`至少 ${MIN_PASSWORD_LENGTH} 位`))
})

test('不加密的包不允许携带凭据', () => {
  assert.throws(() => plainBundle(PAYLOAD, META), /包含密码的同步包必须加密/)
  const ok = plainBundle({ hosts: PAYLOAD.hosts }, META)
  assert.equal(ok.encrypted, false)
})

test('序列化后能解析回来，并且首行带 magic', () => {
  const text = serializeBundle(encryptBundle(PAYLOAD, META, PASSWORD))
  assert.ok(text.startsWith('JSHELL-SYNC/1\n'))
  const parsed = parseSyncText(text)
  assert.equal(parsed.legacy, false)
  assert.equal(parsed.envelope.encrypted, true)
  assert.deepEqual(decryptBundle(parsed.envelope, PASSWORD), PAYLOAD)
})

test('明文包解析后直接可用', () => {
  const text = serializeBundle(plainBundle({ hosts: PAYLOAD.hosts }, META))
  const parsed = parseSyncText(text)
  assert.equal(parsed.legacy, false)
  assert.equal(parsed.envelope.encrypted, false)
  assert.equal(parsed.envelope.payload.hosts.length, 1)
})

test('旧版纯 JSON 配置被识别为 legacy', () => {
  const text = JSON.stringify({
    version: 1,
    exportedAt: '2026-01-01T00:00:00.000Z',
    hosts: PAYLOAD.hosts,
    snippets: PAYLOAD.snippets
  })
  const parsed = parseSyncText(text)
  assert.equal(parsed.legacy, true)
  assert.equal(parsed.payload.hosts.length, 1)
})

test('未知格式或损坏内容给出明确提示', () => {
  assert.throws(() => parseSyncText(''), /内容为空/)
  assert.throws(() => parseSyncText('hello world'), /不是有效的 JShell 同步包/)
  assert.throws(() => parseSyncText('JSHELL-SYNC/1\n{ broken'), /已损坏/)
})

test('更高版本的包要求先升级应用', () => {
  const text = `JSHELL-SYNC/1\n${JSON.stringify({
    format: 'jshell-sync',
    version: 99,
    encrypted: false,
    meta: META,
    payload: {}
  })}`
  assert.throws(() => parseSyncText(text), /更新版本/)
})

test('口令强度分级', () => {
  assert.equal(passwordStrength(''), 'empty')
  assert.equal(passwordStrength('abc'), 'short')
  assert.equal(passwordStrength('abcdefgh'), 'weak')
  assert.equal(passwordStrength('abcd1234ef'), 'fair')
  assert.equal(passwordStrength('Abcd1234!xyz'), 'good')
})

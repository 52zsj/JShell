import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildRsyncArgs,
  buildSshCommand,
  parseProgressLine,
  summarizeRsyncError
} from '../src/shared/rsync.ts'

const host = {
  id: 'h1',
  name: 'demo',
  host: '10.0.0.5',
  port: 2222,
  username: 'jay',
  authType: 'password',
  createdAt: 0,
  updatedAt: 0
}

const plan = {
  direction: 'upload',
  source: { kind: 'local', path: '/Users/jay/app' },
  target: { kind: 'host', hostId: 'h1', path: '/var/www/app' },
  options: { deleteExtraneous: false, compress: true, exclude: '', retries: 2 }
}

test('解析 progress2 输出（rsync 3.1+）', () => {
  const parsed = parseProgressLine('    1.23M  45%   12.34MB/s    0:00:03 (xfr#1, to-chk=8/16)')
  assert.equal(parsed.percent, 45)
  assert.equal(parsed.speed, '12.34MB/s')
  assert.equal(parsed.eta, '0:00:03')
  assert.equal(parsed.transferred, Math.round(1.23 * 1024 ** 2))
})

test('解析 --progress 输出（rsync 2.6.9）', () => {
  const parsed = parseProgressLine('  12,345,678  82%    3.20MB/s    0:00:12')
  assert.equal(parsed.percent, 82)
  assert.equal(parsed.transferred, 12345678)
  assert.equal(parsed.speed, '3.20MB/s')
  assert.equal(parsed.eta, '0:00:12')
})

test('无百分比的行返回 null（普通日志不当作进度）', () => {
  assert.equal(parseProgressLine('sending incremental file list'), null)
  assert.equal(parseProgressLine(''), null)
})

test('参数包含断点续传与保护远端路径', () => {
  const args = buildRsyncArgs(plan, {
    capability: {
      available: true,
      version: '3.2.7',
      progress2: true,
      appendVerify: true,
      protectArgs: true,
      binary: 'rsync'
    },
    sshCommand: 'ssh -p 2222',
    source: '/Users/jay/app',
    target: 'jay@10.0.0.5:/var/www/app'
  })
  assert.ok(args.includes('--partial'))
  assert.ok(args.includes('--append-verify'))
  assert.ok(args.includes('--info=progress2'))
  assert.ok(args.includes('-s'))
  assert.ok(args.includes('-z'))
  assert.ok(args.includes('-e'))
  assert.equal(args.at(-1), 'jay@10.0.0.5:/var/www/app')
})

test('旧版 rsync 退化到逐文件进度，并支持 --delete/排除', () => {
  const args = buildRsyncArgs(
    { ...plan, options: { ...plan.options, deleteExtraneous: true, exclude: 'node_modules, *.log' } },
    {
      capability: {
        available: true,
        version: '2.6.9',
        progress2: false,
        appendVerify: false,
        protectArgs: false,
        binary: 'rsync'
      },
      source: '/a',
      target: '/b'
    }
  )
  assert.ok(args.includes('--progress'))
  assert.ok(args.includes('--append'))
  assert.equal(args.includes('--append-verify'), false)
  assert.equal(args.includes('-s'), false)
  assert.equal(args.includes('--info=progress2'), false)
  assert.ok(args.includes('--delete'))
  assert.equal(args.filter((item) => item === '--exclude').length, 2)
})

test('ssh 命令带端口、独立 known_hosts 与引号包裹的私钥路径', () => {
  const cmd = buildSshCommand(
    { ...host, authType: 'key', privateKeyPath: '/Users/jay/my key' },
    '/Users/jay/my key',
    '/tmp/js known_hosts'
  )
  assert.match(cmd, /^ssh -p 2222 /)
  assert.ok(cmd.includes('StrictHostKeyChecking=accept-new'))
  assert.ok(cmd.includes('UserKnownHostsFile="/tmp/js known_hosts"'))
  assert.ok(cmd.includes('-i "/Users/jay/my key"'))
})


test('远端没装 rsync 时给出中文结论而不是原始堆栈', () => {
  const raw =
    'bash: rsync: 未找到命令 rsync: connection unexpectedly closed (0 bytes received so far) [sender] ' +
    'rsync error: error in rsync protocol data stream (code 12) at /AppleInternal/Library/rsync/io.c(453) [sender=2.6.9]'
  const message = summarizeRsyncError(raw)
  assert.ok(message.includes('远端未安装 rsync'))
  assert.ok(message.includes('apt install rsync'))
  assert.equal(message.includes('AppleInternal'), false)
})

test('认证失败 / 超时 / 旧版本都能归类', () => {
  assert.ok(summarizeRsyncError('Permission denied (publickey).').includes('认证或权限不足'))
  assert.ok(summarizeRsyncError('ssh: connect to host a.com port 22: Connection timed out').includes('超时'))
  assert.ok(summarizeRsyncError('rsync: --append-verify: unknown option').includes('版本过旧'))
})

test('未知错误被裁剪成一句话，不带编译路径', () => {
  const message = summarizeRsyncError(
    'rsync: something weird happened at /AppleInternal/Library/BuildRoots/x/rsync/io.c(12)'
  )
  assert.equal(message.startsWith('同步失败：'), true)
  assert.equal(message.includes('AppleInternal'), false)
  assert.ok(message.length <= 200)
})

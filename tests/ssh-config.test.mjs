import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  expandHome,
  parseSshConfig,
  readSshConfigHosts
} from '../src/main/services/ssh-config.ts'

const ME = 'me'

test('基本块：HostName / User / Port / IdentityFile 都能取到', () => {
  const hosts = parseSshConfig(
    `
Host web
  HostName 10.0.0.11
  User deploy
  Port 2222
  IdentityFile ~/.ssh/id_ed25519
`,
    ME
  )
  assert.equal(hosts.length, 1)
  assert.deepEqual(hosts[0], {
    alias: 'web',
    host: '10.0.0.11',
    port: 2222,
    username: 'deploy',
    identityFile: expandHome('~/.ssh/id_ed25519')
  })
})

test('缺省值：没有 HostName 就用别名，没有 User 用本机用户名，没有 Port 用 22', () => {
  const hosts = parseSshConfig('Host db\n  HostName 10.0.0.12\n', ME)
  assert.deepEqual(hosts[0], { alias: 'db', host: '10.0.0.12', port: 22, username: ME, identityFile: undefined })

  const aliasOnly = parseSshConfig('Host plain\n', ME)
  assert.deepEqual(aliasOnly[0], { alias: 'plain', host: 'plain', port: 22, username: ME, identityFile: undefined })
})

test('通配符块被跳过（Host * 通常只是全局默认值）', () => {
  const hosts = parseSshConfig(
    `
Host *
  ServerAliveInterval 60
  User root

Host real
  HostName 1.2.3.4
`,
    ME
  )
  assert.deepEqual(hosts.map((h) => h.alias), ['real'])
  // `Host *` 里的 User 不应该泄漏到别的块
  assert.equal(hosts[0].username, ME)
})

test('Match 块里的选项被忽略，且不影响后面的 Host', () => {
  const hosts = parseSshConfig(
    `
Match host *.internal
  User should-not-be-used

Host after
  HostName 5.6.7.8
  User ok
`,
    ME
  )
  assert.deepEqual(
    hosts.map((h) => [h.alias, h.username]),
    [['after', 'ok']]
  )
})

test('同一块内先出现的值生效（与 ssh 的 first-obtained-value 一致）', () => {
  const hosts = parseSshConfig(
    `
Host dup
  HostName first.example
  HostName second.example
  Port 2200
  Port 2201
`,
    ME
  )
  assert.equal(hosts[0].host, 'first.example')
  assert.equal(hosts[0].port, 2200)
})

test('Host 一行写多个别名：每个别名各生成一条', () => {
  const hosts = parseSshConfig(
    `
Host a b c
  HostName shared.example
`,
    ME
  )
  assert.deepEqual(hosts.map((h) => h.alias), ['a', 'b', 'c'])
  assert.ok(hosts.every((h) => h.host === 'shared.example'))
})

test('注释与行内注释都被剥掉', () => {
  const hosts = parseSshConfig(
    `
# 这是注释
Host web  # 行内注释
  HostName 10.0.0.13  # 这里也是
  # User nobody
  User real
`,
    ME
  )
  assert.equal(hosts.length, 1)
  assert.equal(hosts[0].host, '10.0.0.13')
  assert.equal(hosts[0].username, 'real')
})

test('IdentityFile 支持引号与 ~', () => {
  const quoted = parseSshConfig('Host q\n  IdentityFile "~/.ssh/my key"\n', ME)
  assert.equal(quoted[0].identityFile, path.join(os.homedir(), '.ssh', 'my key'))
})

test('非法端口被忽略，回落到 22', () => {
  const hosts = parseSshConfig('Host bad\n  Port 99999\n  Port abc\n', ME)
  assert.equal(hosts[0].port, 22)
})

test('重复别名只保留第一次出现的块', () => {
  const hosts = parseSshConfig(
    `
Host same
  HostName one.example

Host same
  HostName two.example
`,
    ME
  )
  assert.equal(hosts.length, 1)
  assert.equal(hosts[0].host, 'one.example')
})

test('空文本 / 只有注释时返回空数组', () => {
  assert.deepEqual(parseSshConfig('', ME), [])
  assert.deepEqual(parseSshConfig('# nothing\n\n', ME), [])
})

test('readSshConfigHosts：文件不存在时返回空结果而不是抛错', () => {
  const result = readSshConfigHosts('/nonexistent/jshell/ssh/config')
  assert.deepEqual(result, { hosts: [], files: [] })
})

test('readSshConfigHosts：展开 Include 里的相对路径', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jshell-ssh-'))
  fs.writeFileSync(
    path.join(dir, 'config'),
    `
Include extra/conf.d

Host main
  HostName main.example
`
  )
  fs.mkdirSync(path.join(dir, 'extra'))
  fs.writeFileSync(
    path.join(dir, 'extra', 'conf.d'),
    `
Host included
  HostName inc.example
  Port 2200
`
  )

  const result = readSshConfigHosts(path.join(dir, 'config'))
  assert.deepEqual(
    result.hosts.map((h) => [h.alias, h.host, h.port]),
    [
      ['main', 'main.example', 22],
      ['included', 'inc.example', 2200]
    ]
  )
  assert.equal(result.files.length, 2)
  fs.rmSync(dir, { recursive: true, force: true })
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { WSL_SHELL_PREFIX } from '../src/shared/types.ts'
import { parseWslDistros, resolveLocalCommand } from '../src/main/services/shells.ts'

/** `wsl.exe -l -q` 的真实输出是 UTF-16LE，这是最容易踩的一条 */
const utf16 = (text) => Buffer.from(text, 'utf16le')

test('解析 UTF-16LE 的发行版列表（wsl.exe 的真实输出格式）', () => {
  const distros = parseWslDistros(utf16('Ubuntu\r\nDebian\r\n'))
  assert.deepEqual(distros, ['Ubuntu', 'Debian'])
})

test('带 BOM 的 UTF-16LE 也能解析，BOM 不会粘在名字上', () => {
  const distros = parseWslDistros(utf16('\uFEFFUbuntu-22.04\r\n'))
  assert.deepEqual(distros, ['Ubuntu-22.04'])
})

test('万一某个版本输出 UTF-8，也要能读', () => {
  const distros = parseWslDistros(Buffer.from('Ubuntu\nDebian\n', 'utf8'))
  assert.deepEqual(distros, ['Ubuntu', 'Debian'])
})

test('发行版名带空格（如 "Ubuntu 22.04 LTS"）保持完整', () => {
  const distros = parseWslDistros(utf16('Ubuntu 22.04 LTS\r\n'))
  assert.deepEqual(distros, ['Ubuntu 22.04 LTS'])
})

test('空输出返回空数组（没装任何发行版）', () => {
  assert.deepEqual(parseWslDistros(Buffer.alloc(0)), [])
  assert.deepEqual(parseWslDistros(utf16('\r\n\r\n')), [])
})

test('过滤掉「未安装发行版」时 wsl 打印的提示行', () => {
  const distros = parseWslDistros(utf16('Windows Subsystem for Linux has no installed distributions.\r\n'))
  assert.deepEqual(distros, [])
})

test('重复条目去重', () => {
  const distros = parseWslDistros(utf16('Ubuntu\r\nUbuntu\r\nDebian\r\n'))
  assert.deepEqual(distros, ['Ubuntu', 'Debian'])
})

test('WSL 条目解析成 wsl.exe -d <发行版> --cd ~', () => {
  const command = resolveLocalCommand(`${WSL_SHELL_PREFIX}Ubuntu`)
  assert.match(command.file, /wsl(\.exe)?$/i)
  assert.deepEqual(command.args, ['-d', 'Ubuntu', '--cd', '~'])
})

test('发行版名带空格时不被拆开（参数是数组，不需要引号）', () => {
  const command = resolveLocalCommand(`${WSL_SHELL_PREFIX}Ubuntu 22.04 LTS`)
  assert.deepEqual(command.args, ['-d', 'Ubuntu 22.04 LTS', '--cd', '~'])
})

test('普通 shell 路径不受影响，仍走原来的参数规则', () => {
  if (process.platform === 'win32') {
    // Windows：powershell 加 -NoLogo，cmd 不加参数
    assert.deepEqual(resolveLocalCommand('C:\\Windows\\System32\\cmd.exe').args, [])
    assert.deepEqual(
      resolveLocalCommand('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe').args,
      ['-NoLogo']
    )
  } else {
    // POSIX：登录 shell
    const command = resolveLocalCommand('/bin/zsh')
    assert.equal(command.file, '/bin/zsh')
    assert.deepEqual(command.args, ['-l'])
  }
})

test('非 WSL 的路径原样返回，不会被当成 WSL 命令', () => {
  const command = resolveLocalCommand(process.platform === 'win32' ? 'C:\\tools\\nu.exe' : '/usr/bin/fish')
  assert.equal(command.file, process.platform === 'win32' ? 'C:\\tools\\nu.exe' : '/usr/bin/fish')
})

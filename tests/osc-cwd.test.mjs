import test from 'node:test'
import assert from 'node:assert/strict'
import {
  OscCwdScanner,
  buildShellIntegrationHook,
  extractOscPath,
  SHELL_HOOK_MARKER
} from '../src/main/services/osc-cwd.ts'

test('extractOscPath 解析 file:// 与裸路径', () => {
  assert.equal(extractOscPath('file://myhost/root/work'), '/root/work')
  assert.equal(extractOscPath('file:///tmp/x'), '/tmp/x')
  assert.equal(extractOscPath('file://localhost/home/jay'), '/home/jay')
  assert.equal(extractOscPath('/plain/path'), '/plain/path')
  assert.equal(extractOscPath('file://host'), null)
  assert.equal(extractOscPath(''), null)
  assert.equal(extractOscPath('relative/path'), null)
  assert.equal(extractOscPath('file://h/a%20b/c'), '/a b/c')
})

test('OscCwdScanner 识别 OSC 7 并从显示流剔除', () => {
  const scanner = new OscCwdScanner()
  const esc = '\x1b'
  const { cleaned, cwd } = scanner.feed(`hello${esc}]7;file://host/var/log\x07world`)
  assert.equal(cwd, '/var/log')
  assert.equal(cleaned, 'helloworld')
})

test('OscCwdScanner 识别 ST 结尾与 OSC 9;9', () => {
  const scanner = new OscCwdScanner()
  const esc = '\x1b'
  const r1 = scanner.feed(`a${esc}]7;file://h/etc${esc}\\b`)
  assert.equal(r1.cwd, '/etc')
  assert.equal(r1.cleaned, 'ab')

  const r2 = scanner.feed(`x${esc}]9;9;/data\x07y`)
  assert.equal(r2.cwd, '/data')
  assert.equal(r2.cleaned, 'xy')
})

test('OscCwdScanner 跨分块拼接未闭合序列', () => {
  const scanner = new OscCwdScanner()
  const esc = '\x1b'
  const first = scanner.feed(`pre${esc}]7;file://host/`)
  assert.equal(first.cwd, null)
  assert.equal(first.cleaned, 'pre')

  const second = scanner.feed(`srv/ok\x07post`)
  assert.equal(second.cwd, '/srv/ok')
  assert.equal(second.cleaned, 'post')
})

test('非目录 OSC（如超链接）原样保留', () => {
  const scanner = new OscCwdScanner()
  const esc = '\x1b'
  const { cleaned, cwd } = scanner.feed(`x${esc}]8;;https://a.b\x07link\x07y`)
  assert.equal(cwd, null)
  assert.equal(cleaned, `x${esc}]8;;https://a.b\x07link\x07y`)
})

test('buildShellIntegrationHook 生成单条 bash/zsh hook', () => {
  const hook = buildShellIntegrationHook()
  assert.ok(hook.startsWith(SHELL_HOOK_MARKER))
  assert.ok(hook.includes('PROMPT_COMMAND'))
  assert.ok(hook.includes('precmd_functions'))
  assert.ok(hook.includes('\\033]7;file://%s%s\\033\\\\'))
  // 末尾用 printf '\r' 覆盖提示符；返回文本本身不含回车（由调用方补）
  assert.ok(hook.endsWith("printf '\\r'"))
  assert.equal(hook.includes('\r'), false)
  assert.equal(hook.includes('stty'), false)
})

test('suppressEcho 命中标记后整行剔除（保留前缀与行尾换行后的内容）', () => {
  const scanner = new OscCwdScanner()
  scanner.suppressEcho(SHELL_HOOK_MARKER)
  const { cleaned } = scanner.feed(
    `bash-3.2$ ${SHELL_HOOK_MARKER}(){ echo hi; }\r\nbash-3.2$ `
  )
  assert.equal(cleaned, 'bash-3.2$ bash-3.2$ ')
})

test('suppressEcho 吞掉窄终端折行插入的孤立 \\r', () => {
  const scanner = new OscCwdScanner()
  scanner.suppressEcho(SHELL_HOOK_MARKER)
  const { cleaned } = scanner.feed(`p ${SHELL_HOOK_MARKER} abc\rdef\r\nNEXT`)
  assert.equal(cleaned, 'p NEXT')
})

test('suppressEcho 未命中标记时不误删', () => {
  const scanner = new OscCwdScanner()
  scanner.suppressEcho(SHELL_HOOK_MARKER)
  const r = scanner.feed('normal output\n')
  assert.equal(r.cleaned, 'normal output\n')
})

test('suppressEcho 跨分片：标记被拆开也能整行剔除', () => {
  const scanner = new OscCwdScanner()
  scanner.suppressEcho(SHELL_HOOK_MARKER)
  // 标记前半截被拆到第一个分片
  assert.equal(scanner.feed('prompt __jshe').cleaned, 'prompt ')
  assert.equal(scanner.feed('ll_osc(){ echo hi; }\r\nrest').cleaned, 'rest')
})

test('suppressEcho 同一命令被回显多次时逐条剔除', () => {
  const scanner = new OscCwdScanner()
  scanner.suppressEcho(SHELL_HOOK_MARKER)
  const { cleaned } = scanner.feed(
    `${SHELL_HOOK_MARKER} a\r\n${SHELL_HOOK_MARKER} b\r\nkeep`
  )
  assert.equal(cleaned, 'keep')
})


// ---------------------------------------------------------------- 非 OSC 的 ESC] 容错

test('ESC] 后面不是数字时当普通文本，不吞后续输出', () => {
  const scanner = new OscCwdScanner()
  const esc = '\x1b'
  const { cleaned, cwd } = scanner.feed(`before${esc}]not-an-osc after`)
  assert.equal(cleaned, `before${esc}]not-an-osc after`)
  assert.equal(cwd, null)
})

test('二进制里偶发的 ESC] 不会让后续输出卡住（曾导致延迟与错位）', () => {
  const scanner = new OscCwdScanner()
  const esc = '\x1b'
  // 模拟二进制输出：ESC] 后面跟一堆非数字字节，然后才是正常文本
  const { cleaned } = scanner.feed(`${esc}]\x01\x02\xff\xfe tail\r\n`)
  assert.ok(cleaned.includes('tail'), '后续文本必须被吐出来')
  assert.ok(cleaned.includes('\r\n'), '换行不能被吞')
})

test('编号过长（>8 字符）不当作 OSC', () => {
  const scanner = new OscCwdScanner()
  const esc = '\x1b'
  const { cleaned } = scanner.feed(`${esc}]1234567890;payload\x07after`)
  assert.ok(cleaned.includes('after'))
})

test('ESC] 恰好卡在分块边界时，等下一块拼完整（不提前丢弃）', () => {
  const scanner = new OscCwdScanner()
  const esc = '\x1b'
  const r1 = scanner.feed(`x${esc}]7;file://h/va`)
  assert.equal(r1.cleaned, 'x')
  assert.equal(r1.cwd, null)
  const r2 = scanner.feed('r/log\x07y')
  assert.equal(r2.cleaned, 'y')
  assert.equal(r2.cwd, '/var/log')
})

test('普通 OSC（非目录）原样透传，比如窗口标题', () => {
  const scanner = new OscCwdScanner()
  const esc = '\x1b'
  const { cleaned, cwd } = scanner.feed(`${esc}]0;my title\x07visible`)
  assert.equal(cleaned, `${esc}]0;my title\x07visible`)
  assert.equal(cwd, null)
})

test('OSC 8 超链接（含空段）也能透传', () => {
  const scanner = new OscCwdScanner()
  const esc = '\x1b'
  const seq = `${esc}]8;;https://example.com${esc}\\`
  const { cleaned } = scanner.feed(`${seq}link${esc}]8;;${esc}\\`)
  assert.equal(cleaned, `${seq}link${esc}]8;;${esc}\\`)
})

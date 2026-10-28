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


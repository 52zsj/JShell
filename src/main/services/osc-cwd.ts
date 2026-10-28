/**
 * OSC 7 / OSC 9;9 解析 —— 用标准转义序列跟踪终端「当前工作目录」。
 *
 * 很多终端（iTerm2 / VS Code / Windows Terminal）都靠 shell 在每个提示符前
 * 打印一条 `ESC ] 7 ; file://host/path BEL`（或 ST 结尾）来上报目录。
 * 我们在这里：
 *  1. 增量扫描 PTY 输出，把这类序列从显示流里剔除（xterm 不识别它，去掉更干净）；
 *  2. 解析出绝对路径，供左侧目录树跟随 `cd` 实时刷新；
 *  3. 提供一个可注入到 bash/zsh 的 hook，让「没配过 shell integration」的服务器
 *     也能自动上报目录。
 */

/** 解析 OSC payload（`file://host/path` 或裸路径）为绝对路径 */
export function extractOscPath(payload: string): string | null {
  let p = payload.trim()
  if (!p) return null

  if (p.toLowerCase().startsWith('file://')) {
    p = p.slice('file://'.length)
    const slash = p.indexOf('/')
    if (slash > 0) p = p.slice(slash) // 去掉主机名
    else if (slash < 0) return null // file://host 没有路径
    // slash === 0 时是 file:///path，p 已是 /path
  }

  if (!p.startsWith('/')) return null
  try {
    return decodeURIComponent(p)
  } catch {
    return p
  }
}

/**
 * 增量扫描器：喂入任意分块文本，返回「剔掉 OSC 目录序列后的显示文本」与
 * 「本次新解析到的目录（没有则为 null）」。
 *
 * 未闭合的序列（分块边界截断）会留在内部 tail，下一次 feed 继续拼接。
 */
export class OscCwdScanner {
  private tail = ''
  private suppressText = ''
  private suppressUntil = 0
  private suppressBuf = ''
  /** 已命中注入标记、正在把「整条回显」吞到行尾 */
  private suppressDropping = false

  /**
   * 注册一段「即将被终端回显」的注入命令标记（如 `__jshell_osc`）。
   * 远端 readline / TTY 会把注入的命令原样回显，窄终端还会折行（在折行处插入孤立的
   * `\r`），按整段明文精确匹配并不可靠。这里改为：命中标记后，从标记起到该行第一个
   * `\n`（含）为止整段吞掉——折行带来的 `\r` 一并被吞，注入做到零残留。
   */
  suppressEcho(marker: string): void {
    this.suppressText = marker
    // 窗口放宽到 8s：慢速服务器上 shell 初始化较久，回显可能延迟到达
    this.suppressUntil = Date.now() + 8000
    this.suppressBuf = ''
    this.suppressDropping = false
  }

  feed(text: string): { cleaned: string; cwd: string | null } {
    const combined = this.tail + text
    let out = ''
    let cwd: string | null = null
    let i = 0
    const n = combined.length

    while (i < n) {
      const esc = combined.indexOf('\x1b]', i)
      if (esc === -1) {
        out += combined.slice(i)
        i = n
        break
      }
      out += combined.slice(i, esc)

      // params 以 ';' 结束，payload 以 BEL 或 ESC\ 结束
      const semi = combined.indexOf(';', esc + 2)
      if (semi === -1) {
        i = esc
        break
      }
      const params = combined.slice(esc + 2, semi)
      const bel = combined.indexOf('\x07', semi + 1)
      const st = combined.indexOf('\x1b\\', semi + 1)
      let end = -1
      let termLen = 1
      if (bel !== -1 && (st === -1 || bel < st)) {
        end = bel
      } else if (st !== -1) {
        end = st
        termLen = 2
      }
      if (end === -1) {
        i = esc
        break
      }

      const payload = combined.slice(semi + 1, end)
      let dir: string | null = null
      if (params === '7') {
        dir = extractOscPath(payload)
      } else if (params === '9' && payload.startsWith('9;')) {
        // Windows Terminal / ConEmu：OSC 9;9;<cwd>
        dir = extractOscPath(payload.slice(2))
      }
      if (dir) {
        cwd = dir
        // 目录序列不进入显示流
      } else {
        out += combined.slice(esc, end + termLen)
      }
      i = end + termLen
    }

    this.tail = combined.slice(i)

    // 剔除注入命令的回显。命中标记后把整条回显（含折行 \r 与行尾 \n）吞掉，
    // 支持跨 chunk、也支持同一条命令被回显多次；窗口结束后自动失效。
    if (this.suppressText) {
      if (Date.now() > this.suppressUntil) {
        // 超时：把残留缓冲吐出，恢复正常显示
        out = this.suppressBuf + out
        this.suppressText = ''
        this.suppressBuf = ''
        this.suppressDropping = false
      } else {
        const buf = this.suppressBuf + out
        this.suppressBuf = ''
        let result = ''
        let cursor = 0
        while (cursor < buf.length) {
          if (this.suppressDropping) {
            const nl = buf.indexOf('\n', cursor)
            if (nl === -1) {
              // 这一行还没结束，剩下的等下一个 chunk 继续吞
              this.suppressBuf = buf.slice(cursor)
              cursor = buf.length
            } else {
              cursor = nl + 1
              this.suppressDropping = false
            }
            continue
          }
          const pos = buf.indexOf(this.suppressText, cursor)
          if (pos === -1) {
            // 没找到标记：尾部可能是标记的前缀（跨 chunk 拆开），先留一留
            const rest = buf.slice(cursor)
            const maxTail = Math.min(rest.length, this.suppressText.length - 1)
            let keep = ''
            for (let k = 1; k <= maxTail; k += 1) {
              const tail = rest.slice(rest.length - k)
              if (this.suppressText.startsWith(tail)) keep = tail
            }
            result += rest.slice(0, rest.length - keep.length)
            this.suppressBuf = keep
            cursor = buf.length
          } else {
            result += buf.slice(cursor, pos)
            cursor = pos + this.suppressText.length
            this.suppressDropping = true
          }
        }
        out = result
      }
    }

    return { cleaned: out, cwd }
  }
}

/** 注入命令的唯一前缀，客户端据此把整条回显从显示流里剔除 */
export const SHELL_HOOK_MARKER = '__jshell_osc'

/**
 * 生成注入到 bash/zsh 的 shell hook（单条命令）。
 * 每个提示符前打印 `ESC ] 7 ; file://host/PWD ESC\`，让客户端拿到当前目录。
 *
 * 关键点：
 *  - 不再用 `stty -echo` 关回显——那条路一旦「恢复回显」没执行到位，远端就会一直不回显，
 *    看起来像「终端死了」；而且关/开回显两条命令各自会多打一个提示符，提示符叠成一行。
 *  - 命令末尾 `printf '\r'` 让 shell 紧接着打印的新提示符原位覆盖旧提示符，
 *    登录后只看到一个干净提示符。
 *  - 命令回显由客户端按 {@link SHELL_HOOK_MARKER} 整行剔除，折行也能吞掉。
 *  - 全程 POSIX 语法：zsh 专属的数组追加放进 eval 里，避免 dash/sh 解析报错。
 */
export function buildShellIntegrationHook(): string {
  // printf 格式用单引号包裹，\033 由 printf 转成 ESC，\\ 转成一个反斜杠（ST 结尾）
  const define =
    '__jshell_osc(){ printf ' +
    "'\\033]7;file://%s%s\\033\\\\'" +
    ' "$(hostname)" "$PWD"; }; '
  const install =
    'if [ -n "$BASH_VERSION" ]; then ' +
    'PROMPT_COMMAND="__jshell_osc${PROMPT_COMMAND:+;$PROMPT_COMMAND}"; ' +
    "elif [ -n \"$ZSH_VERSION\" ]; then eval 'precmd_functions+=(__jshell_osc)'; fi; "
  // 末尾回车（只回行首不换行）：shell 随后打印的提示符会覆盖掉当前这一行
  const overwrite = "printf '\\r'"
  return define + install + overwrite
}

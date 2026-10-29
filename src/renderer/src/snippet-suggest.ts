import type { Snippet } from '@shared/types'

/**
 * 命令片段的「别名式」补全。
 *
 * 需求：像 shell 的 alias 一样，输入一个短触发词就能带出整条命令。
 * 例如片段 command 是 `git push`、alias 是 `gps`，输入 `gps` 后按 Tab
 * 就应该把当前行变成 `git push`。
 *
 * 纯函数，不碰终端，方便单测。
 */

export interface SnippetSuggestion {
  snippet: Snippet
  /** 用户已经输入的部分 */
  typed: string
  /** 补全后整行应该是什么 */
  full: string
  /** 命中的触发词（没命中触发词时为空） */
  matchedAlias?: string
}

export interface MatchOptions {
  /**
   * 只在这一段之前匹配（默认整行开头）。
   * alias 一般就是命令的第一个词，所以默认整行前缀匹配即可。
   */
  trimStart?: boolean
}

interface Candidate extends SnippetSuggestion {
  /** alias 命中优先于命令前缀命中 */
  rank: 'alias' | 'command'
  /** 同为 alias 命中时，触发词越长越具体 */
  aliasLen: number
}

/**
 * 在片段里找一条能补全当前输入的。
 *
 * 优先级：alias 命中 > 命令前缀命中；同为 alias 命中时取触发词最长的那条
 * （`gps` 比 `g` 更具体）。
 */
export function matchSuggestion(
  snippets: Snippet[],
  input: string,
  options: MatchOptions = {}
): SnippetSuggestion | null {
  const typed = options.trimStart === false ? input : input.trimStart()
  if (!typed) return null

  const candidates: Candidate[] = []
  const consider = (candidate: Candidate): void => {
    candidates.push(candidate)
  }

  for (const snippet of snippets) {
    const alias = snippet.alias?.trim()
    const command = snippet.command

    if (alias) {
      if (typed === alias) {
        // 输入的正好是触发词 → 整行替换成命令
        consider({ snippet, typed, full: command, matchedAlias: alias, rank: 'alias', aliasLen: alias.length })
        continue
      }
      if (alias.startsWith(typed)) {
        // 触发词只输入了一部分 → 补成完整命令
        consider({ snippet, typed, full: command, matchedAlias: alias, rank: 'alias', aliasLen: typed.length })
        continue
      }
      if (typed.startsWith(alias)) {
        // 已经打了完整触发词，后面还跟着内容：只有「空格 + 参数」这种才算
        // （`gps --force` → `git push --force`）。
        // 否则不补全——否则 `gpsugps` 会被补成 `git pushugps` 这种莫名其妙的东西
        const rest = typed.slice(alias.length)
        if (rest.startsWith(' ')) {
          consider({
            snippet,
            typed,
            full: command + rest,
            matchedAlias: alias,
            rank: 'alias',
            aliasLen: alias.length
          })
        }
        continue
      }
    }

    if (command.startsWith(typed) && command !== typed) {
      // 没有触发词时，退而求其次：命令本身的前缀
      consider({ snippet, typed, full: command, rank: 'command', aliasLen: 0 })
    }
  }

  if (candidates.length === 0) return null
  // alias 命中优先；同为 alias 命中时触发词更长的更具体
  candidates.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank === 'alias' ? -1 : 1
    return b.aliasLen - a.aliasLen
  })
  const winner = candidates[0]
  return {
    snippet: winner.snippet,
    typed: winner.typed,
    full: winner.full,
    matchedAlias: winner.matchedAlias
  }
}

/**
 * 接受补全时需要发给终端的内容。
 *
 * 终端里已经有 typed.length 个字符，要先退格删掉，再写上补全后的整行。
 * 不带回车——命令是否执行交给用户自己确认。
 */
export function acceptanceSequence(suggestion: SnippetSuggestion): string {
  const backspaces = '\u007f'.repeat(suggestion.typed.length)
  return backspaces + suggestion.full
}

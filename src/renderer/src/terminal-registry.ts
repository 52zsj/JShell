import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { SearchAddon } from '@xterm/addon-search'
import type { AppSettings } from '@shared/types'
import { getTerminalTheme } from './themes'

/**
 * 终端实例注册表（React 之外）。
 *
 * 为什么需要它：
 *  1. SSH/PTY 数据通过 IPC 高频到达，若走 React state 会引起整棵树重渲染；
 *  2. 分屏重排会让组件树「换父节点」，React 必然卸载重建 —— 若终端随组件销毁，
 *     历史输出会丢。这里把 xterm 实例与它的宿主 <div> 一起常驻在模块级，
 *     组件重新挂载时只是把宿主 div 搬到新容器里（reparent），终端本身不重建。
 *
 * 生命周期：只有会话真正关闭（关闭分屏/标签页）时才 disposeTerminal()。
 */
interface TerminalEntry {
  term: Terminal
  host: HTMLDivElement
  fit: FitAddon
  search: SearchAddon
}

const entries = new Map<string, TerminalEntry>()
const pending = new Map<string, string[]>()
/** 缓冲块数上限 */
const PENDING_LIMIT = 400
/** 缓冲字节上限：旧实现只限块数，单块可达 64KB，最坏会占十几 MB */
const PENDING_BYTES = 512 * 1024
/**
 * 后台标签的 scrollback 上限。
 *
 * xterm 的缓冲是内存大头（5000 行 × 120 列 ≈ 20MB/终端）。被隐藏的标签
 * 基本没人回看很久以前的内容，收窄到 1000 行；切回可见时恢复用户设置值。
 */
const HIDDEN_SCROLLBACK = 1000

function trimPending(queue: string[]): void {
  let bytes = 0
  for (const chunk of queue) bytes += chunk.length
  while (queue.length > 1 && (bytes > PENDING_BYTES || queue.length > PENDING_LIMIT)) {
    bytes -= queue[0]?.length ?? 0
    queue.shift()
  }
}

function flushPending(sessionId: string, term: Terminal): void {
  const backlog = pending.get(sessionId)
  if (!backlog) return
  pending.delete(sessionId)
  for (const chunk of backlog) {
    // 这些块在入队时已经回过执，创建终端后只补写，不再重复确认
    term.write(chunk)
  }
}

/** 取得（必要时创建）某个会话的终端实例 */
export function acquireTerminal(sessionId: string, settings: AppSettings): TerminalEntry {
  const existing = entries.get(sessionId)
  if (existing) return existing

  const host = document.createElement('div')
  host.className = 'terminal-host'

  const term = new Terminal({
    fontFamily: settings.fontFamily,
    fontSize: settings.fontSize,
    cursorBlink: settings.cursorBlink,
    cursorStyle: 'bar',
    scrollback: settings.scrollback,
    lineHeight: 1.25,
    allowProposedApi: true,
    macOptionIsMeta: true,
    theme: getTerminalTheme(settings.terminalTheme)
  })

  const fit = new FitAddon()
  const search = new SearchAddon()
  term.loadAddon(fit)
  term.loadAddon(search)
  term.loadAddon(new WebLinksAddon())
  term.open(host)

  // 输入方向：xterm -> IPC -> 主进程会话
  term.onData((data) => {
    void window.jshell.sessions.write(sessionId, data)
  })
  // 尺寸变化 -> 远端 PTY / 本地 PTY
  term.onResize(({ cols, rows }) => {
    void window.jshell.sessions.resize(sessionId, cols, rows)
  })

  const entry: TerminalEntry = { term, host, fit, search }
  entries.set(sessionId, entry)
  flushPending(sessionId, term)
  return entry
}

export function getTerminal(sessionId: string): Terminal | undefined {
  return entries.get(sessionId)?.term
}

/** 终端搜索插件（Ctrl/Cmd+F 搜索条使用） */
export function getSearchAddon(sessionId: string): SearchAddon | undefined {
  return entries.get(sessionId)?.search
}

/** 在容器尺寸有效时重新计算行列数（隐藏标签页/分屏为 0 尺寸时跳过，避免 PTY 被压成 1 列） */
export function fitTerminal(sessionId: string): void {
  const entry = entries.get(sessionId)
  if (!entry) return
  const parent = entry.host.parentElement
  if (!parent || parent.clientWidth < 40 || parent.clientHeight < 40) return
  try {
    entry.fit.fit()
  } catch {
    /* 忽略测量失败 */
  }
}

/** 会话关闭时调用，释放 xterm 与 DOM */
export function disposeTerminal(sessionId: string): void {
  const entry = entries.get(sessionId)
  pending.delete(sessionId)
  if (!entry) return
  entries.delete(sessionId)
  entry.host.remove()
  entry.term.dispose()
}

/** 远端/本地输出 -> 终端；终端尚未创建时先缓冲 */
/** 回执：告诉主进程这一块已经解析完，主进程据此解除背压 */
function ackOutput(sessionId: string, chars: number): void {
  window.jshell.sessions.ack(sessionId, chars)
}

export function pushTerminalData(sessionId: string, data: string): void {
  const entry = entries.get(sessionId)
  if (entry) {
    // 用 write 的回调做回执：xterm 真正解析完才确认，才是有效背压
    entry.term.write(data, () => ackOutput(sessionId, data.length))
    return
  }
  const queue = pending.get(sessionId) ?? []
  queue.push(data)
  trimPending(queue)
  pending.set(sessionId, queue)
  // 还没有终端时数据先入队：入队长度有上限（PENDING_BYTES），
  // 这里直接回执，避免主进程一直等一个永远不会来的确认而卡住会话
  ackOutput(sessionId, data.length)
}

/**
 * 标签可见性变化时调整 scrollback 上限。
 *
 * 不可见的标签把缓冲收窄到 HIDDEN_SCROLLBACK，切回可见时恢复用户设置；
 * 这样多标签场景下内存不再随「开着的标签数」线性膨胀。
 */
export function setTerminalVisible(sessionId: string, visible: boolean, settings: AppSettings): void {
  const entry = entries.get(sessionId)
  if (!entry) return
  const target = visible ? settings.scrollback : hiddenScrollback(settings)
  if (entry.term.options.scrollback === target) return
  entry.term.options.scrollback = target
}

/** 后台标签实际使用的 scrollback（供 UI 层复用同一套换算） */
export function hiddenScrollback(settings: AppSettings): number {
  return Math.min(settings.scrollback, HIDDEN_SCROLLBACK)
}

/**
 * 当前获得焦点的终端会话。
 * 主进程拦截 Cmd+C / Cmd+V 后需要知道把动作投给哪个终端（文件面板聚焦时为 null）。
 */
let focusedSessionId: string | null = null

export function setFocusedSession(sessionId: string | null): void {
  focusedSessionId = sessionId
}

export function getFocusedSession(): string | null {
  return focusedSessionId
}

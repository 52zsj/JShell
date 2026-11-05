import { useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '../store'
import { syncTargets, targetLabel, type InputSyncTarget } from '../input-sync'
import { cx } from '../utils'

/**
 * 批量编辑的开关与作用范围选择器（状态栏右侧）。
 *
 * 交互约定（按用户要求）：**不勾任何一项 = 全部**。
 * 因为广播输入本身很危险（一条 rm 会打到所有机器上），所以：
 *  - 默认关闭，不落盘，重启必为关闭；
 *  - 开启后状态栏变红、终端区出现红色描边，任何时刻都看得见"我现在在广播"；
 *  - 列表粒度是**分屏**：多标签按 1、2、3 列出，同一个标签里的分屏按 1.1、1.2 列出，
 *    两种用法（多机分标签 / 单机分屏）都能单独勾选。
 */
export function InputSyncControl() {
  const enabled = useAppStore((s) => s.inputSyncEnabled)
  const selectedIds = useAppStore((s) => s.inputSyncSessions)
  const tabs = useAppStore((s) => s.tabs)
  const setInputSync = useAppStore((s) => s.setInputSync)
  const toggleSession = useAppStore((s) => s.toggleInputSyncSession)
  const selectAll = useAppStore((s) => s.selectAllInputSyncSessions)

  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  const targets = syncTargets(tabs, selectedIds)
  const allMode = selectedIds.length === 0
  const chosen = targets.filter((target) => target.selected)
  const readyCount = chosen.filter((target) => target.ready).length
  const others = Math.max(0, readyCount - 1)
  const tabCount = new Set(chosen.map((target) => target.tabId)).size

  // 按标签分组：单分屏标签不显示分组标题，多分屏才加一行，避免列表太吵
  const groups = useMemo(() => {
    const map = new Map<string, InputSyncTarget[]>()
    for (const target of targets) {
      const list = map.get(target.tabId) ?? []
      list.push(target)
      map.set(target.tabId, list)
    }
    return [...map.values()]
  }, [targets])

  // 点空白处 / Esc 关闭选择器
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onPointerDown, true)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('mousedown', onPointerDown, true)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  // 关闭广播时把面板也收起来，否则会留一个浮层挂在状态栏上
  useEffect(() => {
    if (!enabled) setOpen(false)
  }, [enabled])

  const scopeLabel = allMode ? `全部 ${chosen.length} 个` : `已选 ${chosen.length} 个`

  return (
    <div className="batch-edit" ref={wrapRef}>
      <button
        className={cx('batch-toggle', enabled && 'is-on')}
        title={
          enabled
            ? '批量编辑已开启：输入的字符会同时发给选中的终端。点击关闭'
            : '批量编辑：在一个终端里输入，同时发给多个终端（默认发给全部标签与分屏）'
        }
        onClick={() => setInputSync(!enabled)}
      >
        <span className="batch-toggle-icon" aria-hidden>
          ⇉
        </span>
        {enabled ? '批量编辑中' : '批量编辑'}
      </button>

      {enabled && (
        <button
          className={cx('batch-scope', others === 0 && 'is-empty')}
          title="选择要把输入同步给哪些标签 / 分屏"
          onClick={() => setOpen((prev) => !prev)}
        >
          {others === 0 ? '无其它可用终端' : scopeLabel}
        </button>
      )}

      {enabled && open && (
        <div className="batch-picker">
          <div className="batch-picker-head">
            <span>输入同时发送到</span>
            <span className="batch-picker-count">
              {tabCount} 个标签 · {chosen.length} 个分屏
            </span>
          </div>

          <button
            className={cx('batch-row', allMode && 'is-checked')}
            onClick={selectAll}
            title="清空选择即代表全部"
          >
            <span className={cx('batch-check', allMode && 'is-on')} />
            <span className="batch-row-label">全部终端</span>
            <span className="batch-row-hint">不勾选即为全部</span>
          </button>

          <div className="batch-list">
            {groups.map((group) => (
              <div key={group[0].tabId}>
                {group.length > 1 && (
                  <div className="batch-group">
                    <span className="batch-group-index">{group[0].tabIndex}</span>
                    <span className="batch-group-label">{group[0].paneCount} 个分屏</span>
                  </div>
                )}
                {group.map((target) => (
                  <button
                    key={target.sessionId}
                    className={cx(
                      'batch-row',
                      target.selected && 'is-checked',
                      !target.ready && 'is-disabled',
                      group.length > 1 && 'is-child'
                    )}
                    disabled={!target.ready}
                    title={
                      target.ready
                        ? `${target.label}（第 ${targetLabel(target)} 号）`
                        : `${target.label} · 未连接，暂不参与`
                    }
                    onClick={() => toggleSession(target.sessionId)}
                  >
                    <span className={cx('batch-check', target.selected && 'is-on')} />
                    <span className="batch-row-index">{targetLabel(target)}</span>
                    <span className="batch-row-label">{target.label}</span>
                    {!target.ready && <span className="batch-row-hint">未连接</span>}
                  </button>
                ))}
              </div>
            ))}
            {targets.length === 0 && <div className="batch-empty">还没有打开的终端</div>}
          </div>

          <p className="batch-warn">
            开启期间每条输入都会发给以上终端；要跑破坏性命令前先关掉。
          </p>
        </div>
      )}
    </div>
  )
}

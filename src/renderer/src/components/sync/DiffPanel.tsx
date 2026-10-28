import type { DiffEntry, DiffReport } from '@shared/sync'
import { cx } from '../../utils'

const ACTION_TEXT: Record<DiffEntry['action'], string> = {
  add: '新增',
  update: '覆盖',
  delete: '删除',
  same: '不变'
}

const KIND_TEXT: Record<DiffEntry['kind'], string> = {
  host: '主机',
  snippet: '片段',
  tunnel: '转发',
  knownHost: '指纹',
  settings: '设置'
}

/**
 * 覆盖前的检测清单。
 * 只列会变化的条目：「不变」的只给计数，否则几百台主机会把真正的风险淹掉。
 */
export function DiffPanel({ diff, loading }: { diff: DiffReport | null; loading: boolean }) {
  if (loading) return <p className="sync-hint">正在检测本机与同步包的差异…</p>
  if (!diff) return null

  const changed = diff.counts.add + diff.counts.update + diff.counts.delete
  const riskyTotal = diff.risky.overwriteNewer + diff.risky.deleteLocal
  if (changed === 0) {
    return <p className="sync-hint">检测结果：本机已是最新，没有需要变更的内容。</p>
  }

  const visible = diff.entries.filter((entry) => entry.action !== 'same')
  const shown = visible.slice(0, 60)

  return (
    <div className="sync-diff">
      <div className="sync-diff-head">
        <strong>检测结果</strong>
        <span className="sync-diff-counts">
          {diff.counts.add > 0 && <em className="is-add">新增 {diff.counts.add}</em>}
          {diff.counts.update > 0 && <em className="is-update">覆盖 {diff.counts.update}</em>}
          {diff.counts.delete > 0 && <em className="is-delete">删除 {diff.counts.delete}</em>}
          {diff.counts.same > 0 && <em className="is-same">不变 {diff.counts.same}</em>}
        </span>
      </div>

      {riskyTotal > 0 && (
        <p className="sync-risk">
          {diff.risky.overwriteNewer > 0 && (
            <span>{diff.risky.overwriteNewer} 项本机改动较新，将被同步包覆盖</span>
          )}
          {diff.risky.deleteLocal > 0 && (
            <span>{diff.risky.deleteLocal} 项本机独有条目将被删除</span>
          )}
        </p>
      )}

      <div className="sync-diff-list">
        {shown.map((entry) => (
          <div className="sync-diff-row" key={`${entry.kind}-${entry.id}`}>
            <span className={cx('sync-diff-badge', `is-${entry.action}`)}>
              {ACTION_TEXT[entry.action]}
            </span>
            <span className="sync-diff-kind">{KIND_TEXT[entry.kind]}</span>
            <span className="sync-diff-label">{entry.label}</span>
            {entry.detail && <span className="sync-diff-detail mono">{entry.detail}</span>}
            {entry.localNewer && entry.action === 'update' && (
              <span className="sync-diff-newer">本机较新</span>
            )}
          </div>
        ))}
        {visible.length > shown.length && (
          <div className="sync-diff-row is-more">
            还有 {visible.length - shown.length} 项变更未列出
          </div>
        )}
      </div>
    </div>
  )
}

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  MIN_PASSWORD_LENGTH,
  SYNC_DELETE_NOTICE,
  SYNC_MODE_LABELS,
  SYNC_SCOPES,
  passwordStrength,
  type DiffReport,
  type PasswordStrength,
  type SyncExportResult,
  type SyncFolderFile,
  type SyncImportMode,
  type SyncImportResult,
  type SyncInspectResult,
  type SyncScope,
  type SyncSource,
  type SyncTarget
} from '@shared/sync'
import {
  IconChevronDown,
  IconClipboard,
  IconCloud,
  IconClose,
  IconFolder,
  IconSave,
  IconShield
} from '../icons'
import { useAppStore } from '../store'
import { cx, errorMessage, formatBytes } from '../utils'
import { AutoSyncPane } from './sync/AutoSyncPane'
import { DiffPanel } from './sync/DiffPanel'
import { formatTime } from './sync/format'

interface Props {
  onClose: () => void
}

type Tab = 'export' | 'import' | 'auto'
type DestKind = 'file' | 'clipboard'

const DEFAULT_SCOPES: SyncScope[] = SYNC_SCOPES.filter((item) => item.defaultOn).map((item) => item.id)

const IMPORT_BUTTON: Record<SyncImportMode, string> = {
  overwrite: '覆盖导入',
  merge: '合并导入',
  replace: '替换导入'
}

const STRENGTH_TEXT: Record<PasswordStrength, string> = {
  empty: '',
  short: `至少 ${MIN_PASSWORD_LENGTH} 位`,
  weak: '偏弱：建议加长或混合大小写与符号',
  fair: '可用：再长一些更稳妥',
  good: '强度足够'
}

/**
 * 数据共享面板。
 *
 * 三种落地方式不是「三个功能」，而是同一个同步包的三个去处：
 * 任意文件 / 探测到的云盘目录 / 剪贴板。少了哪一个都不影响另外两个可用，
 * 这样用户没有 iCloud 也照样能同步，不会被某个服务绑死。
 */
export function SyncDialog({ onClose }: Props) {
  const pushToast = useAppStore((s) => s.pushToast)
  const reloadHosts = useAppStore((s) => s.reloadHosts)
  const reloadSnippets = useAppStore((s) => s.reloadSnippets)
  const reloadSettings = useAppStore((s) => s.reloadSettings)

  const [tab, setTab] = useState<Tab>('export')

  // ------------------------------------------------------------------ 导出
  const [targets, setTargets] = useState<SyncTarget[]>([])
  const [dest, setDest] = useState<DestKind>('file')
  const [scopes, setScopes] = useState<SyncScope[]>(DEFAULT_SCOPES)
  const [usePassword, setUsePassword] = useState(true)
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [busy, setBusy] = useState(false)
  const [exported, setExported] = useState<SyncExportResult | null>(null)

  // ------------------------------------------------------------------ 导入
  const [source, setSource] = useState<SyncSource | null>(null)
  const [folderTarget, setFolderTarget] = useState('')
  const [folderFiles, setFolderFiles] = useState<SyncFolderFile[]>([])
  const [inspect, setInspect] = useState<SyncInspectResult | null>(null)
  const [importPassword, setImportPassword] = useState('')
  const [mode, setMode] = useState<SyncImportMode>('overwrite')
  const [importing, setImporting] = useState(false)
  const [importResult, setImportResult] = useState<SyncImportResult | null>(null)
  const [diff, setDiff] = useState<DiffReport | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)


  const credentialsSelected = scopes.includes('credentials')
  const strength = passwordStrength(password)
  /** 含密码的包必须加密：这是硬边界，不提供「明文带密码」的选项 */
  const encryptionLocked = credentialsSelected

  useEffect(() => {
    let alive = true
    void window.jshell.sync
      .targets()
      .then((list) => {
        if (!alive) return
        setTargets(list)
      })
      .catch((err) => pushToast(errorMessage(err), 'error'))
    return () => {
      alive = false
    }
  }, [pushToast])

  // 关闭面板时清空主进程里挂起的导入会话，不把明文留在内存
  useEffect(() => () => void window.jshell.sync.dispose().catch(() => undefined), [])

  useEffect(() => {
    if (credentialsSelected) setUsePassword(true)
  }, [credentialsSelected])

  /**
   * 解读成功后立刻做一次检测：切换覆盖 / 合并 / 替换时重新算。
   * 检测只读，不产生副作用；真正的写入发生在用户确认之后。
   */
  const inspectToken = inspect?.token
  const hasPreview = Boolean(inspect?.preview)
  useEffect(() => {
    if (!inspectToken || !hasPreview) {
      setDiff(null)
      return
    }
    let alive = true
    setDiffLoading(true)
    window.jshell.sync
      .diff(inspectToken, mode)
      .then((report) => {
        if (alive) setDiff(report)
      })
      .catch((err) => {
        if (alive) {
          setDiff(null)
          pushToast(errorMessage(err), 'error')
        }
      })
      .finally(() => {
        if (alive) setDiffLoading(false)
      })
    return () => {
      alive = false
    }
  }, [inspectToken, hasPreview, mode, pushToast])

  const close = useCallback(() => {
    void window.jshell.sync.dispose().catch(() => undefined)
    onClose()
  }, [onClose])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [close])

  const toggleScope = (id: SyncScope): void => {
    setScopes((prev) => {
      const has = prev.includes(id)
      if (has) return prev.filter((item) => item !== id)
      const next = [...prev, id]
      // 凭据离开主机没有意义：勾选「密码」时自动带上主机
      if (id === 'credentials' && !next.includes('hosts')) next.unshift('hosts')
      return next
    })
  }


  // ------------------------------------------------------------------ 导出
  const runExport = async (): Promise<void> => {
    if (scopes.length === 0) {
      pushToast('请至少选择一项要同步的内容', 'error')
      return
    }
    if (usePassword) {
      if (password.length < MIN_PASSWORD_LENGTH) {
        pushToast(`口令至少 ${MIN_PASSWORD_LENGTH} 位`, 'error')
        return
      }
    }

    setBusy(true)
    try {
      const result = await window.jshell.sync.exportBundle({
        scopes,
        password: usePassword ? password : undefined,
        destination: dest === 'file' ? { kind: 'dialog' } : { kind: 'clipboard' }
      })
      if (result.canceled) return
      setExported(result)
      pushToast(
        result.clipboard ? '同步包已复制到剪贴板' : `同步包已导出（${formatBytes(result.bytes ?? 0)}）`,
        'success'
      )
    } catch (err) {
      pushToast(errorMessage(err), 'error')
    } finally {
      setBusy(false)
    }
  }

  // ------------------------------------------------------------------ 导入
  const runInspect = useCallback(
    async (next: SyncSource, pwd?: string) => {
      setBusy(true)
      try {
        const result = await window.jshell.sync.inspect(next, pwd)
        if (result.canceled) return
        setSource(next)
        setInspect(result)
        setImportResult(null)
      } catch (err) {
        pushToast(errorMessage(err), 'error')
      } finally {
        setBusy(false)
      }
    },
    [pushToast]
  )

  const loadFolder = useCallback(
    async (id: string) => {
      setFolderTarget(id)
      setSource(null)
      setInspect(null)
      try {
        const files = await window.jshell.sync.files(id)
        setFolderFiles(files)
        if (files.length === 0) pushToast('该云盘目录里还没有同步包', 'info')
      } catch (err) {
        pushToast(errorMessage(err), 'error')
      }
    },
    [pushToast]
  )

  const runImport = async (): Promise<void> => {
    if (!inspect?.token) return
    if (!inspect.preview) {
      pushToast('请先输入口令完成解读', 'error')
      return
    }
    if (!diff) {
      pushToast('正在检测差异，请稍候', 'error')
      return
    }

    const changed = diff.counts.add + diff.counts.update + diff.counts.delete
    if (changed === 0) {
      pushToast('本机已是最新，没有需要导入的内容', 'info')
      return
    }

    /**
     * 覆盖前必须过这一关：把「会被改掉/删掉什么」摊开给用户确认，
     * 而不是导完才发现本机的新改动没了。
     */
    const riskyTotal = diff.risky.overwriteNewer + diff.risky.deleteLocal
    if (riskyTotal > 0 || mode === 'replace') {
      const parts: string[] = []
      if (diff.risky.overwriteNewer > 0) {
        parts.push(`${diff.risky.overwriteNewer} 项本机改动较新，将被同步包覆盖`)
      }
      if (diff.risky.deleteLocal > 0) {
        parts.push(`${diff.risky.deleteLocal} 项本机独有条目将被删除`)
      }
      if (mode === 'replace') parts.push('替换模式下，包里的分区会整体覆盖本机')
      parts.push(`本次共覆盖 ${diff.counts.update} 项、新增 ${diff.counts.add} 项`)

      const ok = await window.jshell.dialog.confirm({
        title: '确认覆盖本机配置？',
        message:
          riskyTotal > 0 ? `有 ${riskyTotal} 项变更会改动或删除本机已有内容` : '本次会替换本机配置',
        detail: `${parts.join('；')}。导入前会自动备份当前配置，可在数据目录 backups/ 中找回。`,
        danger: true
      })
      if (!ok) return
    }

    setImporting(true)
    try {
      const result = await window.jshell.sync.import({
        token: inspect.token,
        password: inspect.encrypted ? importPassword : undefined,
        mode,
        acknowledge: riskyTotal > 0
      })
      setImportResult(result)
      setDiff(null)
      await Promise.all([reloadHosts(), reloadSnippets(), reloadSettings()])
      pushToast('同步包已导入', 'success')
    } catch (err) {
      pushToast(errorMessage(err), 'error')
    } finally {
      setImporting(false)
    }
  }

  const resetImport = (): void => {
    setSource(null)
    setInspect(null)
    setImportPassword('')
    setImportResult(null)
    setDiff(null)
    setMode('overwrite')
  }

  const preview = inspect?.preview
  const needsPassword = Boolean(inspect?.encrypted && !inspect.preview)
  const pendingChanges = diff ? diff.counts.add + diff.counts.update + diff.counts.delete : 0
  const destinationLabel = useMemo(
    () => (dest === 'clipboard' ? '剪贴板' : '系统文件对话框'),
    [dest]
  )

  return (
    <div className="modal-mask" onClick={close}>
      <div className="modal wide sync-modal" onClick={(event) => event.stopPropagation()}>
        <header className="modal-head">
          <div>
            <h2>配置包</h2>
            <p className="sync-intro">
              把主机与设置打成一个文件，拷到另一台机器导入，就能多机统一配置。
            </p>
          </div>
          <button className="icon-btn" onClick={close} title="关闭">
            <IconClose />
          </button>
        </header>

        <div className="sync-tabs">
          <button
            className={cx('sync-tab', tab === 'export' && 'is-active')}
            onClick={() => setTab('export')}
          >
            生成配置包
          </button>
          <button
            className={cx('sync-tab', tab === 'import' && 'is-active')}
            onClick={() => setTab('import')}
          >
            导入配置包
          </button>
          <button
            className={cx('sync-tab', tab === 'auto' && 'is-active')}
            onClick={() => setTab('auto')}
          >
            自动同步
          </button>
        </div>

        {tab === 'auto' ? (
          <AutoSyncPane
            targets={targets}
            onOpenImport={(id) => {
              setTab('import')
              if (id) void loadFolder(id)
            }}
            onClose={close}
          />
        ) : (
          <>
        <div className="modal-body sync-body">
          {tab === 'export' ? (
            <>
              <section className="sync-section">
                <h3>保存到哪里</h3>
                <p className="sync-hint">
                  配置包就是一个普通文件。存成文件最通用——网盘目录、U 盘、局域网共享都能选；
                  复制到剪贴板适合临时传给另一台设备。
                </p>
                <div className="sync-dest-row">
                  <button
                    className={cx('btn', dest === 'file' ? 'btn-primary' : 'btn-ghost')}
                    onClick={() => setDest('file')}
                  >
                    <IconSave /> 保存到文件…
                  </button>
                  <button
                    className={cx('btn', dest === 'clipboard' ? 'btn-primary' : 'btn-ghost')}
                    onClick={() => setDest('clipboard')}
                  >
                    <IconClipboard /> 复制到剪贴板
                  </button>
                </div>
                <p className="sync-hint">
                  想让它长期跟着多台机器一致，用下面的「自动同步」——它会自己写进网盘目录，不用手动搬。
                </p>

              </section>

              <section className="sync-section">
                <h3>包含内容</h3>
                {/* 不受控的 details：默认收起，用户自己决定要不要展开看细节 */}
                <details className="sync-advanced">
                  <summary>
                    <span className="sync-summary-text">
                      {scopes.length === SYNC_SCOPES.length
                        ? '全部内容（主机与分组 · 命令片段 · 转发设置 · 端口转发规则）'
                        : `已选 ${scopes.length} 项：${scopes
                            .map((id) => SYNC_SCOPES.find((item) => item.id === id)?.label ?? id)
                            .join('、')}`}
                    </span>
                    <span className="sync-summary-hint">点击调整</span>
                  </summary>
                  <div className="sync-scopes">
                    {SYNC_SCOPES.map((item) => (
                      <label className="sync-scope" key={item.id}>
                        <input
                          type="checkbox"
                          checked={scopes.includes(item.id)}
                          onChange={() => toggleScope(item.id)}
                        />
                        <span className="sync-scope-body">
                          <strong>
                            {item.label}
                            {item.sensitive && <span className="sync-badge warn">敏感</span>}
                          </strong>
                          <em>{item.hint}</em>
                        </span>
                      </label>
                    ))}
                  </div>
                </details>
              </section>

              <section className="sync-section">
                <h3>加密保护</h3>
                <div className="segmented sync-encrypt">
                  <button
                    className={cx('segmented-item', usePassword && 'is-active')}
                    onClick={() => setUsePassword(true)}
                  >
                    口令加密
                    <span className="sync-seg-hint">推荐</span>
                  </button>
                  <button
                    className={cx('segmented-item', !usePassword && 'is-active')}
                    disabled={encryptionLocked}
                    title={encryptionLocked ? '包含密码时必须加密' : undefined}
                    onClick={() => setUsePassword(false)}
                  >
                    不加密
                  </button>
                </div>
                {encryptionLocked && (
                  <p className="sync-hint">
                    已勾选「密码与私钥口令」：整包必须加密，否则无法导出。
                  </p>
                )}

                {usePassword ? (
                  <div className="sync-password">
                    <label className="field">
                      <span>口令</span>
                      <div className="sync-password-row">
                        <input
                          className="input"
                          type={showPassword ? 'text' : 'password'}
                          autoComplete="new-password"
                          value={password}
                          placeholder={`至少 ${MIN_PASSWORD_LENGTH} 位，导入时需输入`}
                          onChange={(event) => setPassword(event.target.value)}
                        />
                        <button
                          className="btn btn-ghost"
                          type="button"
                          onClick={() => setShowPassword((v) => !v)}
                        >
                          {showPassword ? '隐藏' : '显示'}
                        </button>
                      </div>
                    </label>
                    {password && (
                      <p className={cx('sync-strength', `is-${strength}`)}>
                        {STRENGTH_TEXT[strength]}
                      </p>
                    )}
                    <p className="sync-hint">
                      口令不会被保存。忘记口令 = 文件无法解密，JShell 也无法帮你找回。
                    </p>
                  </div>
                ) : (
                  <p className="sync-hint warn">
                    不加密时，任何拿到这个文件的人都能读到你的主机地址、用户名和分组。
                    只建议在完全可信的介质上使用，并且不要勾选「密码与私钥口令」。
                  </p>
                )}
              </section>

              {exported && (
                <div className="sync-result">
                  <div className="sync-result-title">已生成配置包</div>
                  <div className="sync-result-body">
                    {exported.clipboard ? (
                      <span>已复制到剪贴板（{formatBytes(exported.bytes ?? 0)}）</span>
                    ) : (
                      <span className="mono selectable">{exported.path}</span>
                    )}
                  </div>
                  <div className="sync-result-note">
                    主机 {exported.meta?.counts.hosts ?? 0} · 片段 {exported.meta?.counts.snippets ?? 0}
                    {exported.meta?.hasCredentials ? ' · 含密码' : ''}
                  </div>
                </div>
              )}
            </>
          ) : (
            <>
              {importResult ? (
                <div className="sync-result big">
                  <div className="sync-result-title">导入完成</div>
                  <div className="sync-result-body">
                    主机 {importResult.hosts} · 片段 {importResult.snippets} · 转发{' '}
                    {importResult.tunnels} · 指纹 {importResult.knownHosts}
                    {importResult.credentials > 0 ? ` · 密码 ${importResult.credentials}` : ''}
                    {importResult.settings ? ' · 已应用设置' : ''}
                  </div>
                  {importResult.warnings.length > 0 && (
                    <ul className="sync-warnings">
                      {importResult.warnings.map((text) => (
                        <li key={text}>{text}</li>
                      ))}
                    </ul>
                  )}
                  {importResult.backupPath && (
                    <div className="sync-result-note mono">{importResult.backupPath}</div>
                  )}
                  <div className="sync-result-actions">
                    <button className="btn btn-ghost" onClick={resetImport}>
                      再导入一个
                    </button>
                    <button className="btn btn-primary" onClick={close}>
                      完成
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <section className="sync-section">
                    <h3>读取配置包</h3>
                    <div className="sync-sources">
                      <button
                        className="btn btn-primary"
                        disabled={busy}
                        onClick={() => void runInspect({ kind: 'file' })}
                      >
                        <IconFolder /> 选择文件…
                      </button>
                      <button
                        className="btn btn-ghost"
                        disabled={busy || targets.length === 0}
                        title={targets.length === 0 ? '没有检测到云盘目录' : undefined}
                        onClick={() => {
                          const id = folderTarget || targets[0]?.id
                          if (id) void loadFolder(id)
                        }}
                      >
                        <IconCloud /> 网盘里的历史包
                        <IconChevronDown />
                      </button>
                      <button
                        className="btn btn-ghost"
                        disabled={busy}
                        onClick={() => void runInspect({ kind: 'clipboard' })}
                      >
                        <IconClipboard /> 从剪贴板
                      </button>
                    </div>

                    {targets.length > 0 && folderTarget && (
                      <div className="sync-files">
                        <div className="sync-files-head">
                          <select
                            className="input"
                            value={folderTarget}
                            onChange={(event) => void loadFolder(event.target.value)}
                          >
                            {targets.map((target) => (
                              <option key={target.id} value={target.id}>
                                {target.label}
                              </option>
                            ))}
                          </select>
                        </div>
                        {folderFiles.length === 0 ? (
                          <p className="sync-hint">这个目录里还没有同步包。</p>
                        ) : (
                          folderFiles.map((file) => (
                            <button
                              key={file.name}
                              className={cx(
                                'sync-file',
                                inspect?.sourceLabel === file.name && 'is-active'
                              )}
                              onClick={() =>
                                void runInspect({
                                  kind: 'folder',
                                  targetId: folderTarget,
                                  name: file.name
                                })
                              }
                            >
                              <span className="sync-file-name mono">{file.name}</span>
                              <span className="sync-file-meta">
                                {formatBytes(file.size)} · {formatTime(new Date(file.mtime).toISOString())}
                              </span>
                            </button>
                          ))
                        )}
                      </div>
                    )}

                    {!inspect && !folderTarget && (
                      <p className="sync-hint">
                        配置包是一个 <code>.jshellsync</code> 文件。可以选任意位置的文件、云盘{' '}
                        <code>JShell</code> 目录里的历史包，或直接粘贴复制到剪贴板的包内容。
                        加密包会在读取后提示输入口令。
                      </p>
                    )}
                  </section>

                  {inspect && (
                    <section className="sync-section">
                      <h3>包内容</h3>
                      <div className="sync-package">
                        <div className="sync-package-head">
                          <IconShield />
                          <strong>{inspect.meta?.deviceName ?? '未知设备'}</strong>
                          {inspect.legacy && <span className="sync-badge">旧版格式</span>}
                          {inspect.encrypted ? (
                            <span className="sync-badge ok">已加密</span>
                          ) : (
                            <span className="sync-badge warn">未加密</span>
                          )}
                        </div>
                        <div className="sync-package-meta">
                          {formatTime(inspect.meta?.createdAt)} · JShell{' '}
                          {inspect.meta?.appVersion ?? '未知版本'} · {inspect.sourceLabel}
                        </div>
                        <div className="sync-counts">
                          <span>主机 {inspect.meta?.counts.hosts ?? 0}</span>
                          <span>片段 {inspect.meta?.counts.snippets ?? 0}</span>
                          <span>转发 {inspect.meta?.counts.tunnels ?? 0}</span>
                          <span>指纹 {inspect.meta?.counts.knownHosts ?? 0}</span>
                          {inspect.meta?.hasCredentials && (
                            <span className="sync-count-danger">
                              密码 {inspect.meta.counts.credentials}
                            </span>
                          )}
                        </div>
                      </div>

                      {needsPassword && (
                        <div className="sync-unlock">
                          <label className="field">
                            <span>该同步包已加密</span>
                            <input
                              className="input"
                              type="password"
                              autoComplete="off"
                              value={importPassword}
                              placeholder="输入导出时设置的口令"
                              onChange={(event) => setImportPassword(event.target.value)}
                              onKeyDown={(event) => {
                                if (event.key === 'Enter' && source) {
                                  void runInspect(source, importPassword)
                                }
                              }}
                            />
                          </label>
                          <button
                            className="btn btn-ghost"
                            disabled={busy || !importPassword}
                            onClick={() => source && void runInspect(source, importPassword)}
                          >
                            解读
                          </button>
                        </div>
                      )}

                      {preview && (
                        <>
                          <div className="sync-mode">
                            <div className="segmented">
                              {(['overwrite', 'merge', 'replace'] as SyncImportMode[]).map((item) => (
                                <button
                                  key={item}
                                  className={cx('segmented-item', mode === item && 'is-active')}
                                  onClick={() => setMode(item)}
                                >
                                  {SYNC_MODE_LABELS[item].label}
                                </button>
                              ))}
                            </div>
                            <p className="sync-hint">{SYNC_MODE_LABELS[mode].hint}</p>
                            <p className="sync-hint">{SYNC_DELETE_NOTICE}</p>
                          </div>

                          <DiffPanel diff={diff} loading={diffLoading} />
                        </>
                      )}
                    </section>
                  )}
                </>
              )}
            </>
          )}
        </div>

        <footer className="modal-foot">
          {tab === 'export' ? (
            <>
              <span className="sync-foot-note">
                方式：{destinationLabel}
                {usePassword ? ' · 已加密' : ' · 未加密'}
              </span>
              <button className="btn btn-ghost" onClick={close}>
                取消
              </button>
              <button className="btn btn-primary" disabled={busy} onClick={() => void runExport()}>
                {busy ? '处理中…' : '生成配置包'}
              </button>
            </>
          ) : (
            <>
              <span className="sync-foot-note">
                {inspect
                  ? needsPassword
                    ? '等待口令'
                    : pendingChanges > 0
                      ? `将变更 ${pendingChanges} 项`
                      : '本机已是最新'
                  : '请选择来源'}
              </span>
              <button className="btn btn-ghost" onClick={close}>
                取消
              </button>
              <button
                className="btn btn-primary"
                disabled={importing || !inspect?.preview || diffLoading || pendingChanges === 0}
                onClick={() => void runImport()}
              >
                {importing ? '导入中…' : IMPORT_BUTTON[mode]}
              </button>
            </>
          )}
        </footer>
          </>
        )}
      </div>
    </div>
  )
}

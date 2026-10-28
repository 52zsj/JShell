import { useCallback, useEffect, useState } from 'react'
import {
  MIN_PASSWORD_LENGTH,
  SYNC_DELETE_NOTICE,
  SYNC_SCOPES,
  type AutoSyncPatch,
  type SyncScope,
  type SyncTarget
} from '@shared/sync'
import { useAppStore } from '../../store'
import { cx, errorMessage } from '../../utils'
import { formatTime } from './format'

interface Props {
  targets: SyncTarget[]
  /** 「手动检查」跳到导入页签，并预选同一个目录 */
  onOpenImport: (folderTargetId: string) => void
  onClose: () => void
}

/**
 * 自动同步页签。
 *
 * 状态有两份来源：配置在全局 store（主进程推送，后台同步后侧边栏也要刷新），
 * 草稿类输入（口令、远端目录）留在本地。所有开关即时生效，与设置面板一致。
 */
export function AutoSyncPane({ targets, onOpenImport, onClose }: Props) {
  const pushToast = useAppStore((s) => s.pushToast)
  const reloadHosts = useAppStore((s) => s.reloadHosts)
  const reloadSnippets = useAppStore((s) => s.reloadSnippets)
  const reloadSettings = useAppStore((s) => s.reloadSettings)
  const hosts = useAppStore((s) => s.hosts)
  const auto = useAppStore((s) => s.autoSync)
  const setAutoSync = useAppStore((s) => s.setAutoSync)

  const [autoPassword, setAutoPassword] = useState('')
  const [autoBusy, setAutoBusy] = useState(false)
  const [sftpDirDraft, setSftpDirDraft] = useState('')
  const [webdavUrlDraft, setWebdavUrlDraft] = useState('')
  const [webdavUserDraft, setWebdavUserDraft] = useState('')
  const [webdavPasswordDraft, setWebdavPasswordDraft] = useState('')
  const [autoTest, setAutoTest] = useState<{ ok: boolean; message: string } | null>(null)
  const [testing, setTesting] = useState(false)

  // 远端目录是手输的，本地草稿跟随已保存值
  useEffect(() => {
    setSftpDirDraft(auto?.sftpDir ?? '')
  }, [auto?.sftpDir])

  useEffect(() => {
    setWebdavUrlDraft(auto?.webdavUrl ?? '')
    setWebdavUserDraft(auto?.webdavUsername ?? '')
  }, [auto?.webdavUrl, auto?.webdavUsername])

  const autoReady = Boolean(
    auto?.transport === 'sftp'
      ? auto.sftpHostId && auto.sftpDir
      : auto?.transport === 'webdav'
        ? auto.webdavUrl
        : auto?.dir
  )

  /** 每个开关都是即时生效（与设置面板一致，没有「保存」按钮） */
  const patchAuto = useCallback(
    async (patch: AutoSyncPatch): Promise<void> => {
      setAutoBusy(true)
      try {
        setAutoSync(await window.jshell.autoSync.set(patch))
      } catch (err) {
        pushToast(errorMessage(err), 'error')
      } finally {
        setAutoBusy(false)
      }
    },
    [pushToast, setAutoSync]
  )

  const runAuto = async (): Promise<void> => {
    setAutoBusy(true)
    try {
      const result = await window.jshell.autoSync.run()
      pushToast(result.message, result.ok ? (result.action === 'idle' ? 'info' : 'success') : 'error')
      await Promise.all([reloadHosts(), reloadSnippets(), reloadSettings()])
    } catch (err) {
      pushToast(errorMessage(err), 'error')
    } finally {
      setAutoBusy(false)
    }
  }

  const applyAutoPending = async (): Promise<void> => {
    const ok = await window.jshell.dialog.confirm({
      title: '按远端覆盖本机？',
      message: auto?.pending?.summary ?? '远端配置会覆盖本机同名条目',
      detail: '这会丢掉本机较新的改动，导入前会自动备份当前配置。',
      danger: true
    })
    if (!ok) return
    setAutoBusy(true)
    try {
      const result = await window.jshell.autoSync.applyPending()
      pushToast(result.message, result.ok ? 'success' : 'error')
      await Promise.all([reloadHosts(), reloadSnippets(), reloadSettings()])
    } catch (err) {
      pushToast(errorMessage(err), 'error')
    } finally {
      setAutoBusy(false)
    }
  }

  const toggleAutoScope = (id: SyncScope): void => {
    const current = auto?.scopes ?? []
    let next = current.includes(id) ? current.filter((item) => item !== id) : [...current, id]
    // 凭据必须与主机一起同步
    if (id === 'credentials' && !next.includes('hosts')) next = ['hosts', ...next]
    void patchAuto({ scopes: [...new Set(next)] })
  }

  return (
    <>
      <div className="modal-body sync-body">
              <section className="sync-section">
                <h3>自动同步</h3>
                <p className="sync-hint">
                  把同一个同步包固定放在云盘目录（或自己的服务器）上：本机改动后自动写回，
                  别的设备改动后自动拉取。拉取前仍然会做检测，遇到「会覆盖本机较新改动」默认先暂停。
                </p>
                <label className="sync-scope">
                  <input
                    type="checkbox"
                    checked={auto?.enabled ?? false}
                    disabled={autoBusy}
                    onChange={(event) => void patchAuto({ enabled: event.target.checked })}
                  />
                  <span className="sync-scope-body">
                    <strong>
                      启用自动同步
                      {auto?.enabled && autoReady && <span className="sync-badge ok">运行中</span>}
                    </strong>
                    <em>
                      {auto?.transport === 'sftp'
                        ? auto.sftpHostId && auto.sftpDir
                          ? `当前通道：${auto.sftpHostLabel ?? 'SFTP'} → ${auto.sftpDir}`
                          : '先选择主机并填写远端目录'
                        : auto?.transport === 'webdav'
                          ? auto.webdavUrl
                            ? `当前通道：${auto.webdavUrl}`
                            : '先填写 WebDAV 目录地址'
                          : auto?.dir
                            ? `当前目录：${auto.dir}`
                            : '先在下面选择一个同步目录；启用后由本机后台监听，不联网'}
                    </em>
                  </span>
                </label>
              </section>

              <section className="sync-section">
                <h3>同步位置</h3>
                <div className="segmented sync-encrypt">
                  <button
                    className={cx('segmented-item', (auto?.transport ?? 'folder') === 'folder' && 'is-active')}
                    disabled={autoBusy}
                    onClick={() => void patchAuto({ transport: 'folder' })}
                  >
                    文件夹 / 云盘
                  </button>
                  <button
                    className={cx('segmented-item', auto?.transport === 'sftp' && 'is-active')}
                    disabled={autoBusy}
                    onClick={() => void patchAuto({ transport: 'sftp' })}
                  >
                    SFTP
                  </button>
                  <button
                    className={cx('segmented-item', auto?.transport === 'webdav' && 'is-active')}
                    disabled={autoBusy}
                    onClick={() => void patchAuto({ transport: 'webdav' })}
                  >
                    WebDAV
                  </button>
                </div>

                {(auto?.transport ?? 'folder') === 'folder' ? (
                  <>
                    {targets.length === 0 ? (
                      <p className="sync-hint warn">
                        没有检测到云盘目录。可以直接用下面的「选择文件夹…」指定任意目录
                        （网络共享、加密盘、U 盘都行）。
                      </p>
                    ) : (
                      <select
                        className="input"
                        value={auto?.targetId ?? ''}
                        disabled={autoBusy}
                        onChange={(event) => void patchAuto({ targetId: event.target.value })}
                      >
                        <option value="">（未选择）</option>
                        {auto?.targetId === 'custom' && auto.dir && (
                          <option value="custom">{auto.targetLabel ?? '自定义目录'}</option>
                        )}
                        {targets.map((target) => (
                          <option key={target.id} value={target.id}>
                            {target.label} — {target.dir}
                          </option>
                        ))}
                      </select>
                    )}
                    <div className="settings-actions">
                      <button
                        className="btn btn-ghost"
                        disabled={autoBusy}
                        onClick={() =>
                          void window.jshell.autoSync
                            .pick()
                            .then((state) => setAutoSync(state))
                            .catch((err) => pushToast(errorMessage(err), 'error'))
                        }
                      >
                        选择文件夹…
                      </button>
                    </div>
                    <p className="sync-hint">
                      文件固定为 <code>&lt;目录&gt;/JShell/jshell-auto.jshellsync</code>，
                      反复同步不会在云盘里堆出一堆副本。
                    </p>
                  </>
                ) : auto?.transport === 'sftp' ? (
                  <>
                    <select
                      className="input"
                      value={auto?.sftpHostId ?? ''}
                      disabled={autoBusy}
                      onChange={(event) => void patchAuto({ sftpHostId: event.target.value })}
                    >
                      <option value="">（选择一台已保存的主机）</option>
                      {auto?.sftpHostId && !hosts.some((host) => host.id === auto.sftpHostId) && (
                        <option value={auto.sftpHostId}>
                          {auto.sftpHostLabel ?? '已删除的主机'}
                        </option>
                      )}
                      {hosts.map((host) => (
                        <option key={host.id} value={host.id}>
                          {host.name} — {host.username}@{host.host}:{host.port}
                        </option>
                      ))}
                    </select>
                    <div className="sync-unlock">
                      <label className="field">
                        <span>
                          远端目录（绝对路径，支持 <code>~/</code>；不存在会自动创建）
                        </span>
                        <input
                          className="input mono"
                          value={sftpDirDraft}
                          placeholder="/home/me/jshell"
                          disabled={autoBusy}
                          onChange={(event) => setSftpDirDraft(event.target.value)}
                          onBlur={() => {
                            if (sftpDirDraft !== (auto?.sftpDir ?? '')) {
                              void patchAuto({ sftpDir: sftpDirDraft })
                            }
                          }}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' && sftpDirDraft !== (auto?.sftpDir ?? '')) {
                              void patchAuto({ sftpDir: sftpDirDraft })
                            }
                          }}
                        />
                      </label>
                    </div>
                    <p className="sync-hint">
                      复用这台主机的地址、认证方式与跳板机设置，等同于「用 SSH 通道搬一个文件」。
                      SFTP 没有文件变更通知，靠每 15 秒比对一次 mtime 判断远端是否变化。
                    </p>
                  </>
                ) : (
                  <>
                    <label className="field">
                      <span>目录地址（含协议；同步包会写到这个目录下）</span>
                      <input
                        className="input mono"
                        value={webdavUrlDraft}
                        placeholder="https://dav.example.com/remote.php/dav/files/me/jshell"
                        disabled={autoBusy}
                        onChange={(event) => setWebdavUrlDraft(event.target.value)}
                        onBlur={() => {
                          if (webdavUrlDraft !== (auto?.webdavUrl ?? '')) {
                            void patchAuto({ webdavUrl: webdavUrlDraft })
                          }
                        }}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' && webdavUrlDraft !== (auto?.webdavUrl ?? '')) {
                            void patchAuto({ webdavUrl: webdavUrlDraft })
                          }
                        }}
                      />
                    </label>
                    <div className="sync-password">
                      <label className="field">
                        <span>用户名（匿名访问可留空）</span>
                        <input
                          className="input"
                          value={webdavUserDraft}
                          autoComplete="off"
                          disabled={autoBusy}
                          onChange={(event) => setWebdavUserDraft(event.target.value)}
                          onBlur={() => {
                            if (webdavUserDraft !== (auto?.webdavUsername ?? '')) {
                              void patchAuto({ webdavUsername: webdavUserDraft })
                            }
                          }}
                        />
                      </label>
                      <label className="field">
                        <span>
                          {auto?.hasWebdavPassword ? '密码已保存（重新输入可更换）' : '密码'}
                        </span>
                        <input
                          className="input"
                          type="password"
                          autoComplete="new-password"
                          value={webdavPasswordDraft}
                          placeholder="保存后写入系统安全存储"
                          disabled={autoBusy}
                          onChange={(event) => setWebdavPasswordDraft(event.target.value)}
                        />
                      </label>
                    </div>
                    <div className="settings-actions">
                      <button
                        className="btn btn-ghost"
                        disabled={autoBusy || !webdavPasswordDraft}
                        onClick={() => {
                          void patchAuto({ webdavPassword: webdavPasswordDraft })
                          setWebdavPasswordDraft('')
                        }}
                      >
                        保存密码
                      </button>
                    </div>
                    <p className="sync-hint">
                      Nextcloud、坚果云、群晖、Apache mod_dav 等都可以；只接受 https（本机回环地址例外）。
                      没有变更通知，靠 ETag 每 15 秒比对一次。密码同样存在系统安全存储里，不写进同步包。
                    </p>
                  </>
                )}

                <div className="settings-actions">
                  <button
                    className="btn btn-ghost"
                    disabled={testing || autoBusy}
                    onClick={() => {
                      setTesting(true)
                      setAutoTest(null)
                      void window.jshell.autoSync
                        .test()
                        .then((result) => setAutoTest(result))
                        .catch((err) =>
                          setAutoTest({ ok: false, message: errorMessage(err) })
                        )
                        .finally(() => setTesting(false))
                    }}
                  >
                    {testing ? '测试中…' : '测试连接'}
                  </button>
                </div>
                {autoTest && (
                  <p className={cx('sync-hint', autoTest.ok ? 'is-ok' : 'is-bad')}>{autoTest.message}</p>
                )}
              </section>

              <section className="sync-section">
                <h3>同步口令</h3>
                <div className="sync-unlock">
                  <label className="field">
                    <span>
                      {auto?.hasPassword
                        ? '已设置口令（输入新口令可更换）'
                        : '未设置：包是明文，不建议放在云盘'}
                    </span>
                    <input
                      className="input"
                      type="password"
                      autoComplete="new-password"
                      value={autoPassword}
                      placeholder={`至少 ${MIN_PASSWORD_LENGTH} 位`}
                      onChange={(event) => setAutoPassword(event.target.value)}
                    />
                  </label>
                  <button
                    className="btn btn-ghost"
                    disabled={autoBusy || autoPassword.length < MIN_PASSWORD_LENGTH}
                    onClick={() => {
                      void patchAuto({ password: autoPassword })
                      setAutoPassword('')
                    }}
                  >
                    保存口令
                  </button>
                </div>
                <p className="sync-hint">
                  口令经系统安全存储保存在本机，不会写进同步包；换设备后需要在那边重新输入一次。
                </p>
              </section>

              <section className="sync-section">
                <h3>同步内容</h3>
                <div className="sync-scopes">
                  {SYNC_SCOPES.map((item) => (
                    <label className="sync-scope" key={item.id}>
                      <input
                        type="checkbox"
                        checked={auto?.scopes.includes(item.id) ?? false}
                        disabled={autoBusy}
                        onChange={() => toggleAutoScope(item.id)}
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
              </section>

              <section className="sync-section">
                <h3>行为</h3>
                <div className="sync-scopes">
                  <label className="sync-scope">
                    <input
                      type="checkbox"
                      checked={auto?.pushLocalChanges ?? true}
                      disabled={autoBusy}
                      onChange={(event) =>
                        void patchAuto({ pushLocalChanges: event.target.checked })
                      }
                    />
                    <span className="sync-scope-body">
                      <strong>本机改动后写回</strong>
                      <em>保存主机/片段/设置后约 1.5 秒写入同步文件</em>
                    </span>
                  </label>
                  <label className="sync-scope">
                    <input
                      type="checkbox"
                      checked={auto?.pullRemoteChanges ?? true}
                      disabled={autoBusy}
                      onChange={(event) =>
                        void patchAuto({ pullRemoteChanges: event.target.checked })
                      }
                    />
                    <span className="sync-scope-body">
                      <strong>远端变化后拉取</strong>
                      <em>云盘同步到本机后自动应用，无需手动操作</em>
                    </span>
                  </label>
                  <label className="sync-scope">
                    <input
                      type="checkbox"
                      checked={auto?.pauseOnRisky ?? true}
                      disabled={autoBusy}
                      onChange={(event) => void patchAuto({ pauseOnRisky: event.target.checked })}
                    />
                    <span className="sync-scope-body">
                      <strong>遇到风险先暂停</strong>
                      <em>
                        关闭后等同于「远端直接覆盖本地」，不再询问；结果里仍会写明覆盖了多少项
                      </em>
                    </span>
                  </label>
                </div>
                <p className="sync-hint">{SYNC_DELETE_NOTICE}</p>
              </section>

              <section className="sync-section">
                <h3>状态</h3>
                <div className="sync-auto-status">
                  <span>
                    {auto?.running
                      ? '正在同步…'
                      : auto?.lastSyncedAt
                        ? `上次同步：${formatTime(new Date(auto.lastSyncedAt).toISOString())}`
                        : '还没有同步过'}
                  </span>
                  {auto?.lastResult && <em>{auto.lastResult}</em>}
                  {auto?.lastError && <em className="is-error">{auto.lastError}</em>}
                </div>

                {auto?.pending && (
                  <div className="sync-risk">
                    <span>{auto.pending.summary}</span>
                    <div className="sync-pending-actions">
                      <button
                        className="btn btn-ghost"
                        disabled={autoBusy}
                        onClick={() => void applyAutoPending()}
                      >
                        按远端覆盖本机
                      </button>
                      <button
                        className="btn btn-ghost"
                        onClick={() => onOpenImport(auto?.targetId ?? '')}
                      >
                        手动检查
                      </button>
                    </div>
                  </div>
                )}

                <div className="settings-actions">
                  <button
                    className="btn btn-ghost"
                    disabled={autoBusy || !autoReady}
                    onClick={() => void runAuto()}
                  >
                    立即同步
                  </button>
                </div>
              </section>
      </div>

      <footer className="modal-foot">
        <span className="sync-foot-note">
          {auto?.enabled
            ? autoReady
              ? '自动同步已开启'
              : '已开启，但同步位置还没配置完整'
            : '自动同步未开启'}
        </span>
        <button className="btn btn-ghost" onClick={onClose}>
          关闭
        </button>
        <button
          className="btn btn-primary"
          disabled={autoBusy || !autoReady}
          onClick={() => void runAuto()}
        >
          {autoBusy ? '同步中…' : '立即同步'}
        </button>
      </footer>
    </>
  )
}

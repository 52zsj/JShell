import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { WSL_SHELL_PREFIX } from '@shared/types'
import type { AppSettings, AppTheme } from '@shared/types'
import { useAppStore } from '../store'
import { TERMINAL_THEMES } from '../themes'
import { formatBinding, SHORTCUTS, specFromEvent, type Bindings } from '../shortcuts'
import { cx, errorMessage, formatBuildTime, modKey, platformLabel } from '../utils'
import { IconClose, IconRotate } from '../icons'

interface Props {
  isMac: boolean
  bindings: Bindings
  onClose: () => void
  /** 打开「配置包」面板（配置导出/导入） */
  onOpenSync: () => void
}

const THEME_LABELS: Array<{ value: AppTheme; label: string }> = [
  { value: 'dark', label: '深色' },
  { value: 'light', label: '浅色' },
  { value: 'system', label: '跟随系统' }
]

/** 设置面板：所有改动即时生效并落盘，无「保存」按钮 */
export function SettingsDialog({ isMac, bindings, onClose, onOpenSync }: Props) {
  const settings = useAppStore((s) => s.settings)
  const info = useAppStore((s) => s.info)
  const shells = useAppStore((s) => s.shells)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const previewSettings = useAppStore((s) => s.previewSettings)
  const pushToast = useAppStore((s) => s.pushToast)
  const updateResult = useAppStore((s) => s.updateResult)
  const updateChecking = useAppStore((s) => s.updateChecking)
  const checkUpdate = useAppStore((s) => s.checkUpdate)
  const [recording, setRecording] = useState<string | null>(null)
  /** 左侧分类：磁贴式设置只渲染当前分类，避免一屏堆到底 */
  const [tab, setTab] = useState('appearance')

  /**
   * 设置写入节流：拖动字号滑块/连续输入字体时每 180ms 才落盘一次，
   * 但每次变更都先 previewSettings 让界面（含终端字号）即时生效。
   * 这样既没有输入延迟，也不会一个拖动产生上百次 IPC + 磁盘写。
   */
  const pending = useRef<Partial<AppSettings>>({})
  const timer = useRef<number | null>(null)

  const flush = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current)
      timer.current = null
    }
    const patch = pending.current
    pending.current = {}
    if (Object.keys(patch).length === 0) return
    void updateSettings(patch).catch(async (err) => {
      // 保存失败（如系统拒绝登记开机自启）时回滚界面，避免显示与实际不一致
      pushToast(`设置保存失败：${errorMessage(err)}`, 'error')
      try {
        const current = await window.jshell.settings.get()
        previewSettings(current)
      } catch {
        /* 重新读取失败时保持现状 */
      }
    })
  }, [previewSettings, pushToast, updateSettings])

  const commit = useCallback(
    (patch: Partial<AppSettings>) => {
      previewSettings(patch)
      pending.current = { ...pending.current, ...patch }
      if (timer.current === null) timer.current = window.setTimeout(flush, 180)
    },
    [flush, previewSettings]
  )

  // 关闭设置面板时把未落盘的改动补写一次
  useEffect(() => () => flush(), [flush])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // 冲突检测：同一个组合被绑定到多个动作时高亮提示
  const duplicated = useMemo(() => {
    const counts = new Map<string, number>()
    for (const spec of Object.values(bindings)) {
      counts.set(spec, (counts.get(spec) ?? 0) + 1)
    }
    const set = new Set<string>()
    for (const [spec, count] of counts) if (count > 1) set.add(spec)
    return set
  }, [bindings])

  const saveBinding = (id: string, spec: string) => {
    commit({ keybindings: { ...settings.keybindings, [id]: spec } })
  }

  const handleRecord = (event: React.KeyboardEvent<HTMLButtonElement>, id: string) => {
    event.preventDefault()
    event.stopPropagation()
    if (event.key === 'Escape') {
      setRecording(null)
      return
    }
    const spec = specFromEvent(event.nativeEvent, isMac)
    if (!spec) return
    setRecording(null)
    saveBinding(id, spec)
  }

  const groups = useMemo(() => {
    const map = new Map<string, typeof SHORTCUTS>()
    for (const def of SHORTCUTS) {
      const list = map.get(def.group) ?? []
      list.push(def)
      map.set(def.group, list)
    }
    return [...map.entries()]
  }, [])

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal wide settings-modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2>设置</h2>
          <button className="icon-btn" onClick={onClose} title="关闭">
            <IconClose />
          </button>
        </header>

        <div className="modal-body settings-shell">
          <nav className="settings-nav">
            {[
              ['appearance', '外观'],
              ['terminal', '终端'],
              ['shortcuts', '快捷键'],
              ['hosts', '主机与连接'],
              ['files', '文件与配置'],
              ['integration', '系统集成'],
              ['about', '关于']
            ].map(([id, label]) => (
              <button
                key={id}
                className={cx('settings-nav-item', tab === id && 'is-active')}
                onClick={() => setTab(id)}
              >
                {label}
              </button>
            ))}
          </nav>

          <div className="settings-pane">
          <section className="settings-section" hidden={tab !== 'terminal'}>
            <h3>本地终端</h3>
            <label className="field">
              <span>默认终端程序</span>
              <select
                className="input"
                value={settings.localShell || shells?.defaultShell || ''}
                onChange={(e) => commit({ localShell: e.target.value })}
              >
                {(shells?.shells ?? []).map((shell) => (
                  <option key={shell.path} value={shell.path}>
                    {/* WSL 的 path 是 `wsl://发行版` 伪路径，对它只显示名字 */}
                    {shell.label}
                    {shell.path.startsWith(WSL_SHELL_PREFIX) ? '' : ` — ${shell.path}`}
                  </option>
                ))}
              </select>
            </label>
            <h3 className="settings-sub">侧边栏显示哪些本机终端</h3>
            <div className="shell-list">
              {(shells?.shells ?? []).map((shell) => {
                const visible = !settings.hiddenLocalShells.includes(shell.path)
                return (
                  <label className="shell-row" key={shell.path}>
                    <input
                      type="checkbox"
                      checked={visible}
                      onChange={(e) => {
                        const next = e.target.checked
                          ? settings.hiddenLocalShells.filter((item) => item !== shell.path)
                          : [...new Set([...settings.hiddenLocalShells, shell.path])]
                        commit({ hiddenLocalShells: next })
                      }}
                    />
                    <span className="shell-name">
                      {shell.label}
                      {shell.isDefault && <span className="host-tag">默认</span>}
                    </span>
                    <span className="shell-path mono">{shell.path}</span>
                  </label>
                )
              })}
              {settings.hiddenLocalShells.length > 0 && (
                <button
                  className="btn btn-ghost shell-reset"
                  onClick={() => commit({ hiddenLocalShells: [] })}
                >
                  全部显示（恢复 {settings.hiddenLocalShells.length} 个）
                </button>
              )}
            </div>
            <p className="notice">识别到 {shells?.shells.length ?? 0} 个本地终端；取消勾选只是隐藏。</p>
          </section>

          <section className="settings-section" hidden={tab !== 'shortcuts'}>
            <h3>快捷键</h3>
            <p className="notice">
              点右侧按键后按下新组合即录制，Esc 取消。需包含 {isMac ? '⌘' : 'Ctrl'}
              ，修改后立即生效。
            </p>
            {groups.map(([group, defs]) => (
              <div key={group} className="kb-group">
                <div className="kb-group-title">{group}</div>
                {defs.map((def) => {
                  const spec = bindings[def.id]
                  const isRecording = recording === def.id
                  return (
                    <div className="kb-row" key={def.id}>
                      <span className="kb-label">{def.label}</span>
                      <button
                        className={cx(
                          'kb-key',
                          isRecording && 'is-recording',
                          duplicated.has(spec) && 'is-conflict'
                        )}
                        onClick={() => setRecording(def.id)}
                        onKeyDown={(e) => handleRecord(e, def.id)}
                        onBlur={() => setRecording(null)}
                        title={duplicated.has(spec) ? '与其他快捷键冲突' : '点击后按下新组合'}
                      >
                        {isRecording ? '按下快捷键…' : formatBinding(spec, isMac)}
                      </button>
                      <button
                        className="icon-btn tiny"
                        title="恢复默认"
                        onClick={() => {
                          const next = { ...settings.keybindings }
                          delete next[def.id]
                          commit({ keybindings: next })
                        }}
                      >
                        <IconRotate />
                      </button>
                    </div>
                  )
                })}
              </div>
            ))}
            <p className="notice">
              {isMac ? '⌘' : 'Ctrl'} + 1..9 切换标签页为固定绑定，不参与自定义。
            </p>
          </section>

          <section className="settings-section" hidden={tab !== 'appearance'}>
            <h3>外观</h3>
            <div className="field">
              <span>应用主题</span>
              <div className="segmented">
                {THEME_LABELS.map((item) => (
                  <button
                    key={item.value}
                    className={`segmented-item${settings.theme === item.value ? ' is-active' : ''}`}
                    onClick={() => commit({ theme: item.value })}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>

            <label className="field">
              <span>终端配色</span>
              <select
                className="input"
                value={settings.terminalTheme}
                onChange={(e) => commit({ terminalTheme: e.target.value })}
              >
                {TERMINAL_THEMES.map((theme) => (
                  <option key={theme.id} value={theme.id}>
                    {theme.name}
                  </option>
                ))}
              </select>
              <div className="theme-preview">
                {TERMINAL_THEMES.find((t) => t.id === settings.terminalTheme)?.swatch.map((color) => (
                  <span key={color} className="theme-chip" style={{ background: color }} />
                ))}
              </div>
            </label>

            <label className="field">
              <span>字体族</span>
              <input
                className="input"
                value={settings.fontFamily}
                onChange={(e) => commit({ fontFamily: e.target.value })}
              />
            </label>

            <div className="field-row">
              <label className="field">
                <span>字号：{settings.fontSize}px</span>
                <input
                  type="range"
                  min={10}
                  max={22}
                  value={settings.fontSize}
                  onChange={(e) => commit({ fontSize: Number(e.target.value) })}
                />
              </label>
              <label className="field">
                <span>回滚行数</span>
                <input
                  className="input"
                  type="number"
                  min={500}
                  max={50000}
                  step={500}
                  value={settings.scrollback}
                  onChange={(e) => commit({ scrollback: Number(e.target.value) })}
                />
              </label>
            </div>

            <div className="field-row">
              <div className="field">
                <span>光标形状</span>
                <div className="segmented">
                  {(
                    [
                      ['bar', '竖线'],
                      ['block', '方块'],
                      ['underline', '下划线']
                    ] as const
                  ).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      className={`segmented-item${settings.cursorStyle === value ? ' is-active' : ''}`}
                      onClick={() => commit({ cursorStyle: value })}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <label className="field">
                <span>行高：{settings.lineHeight.toFixed(2)}</span>
                <input
                  type="range"
                  min={1}
                  max={1.6}
                  step={0.05}
                  value={settings.lineHeight}
                  onChange={(e) => commit({ lineHeight: Number(e.target.value) })}
                />
              </label>
            </div>

            <div className="tile-grid">
              <label className="tile">
                <input
                  type="checkbox"
                  checked={settings.cursorBlink}
                  onChange={(e) => commit({ cursorBlink: e.target.checked })}
                />
                <span className="tile-body">
                  <strong>光标闪烁</strong>
                  <em>关闭后光标常亮，长时间盯屏更安静</em>
                </span>
              </label>
              <label className="tile">
                <input
                  type="checkbox"
                  checked={settings.showLocalShells}
                  onChange={(e) => commit({ showLocalShells: e.target.checked })}
                />
                <span className="tile-body">
                  <strong>侧边栏显示「本机」终端分组</strong>
                  <em>关闭后只保留主机列表，腾出更多空间</em>
                </span>
              </label>
            </div>
          </section>

          <section className="settings-section" hidden={tab !== 'hosts'}>
            <h3>主机与连接</h3>
            <label className="field">
              <span>主机公钥校验</span>
              <select
                className="input"
                value={settings.hostKeyPolicy}
                onChange={(e) =>
                  commit({ hostKeyPolicy: e.target.value as 'tofu' | 'ignore' })
                }
              >
                <option value="tofu">首次信任（TOFU，推荐）</option>
                <option value="ignore">跳过校验（不安全）</option>
              </select>
            </label>
            <p className="notice">
              {info?.safeStorageAvailable
                ? '密码与私钥口令通过系统安全存储加密后保存在本地。'
                : '系统无可用安全存储（常见于无 keyring 的 Linux），口令将以弱编码保存。'}
            </p>

            <h3 className="settings-sub">连接保活</h3>
            <label className="tile">
              <input
                type="checkbox"
                checked={settings.keepaliveEnabled}
                onChange={(e) => commit({ keepaliveEnabled: e.target.checked })}
              />
              <span className="tile-body">
                <strong>定时保活，避免空闲连接被中断</strong>
                <em>在 SSH 协议层发心跳，不写终端、不进历史；只对 SSH 会话生效</em>
              </span>
            </label>
            <div className="field-row">
              <label className="field">
                <span>保活间隔（秒）</span>
                <input
                  className="input"
                  type="number"
                  min={10}
                  max={300}
                  step={10}
                  disabled={!settings.keepaliveEnabled}
                  value={settings.keepaliveIntervalSeconds}
                  onChange={(e) => commit({ keepaliveIntervalSeconds: Number(e.target.value) })}
                />
              </label>
              <label className="field">
                <span>无响应几次判定断开</span>
                <input
                  className="input"
                  type="number"
                  min={1}
                  max={10}
                  step={1}
                  disabled={!settings.keepaliveEnabled}
                  value={settings.keepaliveCountMax}
                  onChange={(e) => commit({ keepaliveCountMax: Number(e.target.value) })}
                />
              </label>
            </div>
            <p className="notice">
              每 {settings.keepaliveIntervalSeconds} 秒发一次，连续 {settings.keepaliveCountMax} 次无响应判定断线
              （约 {Math.round((settings.keepaliveIntervalSeconds * settings.keepaliveCountMax) / 60)} 分钟）。
              改动只对新建或重连的会话生效。
            </p>

            <h3 className="settings-sub">主机删除</h3>
            <div className="tile-grid">
              <label className="tile">
                <input
                  type="checkbox"
                  checked={settings.hostDeleteButton}
                  onChange={(e) => commit({ hostDeleteButton: e.target.checked })}
                />
                <span className="tile-body">
                  <strong>列表中显示删除按钮</strong>
                  <em>关闭后仍可右键主机删除</em>
                </span>
              </label>
              <label className="tile">
                <input
                  type="checkbox"
                  checked={settings.hostDeleteConfirm}
                  onChange={(e) => commit({ hostDeleteConfirm: e.target.checked })}
                />
                <span className="tile-body">
                  <strong>删除前二次确认</strong>
                  <em>关闭后点击即删除，不可撤销</em>
                </span>
              </label>
            </div>
          </section>

          <section className="settings-section" hidden={tab !== 'files'}>
            <h3>文件与目录</h3>
            <div className="tile-grid">
              <label className="tile">
                <input
                  type="checkbox"
                  checked={settings.autoFollowCwd}
                  onChange={(e) => commit({ autoFollowCwd: e.target.checked })}
                />
                <span className="tile-body">
                  <strong>目录树自动跟随终端目录</strong>
                  <em>开启后目录树跟随 <code>cd</code>，关闭则固定在当前位置</em>
                </span>
              </label>
              <div className="tile is-static">
                <span className="tile-body">
                  <strong>目录树</strong>
                  <em>双击进入目录、编辑文件，支持上一级与定位当前目录</em>
                </span>
              </div>
              <div className="tile is-static">
                <span className="tile-body">
                  <strong>文件传输（rsync）</strong>
                  <em>本机上传下载、服务器间中转、断点续传与重试</em>
                </span>
              </div>
              <div className="tile is-static">
                <span className="tile-body">
                  <strong>路径直达</strong>
                  <em>文件面板地址栏粘贴路径回车即可跳转（{modKey(isMac)} + L 聚焦，支持 ~ 与 ..）</em>
                </span>
              </div>
            </div>
            <p className="notice">本机与远端都要有 rsync；3.1+ 才有整体进度。</p>

            <h3 className="settings-sub">配置包</h3>
            <div className="settings-actions">
              <button className="btn btn-primary" onClick={onOpenSync}>
                生成 / 导入配置包…
              </button>
            </div>
            <p className="notice">
              打成加密文件，可存本地、云盘目录或剪贴板；云盘里只有密文。
            </p>
          </section>

          <section className="settings-section" hidden={tab !== 'integration'}>
            <h3>系统集成</h3>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={settings.launchAtLogin}
                onChange={(e) => commit({ launchAtLogin: e.target.checked })}
              />
              <span>开机自动启动</span>
            </label>
            <div className="tile-grid">
              <label className="tile">
                <input
                  type="checkbox"
                  checked={settings.startMinimized}
                  onChange={(e) => commit({ startMinimized: e.target.checked })}
                />
                <span className="tile-body">
                  <strong>启动后仅驻留托盘</strong>
                  <em>开机自启时不打开主窗口</em>
                </span>
              </label>
              <label className="tile">
                <input
                  type="checkbox"
                  checked={settings.closeToTray}
                  onChange={(e) => commit({ closeToTray: e.target.checked })}
                />
                <span className="tile-body">
                  <strong>关闭窗口时最小化到托盘</strong>
                  <em>会话在后台继续运行</em>
                </span>
              </label>
              <label className="tile">
                <input
                  type="checkbox"
                  checked={settings.notifications}
                  onChange={(e) => commit({ notifications: e.target.checked })}
                />
                <span className="tile-body">
                  <strong>发送系统通知</strong>
                  <em>会话异常断开、文件传输失败</em>
                </span>
              </label>
            </div>
            <p className="notice">
              开机自启登记在系统登录项里；便携版换目录后需重新开关一次。
            </p>
          </section>

          <section className="settings-section" hidden={tab !== 'about'}>
            <h3>关于</h3>
            <dl className="kv">
              <dt>版本</dt>
              <dd>v{info?.version ?? '-'}</dd>
              <dt>构建时间</dt>
              <dd>{formatBuildTime(info?.buildTime)}</dd>
              <dt>分发渠道</dt>
              <dd>{info?.channel === 'public' ? '公开下载' : '内部渠道'}</dd>
              <dt>运行模式</dt>
              <dd>
                {info?.portable ? '便携版（数据保存在程序目录）' : '安装版（数据保存在系统用户目录）'}
              </dd>
              <dt>运行环境</dt>
              <dd>
                {platformLabel(info?.platform)} · {info?.arch ?? '-'} · Electron {info?.electron ?? '-'} ·
                Node {info?.node ?? '-'}
              </dd>
              <dt>数据目录</dt>
              <dd className="mono">{info?.userDataPath ?? '-'}</dd>
            </dl>

            <div className="settings-actions">
              <button
                className="btn btn-ghost"
                onClick={() =>
                  void window.jshell.app
                    .openPath(info?.userDataPath ?? '')
                    .catch((err) => pushToast(errorMessage(err), 'error'))
                }
              >
                打开数据目录
              </button>
              <button
                className="btn btn-ghost"
                onClick={() =>
                  void window.jshell.app
                    .openLogs()
                    .catch((err) => pushToast(errorMessage(err), 'error'))
                }
              >
                打开日志目录
              </button>
            </div>

            <div className="field">
              <span>更新检查</span>
              <div className="update-row">
                <button
                  className="btn btn-ghost"
                  disabled={updateChecking}
                  onClick={() => void checkUpdate()}
                >
                  {updateChecking ? '正在检查…' : '检查更新'}
                </button>
                <span className="notice inline">
                  {updateResult?.message ??
                    (info?.channel === 'public'
                      ? '公开渠道：将从更新地址读取版本信息。'
                      : '内部渠道：默认不联网，不发送任何数据。')}
                </span>
              </div>
              {updateResult?.status === 'available' && updateResult.notes && (
                <p className="notice inline update-notes">{updateResult.notes}</p>
              )}
              {updateResult?.status === 'available' && updateResult.url && (
                <button
                  className="btn btn-primary update-download"
                  onClick={() => void window.jshell.app.openExternal(updateResult.url as string)}
                >
                  打开发布页面
                </button>
              )}
            </div>

            <div className="settings-actions">
              <button
                className="btn btn-ghost"
                onClick={() =>
                  void window.jshell.app.openDoc('manual').catch((err) => pushToast(errorMessage(err), 'error'))
                }
              >
                使用说明
              </button>
              <button
                className="btn btn-ghost"
                onClick={() =>
                  void window.jshell.app.openDoc('privacy').catch((err) => pushToast(errorMessage(err), 'error'))
                }
              >
                隐私说明
              </button>
              <button
                className="btn btn-ghost"
                onClick={() =>
                  void window.jshell.app.openDoc('license').catch((err) => pushToast(errorMessage(err), 'error'))
                }
              >
                许可协议
              </button>
              <button
                className="btn btn-ghost"
                onClick={() =>
                  void window.jshell.app
                    .openDoc('changelog')
                    .catch((err) => pushToast(errorMessage(err), 'error'))
                }
              >
                更新记录
              </button>
            </div>
          </section>
          </div>
        </div>

        <footer className="modal-foot">
          <button className="btn btn-primary" onClick={onClose}>
            完成
          </button>
        </footer>
      </div>
    </div>
  )
}

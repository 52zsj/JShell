import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RsyncCapability, RsyncDirection, RsyncPlan, RsyncTask } from '@shared/types'
import { useAppStore } from '../store'
import { cx, errorMessage, formatBytes } from '../utils'
import { IconClose, IconFolder, IconRefresh, IconSync } from '../icons'

interface Props {
  onClose: () => void
  onDone?: () => void
  /** 当前选中会话的主机，作为默认远端 */
  defaultHostId?: string
  /** 文件面板当前目录，作为默认远端路径 */
  defaultRemoteDir?: string
}

const DIRECTIONS: Array<{ id: RsyncDirection; title: string; desc: string }> = [
  { id: 'upload', title: '本机 → 服务器', desc: '把本地目录或文件同步到远端' },
  { id: 'download', title: '服务器 → 本机', desc: '把远端目录或文件同步回本地' },
  { id: 'relay', title: '服务器 → 服务器', desc: '经本机中转，两段都支持断点续传' }
]

/**
 * rsync 同步向导（全局工具，不依赖某个会话）。
 *
 * 四步：方向 → 源/目标 → 选项 → 执行。
 * 第二步会用一条 ssh 命令预检远端是否装了 rsync，避免跑到执行页才失败。
 */
export function RsyncWizard({ onClose, onDone, defaultHostId, defaultRemoteDir }: Props) {
  const hosts = useAppStore((s) => s.hosts)
  const [step, setStep] = useState(1)
  const [capability, setCapability] = useState<RsyncCapability | null>(null)
  const [direction, setDirection] = useState<RsyncDirection>('upload')
  const [hostId, setHostId] = useState(defaultHostId ?? '')
  const [localPath, setLocalPath] = useState('')
  const [remotePath, setRemotePath] = useState(defaultRemoteDir || '~')
  const [relaySourceHost, setRelaySourceHost] = useState(defaultHostId ?? '')
  const [relayTargetHost, setRelayTargetHost] = useState('')
  const [relaySourcePath, setRelaySourcePath] = useState(defaultRemoteDir || '~')
  const [relayTargetPath, setRelayTargetPath] = useState('')
  const [deleteExtraneous, setDeleteExtraneous] = useState(false)
  const [compress, setCompress] = useState(true)
  const [exclude, setExclude] = useState('')
  const [retries, setRetries] = useState(2)
  const [probe, setProbe] = useState<{ loading: boolean; ok: boolean; message: string } | null>(null)
  const [task, setTask] = useState<RsyncTask | null>(null)
  const [error, setError] = useState('')
  const taskId = useRef('')

  // 默认主机：优先当前会话，其次第一台
  useEffect(() => {
    if (hostId) return
    const first = defaultHostId || hosts[0]?.id
    if (first) {
      setHostId(first)
      setRelaySourceHost((prev) => prev || first)
    }
  }, [hostId, defaultHostId, hosts])

  useEffect(() => {
    if (relayTargetHost) return
    const other = hosts.find((host) => host.id !== relaySourceHost)
    if (other) setRelayTargetHost(other.id)
  }, [hosts, relaySourceHost, relayTargetHost])

  useEffect(() => {
    void window.jshell.rsync
      .check()
      .then(setCapability)
      .catch(() =>
        setCapability({
          available: false,
          version: '',
          progress2: false,
          appendVerify: false,
          protectArgs: false,
          binary: 'rsync'
        })
      )
  }, [])

  useEffect(() => {
    window.jshell.rsync.onEvent((next) => {
      if (next.id !== taskId.current) return
      setTask(next)
      if (next.status === 'done') onDone?.()
    })
    return () => window.jshell.rsync.unsubscribe()
  }, [onDone])

  /** 第二步预检：远端有没有 rsync */
  const runProbe = useCallback(async () => {
    const targets = direction === 'relay'
      ? [relaySourceHost, relayTargetHost].filter(Boolean)
      : [hostId].filter(Boolean)
    if (targets.length === 0) {
      setProbe(null)
      return
    }
    setProbe({ loading: true, ok: false, message: '正在检测远端 rsync…' })
    const results = await Promise.all(
      targets.map((id) => window.jshell.rsync.probe(id).catch((err) => ({
        ok: false,
        message: errorMessage(err)
      })))
    )
    const bad = results.find((item) => !item.ok)
    const names = targets
      .map((id) => hosts.find((host) => host.id === id)?.name || '主机')
      .join('、')
    if (bad) setProbe({ loading: false, ok: false, message: `${names}：${bad.message}` })
    else setProbe({ loading: false, ok: true, message: `${names}：已安装 rsync，可以开始同步` })
  }, [direction, hostId, relaySourceHost, relayTargetHost, hosts])

  useEffect(() => {
    if (step !== 2) return
    void runProbe()
  }, [step, runProbe])

  const pickLocal = async (mode: 'dir' | 'file'): Promise<void> => {
    const picked =
      mode === 'dir'
        ? await window.jshell.dialog.pickDirectory({ title: '选择本机目录' })
        : await window.jshell.dialog.pickFile({ title: '选择本机文件' })
    if (typeof picked === 'string') setLocalPath(picked)
  }

  const options = { deleteExtraneous, compress, exclude, retries }

  const buildPlan = (): RsyncPlan => {
    if (direction === 'upload') {
      return {
        direction,
        source: { kind: 'local', path: localPath },
        target: { kind: 'host', hostId, path: remotePath },
        options
      }
    }
    if (direction === 'download') {
      return {
        direction,
        source: { kind: 'host', hostId, path: remotePath },
        target: { kind: 'local', path: localPath },
        options
      }
    }
    return {
      direction,
      source: { kind: 'host', hostId: relaySourceHost, path: relaySourcePath },
      target: { kind: 'host', hostId: relayTargetHost, path: relayTargetPath },
      options
    }
  }

  const start = async (): Promise<void> => {
    setError('')
    try {
      const started = await window.jshell.rsync.start(buildPlan())
      taskId.current = started.id
      setTask(started)
      setStep(4)
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  const canNext = (): boolean => {
    // 三种方向都至少需要一个 SSH 主机；没有主机时停在第一步，避免进到空白的第二步
    if (step === 1) return hosts.length > 0
    if (step !== 2) return true
    if (direction === 'relay') {
      return Boolean(
        relaySourceHost &&
          relayTargetHost &&
          relaySourceHost !== relayTargetHost &&
          relaySourcePath.trim() &&
          relayTargetPath.trim()
      )
    }
    return Boolean(hostId && localPath.trim() && remotePath.trim())
  }

  const running = task?.status === 'running' || task?.status === 'retrying'
  const relayHosts = useMemo(
    () => hosts.filter((host) => host.id !== relaySourceHost),
    [hosts, relaySourceHost]
  )

  return (
    <div className="modal-mask" onClick={() => !running && onClose()}>
      <div className="modal rsync-modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2>
            <IconSync />
            文件传输
          </h2>
          <p className="sync-intro">
            在本机和服务器之间传文件（rsync）。适合整目录同步、增量续传；想临时看几个文件，
            用终端里的 SFTP 文件面板更方便。
          </p>
          <button className="icon-btn" onClick={onClose} title="关闭" disabled={running}>
            <IconClose />
          </button>
        </header>

        <div className="rsync-steps">
          {['方向', '源与目标', '选项', '执行'].map((label, index) => (
            <span
              key={label}
              className={cx(
                'rsync-step',
                step >= index + 1 && 'is-done',
                step === index + 1 && 'is-active'
              )}
            >
              {index + 1}. {label}
            </span>
          ))}
        </div>

        <div className="modal-body rsync-body">
          {step === 1 && (
            <div className="rsync-cards">
              {DIRECTIONS.map((item) => (
                <button
                  key={item.id}
                  className={cx('rsync-card', direction === item.id && 'is-active')}
                  onClick={() => setDirection(item.id)}
                >
                  <strong>{item.title}</strong>
                  <span>{item.desc}</span>
                </button>
              ))}
              {capability && !capability.available && (
                <p className="notice notice-bad">
                  未检测到本机 rsync。macOS 可用 <code>brew install rsync</code> 安装后重试；
                  也可以继续用文件面板上传下载。
                </p>
              )}
              {hosts.length === 0 && (
                <p className="notice notice-bad">还没有主机，请先在「新建主机」里添加。</p>
              )}
            </div>
          )}

          {step === 2 && (
            <>
              {direction !== 'relay' ? (
                <>
                  <label className="field">
                    <span>远端主机</span>
                    <select className="input" value={hostId} onChange={(e) => setHostId(e.target.value)}>
                      {hosts.map((host) => (
                        <option key={host.id} value={host.id}>
                          {host.name || host.host}（{host.username}@{host.host}:{host.port}）
                        </option>
                      ))}
                    </select>
                  </label>

                  {direction === 'upload' && (
                    <label className="field">
                      <span>本机来源</span>
                      <div className="input-with-btn">
                        <input
                          className="input"
                          value={localPath}
                          placeholder="/Users/you/project"
                          onChange={(e) => setLocalPath(e.target.value)}
                        />
                        <button className="btn btn-ghost" onClick={() => void pickLocal('dir')}>
                          <IconFolder />
                          目录
                        </button>
                        <button className="btn btn-ghost" onClick={() => void pickLocal('file')}>
                          文件
                        </button>
                      </div>
                    </label>
                  )}

                  <label className="field">
                    <span>远端路径</span>
                    <input
                      className="input mono"
                      value={remotePath}
                      placeholder="/var/www/app"
                      onChange={(e) => setRemotePath(e.target.value)}
                    />
                  </label>

                  {direction === 'download' && (
                    <label className="field">
                      <span>保存到本机</span>
                      <div className="input-with-btn">
                        <input
                          className="input"
                          value={localPath}
                          placeholder="/Users/you/Downloads"
                          onChange={(e) => setLocalPath(e.target.value)}
                        />
                        <button className="btn btn-ghost" onClick={() => void pickLocal('dir')}>
                          <IconFolder />
                          目录
                        </button>
                      </div>
                    </label>
                  )}
                </>
              ) : (
                <>
                  <div className="field-row">
                    <label className="field">
                      <span>源主机</span>
                      <select
                        className="input"
                        value={relaySourceHost}
                        onChange={(e) => setRelaySourceHost(e.target.value)}
                      >
                        {hosts.map((host) => (
                          <option key={host.id} value={host.id}>
                            {host.name || host.host}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="field">
                      <span>目标主机</span>
                      <select
                        className="input"
                        value={relayTargetHost}
                        onChange={(e) => setRelayTargetHost(e.target.value)}
                      >
                        {relayHosts.map((host) => (
                          <option key={host.id} value={host.id}>
                            {host.name || host.host}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <label className="field">
                    <span>源路径</span>
                    <input
                      className="input mono"
                      value={relaySourcePath}
                      onChange={(e) => setRelaySourcePath(e.target.value)}
                    />
                  </label>
                  <label className="field">
                    <span>目标路径</span>
                    <input
                      className="input mono"
                      value={relayTargetPath}
                      placeholder="/data/backup"
                      onChange={(e) => setRelayTargetPath(e.target.value)}
                    />
                  </label>
                  <p className="notice">
                    服务器之间经本机中转：先下载到临时目录再上传；两段都支持断点续传，完成后自动清理。
                  </p>
                </>
              )}

              {probe && (
                <p className={cx('notice', probe.loading ? '' : probe.ok ? 'notice-ok' : 'notice-bad')}>
                  {probe.message}
                  {!probe.loading && !probe.ok && (
                    <button className="btn btn-ghost rsync-reprobe" onClick={() => void runProbe()}>
                      <IconRefresh />
                      重新检测
                    </button>
                  )}
                </p>
              )}
            </>
          )}

          {step === 3 && (
            <>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={compress}
                  onChange={(e) => setCompress(e.target.checked)}
                />
                <span>传输压缩（弱网推荐）</span>
              </label>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={deleteExtraneous}
                  onChange={(e) => setDeleteExtraneous(e.target.checked)}
                />
                <span>删除目标端多余文件（--delete，谨慎）</span>
              </label>
              <label className="field">
                <span>排除规则（逗号分隔，可选）</span>
                <input
                  className="input mono"
                  value={exclude}
                  placeholder="node_modules, .git, *.log"
                  onChange={(e) => setExclude(e.target.value)}
                />
              </label>
              <label className="field">
                <span>失败重试次数：{retries}</span>
                <input
                  type="range"
                  min={0}
                  max={5}
                  value={retries}
                  onChange={(e) => setRetries(Number(e.target.value))}
                />
              </label>
              <p className="notice">
                断点续传默认开启（--partial + 版本对应的 --append / --append-verify）：中断后重新执行会从已传输部分继续。
              </p>
            </>
          )}

          {step === 4 && task && (
            <div className="rsync-run">
              <div className="rsync-stage">{task.stage}</div>
              <div className={cx('rsync-bar', task.percent < 0 && 'is-indeterminate')}>
                <span style={{ width: task.percent >= 0 ? `${task.percent}%` : '40%' }} />
              </div>
              <div className="rsync-metrics mono">
                <span>{task.percent >= 0 ? `${task.percent}%` : '进行中'}</span>
                <span>{task.transferred ? formatBytes(task.transferred) : '—'}</span>
                <span>{task.speed || '—'}</span>
                <span>{task.eta ? `剩余 ${task.eta}` : ''}</span>
              </div>
              <p className={cx('rsync-state', `is-${task.status}`)}>
                {task.status === 'running' && `第 ${task.attempt} 次尝试`}
                {task.status === 'retrying' && (task.message || '正在重试…')}
                {task.status === 'done' && '同步完成'}
                {task.status === 'canceled' && '已取消（已传输部分保留，可直接续传）'}
                {task.status === 'error' && (task.message || '同步失败')}
              </p>
            </div>
          )}

          {error && <p className="form-error">{error}</p>}
        </div>

        <footer className="modal-foot">
          <button className="btn btn-ghost foot-left" onClick={onClose} disabled={running}>
            {task && !running ? '关闭' : '取消'}
          </button>
          {step > 1 && step < 4 && (
            <button className="btn btn-ghost" onClick={() => setStep(step - 1)}>
              上一步
            </button>
          )}
          {step < 3 && (
            <button className="btn btn-primary" disabled={!canNext()} onClick={() => setStep(step + 1)}>
              下一步
            </button>
          )}
          {step === 3 && (
            <button
              className="btn btn-primary"
              disabled={!capability?.available}
              onClick={() => void start()}
            >
              开始传输
            </button>
          )}
          {step === 4 && running && (
            <button
              className="btn btn-ghost"
              onClick={() => void window.jshell.rsync.cancel(taskId.current)}
            >
              取消传输
            </button>
          )}
          {step === 4 && task?.status === 'error' && (
            <button className="btn btn-primary" onClick={() => void start()}>
              重试
            </button>
          )}
        </footer>
      </div>
    </div>
  )
}

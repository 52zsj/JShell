import { useEffect, useState } from 'react'
import type { AuthType, HostProfile } from '@shared/types'
import { useAppStore } from '../store'
import { cx, errorMessage } from '../utils'
import { useModalDrag } from '../use-modal-drag'
import { IconClose, IconKey } from '../icons'

interface Props {
  /** 传入表示编辑，缺省表示新建 */
  host?: HostProfile
  /** 克隆模式：从 host 预填一份配置，但不带 id（保存时作为新主机） */
  clone?: boolean
  onClose: () => void
}

const COLORS = ['#35d0a5', '#61afef', '#c678dd', '#e5c07b', '#e06c75', '#56b6c2']

const AUTH_LABELS: Record<AuthType, string> = {
  password: '密码',
  key: '私钥文件',
  agent: 'SSH 代理'
}

/**
 * 主机编辑弹窗。
 * 注意：编辑态不回填明文密码（主进程从不回传），留空即表示保持原值。
 */
export function HostEditor({ host, clone, onClose }: Props) {
  const saveHost = useAppStore((s) => s.saveHost)
  const hosts = useAppStore((s) => s.hosts)
  const [form, setForm] = useState({
    name: clone ? `${host?.name ?? host?.host ?? ''} 副本` : (host?.name ?? ''),
    host: host?.host ?? '',
    port: String(host?.port ?? 22),
    username: host?.username ?? '',
    authType: (host?.authType ?? 'password') as AuthType,
    password: '',
    passphrase: '',
    privateKeyPath: host?.privateKeyPath ?? '',
    proxyJump: host?.proxyJump ?? '',
    group: host?.group ?? '',
    color: host?.color ?? COLORS[0]
  })
  const [busy, setBusy] = useState(false)
  const [testing, setTesting] = useState(false)
  const [test, setTest] = useState<{ ok: boolean; message: string } | null>(null)
  const [error, setError] = useState('')

  // 表单可以拖着走：填表时想边看终端边填，弹窗挡着就直接拖开
  const drag = useModalDrag<HTMLFormElement>()

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const update = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }))

  const pickKey = async () => {
    const picked = await window.jshell.dialog.pickFile({ title: '选择私钥文件' })
    if (typeof picked === 'string') update('privateKeyPath', picked)
  }

  /** 表单 -> 草稿；口令留空时由主进程回落到已保存凭据 */
  const buildDraft = () => ({
    id: host && !clone ? host.id : undefined,
    name: form.name,
    host: form.host,
    port: Number(form.port),
    username: form.username,
    authType: form.authType,
    privateKeyPath: form.authType === 'key' ? form.privateKeyPath : undefined,
    proxyJump: form.proxyJump || undefined,
    group: form.group,
    color: form.color,
    password: form.authType === 'password' ? form.password : undefined,
    passphrase: form.authType === 'key' ? form.passphrase : undefined
  })

  const testConnection = async () => {
    setError('')
    setTest(null)
    setTesting(true)
    try {
      const result = await window.jshell.hosts.test(buildDraft())
      setTest({ ok: result.ok, message: result.message })
    } catch (err) {
      setTest({ ok: false, message: errorMessage(err) })
    } finally {
      setTesting(false)
    }
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setError('')
    setBusy(true)
    try {
      await saveHost(buildDraft())
      onClose()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={cx('modal-mask', drag.dragging && 'is-dragging')}>
      <form
        className="modal is-draggable"
        ref={drag.modalRef}
        style={drag.style}
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
      >
        <header className="modal-head" {...drag.handleProps}>
          <h2>{clone ? '克隆主机' : host ? '编辑主机' : '新建主机'}</h2>
          <button type="button" className="icon-btn" onClick={onClose} title="关闭">
            <IconClose />
          </button>
        </header>

        <div className="modal-body">
          <div className="field-row">
            <label className="field">
              <span>名称</span>
              <input
                className="input"
                value={form.name}
                placeholder="例如：生产环境 Web"
                onChange={(e) => update('name', e.target.value)}
              />
            </label>
            <label className="field">
              <span>分组</span>
              <input
                className="input"
                value={form.group}
                placeholder="可选，例如：生产"
                onChange={(e) => update('group', e.target.value)}
              />
            </label>
          </div>

          <div className="field-row">
            <label className="field grow">
              <span>主机地址</span>
              <input
                className="input"
                required
                value={form.host}
                placeholder="192.168.1.10 或 example.com"
                onChange={(e) => update('host', e.target.value)}
              />
            </label>
            <label className="field port">
              <span>端口</span>
              <input
                className="input"
                required
                type="number"
                min={1}
                max={65535}
                value={form.port}
                onChange={(e) => update('port', e.target.value)}
              />
            </label>
          </div>

          <label className="field">
            <span>用户名</span>
            <input
              className="input"
              required
              value={form.username}
              placeholder="root"
              onChange={(e) => update('username', e.target.value)}
            />
          </label>

          <label className="field">
            <span>跳板机</span>
            <select
              className="input"
              value={form.proxyJump}
              onChange={(e) => update('proxyJump', e.target.value)}
            >
              <option value="">直连</option>
              {hosts
                .filter((item) => item.id !== host?.id)
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name || item.host}
                  </option>
                ))}
            </select>
          </label>

          <div className="field">
            <span>认证方式</span>
            <div className="segmented">
              {(Object.keys(AUTH_LABELS) as AuthType[]).map((type) => (
                <button
                  key={type}
                  type="button"
                  className={`segmented-item${form.authType === type ? ' is-active' : ''}`}
                  onClick={() => update('authType', type)}
                >
                  {AUTH_LABELS[type]}
                </button>
              ))}
            </div>
          </div>

          {form.authType === 'password' && (
            <label className="field">
              <span>密码{host && <em className="hint">（留空则不修改）</em>}</span>
              <input
                className="input"
                type="password"
                autoComplete="off"
                value={form.password}
                placeholder={host ? '••••••••' : '登录密码'}
                onChange={(e) => update('password', e.target.value)}
              />
            </label>
          )}

          {form.authType === 'key' && (
            <>
              <label className="field">
                <span>私钥文件</span>
                <div className="input-with-btn">
                  <input
                    className="input"
                    required
                    value={form.privateKeyPath}
                    placeholder="~/.ssh/id_ed25519"
                    onChange={(e) => update('privateKeyPath', e.target.value)}
                  />
                  <button type="button" className="btn btn-ghost" onClick={() => void pickKey()}>
                    <IconKey />
                    选择
                  </button>
                </div>
              </label>
              <label className="field">
                <span>私钥口令{host && <em className="hint">（留空则不修改）</em>}</span>
                <input
                  className="input"
                  type="password"
                  autoComplete="off"
                  value={form.passphrase}
                  placeholder="私钥密码，可留空"
                  onChange={(e) => update('passphrase', e.target.value)}
                />
              </label>
            </>
          )}

          {form.authType === 'agent' && (
            <p className="notice">将使用系统 SSH 代理（macOS/Linux 读环境变量，Windows 读 OpenSSH 代理管道），请确保已加载对应私钥。</p>
          )}

          <div className="field">
            <span>标签色</span>
            <div className="swatches">
              {COLORS.map((color) => (
                <button
                  key={color}
                  type="button"
                  className={`swatch${form.color === color ? ' is-active' : ''}`}
                  style={{ background: color }}
                  onClick={() => update('color', color)}
                  title={color}
                />
              ))}
              {/*
                自定义颜色：用原生取色器，外观仍是一个圆点。
                当前色不在预设里时，这个圆点显示当前色并高亮——这样「自定义」
                和预设是同一个视觉语义，不需要额外的输入框。
              */}
              <label
                className={cx('swatch', 'swatch-custom', !COLORS.includes(form.color) && 'is-active')}
                style={!COLORS.includes(form.color) ? { background: form.color } : undefined}
                title="自定义颜色"
              >
                <input
                  type="color"
                  value={form.color}
                  onChange={(e) => update('color', e.target.value)}
                  aria-label="自定义标签色"
                />
              </label>
            </div>
          </div>

          {test && (
            <p className={`notice ${test.ok ? 'notice-ok' : 'notice-bad'}`}>{test.message}</p>
          )}

          {error && <p className="form-error">{error}</p>}
        </div>

        <footer className="modal-foot">
          <button
            type="button"
            className="btn btn-ghost foot-left"
            onClick={() => void testConnection()}
            disabled={testing || busy}
          >
            {testing ? '测试中…' : '测试连接'}
          </button>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? '保存中…' : '保存'}
          </button>
        </footer>
      </form>
    </div>
  )
}

import { useAppStore } from '../store'
import { IconClose } from '../icons'

/**
 * 主机公钥指纹变更确认。
 *
 * 出现在 hostVerifier 判定「指纹与本地记录不一致」时：把两个指纹并排给出，
 * 由用户决定是「服务器换密钥」还是「有人在中间」。信任后会覆盖本地记录并重连。
 */
export function HostKeyDialog() {
  const prompt = useAppStore((s) => s.hostKeyPrompt)
  const trust = useAppStore((s) => s.trustHostKey)
  const dismiss = useAppStore((s) => s.dismissHostKeyPrompt)

  if (!prompt) return null

  return (
    <div className="modal-mask" onClick={dismiss}>
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <header className="modal-head">
          <h2>主机指纹已变更</h2>
          <button className="icon-btn" onClick={dismiss} title="关闭">
            <IconClose />
          </button>
        </header>

        <div className="modal-body">
          <p className="notice is-danger">
            这台主机的公钥与本地记录不一致，连接已被阻止。可能是服务器重装或更换了密钥，
            也可能是中间人攻击——请先确认原因。
          </p>

          <dl className="kv">
            <dt>主机</dt>
            <dd className="mono">
              {prompt.host}:{prompt.port}
            </dd>
            <dt>密钥算法</dt>
            <dd className="mono">{prompt.algorithm}</dd>
            <dt>已记录</dt>
            <dd className="mono fingerprint">{prompt.known}</dd>
            <dt>本次连接</dt>
            <dd className="mono fingerprint is-new">{prompt.actual}</dd>
          </dl>

          <p className="notice">
            确认是本人变更（例如服务器重装、替换了 host key）后，点击「信任新指纹」会覆盖本地记录
            并重新连接；否则请取消并联系服务器管理员。
          </p>
        </div>

        <footer className="modal-foot">
          <button className="btn btn-ghost" onClick={dismiss}>
            取消
          </button>
          <button className="btn btn-primary" onClick={() => void trust()}>
            信任新指纹并重连
          </button>
        </footer>
      </div>
    </div>
  )
}

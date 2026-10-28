import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

/** 顶层错误边界：渲染异常时给出可恢复界面，而不是白屏 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('界面渲染异常', error, info.componentStack)
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children
    return (
      <div className="app-loading">
        <p>界面出现异常：{this.state.error.message}</p>
        <button className="btn btn-primary" onClick={() => window.location.reload()}>
          重新加载界面
        </button>
      </div>
    )
  }
}

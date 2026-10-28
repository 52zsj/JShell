import { createRoot } from 'react-dom/client'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import './styles.css'

const container = document.getElementById('root')
if (!container) throw new Error('#root 未找到')

// 不使用 StrictMode：dev 下 effect 双调用会重建 xterm 实例并丢弃缓冲输出
createRoot(container).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
)

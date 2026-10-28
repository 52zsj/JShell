import type { JShellApi } from '@shared/api'

declare global {
  interface Window {
    /** 由 preload 通过 contextBridge 注入，见 src/preload/index.ts */
    jshell: JShellApi
  }
}

export {}

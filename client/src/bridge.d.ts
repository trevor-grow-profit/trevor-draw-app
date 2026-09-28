// The preload installs the bridge (Desktop A1, GRO-2153). Lives here, not in shared/, because
// the desktop (main/preload) tsconfig has no DOM lib and `Window` would not resolve there.
import type { YaseenDrawApi } from '@shared/ipc'

declare global {
  interface Window {
    yaseenDraw: YaseenDrawApi
  }
}

export {}

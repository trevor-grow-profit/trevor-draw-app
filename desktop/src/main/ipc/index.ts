import type { GitSyncManager } from '../git/manager'
import type { Store } from '../store'
import type { WindowManagerIpc } from '../windows'
import { registerComponentsIpc } from './components'
import { registerDiagramIpc } from './diagram'
import { registerDialogIpc } from './dialog'
import { registerDrawingIpc } from './drawing'
import { registerFavoritesIpc } from './favorites'
import { registerFsIpc } from './fs'
import { registerGithubIpc } from './github'
import { registerMediaLibraryIpc } from './mediaLibrary'
import { registerMediaStudioIpc } from './mediaStudio'
import { registerSecretsIpc } from './secrets'
import { registerShareIpc } from './share'
import { registerStateIpc } from './state'
import { registerStorageIpc } from './storage'
import { registerWatchIpc } from './watch'
import { registerWindowIpc } from './window'

/**
 * Every `ipcMain` handler the preload's bridge invokes; call once before the first window loads.
 *
 * Returns the GitHub sync manager (YAZ-1081, YAZ-1809) — the one registration with triggers no renderer
 * can send (window focus, OS wake, the last flush before quit), which `main/index.ts` owns.
 *
 * `userData` is passed in rather than read from `app`: it is the library folder's default root
 * (🔒 YAZ-1775 D5) and where `secrets.json` lives (🔒 YAZ-1775 D4), and every module under `main/` that touches it
 * stays Electron-free and testable.
 */
export function registerIpc(store: Store, windows: WindowManagerIpc, userData: string, share: { viewerAssetsDir: string; drawioDir: string; fontsDir: string; isPackaged: boolean }): GitSyncManager {
  registerFsIpc(store, windows)
  registerDrawingIpc(store, userData)
  registerDiagramIpc()
  registerDialogIpc()
  registerWatchIpc()
  registerStateIpc(store)
  registerFavoritesIpc(store)
  registerMediaLibraryIpc(store, userData)
  registerComponentsIpc(store, userData)
  // 🔒 YAZ-1775 D4: the secrets instance is THREADED into the studio's providers — that is how a Pixabay
  // request gets its key without the key ever leaving main.
  const secrets = registerSecretsIpc(userData)
  registerMediaStudioIpc(userData, secrets)
  // YAZ-1799: sharing reads the Cloudflare token and upload password from the same door — main only.
  registerShareIpc(userData, secrets, share)
  registerWindowIpc(store, windows)
  registerStorageIpc()
  return registerGithubIpc(store)
}

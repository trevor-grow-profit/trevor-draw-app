import type { GitSyncManager } from './git/manager'
import type { Store } from './store'
import type { WindowManager } from './windows'

/** The slices of main that quitting drives; `index.ts` passes the real ones, tests fake them. */
export interface QuitDeps {
  manager: Pick<WindowManager, 'flushAllForQuit'>
  store: Pick<Store, 'flush'>
  /** Undefined when quitting before `ready` created it. */
  gitSync: Pick<GitSyncManager, 'flushForQuit'> | undefined
  exit(): void
}

/**
 * Quit, in the one order that loses nothing (YAZ-2073 D11): every renderer flushes FIRST (5 s cap
 * each, windows.ts), so its last save lands; THEN the state file is written at once (a commit from the
 * last 150 ms — `commitBounds` inside the renderer flush included — would die with its timer) and the
 * last sync pass commits and pushes that save (YAZ-1081 D2, its network capped by YAZ-1111). Neither
 * failing may keep the app alive, so exit always runs. A test pins every step: 82d63ce dropped the
 * middle one silently.
 */
export async function runQuitSequence({ manager, store, gitSync, exit }: QuitDeps): Promise<void> {
  try {
    await manager.flushAllForQuit()
    await Promise.allSettled([store.flush(), gitSync?.flushForQuit()])
  } finally {
    exit()
  }
}

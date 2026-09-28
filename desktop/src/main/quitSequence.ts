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
 * Quit, in the one order that loses nothing (YAZ-2073 D11): every renderer flushes FIRST (in
 * parallel, 5 s at most, windows.ts), so its last save lands; THEN the state file is written at
 * once (a commit from the last 150 ms — `commitBounds` inside the renderer flush included — would die
 * with its timer) and the last sync pass commits and pushes that save (YAZ-1081 D2, its network capped
 * by YAZ-1111). No step failing may skip a later one or keep the app alive, and the sequence itself
 * never rejects (its caller does not wait). A test pins every step.
 */
export async function runQuitSequence({ manager, store, gitSync, exit }: QuitDeps): Promise<void> {
  try {
    await manager.flushAllForQuit().catch((err: unknown) => console.error(`[quit] a window did not flush: ${String(err)}`))
    await Promise.allSettled([store.flush(), gitSync?.flushForQuit()])
  } finally {
    exit()
  }
}

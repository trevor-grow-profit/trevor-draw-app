/** The row verbs that leave the app: other tabs and windows, Finder, VS Code, the OS default app. */
import { useCallback } from 'react'
import { api, BridgeRequestError } from '../../api'
import type { NoticeKind } from '../../lib/notice'
import { basename } from '../../lib/paths'

export function useShellActions(root: string, onOpenFileBackground: (path: string) => void, onNotice: (message: string, kind?: NoticeKind) => void) {
  /**
   * Context menu "Open N in new tabs" (🔒 D5, YAZ-1337): the SAME background opener ⌘-click
   * already uses (I3, GRO-2235), once per selected path. The loop needs no guard of its own —
   * the workspace ignores a path that is already open and appends without stealing activation
   * (`open-background`, useWorkspace.ts) — so N tabs land in tree order and the caret stays put.
   */
  const openFilesInTabs = useCallback(
    (paths: string[]) => {
      for (const path of paths) onOpenFileBackground(path)
    },
    [onOpenFileBackground],
  )

  /** Context menu "Open in new window" (D2, GRO-2168): a fresh window on {root, file}; this one untouched. (⌘-click opens a background tab instead since I3.) */
  const openFileNewWindow = useCallback(
    (path: string) => {
      window.yaseenDraw.window.open({ root, file: path }).catch((err: unknown) => console.error('[sidebar] window.open failed:', err))
    },
    [root],
  )

  /**
   * Reveal in Finder (GRO-2274). Read-only, so there is no confirm and nothing to repair —
   * but a STALE row (deleted or moved externally) rejects `NOT_FOUND`, and that has to be
   * visible: `showItemInFolder` is silent on a missing path, so without a notice the menu
   * item would just look broken.
   */
  const reveal = useCallback(
    (path: string) => {
      api.reveal({ path }).catch((err: unknown) => {
        onNotice(err instanceof BridgeRequestError && err.code === 'NOT_FOUND' ? `Can't reveal "${basename(path)}" — it is no longer there` : `Can't reveal: ${err instanceof Error ? err.message : String(err)}`, 'error')
      })
    },
    [onNotice],
  )

  /**
   * Open in VS Code (YAZ-963): `reveal`'s twin, notice included. A dead `vscode://` URL opens
   * an empty editor rather than reporting anything, so the stale-row `NOT_FOUND` is exactly as
   * load-bearing here as it is above.
   */
  const openVsCode = useCallback(
    (path: string) => {
      api.openVsCode({ path }).catch((err: unknown) => {
        onNotice(err instanceof BridgeRequestError && err.code === 'NOT_FOUND' ? `Can't open "${basename(path)}" in VS Code — it is no longer there` : `Can't open in VS Code: ${err instanceof Error ? err.message : String(err)}`, 'error')
      })
    },
    [onNotice],
  )

  /**
   * Open in default app (YAZ-1577): the third twin. Both the click on a row with no viewer and
   * the menu item land here; the OS' own refusal (`IO_ERROR`, e.g. no app registered for the
   * type) is the one extra message worth showing verbatim.
   */
  const openDefault = useCallback(
    (path: string) => {
      api.openDefault({ path }).catch((err: unknown) => {
        onNotice(err instanceof BridgeRequestError && err.code === 'NOT_FOUND' ? `Can't open "${basename(path)}" — it is no longer there` : `Can't open "${basename(path)}": ${err instanceof Error ? err.message : String(err)}`, 'error')
      })
    },
    [onNotice],
  )

  return { openFilesInTabs, openFileNewWindow, reveal, openVsCode, openDefault }
}

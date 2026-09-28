import { useCallback, useEffect, useState, type Dispatch } from 'react'
import type { FileClipState } from '@shared/types'
import { api } from '../../api'
import type { NoticeKind } from '../../lib/notice'
import { basename } from '../../lib/paths'
import { type TreeAction } from '../../lib/treeState'
import { countItems } from '../menuSections'

/** Cut / Copy / Paste (YAZ-1674): the app-wide clipboard as this window sees it, and its verbs. */
export function useFileClipboard(root: string, refresh: () => void, dispatch: Dispatch<TreeAction>, onNotice: (message: string, kind?: NoticeKind) => void) {
  /**
   * Main's ONE app-wide file clipboard (🔒 YAZ-1674 D1): `{ count, op }` or null, pushed to every window on
   * every change, so a menu opened here can label "Paste N items" for a copy made in another
   * window on another vault. Session-only, never persisted. A window opened AFTER a clip reads the
   * current state ONCE on mount (`clipState`), so its Paste is labelled from the start.
   */
  const [clip, setClip] = useState<FileClipState>(null)
  useEffect(() => {
    // Subscribe FIRST, then read: a push that lands while the read is in flight is newer than the
    // read and must win — the read only fills a window nothing has pushed to yet.
    let live = true
    let pushed = false
    const unsubscribe = api.file.onClipChanged((state) => {
      pushed = true
      setClip(state)
    })
    api.file.clipState().then(
      (state) => {
        if (live && !pushed) setClip(state)
      },
      () => undefined, // an empty clipboard is the honest fallback; the next push corrects it
    )
    return () => {
      live = false
      unsubscribe()
    }
  }, [])

  /**
   * Cut / Copy: hand the ordered paths to main (🔒 YAZ-1674 D1) and SAY SO — every clipboard write confirms
   * (YAZ-1341), and a refusal is reported, never swallowed. The selection stands: acting on it is
   * not the same as ending it (YAZ-1337).
   */
  const clipTo = useCallback(
    (paths: string[], op: 'copy' | 'cut') => {
      const what = countItems(paths.length)
      api.file.clip({ paths, op }).then(
        () => onNotice(op === 'cut' ? `Cut ${what}` : `Copied ${what}`, op),
        (err: unknown) => onNotice(`Can't ${op}: ${err instanceof Error ? err.message : String(err)}`, 'error'),
      )
    },
    [onNotice],
  )

  /**
   * Paste into `dir` (🔒 YAZ-1674 D2–D4): PER-ENTRY results, so one bad entry never hides the rest — the
   * notice counts both halves and names the first failure. The target opens and the tree refreshes
   * EXPLICITLY: a copy moves nothing, so no `fileRenamed` broadcast repairs it, and the watcher's add
   * echo is a courtesy, not a contract (`refresh` is idempotent).
   */
  const pasteInto = useCallback(
    async (dir: string) => {
      try {
        const res = await api.file.paste({ targetDir: dir })
        dispatch({ type: 'expandDir', root, dir })
        refresh()
        const first = res.failed[0]
        if (first === undefined) {
          // Reachable only when EVERY entry was a cut into the folder it is already in (skipped silently, D2) — nothing went wrong.
          if (res.pasted.length === 0) onNotice('Nothing to paste', 'info')
          else onNotice(`Pasted ${countItems(res.pasted.length)}`, 'paste')
        } else if (res.pasted.length === 0) onNotice(`Couldn't paste: ${basename(first.from)} — ${first.message}`, 'error')
        else onNotice(`Pasted ${countItems(res.pasted.length)}, skipped ${res.failed.length}: ${basename(first.from)} — ${first.message}`, 'paste')
      } catch (err: unknown) {
        onNotice(`Can't paste: ${err instanceof Error ? err.message : String(err)}`, 'error')
      }
    },
    [root, dispatch, refresh, onNotice],
  )

  return { clip, clipTo, pasteInto }
}

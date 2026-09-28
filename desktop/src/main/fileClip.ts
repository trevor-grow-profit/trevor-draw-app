import type { FileClipState } from '@shared/types'
import { BridgeFailure } from './fs/fsUtils'
import { requireAbsPath, requireObject } from './fs/validate'

/**
 * The ONE app-wide file clipboard (YAZ-1674, D1): what Cut / Copy in ANY window's sidebar put
 * here, and what Paste in ANY window takes out. It lives in main — not in a renderer, which
 * cannot cross windows, and not on the OS clipboard, whose Electron file-list write is a
 * macOS-only `public.file-url` that is flaky for many files (Finder interop, Future YAZ-1707) — so
 * cutting in a window on vault A and pasting in a window on vault B is the same gesture as
 * pasting within one vault.
 *
 * Session-only and NEVER persisted: a clipboard that survived a relaunch would offer a paste of
 * paths nobody remembers cutting. No Electron import, so it unit-tests in plain node; the IPC
 * layer (`ipc/fs.ts`) wires `onChange` to the `clip:changed` push every window gets.
 */
export interface FileClip {
  /** Absolute, resolved, de-duplicated, in the ORDER the sidebar handed them (the ordered selection). */
  paths: string[]
  op: 'copy' | 'cut'
}

export interface FileClipStore {
  /**
   * Validates the renderer's request and replaces the clipboard: `op` must be `copy` or `cut`,
   * `paths` a non-empty array of absolute paths (each through `requireAbsPath`, so a relative
   * entry rejects `NOT_ABSOLUTE` and a missing one `BAD_REQUEST`). Duplicates collapse to their
   * first position. Nothing is stat'ed here: a path that goes stale between Cut and Paste fails
   * per entry AT PASTE (`NOT_FOUND`), which is where the user can see it.
   */
  set(req: unknown): void
  /** The current clipboard, or null when empty. Callers never mutate it. */
  get(): FileClip | null
  /** Empties the clipboard (a cut that pasted, D2). Idempotent: clearing an empty clipboard notifies nobody. */
  clear(): void
  /** What the renderers show — count + op, never the paths (a menu label needs no more). */
  state(): FileClipState
  /** Fires with the new `state()` after every change; returns the unsubscribe. */
  onChange(listener: (state: FileClipState) => void): () => void
}

export function createFileClip(): FileClipStore {
  let clip: FileClip | null = null
  const listeners = new Set<(state: FileClipState) => void>()
  const state = (): FileClipState => (clip === null ? null : { count: clip.paths.length, op: clip.op })
  const notify = () => {
    const s = state()
    listeners.forEach((l) => l(s))
  }
  return {
    set(req) {
      const { op, paths } = requireObject(req)
      if (op !== 'copy' && op !== 'cut') throw new BridgeFailure('BAD_REQUEST', "'op' must be 'copy' or 'cut'")
      if (!Array.isArray(paths) || paths.length === 0) throw new BridgeFailure('BAD_REQUEST', "'paths' must be a non-empty array")
      // Validate EVERY entry before storing any: a half-valid clipboard is worse than none.
      // `requireAbsPath` already resolves, so the Set de-duplicates on the canonical spelling.
      const resolved = paths.map((p) => requireAbsPath(p, 'paths'))
      clip = { op, paths: [...new Set(resolved)] }
      notify()
    },
    get: () => clip,
    clear() {
      if (clip === null) return
      clip = null
      notify()
    },
    state,
    onChange(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

/** The app-wide instance `ipc/fs.ts` serves; tests build their own with `createFileClip()`. */
export const fileClip = createFileClip()

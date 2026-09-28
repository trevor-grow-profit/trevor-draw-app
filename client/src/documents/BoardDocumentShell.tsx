import { Fragment, useEffect, useState, type ReactNode } from 'react'

interface BoardDocumentShellProps<T> {
  root: string
  path: string
  /** `editor--drawing` or `editor--diagram`: the section `boardCommand.ts` dispatches on. */
  className: string
  /** Module-level, so its identity never changes; a rejection is `errorText`'s error pane. */
  load: (req: { root: string; path: string }) => Promise<T>
  errorText: (err: unknown) => string
  /** The host, handed the document and the error pane (for an engine that fails after mount). */
  children: (loaded: T, onFailed: (message: string) => void) => ReactNode
}

/**
 * A board's outer section (YAZ-2073 🔒 D16): the document is read BEFORE any engine mounts, so a
 * file that will not open is ONE readable state — never a blank pane, and never an engine that
 * could autosave over it. The host is keyed by path, so a rename mounts a fresh one rather than
 * re-pointing a live engine.
 */
export function BoardDocumentShell<T>({ root, path, className, load, errorText, children }: BoardDocumentShellProps<T>) {
  const [loaded, setLoaded] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    setLoaded(null)
    setError(null)
    load({ root, path }).then(
      (doc) => {
        if (live) setLoaded(doc)
      },
      (err: unknown) => {
        if (live) setError(errorText(err))
      },
    )
    return () => {
      live = false
    }
  }, [root, path, load, errorText])

  return (
    <section className={`editor ${className}`}>
      {error !== null && (
        <p className="editor-msg editor-msg--error" role="alert">
          {error}
        </p>
      )}
      {error === null && loaded === null && <p className="editor-msg">Loading…</p>}
      {error === null && loaded !== null && <Fragment key={path}>{children(loaded, setError)}</Fragment>}
    </section>
  )
}

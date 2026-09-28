import { useEffect, useRef, useState } from 'react'

interface TextFieldProps {
  value: string
  /** The new text, once per edit (Enter or blur) and only when it differs from `value`. */
  onCommit: (next: string) => void
  /** Canonicalizes a committed draft before the comparison; the field then shows the result. */
  normalize?: (draft: string) => string
  /** After Enter, blur or Escape, whether or not anything was committed. */
  onDone?: () => void
  className?: string
  placeholder?: string
  autoFocus?: boolean
  /** Select the whole value when the field mounts, so typing replaces it (Finder's rename, Docs YAZ-1974 D5). */
  selectOnMount?: boolean
  'aria-label'?: string
}

/** Text input that reports its value once per edit — ported from Docs `views/view/TextField.tsx` (YAZ-2056 D3). */
export function TextField({ value, onCommit, normalize, onDone, selectOnMount, ...rest }: TextFieldProps) {
  const [draft, setDraft] = useState(value)
  const done = useRef(false)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => setDraft(value), [value])
  useEffect(() => {
    if (selectOnMount === true) input.current?.select()
  }, [])

  const finish = (commit: boolean) => {
    if (done.current) return
    done.current = true
    if (commit && draft !== value) {
      const next = normalize === undefined ? draft : normalize(draft)
      setDraft(next)
      if (next !== value) onCommit(next)
    } else if (!commit) setDraft(value)
    onDone?.()
  }

  return (
    <input
      {...rest}
      ref={input}
      value={draft}
      onChange={(e) => {
        done.current = false
        setDraft(e.target.value)
      }}
      onBlur={() => finish(true)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          finish(true)
        } else if (e.key === 'Escape') {
          e.stopPropagation()
          finish(false)
        }
      }}
    />
  )
}

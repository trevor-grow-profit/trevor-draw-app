import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'

interface UsePickFolderOptions {
  onPicked: (path: string) => void
}

/**
 * "Open folder" flow: the native open-directory dialog (`api.pickFolder()`).
 * Only one dialog is ever in flight; `pick()` is a no-op while it is open. A cancelled or
 * failed dialog changes nothing.
 */
export function usePickFolder({ onPicked }: UsePickFolderOptions) {
  const [picking, setPicking] = useState(false)
  const inFlight = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const pick = useCallback(() => {
    if (inFlight.current) return
    inFlight.current = true
    setPicking(true)
    api
      .pickFolder()
      .then(
        (res) => {
          if (mounted.current && 'path' in res) onPicked(res.path)
        },
        () => undefined,
      )
      .finally(() => {
        inFlight.current = false
        if (mounted.current) setPicking(false)
      })
  }, [onPicked])

  return { pick, picking }
}

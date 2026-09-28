/** Which folders are open (per vault, persisted), shared by both lenses (YAZ-1766 D7). */
import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react'
import { storage } from '../../lib/storage'
import { treeReducer } from '../../lib/treeState'
import { sameList } from './sameList'

export function useExpansion(root: string, activeFile: string | null) {
  const [expanded, dispatch] = useReducer(treeReducer, root, storage.getExpanded)

  useEffect(() => {
    // Idempotent (⚡ YAZ-874): the first render holds exactly what was
    // just read, and re-sending it would make the main process commit, write and broadcast for nothing.
    if (sameList(storage.getExpanded(root), expanded)) return
    storage.setExpanded(root, expanded)
  }, [root, expanded])

  // The file this mount woke up with is SHOWN, not revealed (YAZ-1642): a relaunch restores the
  // tab and leaves the tree collapsed. Any file opened after that still opens its folders.
  const restoredFile = useRef(activeFile)
  useEffect(() => {
    if (activeFile === restoredFile.current) return
    restoredFile.current = null
    if (activeFile !== null) dispatch({ type: 'expandTo', root, file: activeFile })
  }, [root, activeFile])

  // The Tree is memoized (YAZ-2073 5D): these two keep their identity until they change.
  const expandedSet = useMemo(() => new Set(expanded), [expanded])
  const toggleDir = useCallback((dir: string) => dispatch({ type: 'toggle', dir }), [])

  return { expanded, dispatch, expandedSet, toggleDir }
}

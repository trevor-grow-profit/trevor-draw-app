/** Rename (files E1 GRO-2194, folders E1b GRO-2241): context menu "Rename" → inline input over the row. */
import { useCallback, useMemo, useState } from 'react'
import type { TreeNode } from '@shared/types'
import { renamedPath } from '../createEntry'
import type { PendingRename } from '../Tree'

export function useInlineRename(onRenameFile: (oldPath: string, newPath: string, kind: TreeNode['type']) => Promise<void>) {
  const [renamingEntry, setRenamingEntry] = useState<{ path: string; kind: 'file' | 'dir' } | null>(null)

  const submitRename = useCallback(
    async (name: string) => {
      if (renamingEntry === null) return
      const target = renamedPath(renamingEntry.path, name, renamingEntry.kind)
      setRenamingEntry(null)
      if (target === renamingEntry.path) return // same name = no-op
      // App owns the whole flow (and routes failures to the passive notice — never a dialog);
      // the tree row follows via the watcher's unlink+add refresh.
      await onRenameFile(renamingEntry.path, target, renamingEntry.kind)
    },
    [renamingEntry, onRenameFile],
  )

  const cancelRename = useCallback(() => setRenamingEntry(null), [])
  const renaming = useMemo<PendingRename | null>(
    () => (renamingEntry === null ? null : { path: renamingEntry.path, onSubmit: submitRename, onCancel: cancelRename }),
    [renamingEntry, submitRename, cancelRename],
  )

  return { renaming, startRename: setRenamingEntry }
}

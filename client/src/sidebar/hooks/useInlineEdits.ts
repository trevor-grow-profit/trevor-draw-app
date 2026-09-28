import { useCallback, useMemo, useState } from 'react'
import { EMPTY_DIAGRAM_XML } from '@shared/diagramFile'
import type { TreeNode } from '@shared/types'
import { api } from '../../api'
import { EMPTY_SCENE_JSON } from '../../drawings/drawingScene'
import type { PendingCreate, PendingRename } from '../Tree'
import { entryPath, renamedPath, type EntryKind } from '../createEntry'

/** The two inline name boxes: New drawing / folder in the target folder (GRO-2022), Rename over the row (E1 GRO-2194, E1b GRO-2241). */
export function useInlineEdits(refresh: () => void, onOpenFile: (path: string) => void, onRenameFile: (oldPath: string, newPath: string, kind: TreeNode['type']) => Promise<void>) {
  const [creating, setCreating] = useState<{ kind: EntryKind; seed: string; parentDir: string } | null>(null)
  const [renamingEntry, setRenamingEntry] = useState<{ path: string; kind: 'file' | 'dir' } | null>(null)

  const submitCreate = useCallback(
    async (name: string) => {
      if (creating === null) return
      const p = entryPath(creating.parentDir, name, creating.kind)
      if (creating.kind === 'dir') await api.createDir(p)
      // Content-at-create (🔒 YAZ-1810): a new board is born with its EMPTY content in the same `wx`
      // write — a zero-byte `.excalidraw` or `.drawio` is exactly the corrupt case the editor's error pane exists for.
      else await api.createFile({ path: p, content: creating.kind === 'diagram' ? EMPTY_DIAGRAM_XML : EMPTY_SCENE_JSON })
      setCreating(null)
      refresh()
      if (creating.kind !== 'dir') onOpenFile(p)
    },
    [creating, refresh, onOpenFile],
  )

  const cancelCreate = useCallback(() => setCreating(null), [])
  const pending = useMemo<PendingCreate | null>(
    () => (creating === null ? null : { kind: creating.kind, seed: creating.seed, parentDir: creating.parentDir, onSubmit: submitCreate, onCancel: cancelCreate }),
    [creating, submitCreate, cancelCreate],
  )

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

  return { startCreate: setCreating, pending, startRename: setRenamingEntry, renaming }
}

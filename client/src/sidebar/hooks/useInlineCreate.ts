/** New drawing / new folder (GRO-2022): right-click menu → inline name input inside the target folder. */
import { useCallback, useMemo, useState, type Dispatch } from 'react'
import type { SidebarLens, TreeNode } from '@shared/types'
import { EMPTY_DIAGRAM_XML } from '@shared/diagramFile'
import { api } from '../../api'
import { EMPTY_SCENE_JSON } from '../../drawings/drawingScene'
import { findDirNode, type TreeAction } from '../../lib/treeState'
import { entryPath, type EntryKind } from '../createEntry'
import type { MenuTargets } from '../Sidebar'
import type { PendingCreate } from '../Tree'

interface InlineCreateOptions {
  root: string
  menu: MenuTargets | null
  closeMenu: () => void
  dispatch: Dispatch<TreeAction>
  /** The Favorites tab's rows: a create into a folder it does not show moves to Files. */
  favoriteNodes: readonly TreeNode[]
  onLensChange: (lens: SidebarLens) => void
  refresh: () => void
  onOpenFile: (path: string) => void
}

export function useInlineCreate({ root, menu, closeMenu, dispatch, favoriteNodes, onLensChange, refresh, onOpenFile }: InlineCreateOptions) {
  const [creating, setCreating] = useState<{ kind: EntryKind; seed: string; parentDir: string } | null>(null)

  const startCreate = useCallback(
    (kind: EntryKind, seed = '') => {
      if (menu === null) return
      // The input renders inside the target dir's children, so that dir must be open;
      // expandTo opens every dir ABOVE the given path, so a synthetic child opens targetDir itself.
      if (menu.targetDir !== root) dispatch({ type: 'expandTo', root, file: `${menu.targetDir}/x` })
      // Favorites shows a SUBSET of the vault (YAZ-1766, 3B1): a target dir it does not hold would give
      // the input nowhere to mount, so the create moves to Files — where the `expandTo` above has
      // already opened that dir. The reveal hop's rule (D10), applied to the other gesture that needs a row.
      if (menu.lens === 'favorites' && menu.targetDir !== root && findDirNode(favoriteNodes, menu.targetDir) === null) onLensChange('files')
      setCreating({ kind, seed, parentDir: menu.targetDir })
      closeMenu()
    },
    [menu, root, dispatch, favoriteNodes, onLensChange, closeMenu],
  )

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

  return { startCreate, pending }
}

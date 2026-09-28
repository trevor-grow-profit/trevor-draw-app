/** Delete (GRO-2272): context menu "Delete" → confirm sheet → App trashes the entry. */
import { useCallback, useState } from 'react'
import type { SettingsState, TreeNode, TreeResponse } from '@shared/types'
import { isWithin } from '@shared/paths'
import type { DeleteTarget } from '../ConfirmDelete'
import type { MenuTargets } from '../Sidebar'

/**
 * Files and subfolders inside `dir`, counted RECURSIVELY from the already-loaded tree
 * (GRO-2272 `C3-`) — a delete takes the whole subtree, so a shallow count would understate
 * what the user is about to lose. No fetch: the sidebar already holds this tree.
 */
export function countChildren(nodes: readonly TreeNode[], dir: string): { files: number; folders: number } {
  const found = findDir(nodes, dir)
  if (found === null) return { files: 0, folders: 0 }
  let files = 0
  let folders = 0
  const walk = (children: readonly TreeNode[]): void => {
    for (const child of children) {
      if (child.type === 'dir') {
        folders++
        walk(child.children)
      } else files++
    }
  }
  walk(found)
  return { files, folders }
}

function findDir(nodes: readonly TreeNode[], dir: string): readonly TreeNode[] | null {
  for (const node of nodes) {
    if (node.type !== 'dir') continue
    if (node.path === dir) return node.children
    if (isWithin(node.path, dir, true)) {
      const hit = findDir(node.children, dir)
      if (hit !== null) return hit
    }
  }
  return null
}

interface DeleteConfirmOptions {
  tree: TreeResponse | null
  menu: MenuTargets | null
  settings: SettingsState
  onChangeSettings: (next: SettingsState) => void
  onDeleteFile: (path: string) => Promise<void>
}

export function useDeleteConfirm({ tree, menu, settings, onChangeSettings, onDeleteFile }: DeleteConfirmOptions) {
  // The delete confirm sheet's target (GRO-2272 `C3-`); null when the sheet is closed.
  const [confirmingDelete, setConfirmingDelete] = useState<DeleteTarget | null>(null)

  /** Counts for the sheet, computed ONCE when it opens rather than on every render, off the loaded tree. */
  const askDelete = useCallback(
    (path: string) => {
      // The setting finally gates the sheet (YAZ-857 — it existed end-to-end but nothing read
      // it): off → delete directly, exactly what "Don't ask me again" promised.
      if (!settings.confirmDelete) {
        void onDeleteFile(path)
        return
      }
      const kind: 'file' | 'dir' = menu?.rowKind === 'file' ? 'file' : 'dir'
      const target: DeleteTarget = { path, kind }
      if (kind === 'dir') target.children = countChildren(tree?.tree ?? [], path)
      setConfirmingDelete(target)
    },
    [menu, tree, settings.confirmDelete, onDeleteFile],
  )

  const confirmDelete = useCallback(
    (dontAskAgain: boolean) => {
      const target = confirmingDelete
      setConfirmingDelete(null)
      if (target === null) return
      if (dontAskAgain) onChangeSettings({ ...settings, confirmDelete: false })
      // Fire and forget: App owns the result and routes every failure to the passive notice.
      void onDeleteFile(target.path)
    },
    [confirmingDelete, onDeleteFile, onChangeSettings, settings],
  )

  const cancelDelete = useCallback(() => setConfirmingDelete(null), [])

  return { confirmingDelete, askDelete, confirmDelete, cancelDelete }
}

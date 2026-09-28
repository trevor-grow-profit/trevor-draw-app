import { useCallback, useMemo, useState, type DragEvent } from 'react'
import type { TreeNode } from '@shared/types'
import { basename } from '../../lib/paths'
import type { TreeFileMove } from '../Tree'

/** File drag-to-move (E1b, GRO-2241): the dragged FILE row and its drop target — a folder row or the root header. */
export function useTreeDrag(root: string, onRenameFile: (oldPath: string, newPath: string, kind: TreeNode['type']) => Promise<void>) {
  const [dragging, setDragging] = useState<string | null>(null)
  const [dropDir, setDropDir] = useState<string | null>(null)

  const dropOnDir = useCallback(
    (dir: string) => {
      const path = dragging
      setDragging(null)
      setDropDir(null)
      if (path === null) return
      const target = `${dir}/${basename(path)}`
      if (target === path) return // dropped into its own folder: nothing to do
      // The SAME rename flow as the context menu — never-overwrite and every failure as a
      // passive notice come with it; link updates and the workspace remap ride the same pipeline.
      void onRenameFile(path, target, 'file')
    },
    [dragging, onRenameFile],
  )

  const fileMove = useMemo<TreeFileMove>(
    () => ({
      dragging,
      dropDir,
      start: setDragging,
      end: () => {
        setDragging(null)
        setDropDir(null)
      },
      hover: setDropDir,
      drop: dropOnDir,
    }),
    [dragging, dropDir, dropOnDir],
  )

  // The root header doubles as the "move to the vault root" drop target (E1b).
  const header = {
    isDropTarget: dropDir === root,
    onDragOver: (e: DragEvent) => {
      if (dragging === null) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
      if (dropDir !== root) setDropDir(root)
    },
    onDragLeave: () => {
      if (dropDir === root) setDropDir(null)
    },
    onDrop: (e: DragEvent) => {
      e.preventDefault()
      dropOnDir(root)
    },
  }

  return { fileMove, header }
}

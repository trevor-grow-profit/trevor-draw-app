import type { TreeNode } from '@shared/types'
import { isWithin, sepOf, trimSep } from '@shared/paths'

/** Expanded-directory set for the sidebar tree (persisted per root; see storage.ts). */
export type TreeAction =
  | { type: 'toggle'; dir: string }
  /** Replace the whole set (⚡ YAZ-862): expand-all and collapse-all are this ONE action, `[]` being the latter. */
  | { type: 'setAll'; dirs: string[] }
  | { type: 'expandTo'; root: string; file: string }

export function treeReducer(expanded: string[], action: TreeAction): string[] {
  switch (action.type) {
    case 'toggle':
      return expanded.includes(action.dir) ? expanded.filter((d) => d !== action.dir) : [...expanded, action.dir]
    case 'setAll':
      return action.dirs
    case 'expandTo': {
      const missing = ancestorDirs(action.root, action.file).filter((d) => !expanded.includes(d))
      return missing.length === 0 ? expanded : [...expanded, ...missing]
    }
  }
}

/**
 * Directories strictly between `root` and `file` (root excluded), outermost first, in the root's own
 * separator. Windows takes `/` as a separator too, so the `${dir}/x` synthetic child opens a folder there.
 */
export function ancestorDirs(root: string, file: string): string[] {
  if (!isWithin(root, file, true)) return []
  const sep = sepOf(root)
  let cur = trimSep(root)
  const parts = file.slice(cur.length + 1).split(sep === '/' ? '/' : /[\\/]/)
  const dirs: string[] = []
  for (const part of parts.slice(0, -1)) {
    cur = `${cur}${sep}${part}`
    dirs.push(cur)
  }
  return dirs
}

/** Every directory in `tree`, at every depth, outer before inner — the expand-all set (YAZ-862). */
export function allDirs(tree: TreeNode[]): string[] {
  return tree.flatMap((n) => (n.type === 'dir' ? [n.path, ...allDirs(n.children)] : []))
}

/** True when `path` is a file somewhere in `tree`. */
export function treeHasFile(tree: TreeNode[], path: string): boolean {
  return tree.some((n) => (n.type === 'file' ? n.path === path : treeHasFile(n.children, path)))
}

/** File OR folder: what the multi-select may hold (YAZ-1578, 🔒 D1), so its prune asks this one. */
export function treeHasPath(tree: TreeNode[], path: string): boolean {
  return tree.some((n) => n.path === path || (n.type === 'dir' && treeHasPath(n.children, path)))
}

/** The dir node at `path`, any depth — Focus Mode's root (YAZ-1605); null once the tree no longer holds it. */
export function findDirNode(tree: readonly TreeNode[], path: string): TreeNode | null {
  for (const n of tree) {
    if (n.type !== 'dir') continue
    if (n.path === path) return n
    if (isWithin(n.path, path, true)) return findDirNode(n.children, path)
  }
  return null
}

/** The node at `path`, file OR dir, any depth — `findDirNode`'s kind-agnostic twin for the Favorites list (YAZ-1766); null once the tree no longer holds it. */
export function findNode(tree: readonly TreeNode[], path: string): TreeNode | null {
  for (const n of tree) {
    if (n.path === path) return n
    if (n.type === 'dir' && isWithin(n.path, path, true)) return findNode(n.children, path)
  }
  return null
}

/**
 * The Favorites tab's top rows (YAZ-1766 D4): every favorite the tree still holds, in the list's
 * STORED order — the user's order, never the tree's — files and dirs alike. NOT `focusRoots`:
 * nesting is kept (a file favorited beside its favorited parent shows at the root AND inside it),
 * and a vanished path simply yields no row; the Sidebar prunes it from the stored list.
 */
export function favoriteRoots(tree: readonly TreeNode[], favorites: readonly string[]): TreeNode[] {
  return favorites.flatMap((p) => findNode(tree, p) ?? [])
}

/**
 * Focus Mode's top rows (YAZ-1605): every dir in `focus`, in TREE order, OUTERMOST only — a focused
 * dir inside another focused dir is drawn once, under its parent, never twice. A vanished path
 * simply yields no row; the Sidebar prunes it from the stored list.
 */
export function focusRoots(tree: readonly TreeNode[], focus: readonly string[]): TreeNode[] {
  return tree.flatMap((n) => (n.type !== 'dir' ? [] : focus.includes(n.path) ? [n] : focusRoots(n.children, focus)))
}

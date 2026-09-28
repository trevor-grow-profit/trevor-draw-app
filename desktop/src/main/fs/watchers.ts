import path from 'node:path'
import type { WatchEvent } from '@shared/types'
import { isSkipped } from './fsUtils'
import { watchTree, type TreeWatcher } from './treeWatcher'

type Listener = (ev: WatchEvent) => void

interface Entry {
  watcher: TreeWatcher
  listeners: Set<Listener>
  ready: boolean
}

/** One watcher per root (`treeWatcher.ts`), shared by every window; closed when the last subscriber leaves. */
const entries = new Map<string, Entry>()

export function activeWatcherRoots(): string[] {
  return [...entries.keys()]
}

/** Dot-entries and `node_modules` at any depth; every regular file is watched, viewer or not (YAZ-1577 D1). */
function ignored(root: string, p: string): boolean {
  const rel = path.relative(root, p)
  return rel !== '' && rel.split(path.sep).some(isSkipped)
}

function createEntry(root: string): Entry {
  const watcher = watchTree(root, { ignored: (p) => ignored(root, p) })
  const entry: Entry = { watcher, listeners: new Set(), ready: false }
  const emit = (ev: WatchEvent) => entry.listeners.forEach((l) => l(ev))
  watcher
    .on('ready', () => {
      entry.ready = true
      emit({ type: 'ready', root })
    })
    .on('add', (p, stats) => emit({ type: 'add', path: p, mtime: stats.mtimeMs }))
    .on('change', (p, stats) => emit({ type: 'change', path: p, mtime: stats.mtimeMs }))
    .on('unlink', (p) => emit({ type: 'unlink', path: p }))
    .on('addDir', (p) => emit({ type: 'addDir', path: p }))
    .on('unlinkDir', (p) => emit({ type: 'unlinkDir', path: p }))
    .on('error', (err) => emit({ type: 'error', message: err instanceof Error ? err.message : String(err) }))
  return entry
}

/** Subscribes to events under `root`; returns an unsubscribe fn. Late joiners get `ready` immediately. */
export function subscribe(root: string, listener: Listener): () => void {
  let entry = entries.get(root)
  if (entry === undefined) {
    entry = createEntry(root)
    entries.set(root, entry)
  }
  entry.listeners.add(listener)
  if (entry.ready) listener({ type: 'ready', root })
  return () => {
    entry.listeners.delete(listener)
    if (entry.listeners.size === 0 && entries.get(root) === entry) {
      entries.delete(root)
      void entry.watcher.close()
    }
  }
}

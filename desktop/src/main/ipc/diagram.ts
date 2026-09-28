/**
 * The diagram document's IPC (🔒 YAZ-1802 D6): `fs/diagram.ts` behind the standard envelope, and
 * nothing else. No store repair and no broadcast, for `ipc/drawing.ts`'s reason: a save changes
 * bytes at a path every window already knows, and the shared watcher tells the others.
 */
import { CONTRACT } from '@shared/ipc'
import { loadDiagram, saveDiagram } from '../fs/diagram'
import { handle } from './envelope'

export function registerDiagramIpc(): void {
  handle(CONTRACT.diagram.load, loadDiagram)
  handle(CONTRACT.diagram.save, saveDiagram)
}

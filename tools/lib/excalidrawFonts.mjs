/**
 * The Excalidraw package's `fonts/` tree, wherever npm hoisted it — the repo root first, then the
 * client workspace: `shared/excalidrawFonts.ts`'s rule, restated because node runs the tools with no
 * TypeScript step (`excalidrawFonts.test.mjs` holds the two to the same answer). The one lookup for
 * the tools: the draw.io pack, the fake Cloudflare and the share-viewer suite.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = fileURLToPath(new URL('../..', import.meta.url))

export function excalidrawFontsDir() {
  for (const base of [REPO, join(REPO, 'client')]) {
    const dir = join(base, 'node_modules/@excalidraw/excalidraw/dist/prod/fonts')
    if (existsSync(dir)) return dir
  }
  throw new Error('@excalidraw/excalidraw fonts not found — run `npm install`')
}

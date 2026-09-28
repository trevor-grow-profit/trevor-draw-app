#!/usr/bin/env node
/**
 * USAGE: node tools/buildShareViewer.mjs   (also the last step of `npm run build`)
 *
 * Builds the share viewer's static assets (YAZ-1799) into `share/dist/assets/`:
 *   viewer.js   — share/viewer/entry.js + React + the app's own vendored Excalidraw, one ES module
 *   viewer.css  — Excalidraw's stylesheet
 *   diagram.js  — share/viewer/diagram.js, a shared draw.io diagram's viewer (🔒 YAZ-1802 D11)
 *   drawio/…    — our part of what it runs: `config.js` (share/viewer/drawioConfig.js) and a
 *                 `fonts.css` for the fonts the diagram editor offers first, from /assets/fonts/.
 * Two things the viewer fetches are NOT copied here, so the app never carries those bytes twice:
 * Excalidraw's fonts (`/assets/fonts/…`, YAZ-2073 3C) and draw.io's own files (its viewer, stencils,
 * licence — `DRAWIO_SHARE_FILES`, 🔒 YAZ-1802 D5). Share setup publishes both from the app's own
 * copies (`readViewerAssets` in `desktop/src/main/ipc/share.ts`).
 * The app ships this folder (extraResources → `share-viewer`) and uploads it as the share Worker's
 * static assets during setup; `tools/fakeCloudflare.mjs` serves it in the demo. Nothing comes from a CDN at view time.
 *
 * React is pinned to the client's copy for the same reason `electron.vite.config.ts` dedupes it:
 * npm hoists a second, older React to the repo root.
 */
import { build } from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DRAWIO_TAG } from './packDrawio.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(REPO, 'share', 'dist', 'assets')
const DRAWIO = path.join(REPO, 'desktop', '.cache', 'drawio', DRAWIO_TAG)
/**
 * `drawio/fonts.css`: the diagram editor's own font sheet (packDrawio's), re-pointed from the app's
 * drawio origin at the same font files share setup publishes under `/assets/fonts/`.
 */
export const diagramFontCss = () => fs.readFileSync(path.join(DRAWIO, 'yaseen-fonts', 'fonts.css'), 'utf8').replaceAll('app://drawio/yaseen-fonts/', '/assets/fonts/')
const pkgDir = (name) => {
  for (const base of [path.join(REPO, 'client', 'node_modules'), path.join(REPO, 'node_modules')]) {
    const dir = path.join(base, name)
    if (fs.existsSync(dir)) return dir
  }
  throw new Error(`${name} not found — run npm install`)
}

async function main() {
  if (!fs.existsSync(path.join(DRAWIO, 'yaseen-fonts', 'fonts.css'))) throw new Error(`draw.io ${DRAWIO_TAG} is not unpacked at ${DRAWIO} — run \`npm run drawio:pack\``)
  fs.rmSync(path.join(REPO, 'share', 'dist'), { recursive: true, force: true })
  fs.mkdirSync(OUT, { recursive: true })
  const result = await build({
    entryPoints: { viewer: path.join(REPO, 'share', 'viewer', 'entry.js'), diagram: path.join(REPO, 'share', 'viewer', 'diagram.js') },
    bundle: true,
    format: 'esm',
    // Lazy features (Mermaid, code editor, …) stay separate chunks, fetched only if a viewer ever needs them.
    splitting: true,
    chunkNames: 'chunks/[name]-[hash]',
    assetNames: 'files/[name]-[hash]',
    minify: true,
    // As Vite does: esbuild's default ASCII escaping inflated the 54 locale chunks by ~0.65 MB (YAZ-2073 3C).
    charset: 'utf8',
    target: 'es2022',
    conditions: ['production'],
    outdir: OUT,
    alias: { react: pkgDir('react'), 'react-dom': pkgDir('react-dom') },
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env.DEV': 'false', 'import.meta.env.PROD': 'true' },
    loader: { '.woff2': 'file', '.png': 'dataurl', '.svg': 'dataurl' },
    logLevel: 'warning',
    metafile: true,
  })
  fs.mkdirSync(path.join(OUT, 'drawio'))
  fs.cpSync(path.join(REPO, 'share', 'viewer', 'drawioConfig.js'), path.join(OUT, 'drawio', 'config.js'))
  fs.writeFileSync(path.join(OUT, 'drawio', 'fonts.css'), diagramFontCss())
  const size = (f) => `${(fs.statSync(path.join(OUT, f)).size / 1e6).toFixed(2)} MB`
  console.log(`built ${path.relative(REPO, OUT)}: viewer.js ${size('viewer.js')}, viewer.css ${size('viewer.css')}, diagram.js ${size('diagram.js')}, drawio/ config written (${Object.keys(result.metafile.outputs).length} outputs)`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main()

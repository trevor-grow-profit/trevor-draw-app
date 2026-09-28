import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'
import { createReadStream, existsSync, readFileSync } from 'node:fs'
import { cp, mkdir, rename, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
// Relative, not `@shared`: this file runs in Node before any alias exists.
import { DRAWIO_TAG } from '../shared/drawio'

const here = fileURLToPath(new URL('.', import.meta.url))
const shared = resolve(here, '../shared')
const client = resolve(here, '../client')
const rendererOut = resolve(here, 'out/renderer')

/** Where the renderer expects Excalidraw's assets (mirrors `EXCALIDRAW_ASSET_DIR` in renderScene.ts). */
const EXCALIDRAW_ASSET_DIR = 'excalidraw-assets'

/** The package's own `fonts/` tree, wherever npm hoisted the workspace dependency. */
function excalidrawFontsDir(): string {
  for (const base of [resolve(here, '..'), client]) {
    const dir = resolve(base, 'node_modules/@excalidraw/excalidraw/dist/prod/fonts')
    if (existsSync(dir)) return dir
  }
  throw new Error('@excalidraw/excalidraw fonts not found — run `npm install`')
}

/**
 * Excalidraw's fonts under the renderer's OWN origin (YAZ-878, 🔒 the locked offline rule).
 *
 * A drawing preview with text elements makes Excalidraw fetch its woff2 files; unless
 * `window.EXCALIDRAW_ASSET_PATH` points somewhere that ANSWERS, the library falls back to its
 * esm.sh CDN. So the package's own folder is copied beside the renderer bundle at build time
 * (`app://yaseen/excalidraw-assets/fonts/…`, served by main's `app` protocol handler and picked
 * up by electron-builder's `out/**`) and served from node_modules in dev — the bytes are never
 * committed. Text-free scenes fetch nothing at all.
 */
function excalidrawAssets(): Plugin {
  const fonts = excalidrawFontsDir()
  const prefix = `/${EXCALIDRAW_ASSET_DIR}/fonts/`
  return {
    name: 'yaseen-excalidraw-assets',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? '').split('?')[0]
        if (!url.startsWith(prefix)) return next()
        const file = resolve(fonts, decodeURIComponent(url.slice(prefix.length)))
        if (!file.startsWith(`${fonts}/`) || !existsSync(file)) return next()
        res.setHeader('Content-Type', 'font/woff2')
        createReadStream(file).pipe(res)
      })
    },
    async writeBundle() {
      await cp(fonts, resolve(rendererOut, EXCALIDRAW_ASSET_DIR, 'fonts'), { recursive: true })
    },
  }
}

/**
 * The draw.io webapp beside the renderer bundle (🔒 YAZ-1802 D5), `excalidrawAssets()`'s twin:
 * `tools/packDrawio.mjs` has unpacked the pinned release into the gitignored cache, and this copies
 * it into `out/drawio` when the bundle is written, where main serves it as `app://drawio/…` and
 * electron-builder's `out/**` carries it into the app. Dev needs no copy — main serves the cache
 * directly (`resolveDrawioDir`). The bytes are never committed.
 *
 * `out/drawio` sits outside the renderer's `outDir`, so nothing else empties it: it is replaced
 * whole, or a bumped release would keep the old one's files. It is pruned to what the editor, the
 * picture page and the share viewer load (🔒 YAZ-1802 D5, `tools/lib/drawioPack.mjs`);
 * share setup uploads the share viewer's draw.io files from this same copy (`readViewerAssets`).
 */
function drawioAssets(): Plugin {
  const cache = resolve(here, '.cache/drawio', DRAWIO_TAG)
  const target = resolve(here, 'out/drawio')
  return {
    name: 'yaseen-drawio-assets',
    apply: 'build',
    async writeBundle() {
      if (!existsSync(resolve(cache, 'index.html'))) throw new Error(`draw.io ${DRAWIO_TAG} is not unpacked at ${cache} — run \`npm run drawio:pack\``)
      await rm(target, { recursive: true, force: true })
      await cp(cache, target, { recursive: true })
    },
  }
}

/**
 * The renderer's sourcemaps, OUT of the app (🔒 YAZ-2073 D14): the build is minified and writes
 * `sourcemap: 'hidden'` maps (no `sourceMappingURL` comment), and this moves every `.map` of the
 * bundle from `outDir` to `mapsDir` the moment it is written — so electron-builder's `out/**` never
 * packs them, and a minified stack trace can still be symbolicated locally. `mapsDir` is replaced
 * whole per build, like `out/drawio`.
 */
export function renderSourcemapsAside(outDir: string, mapsDir: string): Plugin {
  return {
    name: 'yaseen-sourcemaps-aside',
    apply: 'build',
    async writeBundle(_options, bundle) {
      await rm(mapsDir, { recursive: true, force: true })
      for (const file of Object.keys(bundle).filter((f) => f.endsWith('.map'))) {
        await mkdir(dirname(resolve(mapsDir, file)), { recursive: true })
        await rename(resolve(outDir, file), resolve(mapsDir, file))
      }
    },
  }
}

/** Kept per shipped version (the ROOT package.json's, which `tools/packDesktop.mjs` stamps in), gitignored. */
const { version } = JSON.parse(readFileSync(resolve(here, '../package.json'), 'utf8')) as { version: string }
const mapsDir = resolve(here, '.maps', version)

export default defineConfig({
  main: {
    // Every dependency is bundled into `out/main` (chokidar 4 is pure JS), so the packaged app ships
    // no node_modules at all (GRO-2151). `externalizeDeps` defaults to ON in electron-vite and
    // externalizes `desktop/package.json`'s `dependencies`, so it is off here and chokidar is a
    // devDependency; `tools/mainBundle.test.mjs` fails if the bundle requires anything but Node
    // built-ins and electron (YAZ-2073 3E).
    resolve: { alias: { '@shared': shared } },
    build: { externalizeDeps: false, rollupOptions: { input: { index: resolve(here, 'src/main/index.ts') } } },
  },
  preload: {
    resolve: { alias: { '@shared': shared } },
    build: { externalizeDeps: false, rollupOptions: { input: resolve(here, 'src/preload/index.ts') } },
  },
  renderer: {
    root: client,
    plugins: [react(), excalidrawAssets(), drawioAssets(), renderSourcemapsAside(rendererOut, mapsDir)],
    resolve: {
      alias: { '@shared': shared },
      /**
       * 🔒 ONE React in the renderer (YAZ-879). npm hoists a SECOND, older `react` to the repo
       * root (a transitive peer of the Excalidraw tree), and `@excalidraw/excalidraw` lives up
       * there too — so without this its bundle carried its own React while `client/` used 19.x,
       * and the first `<Excalidraw>` mount died on a null dispatcher — the React "useEffect of
       * null" crash. Invisible until now only because YAZ-878's previews call `exportToSvg` and
       * render no components at all.
       */
      dedupe: ['react', 'react-dom'],
    },
    // electron-vite 5 leaves the renderer unminified; Vite's esbuild minifier cuts its JS + CSS
    // 14.7 → 9.4 MB and the entry chunk every window parses 973 → 413 KB (YAZ-2073 D14).
    build: { outDir: rendererOut, minify: 'esbuild', sourcemap: 'hidden', rollupOptions: { input: resolve(client, 'index.html') } },
  },
})

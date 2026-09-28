#!/usr/bin/env node
/**
 * USAGE: node tools/packDrawio.mjs [--war <path>] [--force]
 *
 *   --war    use an already-downloaded `draw.war` instead of fetching it (still size- and
 *            sha256-checked, so a wrong file cannot sneak in)
 *   --force  unpack again even when the cache already holds this release
 *
 * Verifies, unpacks and prunes the pinned draw.io webapp into the gitignored
 * `desktop/.cache/drawio/<tag>/`, then lays our overlay and fonts over it (🔒 YAZ-1802 D5 / D12a —
 * the rules and why: `tools/lib/drawioPack.mjs`). Idempotent; the overlay is re-laid on every run.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isUnpacked, layOverlay, unpackWebapp, verifyArchive } from './lib/drawioPack.mjs'
import { excalidrawFontsDir } from './lib/excalidrawFonts.mjs'

/** 🔒 YAZ-1802 D5: the pinned release. Keep in step with `DRAWIO_TAG` in `desktop/src/main/drawio/assets.ts` (`packDrawio.test.mjs` pins the pair). */
export const DRAWIO_TAG = 'v31.5.2'
export const WAR_URL = `https://github.com/jgraph/drawio/releases/download/${DRAWIO_TAG}/draw.war`
export const WAR_BYTES = 53_946_815
/** Computed on the first download of the v31.5.2 asset (2026-09-23); a different archive under the same URL is refused. */
export const WAR_SHA256 = 'abd58ad15baef57f43acb79a56350ba8900a8b6fabe94391d8906148fe64e264'
const PIN = { tag: DRAWIO_TAG, bytes: WAR_BYTES, sha256: WAR_SHA256 }

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..')
const CACHE_ROOT = join(repo, 'desktop', '.cache', 'drawio')
const WEBAPP_DIR = join(CACHE_ROOT, DRAWIO_TAG)
const OVERLAY_DIR = join(repo, 'desktop', 'drawio-overlay')

/** The archive's bytes, verified: `--war`, else the cached copy, else a fresh download (then cached). */
async function warBytes(warArg) {
  const cached = join(CACHE_ROOT, `draw-${DRAWIO_TAG}.war`)
  let bytes
  if (warArg) bytes = readFileSync(resolve(warArg))
  else if (existsSync(cached)) bytes = readFileSync(cached)
  else {
    console.log(`[drawio] downloading ${WAR_URL} (${(WAR_BYTES / 1e6).toFixed(1)} MB)…`)
    const res = await fetch(WAR_URL)
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status} for ${WAR_URL}`)
    bytes = Buffer.from(await res.arrayBuffer())
  }
  verifyArchive(bytes, PIN)
  if (!existsSync(cached)) {
    mkdirSync(CACHE_ROOT, { recursive: true })
    writeFileSync(cached, bytes)
  }
  return bytes
}

async function main() {
  const args = process.argv.slice(2)
  const warIdx = args.indexOf('--war')
  const warArg = warIdx === -1 ? undefined : args[warIdx + 1]
  if (args.includes('--force') || !isUnpacked(WEBAPP_DIR, PIN)) {
    const written = unpackWebapp(await warBytes(warArg), WEBAPP_DIR, PIN)
    console.log(`[drawio] unpacked ${written} files into ${WEBAPP_DIR}`)
  }
  layOverlay(WEBAPP_DIR, OVERLAY_DIR, excalidrawFontsDir())
  console.log(`[drawio] ${DRAWIO_TAG} ready at ${WEBAPP_DIR}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(`[drawio] ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  })
}

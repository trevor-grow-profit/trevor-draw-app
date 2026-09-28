import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { builtinModules } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveConfig } from 'electron-vite'
import { build } from 'vite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * THE PACKAGED APP SHIPS NO node_modules (GRO-2151, YAZ-2073 3E). electron-builder copies
 * `desktop/package.json`'s `dependencies` into `app.asar`, and electron-vite externalizes exactly
 * those by default — so a runtime dependency there would be `require`d from an asar `node_modules`
 * rather than bundled. This builds main and preload with the real `electron.vite.config.ts` and
 * holds both halves: nothing is left to install, and the bundle loads nothing but Node built-ins,
 * electron and its own chunks.
 */
const DESKTOP = fileURLToPath(new URL('../desktop', import.meta.url))
const BUILTIN = new Set([...builtinModules, 'electron'])

let out
beforeAll(async () => {
  out = await mkdtemp(path.join(tmpdir(), 'yaseendraw-main-bundle-'))
  // electron-vite reads the `dependencies` it externalizes from the CWD's package.json, as `npm run build -w desktop` sees it.
  const cwd = process.cwd()
  process.chdir(DESKTOP)
  try {
    const { config } = await resolveConfig({ logLevel: 'silent', build: { outDir: out } }, 'build', 'production')
    await build(config.main)
    await build(config.preload)
  } finally {
    process.chdir(cwd)
  }
}, 120_000)
afterAll(() => rm(out, { recursive: true, force: true }))

/** Every module specifier a built (CommonJS) file loads, by `require('…')` or `import('…')`. */
async function specifiers(dir) {
  const found = new Set()
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !/\.[cm]?js$/.test(entry.name)) continue
    const code = await readFile(path.join(entry.parentPath, entry.name), 'utf8')
    for (const m of code.matchAll(/\b(?:require|import)\(\s*["'`]([\w@./:-]+)["'`]\s*\)/g)) found.add(m[1])
  }
  return [...found]
}

describe('the main-process bundle', () => {
  it('declares no runtime dependencies for electron-builder to pack', async () => {
    const pkg = JSON.parse(await readFile(path.join(DESKTOP, 'package.json'), 'utf8'))
    expect(pkg.dependencies ?? {}).toEqual({})
  })

  it('loads only Node built-ins, electron and its own chunks — chokidar is inside it', async () => {
    const loaded = await specifiers(out)
    expect(loaded.length).toBeGreaterThan(0)
    const bare = loaded.filter((s) => !s.startsWith('.') && !s.startsWith('node:') && !BUILTIN.has(s.split('/')[0]))
    expect(bare).toEqual([])
    expect(loaded).not.toContain('chokidar')
  })
})

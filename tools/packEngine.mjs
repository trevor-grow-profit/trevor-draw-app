#!/usr/bin/env node
/**
 * USAGE: node tools/packEngine.mjs [--fork <path>] [--commit <sha>] [--use <dir>]
 *
 * Bumps the vendored drawing engine to a fork commit in one command.
 *
 * AFTER A BUMP, RUN `npm test`: `client/src/drawings/engineSelectors.test.ts` pins the engine-owned
 * class names this app reaches into (the presenting-chrome block in
 * `client/src/drawings/presentation/presentation.css`, the sidebar rules in
 * `client/src/drawings/drawingEditor.css`) and goes red when the fork renames one.
 *
 *   --fork    the yaseen-excalidraw checkout (default: ~/Documents/GitHub/yaseen-excalidraw)
 *   --commit  the commit the fork must be sitting on (default: whatever HEAD is)
 *   --use     a directory of already-built `yaseendraw-*-<hash>.tgz` to copy instead of
 *             rebuilding — the filenames must carry <hash>, so a stale build cannot sneak in
 *
 * What it does: verifies the fork is clean and at the commit, `yarn install`s it, runs
 * `build:esm` and `npm pack` for each of the five packages, renames each tarball with the
 * short fork hash, deletes the previous set from `client/vendor/`, repoints the five `file:`
 * dependencies in `client/package.json`, rewrites every matching `resolved`/`integrity` in
 * `package-lock.json`, restores the fork's `yarn.lock` (its `yarn install` rewrites it), and
 * asserts no reference to an older fork hash survives.
 *
 * Two traps this exists to defuse — see `tools/lib/packEngine.mjs` and `client/vendor/README.md`:
 *  1. npm keys `file:` deps on content integrity, so a byte-identical package keeps its old
 *     `resolved` path pointing at a tarball this script just deleted.
 *  2. `yarn install` in the fork dirties `yarn.lock`; the fork must be left clean.
 *
 * The only things it touches inside the fork are `yarn install`, `build:esm` and `npm pack`.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ENGINE_PACKAGES,
  buildEngineMap,
  findStaleTarballRefs,
  packedName,
  parseArgs,
  rewriteClientPackageJson,
  rewriteLockfile,
  selectPrebuilt,
  significantStatusLines,
  tarballName,
} from './lib/packEngine.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const vendor = join(root, 'client', 'vendor')

const run = (cmd, args, cwd, capture = false) =>
  execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit' })
const git = (cwd, ...args) => run('git', args, cwd, true).trim()
const step = (msg) => console.log(`\n→ ${msg}`)

let args
try {
  args = parseArgs(process.argv.slice(2))
} catch (err) {
  console.error(`${err.message}\nusage: node tools/packEngine.mjs [--fork <path>] [--commit <sha>] [--use <dir>]`)
  process.exit(2)
}

const fork = args.fork ?? join(homedir(), 'Documents', 'GitHub', 'yaseen-excalidraw')

// --- 1. the fork must be clean and on the commit we are about to stamp into filenames -----
step(`checking fork at ${fork}`)
const head = git(fork, 'rev-parse', 'HEAD')
const hash = git(fork, 'rev-parse', '--short', 'HEAD')
if (args.commit && !head.startsWith(args.commit) && !args.commit.startsWith(hash)) {
  console.error(`fork HEAD is ${hash} (${head}), not ${args.commit} — check it out first`)
  process.exit(1)
}
const dirty = significantStatusLines(git(fork, 'status', '--porcelain'))
if (dirty.length) {
  console.error(`fork working tree is dirty; a build here would not match ${hash}:\n${dirty.join('\n')}`)
  process.exit(1)
}
console.log(`  fork commit: ${hash} (${head})`)
console.log(`  ${git(fork, 'log', '-1', '--pretty=%s')}`)

// --- 2. produce one tarball per package, either by building or by copying a proven set ----
const built = []
if (args.use) {
  step(`copying prebuilt tarballs from ${args.use}`)
  const names = readdirSync(args.use)
  for (const pkg of ENGINE_PACKAGES) {
    const hit = selectPrebuilt(names, pkg, hash)
    copyFileSync(join(args.use, hit.name), join(vendor, hit.name))
    built.push({ pkg, version: hit.version, hash })
    console.log(`  ${hit.name}`)
  }
} else {
  step('yarn install in the fork')
  run('yarn', ['install'], fork)

  const stage = mkdtempSync(join(tmpdir(), 'packEngine-'))
  try {
    for (const pkg of ENGINE_PACKAGES) {
      step(`building ${pkg}`)
      run('yarn', ['--cwd', `./packages/${pkg}`, 'build:esm'], fork)
      const pkgDir = join(fork, 'packages', pkg)
      const { version } = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
      run('npm', ['pack', '--pack-destination', stage], pkgDir)
      const name = tarballName(pkg, version, hash)
      copyFileSync(join(stage, packedName(pkg, version)), join(vendor, name))
      built.push({ pkg, version, hash })
      console.log(`  packed ${name}`)
    }
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
}

// npm records the sha512 of the tarball bytes as the `file:` dep's integrity; computing it
// here is what lets `npm ci` run straight after the bump instead of needing an `npm install`.
const entries = built.map(({ pkg, version }) => {
  const name = tarballName(pkg, version, hash)
  const bytes = readFileSync(join(vendor, name))
  return { pkg, version, hash, integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}` }
})
const engineMap = buildEngineMap(entries)
const keep = new Set(Object.values(engineMap).map((i) => i.name))

// --- 3. drop the previous set -------------------------------------------------------------
step('removing superseded tarballs')
for (const name of readdirSync(vendor)) {
  if (name.startsWith('yaseendraw-') && name.endsWith('.tgz') && !keep.has(name)) {
    unlinkSync(join(vendor, name))
    console.log(`  removed ${name}`)
  }
}

// --- 4. repoint client/package.json and the lockfile ---------------------------------------
step('rewriting client/package.json')
const clientPkgPath = join(root, 'client', 'package.json')
const clientPkg = JSON.parse(readFileSync(clientPkgPath, 'utf8'))
rewriteClientPackageJson(clientPkg, engineMap)
writeFileSync(clientPkgPath, `${JSON.stringify(clientPkg, null, 2)}\n`)

step('rewriting package-lock.json')
const lockPath = join(root, 'package-lock.json')
const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
const edits = rewriteLockfile(lock, engineMap)
for (const [name, count] of Object.entries(edits)) {
  if (count === 0) throw new Error(`package-lock.json had nothing to rewrite for ${name} — is it in sync?`)
  console.log(`  ${name}: ${count} entr${count === 1 ? 'y' : 'ies'}`)
}
writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`)

// --- 5. the assertion the whole script exists for ------------------------------------------
step('checking for references to older fork builds')
for (const file of [lockPath, clientPkgPath]) {
  const stale = findStaleTarballRefs(readFileSync(file, 'utf8'), hash)
  if (stale.length) throw new Error(`${file} still references ${stale.join(', ')}`)
}
console.log(`  clean — every yaseendraw-*.tgz reference is at ${hash}`)

// --- 6. leave the fork exactly as we found it ----------------------------------------------
step('restoring the fork')
git(fork, 'checkout', '--', 'yarn.lock')
const left = significantStatusLines(git(fork, 'status', '--porcelain'))
if (left.length) throw new Error(`fork is still dirty after restore:\n${left.join('\n')}`)
console.log('  fork working tree is clean')

console.log(`
Engine repacked at ${hash}:`)
for (const info of Object.values(engineMap)) console.log(`  client/vendor/${info.name}`)
console.log(`
Next: stop any dev server (npm ci wipes node_modules under a running process), then

  npm ci
  grep -c writingMode "$(npm ls @excalidraw/excalidraw -w client --parseable | tail -1)/dist/prod/index.js"

The grep must print a number greater than 0 — that is the Writing mode support living in
the built engine. A 0 (or "No such file") means the tarballs are not the build you think.
The \`npm ls\` detour is deliberate: npm hoists the engine to the workspace root, so the
package is at ./node_modules/@excalidraw/excalidraw, not under client/.
`)

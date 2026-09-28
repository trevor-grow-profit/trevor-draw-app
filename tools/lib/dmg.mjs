/**
 * The Mac download's last step (YAZ-2073 3A), after electron-builder: `tools/packDesktop.mjs --mac`.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, renameSync, rmdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** The dmg electron-builder wrote: `build.dmg.artifactName` in `desktop/package.json`, filled in. */
export function dmgPath(desktopDir, build, version) {
  const name = build.dmg.artifactName.replaceAll('${productName}', build.productName).replaceAll('${version}', version)
  return join(desktopDir, build.directories.output, name)
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

/**
 * `hdiutil detach`, retried: Spotlight or fseventsd can hold a just-mounted volume for a moment
 * ("Resource busy"), so a busy detach waits a second and tries again, the last time with `-force`.
 */
export function detach(mount, run, { tries = 3, waitMs = 1_000 } = {}) {
  for (let i = 1; ; i++) {
    try {
      return run('hdiutil', ['detach', mount, ...(i === tries ? ['-force'] : [])])
    } catch (err) {
      if (i === tries) throw err
      sleep(waitMs)
    }
  }
}

/**
 * Recompresses the dmg zlib (UDZO) → lzma (ULMO): about a fifth smaller (172 → 139 MB at 0.1.11)
 * with the same volume, layout and ad-hoc-signed app — `hdiutil convert` copies the filesystem, it
 * never touches the bundle. electron-builder's `dmg.format` enum has no ULMO, hence a post-step.
 * ULMO opens on macOS 10.15+; Electron 43 already needs 12. The new image is mounted (which checks
 * its checksum) and its app's seal verified BEFORE it replaces the old one, so a bad conversion
 * fails the build and leaves electron-builder's image as it was. The `.blockmap` described the zlib image and
 * nothing reads it (no auto-updater), so it goes.
 */
export function lzmaDmg(dmg, appName) {
  const tmp = `${dmg}.ulmo.dmg`
  const mount = mkdtempSync(join(tmpdir(), 'yaseen-dmg-'))
  const run = (cmd, args) => execFileSync(cmd, args, { stdio: ['ignore', 'ignore', 'inherit'] })
  try {
    rmSync(tmp, { force: true })
    run('hdiutil', ['convert', dmg, '-format', 'ULMO', '-o', tmp])
    run('hdiutil', ['attach', tmp, '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mount])
    try {
      run('codesign', ['--verify', '--deep', '--strict', join(mount, appName)])
    } finally {
      detach(mount, run)
    }
    renameSync(tmp, dmg)
    rmSync(`${dmg}.blockmap`, { force: true })
  } finally {
    rmSync(tmp, { force: true })
    rmdirSync(mount) // empty once detached; never recursive, which would empty a volume still mounted there
  }
}

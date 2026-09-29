#!/usr/bin/env node
/**
 * USAGE: node tools/packDesktop.mjs --mac | --win
 *
 * Runs electron-builder in desktop/ with the ROOT package.json version stamped in
 * (-c.extraMetadata.version). A script that wrote `$npm_package_version` only expanded
 * under a Unix shell; on Windows npm runs scripts through cmd.exe and the literal string
 * reached electron-builder ("Invalid major number"). Reading the version here works on both.
 *
 * `--mac` then recompresses the dmg zlib → lzma (`lzmaDmg`, YAZ-2073 3A).
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dmgPath, lzmaDmg } from './lib/dmg.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const { build } = JSON.parse(readFileSync(join(root, 'desktop', 'package.json'), 'utf8'))
const args = process.argv.slice(2)
if (args.length === 0) {
  console.error('usage: node tools/packDesktop.mjs --mac | --win')
  process.exit(2)
}

/**
 * Whether `dir` or an ancestor (up to $HOME) is managed by a macOS File Provider — iCloud Drive's
 * "Desktop & Documents", Google Drive, Dropbox. Such a folder stamps `com.apple.FinderInfo` and
 * `com.apple.fileprovider.*` on every bundle folder electron-builder writes, and codesign's strict
 * verify (the dmg step) refuses the bundle as "resource fork, Finder information, or similar
 * detritus". `xattr -c` cannot hold them off: the provider puts them back.
 */
function underFileProvider(dir) {
  if (process.platform !== 'darwin') return false
  const home = homedir()
  for (let d = resolve(dir); d.startsWith(home) && d !== home; d = dirname(d)) {
    try {
      execFileSync('xattr', ['-p', 'com.apple.file-provider-domain-id', d], { stdio: 'ignore' })
      return true
    } catch {
      /* not this one */
    }
  }
  return false
}

/**
 * Where the packaged app and dmg land: `desktop/dist-app` (electron-builder's `directories.output`),
 * unless `DIST_DIR` says otherwise or the repo sits in a File Provider folder, in which case the
 * build goes to `~/Library/Caches/<productName>/dist-app` — never synced, never stamped.
 */
const distDir =
  process.env.DIST_DIR !== undefined
    ? resolve(process.env.DIST_DIR)
    : underFileProvider(root)
      ? join(homedir(), 'Library', 'Caches', build.productName, build.directories.output)
      : null
if (distDir !== null) console.log(`packaging into ${distDir} (the repo is in a synced folder, or DIST_DIR is set)`)

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
execFileSync(npm, ['exec', '-w', 'desktop', '--', 'electron-builder', ...args, `-c.extraMetadata.version=${version}`, ...(distDir === null ? [] : [`-c.directories.output=${distDir}`])], {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
})
if (args.includes('--mac')) {
  const dmg = distDir === null ? dmgPath(join(root, 'desktop'), build, version) : dmgPath(distDir, { ...build, directories: { output: '.' } }, version)
  lzmaDmg(dmg, `${build.productName}.app`)
  console.log(`lzma dmg: ${dmg}`)
}

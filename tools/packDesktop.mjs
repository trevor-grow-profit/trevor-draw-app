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
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dmgPath, lzmaDmg } from './lib/dmg.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const args = process.argv.slice(2)
if (args.length === 0) {
  console.error('usage: node tools/packDesktop.mjs --mac | --win')
  process.exit(2)
}
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
execFileSync(npm, ['exec', '-w', 'desktop', '--', 'electron-builder', ...args, `-c.extraMetadata.version=${version}`], {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
})
if (args.includes('--mac')) {
  const { build } = JSON.parse(readFileSync(join(root, 'desktop', 'package.json'), 'utf8'))
  const dmg = dmgPath(join(root, 'desktop'), build, version)
  lzmaDmg(dmg, `${build.productName}.app`)
  console.log(`lzma dmg: ${dmg}`)
}

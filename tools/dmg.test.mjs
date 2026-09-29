import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { detach, dmgPath, lzmaDmg } from './lib/dmg.mjs'

describe('dmgPath', () => {
  it("names the dmg electron-builder wrote from desktop/package.json's own build config", () => {
    const { build } = JSON.parse(readFileSync(new URL('../desktop/package.json', import.meta.url), 'utf8'))
    expect(dmgPath('/repo/desktop', build, '0.1.11')).toBe(join('/repo/desktop', 'dist-app', 'Trevor Draw-0.1.11-arm64.dmg'))
  })
})

describe('detach', () => {
  const busy = (failures) => {
    const calls = []
    const run = (cmd, args) => {
      calls.push([cmd, ...args])
      if (calls.length <= failures) throw new Error('hdiutil: detach failed - Resource busy')
    }
    return { calls, run }
  }

  it('retries a busy volume, the last try with -force', () => {
    const { calls, run } = busy(2)
    detach('/mnt', run, { waitMs: 0 })
    expect(calls).toEqual([['hdiutil', 'detach', '/mnt'], ['hdiutil', 'detach', '/mnt'], ['hdiutil', 'detach', '/mnt', '-force']])
  })

  it('stops at the first success, and throws once the forced try fails too', () => {
    const once = busy(0)
    detach('/mnt', once.run, { waitMs: 0 })
    expect(once.calls).toHaveLength(1)
    const stuck = busy(3)
    expect(() => detach('/mnt', stuck.run, { waitMs: 0 })).toThrow(/Resource busy/)
    expect(stuck.calls).toHaveLength(3)
  })
})

/**
 * THE REAL TOOLS on a tiny image (YAZ-2073 3A): one-binary apps, ad-hoc signed like ours, in a zlib
 * dmg the way electron-builder writes it — `Tiny.app` sealed, `Broken.app` changed after signing.
 * Made once; every test converts its own copy. macOS only — `hdiutil` and `codesign` are the point.
 */
describe.skipIf(process.platform !== 'darwin')('lzmaDmg', { timeout: 180_000, retry: 1 }, () => {
  let dir = ''
  let fixture = ''
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'yaz-2073-dmg-'))
    for (const [name, breakSeal] of [['Tiny', false], ['Broken', true]]) {
      const app = join(dir, 'src', `${name}.app`)
      mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true })
      mkdirSync(join(app, 'Contents', 'Resources'))
      copyFileSync('/usr/bin/true', join(app, 'Contents', 'MacOS', name))
      writeFileSync(join(app, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>${name}</string><key>CFBundleIdentifier</key><string>test.${name}</string></dict></plist>`)
      writeFileSync(join(app, 'Contents', 'Resources', 'data.txt'), 'sealed')
      execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'ignore' })
      if (breakSeal) writeFileSync(join(app, 'Contents', 'Resources', 'data.txt'), 'changed after signing')
    }
    fixture = join(dir, 'fixture.dmg')
    const create = () => execFileSync('hdiutil', ['create', '-srcfolder', join(dir, 'src'), '-volname', 'Tiny', '-format', 'UDZO', fixture], { stdio: 'ignore' })
    try {
      create()
    } catch {
      rmSync(fixture, { force: true }) // `hdiutil create` sometimes fails "Resource busy" under a loaded suite; once more
      create()
    }
  }, 180_000) // `hdiutil create` alone takes 4–13 s idle, and far longer beside the rest of the suite
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  const zlibDmg = (test) => {
    const out = join(dir, test)
    mkdirSync(out)
    const dmg = join(out, 'Tiny-1.0.0-arm64.dmg')
    copyFileSync(fixture, dmg)
    writeFileSync(`${dmg}.blockmap`, 'zlib blocks')
    return { out, dmg }
  }
  const format = (dmg) => execFileSync('hdiutil', ['imageinfo', dmg], { encoding: 'utf8' }).match(/Format Description: (.*)/)[1]

  it('replaces the zlib image with an lzma one that mounts with the app sealed, and drops the stale blockmap', () => {
    const { out, dmg } = zlibDmg('ok')
    expect(format(dmg)).toContain('(zlib)')
    lzmaDmg(dmg, 'Tiny.app')
    expect(format(dmg)).toContain('(lzma)')
    expect(readdirSync(out)).toEqual(['Tiny-1.0.0-arm64.dmg'])
  })

  it("refuses an image whose app fails its seal check, leaving electron-builder's image and blockmap as they were", () => {
    const { out, dmg } = zlibDmg('broken')
    expect(() => lzmaDmg(dmg, 'Broken.app')).toThrow()
    expect(readFileSync(dmg).equals(readFileSync(fixture))).toBe(true)
    expect(readdirSync(out).sort()).toEqual(['Tiny-1.0.0-arm64.dmg', 'Tiny-1.0.0-arm64.dmg.blockmap'])
  })
})

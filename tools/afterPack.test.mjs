import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const { trimChromiumLocales } = createRequire(import.meta.url)('../desktop/build/adhocSign.cjs')

describe('trimChromiumLocales (YAZ-2073 D3)', () => {
  let dir = ''
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  const put = (file) => {
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, 'pak')
  }

  it("keeps the framework's English locale folders and every app-level .lproj marker on the Mac", () => {
    dir = mkdtempSync(join(tmpdir(), 'yaz-2073-locales-'))
    const app = join(dir, 'Trevor Draw.app', 'Contents')
    const fw = join(app, 'Frameworks', 'Electron Framework.framework', 'Versions', 'A', 'Resources')
    for (const l of ['en', 'en_GB', 'en_GB_FEMININE', 'de', 'de_FEMININE', 'es_419', 'zh_TW']) put(join(fw, `${l}.lproj`, 'locale.pak'))
    put(join(fw, 'resources.pak'))
    for (const l of ['en', 'de', 'zh_TW']) mkdirSync(join(app, 'Resources', `${l}.lproj`), { recursive: true })
    trimChromiumLocales(dir, 'darwin', 'Trevor Draw')
    expect(readdirSync(fw).sort()).toEqual(['en.lproj', 'en_GB.lproj', 'en_GB_FEMININE.lproj', 'resources.pak'])
    expect(readdirSync(join(app, 'Resources')).sort()).toEqual(['de.lproj', 'en.lproj', 'zh_TW.lproj'])
  })

  it("keeps Windows' English paks only", () => {
    dir = mkdtempSync(join(tmpdir(), 'yaz-2073-locales-'))
    for (const l of ['en-US', 'en-GB', 'de', 'es-419', 'zh-TW']) put(join(dir, 'locales', `${l}.pak`))
    trimChromiumLocales(dir, 'win32', 'Trevor Draw')
    expect(readdirSync(join(dir, 'locales')).sort()).toEqual(['en-GB.pak', 'en-US.pak'])
  })
})

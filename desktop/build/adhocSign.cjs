// electron-builder `afterPack` hook: trim Chromium's locale paks, then ad-hoc sign the packed macOS bundle.
//
// `mac.identity: null` makes electron-builder skip signing entirely, which leaves the app with
// only the linker signature Electron ships on its main binary and NO bundle seal
// (`_CodeSignature/CodeResources`). Gatekeeper reports a downloaded bundle in that state as
// "damaged and can't be opened" instead of the ordinary unidentified-developer prompt with its
// "Open Anyway". A deep ad-hoc signature (`codesign --sign -`) seals every nested binary and the
// resources, needs no certificate, and runs identically on a laptop and on the CI runner.
const { execFileSync } = require('node:child_process')
const { readdirSync, rmSync } = require('node:fs')
const path = require('node:path')

/**
 * Chromium's own UI strings — validation bubbles, file/date/colour pickers — ship in 55 languages
 * (220 `locale.pak`, 48.7 MB on the Mac) inside an app whose UI is English only; this keeps the
 * English ones (YAZ-2073 D3). Framework-side only: the app's own `Contents/Resources/*.lproj` markers
 * stay, so AppKit's Open/Save panels and system menu items still follow the OS language
 * (`electronLanguages` would delete those too). On the Mac it must run BEFORE codesign seals the bundle.
 */
function trimChromiumLocales(appOutDir, platform, productFilename) {
  if (platform === 'darwin') {
    const dir = path.join(appOutDir, `${productFilename}.app`, 'Contents', 'Frameworks', 'Electron Framework.framework', 'Versions', 'A', 'Resources')
    for (const name of readdirSync(dir)) if (name.endsWith('.lproj') && name !== 'en.lproj' && !name.startsWith('en_')) rmSync(path.join(dir, name), { recursive: true })
  } else {
    const dir = path.join(appOutDir, 'locales')
    for (const name of readdirSync(dir)) if (name.endsWith('.pak') && !name.startsWith('en-')) rmSync(path.join(dir, name))
  }
}

module.exports = async function afterPack(context) {
  trimChromiumLocales(context.appOutDir, context.electronPlatformName, context.packager.appInfo.productFilename)
  if (context.electronPlatformName !== 'darwin') return
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  // macOS stamps `com.apple.provenance` (and Finder info) on files some tools write, and codesign's
  // strict verify refuses a bundle carrying any ("resource fork, Finder information, or similar
  // detritus not allowed") — the dmg step verifies exactly that. Strip every extended attribute
  // from the bundle BEFORE sealing it; they carry nothing the app needs.
  execFileSync('xattr', ['-cr', app], { stdio: 'inherit' })
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' })
}
module.exports.trimChromiumLocales = trimChromiumLocales

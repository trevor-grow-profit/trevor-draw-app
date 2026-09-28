#!/usr/bin/env node
/**
 * USAGE: node tools/seedShareDemoVault.mjs --dir <demo-dir> [--port 8787] [--force]
 *
 * The share-link demo (YAZ-1799). Writes, under `<demo-dir>`:
 *   - `Share Button (YAZ-1799)/`  the vault: 13 boards, one per share case, each name saying what it
 *                                 tests, plus a README.md listing the scenarios
 *   - `profile/`                  an isolated Electron profile (`yaseendraw.json`) whose one window is
 *                                 already on the vault. Sharing is NOT set up in it — walk the setup.
 *   - `fake-cloudflare/`          the fake account's disk bucket, pre-seeded so board 10's (and 12's)
 *                                 link works on launch and board 11's is stale
 *   - `start-demo.sh` / `stop-demo.sh`  start / stop the fake Cloudflare + the dev app (HMR)
 *
 * Boards only — nothing here is about any other feature. `--dir` IS REQUIRED AND ITS FOUR
 * CHILDREN ARE WIPED (the `seedDemoVault.mjs` rule): an existing vault is refused without `--force`.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { asset as assetIn, cli, elementKit, embedded, gradientPNG, noisePNG, refuseExisting, scene as sceneOf, solidPNG, stripesPNG, wipe, write as writeIn, writeProfile } from './lib/seedKit.mjs'
import { fileIdFor } from './lib/seedDemoVault.mjs'

const USAGE = 'usage: node tools/seedShareDemoVault.mjs --dir <demo-dir> [--port 8787] [--force]'
const args = cli(USAGE, { '--dir': 'dir', '--port': 'value' }, ['--dir'])
const DIR = args.dir
const PORT = Number(args.port ?? 8787)
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const VAULT = path.join(DIR, 'Share Button (YAZ-1799)')
const PROFILE = path.join(DIR, 'profile')
const FAKE = path.join(DIR, 'fake-cloudflare')
refuseExisting(VAULT, USAGE, { what: 'vault', force: args.force })
wipe(VAULT, PROFILE, FAKE, path.join(DIR, 'logs'))
fs.mkdirSync(VAULT, { recursive: true })

// ---------------------------------------------------------------- Excalidraw elements (seedPreviewDemoVault's)
const { rect, ellipse, diamond, arrow, text, image, frame } = elementKit('s')
const label = (title, sub) => [text(0, -110, title, 32), text(0, -60, sub, 18, { strokeColor: '#868e96' })]

// ---------------------------------------------------------------- writers
const scene = (elements, opts) => sceneOf('yaz-1799-demo', elements, opts)
const write = (rel, content) => writeIn(VAULT, rel, content)
const board = (rel, elements, opts) => write(`${rel}.excalidraw`, scene(elements, opts))
const asset = (bytes) => assetIn(VAULT, bytes)
const fileEntry = (id, bytes) => embedded(id, bytes, { created: 1, lastRetrieved: 1 })

// ---------------------------------------------------------------- 01 simple
board('01 Simple — shapes, arrows and text', [
  ...label('01 Simple board', 'Share it, open the link: the viewer must look exactly like this.'),
  rect(0, 0, 220, 120), ellipse(320, 0, 180, 120), diamond(600, -10, 160, 140),
  arrow(225, 60, 90, 0), arrow(505, 60, 90, 0),
  text(20, 45, 'Idea', 28), text(365, 45, 'Build', 28), text(640, 45, 'Ship', 28),
  text(0, 200, 'Plain text with no container, so PNG export has a caption to render.', 20),
])

// ---------------------------------------------------------------- 02 lean images (assets/)
const lean1 = asset(gradientPNG(480, 320, [255, 107, 107], [77, 171, 247]))
const lean2 = asset(stripesPNG(600, 240))
const lean3 = asset(gradientPNG(1600, 1000, [20, 20, 60], [250, 200, 80]))
board('02 Lean images — pictures live in assets, must arrive embedded', [
  ...label('02 Three images from assets/', 'The vault file holds no bytes; the shared copy must carry all three.'),
  image(0, 0, 480, 320, lean1), image(520, 0, 600, 240, lean2), image(0, 360, 800, 500, lean3),
])

// ---------------------------------------------------------------- 03 legacy (embedded base64)
const legacyA = gradientPNG(300, 300, [40, 200, 120], [250, 250, 250])
const legacyB = solidPNG(200, 200, [230, 73, 128])
const legacyAId = fileIdFor(legacyA)
const legacyBId = fileIdFor(legacyB)
board('03 Legacy — images embedded as base64 in the file itself', [
  ...label('03 Legacy board', 'Images are inside this file (an upstream export). Shared copy keeps them.'),
  image(0, 0, 300, 300, legacyAId), image(340, 50, 200, 200, legacyBId),
], { files: { [legacyAId]: fileEntry(legacyAId, legacyA), [legacyBId]: fileEntry(legacyBId, legacyB) } })

// ---------------------------------------------------------------- 04 big (~45 MB shared)
console.log('writing noise images for 04 and 05 (≈120 MB)…')
const big = [0, 1, 2, 3].map(() => asset(noisePNG(1800, 1560)))
board('04 Big — about 45 MB once shared (slow upload, must succeed)', [
  ...label('04 Big board: four noise images', '≈34 MB of PNG on disk → ≈45 MB once base64-packed. Under the 100 MB cap.'),
  ...big.map((id, i) => image((i % 2) * 940, Math.floor(i / 2) * 820, 900, 780, id)),
])

// ---------------------------------------------------------------- 05 over the limit (~115 MB shared)
const huge = Array.from({ length: 10 }, () => asset(noisePNG(1800, 1600)))
board('05 Too big — about 115 MB once shared (must be refused before upload)', [
  ...label('05 Over the limit: ten noise images', '≈86 MB of PNG → ≈115 MB packed. The app must refuse BEFORE uploading, and say why.'),
  ...huge.map((id, i) => image((i % 5) * 920, Math.floor(i / 5) * 820, 900, 800, id)),
])

// ---------------------------------------------------------------- 06 empty
board('06 Empty — no elements at all', [])

// ---------------------------------------------------------------- 07 deleted images must not ship
const keepA = asset(solidPNG(240, 240, [64, 192, 87]))
const keepB = asset(solidPNG(240, 240, [34, 139, 230]))
const goneABytes = solidPNG(240, 240, [250, 82, 82])
const goneBBytes = gradientPNG(240, 240, [250, 82, 82], [0, 0, 0])
const goneA = asset(goneABytes)
const goneB = asset(goneBBytes)
board('07 Deleted images — the red ones were deleted and must NOT be shipped', [
  ...label('07 Two green/blue images stay; two RED images were deleted', 'Download the shared .excalidraw: its files map must hold exactly 2 images, no red.'),
  image(0, 0, 240, 240, keepA), image(280, 0, 240, 240, keepB),
  image(560, 0, 240, 240, goneA, { isDeleted: true }), image(840, 0, 240, 240, goneB, { isDeleted: true }),
], { files: { [goneA]: fileEntry(goneA, goneABytes), [goneB]: fileEntry(goneB, goneBBytes) } })

// ---------------------------------------------------------------- 08 awkward name
board("08 Tom's “café” board 🎨 — ünïcödé & spaces", [
  ...label("08 Tom's “café” board 🎨", 'The viewer title, the download file names and shares.json must all keep this name intact.'),
  rect(0, 0, 300, 120, '#ffec99'), text(20, 40, 'Ça marche — 日本語 ✓', 26),
])

// ---------------------------------------------------------------- 09 deep nesting
board('Clients/Acme Corp/2026/Q3 workshop/09 Deep nested — four folders down', [
  ...label('09 Deep nested board', 'Clients/Acme Corp/2026/Q3 workshop/ — the shares.json key must be the full relative path.'),
  rect(0, 0, 200, 100, '#d0bfff'), arrow(210, 50, 100, 0), rect(320, 0, 200, 100, '#99e9f2'),
])

// ---------------------------------------------------------------- 10 / 11 / 12: pre-existing share records
const board10 = scene([...label('10 Already shared', 'Its link works the moment the app launches — before you set sharing up.'), rect(0, 0, 260, 120, '#b2f2bb'), text(20, 45, 'shared yesterday', 24)])
write('10 Already shared — link works on launch.excalidraw', board10)
board('11 Stale share — in shares.json but gone from Cloudflare', [
  ...label('11 Stale share', 'shares.json says it is shared; the object is missing on the server. Settings flags it; one save restores it.'),
  ellipse(0, 0, 240, 140, '#ffd8a8'),
])
const board12 = scene([...label('12 Shared, then renamed & moved', 'shares.json still has the OLD path (“12 Renamed — old name”). The link still works.'), diamond(0, 0, 200, 160, '#fcc2d7')])
write('Moved here/12 Renamed after sharing — shares.json has the OLD path.excalidraw', board12)

// ---------------------------------------------------------------- 13 frames + text-heavy
const para = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit.\nSed do eiusmod tempor incididunt ut labore et dolore magna aliqua.\nUt enim ad minim veniam, quis nostrud exercitation ullamco.'
board('13 Frames and lots of text — PNG export check', [
  ...label('13 Frames + text', 'Download PNG in the viewer: frames, their names and every line of text must be in it.'),
  frame(0, 0, 620, 460, 'Agenda'), text(30, 40, 'Agenda', 36), text(30, 110, para, 18), rect(30, 300, 250, 110, '#ffec99'), text(50, 340, 'Decision needed', 22),
  frame(680, 0, 620, 460, 'Notes'), text(710, 40, 'Notes', 36), text(710, 110, `${para}\n${para}`, 16), ellipse(1000, 330, 200, 100, '#a5d8ff'),
  text(0, 520, 'A caption below both frames, in a different size.', 26),
], { bg: '#fffce8' })

// ---------------------------------------------------------------- shares.json + the fake bucket
const DAY = 86_400_000
const now = Date.now()
// One id per board plus the owner's permission (the Google Docs model). Board 10 is VIEW ONLY on purpose.
const ID10 = 'demo10-AlreadyShared-Kx7Qp2'
const ID11 = 'demo11-StaleGone-Vb3Zr8Lm'
const ID12 = 'demo12-RenamedLater-Tt9Wd4'
write('.yaseendraw/shares.json', {
  version: 1,
  shares: {
    '10 Already shared — link works on launch.excalidraw': { id: ID10, allowDownload: false, sharedAt: now - DAY, updatedAt: now - DAY },
    '11 Stale share — in shares.json but gone from Cloudflare.excalidraw': { id: ID11, allowDownload: true, sharedAt: now - 3 * DAY, updatedAt: now - 2 * DAY },
    '12 Renamed — old name.excalidraw': { id: ID12, allowDownload: true, sharedAt: now - 5 * DAY, updatedAt: now - 5 * DAY },
  },
})
const BUCKET = path.join(FAKE, 'bucket')
fs.mkdirSync(BUCKET, { recursive: true })
/** One object in the fake bucket, the way `tools/fakeCloudflare.mjs` stores them (key file + .meta.json). */
function bucketObject(key, bytes, customMetadata, updatedAt) {
  fs.writeFileSync(path.join(BUCKET, encodeURIComponent(key)), bytes)
  fs.writeFileSync(path.join(BUCKET, `${encodeURIComponent(key)}.meta.json`), JSON.stringify({ key, size: bytes.length, uploaded: new Date(updatedAt).toISOString(), httpMetadata: { contentType: 'application/json; charset=utf-8' }, customMetadata }))
}
/** A shared board as the Worker stores it: the board, plus its download flag as its own `perm/<id>` object. */
function bucketPut(id, allowDownload, name, sceneObj, updatedAt) {
  bucketObject(`boards/${id}.excalidraw`, Buffer.from(`${JSON.stringify(sceneObj)}\n`), { name, updatedAt: String(updatedAt) }, updatedAt)
  bucketObject(`perm/${id}`, Buffer.from(allowDownload ? '1' : '0'), {}, updatedAt)
}
bucketPut(ID10, false, '10 Already shared — link works on launch', board10, now - DAY)
bucketPut(ID12, true, '12 Renamed — old name', board12, now - 5 * DAY)
// (nothing for board 11 — that is the stale case)

// ---------------------------------------------------------------- README
write('README.md', `# Share Button (YAZ-1799) — demo vault

Prototype of **Share link**. The app talks to a FAKE Cloudflare on http://localhost:${PORT}
(\`tools/fakeCloudflare.mjs\`) — nothing reaches the real Cloudflare. Sharing is **not set up** yet:
open Settings › Sharing, press *Open Cloudflare*, paste a magic token.

Sharing works like Google Docs: the Share dialog's **General access** is *Not shared* or *Anyone
with the link*, and when shared, *can view and download* (default) or *can view only*. One link per
board (\`/b/<id>\`); switching the permission is instant on the same link. View only hides the
download buttons AND the Worker refuses \`/raw/<id>\` with 403.

Links are **always live**: after a board is shared, every save re-uploads it
once the saves settle (~10 s quiet). A failed upload keeps the link on
their last good version, shows "Couldn't update: …" in the Share dialog and Settings › Sharing, and
the next save retries.

## Magic tokens (Settings › Sharing › paste key)

Press *Open Cloudflare*: the fake token page lists every magic token and what it does
(\`demo-good\` just works).

Offline: \`../stop-demo.sh fake\` stops only the fake server → every action says it can't reach
Cloudflare / the Worker; \`../start-demo.sh\` brings everything back.
Custom domain: the fake account holds the zones yasin.dev, example.com, example.co.uk and
yaseendraw.app — \`share.yasin.dev\` and \`share.example.co.uk\` attach (the longest matching zone
wins); \`share.missingzone.com\` is "not on your Cloudflare account yet"; \`share.pending-zone.dev\`
is on the account but "not active yet"; \`cname.yasin.dev\` already has a DNS record, so it is refused
with a plain explanation.

Reconnect: Settings › Sharing › *Forget key on this Mac*, then set up again with the same token —
the progress list says the bucket and Worker were **found and reused**, the custom domain comes
back, and every old link still works and can be switched or turned off.

The viewer (\`/b/<id>\`) is served entirely by the Worker: React + Excalidraw + fonts are its static
assets (\`/assets/…\`), no CDN. Download PNG renders at 2×.

Shared boards show a small **link mark** in the sidebar; it turns **red** when the last automatic
update failed or the link is stale (hover for the status). Renaming, moving (drag or cut/paste) a
shared board inside the app keeps its link; deleting it turns the link off. A rename in Finder is
not seen — Settings flags it like board 12.

## Boards

| # | Board | What to check |
|---|---|---|
| 01 | Simple — shapes, arrows and text | Share dialog → *Anyone with the link* → Copy link → open it: both download buttons work. Switch to *view only* → refresh: buttons gone, \`/raw/<id>\` is 403. Switch back → buttons return. *Not shared* → the link says "stopped" |
| 02 | Lean images (assets/) | Viewer shows all 3 images. LIVE: edit + save, wait ~10 s, refresh the link → the edit is there, same link. Edit while offline → "Couldn't update", next save (online) fixes it |
| 03 | Legacy (embedded base64) | Same as 02 for a file that embeds its own images |
| 04 | Big (~45 MB shared) | Slow upload succeeds (the dialog says Uploading… until it lands) |
| 05 | Too big (~115 MB shared) | Refused BEFORE upload with the 100 MB explanation — it never shares |
| 06 | Empty | Shares; viewer shows an empty canvas; PNG button disabled |
| 07 | Deleted images | Downloaded file holds exactly 2 images (no red ones) |
| 08 | Tom's “café” board 🎨 — ünïcödé | Name survives in the viewer title, download names, shares.json |
| 09 | Clients/Acme Corp/2026/Q3 workshop/… | Deep path key in shares.json; right-click Share works in nested folders |
| 10 | Already shared, VIEW ONLY | \`http://localhost:${PORT}/b/${ID10}\` works at launch, before setup, with no download buttons (\`/raw/${ID10}\` → 403); saves update it only after setup |
| 11 | Stale share | Settings list flags "Stale"; Share dialog warns; one edit + save puts it back at the same link |
| 12 | Moved here/… renamed after sharing (outside the app) | shares.json has the OLD path; Settings flags "no board at this path"; the board itself shows "not shared". Rename a shared board INSIDE the app instead and its link follows |
| 13 | Frames and lots of text | Viewer "Download PNG" contains both frames and all text |
`)

// ---------------------------------------------------------------- isolated profile (LAUNCH.md recipe)
const first = path.join(VAULT, '01 Simple — shapes, arrows and text.excalidraw')
writeProfile(PROFILE, VAULT, { theme: 'light', sidebarWidth: 340, lastOpened: now, file: first, tabs: [first] })

// ---------------------------------------------------------------- start / stop scripts
fs.mkdirSync(path.join(DIR, 'logs'), { recursive: true })
const q = (s) => `'${s.replace(/'/g, `'\\''`)}'`
fs.writeFileSync(path.join(DIR, 'start-demo.sh'), `#!/bin/bash
# Share link demo (YAZ-1799): fake Cloudflare on :${PORT} + the dev app (renderer HMR) on the demo profile.
# Client edits hot-reload; main/preload edits need ./start-demo.sh again (it restarts both).
DEMO=${q(DIR)}
REPO=${q(REPO)}
export PATH=/opt/homebrew/bin:$PATH
"$DEMO/stop-demo.sh"
mkdir -p "$DEMO/logs"
# The share viewer (React + Excalidraw + fonts) is a build output the Worker serves as static assets.
[ -f "$REPO/share/dist/assets/viewer.js" ] || node "$REPO/tools/buildShareViewer.mjs"
nohup node "$REPO/tools/fakeCloudflare.mjs" --data "$DEMO/fake-cloudflare" --port ${PORT} > "$DEMO/logs/fake-cloudflare.log" 2>&1 &
echo "fake Cloudflare pid $!  (log: $DEMO/logs/fake-cloudflare.log)"
cd "$REPO/desktop" || exit 1
YASEEN_DRAW_USER_DATA_DIR="$DEMO/profile" \\
YASEEN_DRAW_CLOUDFLARE_API="http://127.0.0.1:${PORT}/client/v4" \\
YASEEN_DRAW_SHARE_ORIGIN="http://localhost:${PORT}" \\
nohup npx electron-vite dev > "$DEMO/logs/app.log" 2>&1 &
echo "dev app pid $!  (log: $DEMO/logs/app.log)"
`)
fs.writeFileSync(path.join(DIR, 'stop-demo.sh'), `#!/bin/bash
# ./stop-demo.sh        stop the fake Cloudflare AND the dev app
# ./stop-demo.sh fake   stop only the fake Cloudflare (the offline case)
DEMO=${q(DIR)}
pkill -f "fakeCloudflare.mjs --data $DEMO/fake-cloudflare" && echo "stopped fake Cloudflare"
[ "$1" = "fake" ] && exit 0
for pid in $(pgrep -f "electron-vite dev"); do
  if ps eww -p "$pid" | grep -q "YASEEN_DRAW_USER_DATA_DIR=$DEMO/profile"; then kill "$pid" && echo "stopped dev app ($pid)"; fi
done
for pid in $(pgrep -f "Electron"); do
  if ps eww -p "$pid" | grep -q "YASEEN_DRAW_USER_DATA_DIR=$DEMO/profile"; then kill "$pid" 2>/dev/null; fi
done
exit 0
`)
fs.chmodSync(path.join(DIR, 'start-demo.sh'), 0o755)
fs.chmodSync(path.join(DIR, 'stop-demo.sh'), 0o755)

console.log(`seeded ${VAULT}\nprofile ${PROFILE}\nfake Cloudflare data ${FAKE}\nstart: ${path.join(DIR, 'start-demo.sh')}`)

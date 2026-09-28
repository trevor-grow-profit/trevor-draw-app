#!/usr/bin/env node
/**
 * USAGE: node tools/seedMergeDemoVault.mjs --vault <dir> [--profile <dir>] [--force]
 *
 * The two-computer vault the sync MERGE and VERSION HISTORY are demoed against (YAZ-1897). It
 * builds a bare "GitHub" at `<vault> (origin).git`, pushes a few boards, clones them to
 * `<vault> (Sam)` and pushes Sam's edits from there — then leaves YOUR conflicting edits unsaved to
 * git in `<vault>`. Open `<vault>` in the app and its first sync pass meets every case at once:
 *   01 both added a shape → both kept · 02 same box moved on both → newest kept (a clash)
 *   03 box deleted by Sam, its text edited by you → box and text kept · Notes.md → both copies kept
 * and the "Merged Sam's changes…" notice appears with See changes → Version history.
 *
 * `--vault` IS REQUIRED AND THE PATH IS WIPED (with its origin and Sam's clone) — the
 * `seedDemoVault.mjs` rule. `--profile` also writes an isolated Electron profile whose one window
 * is already on the vault (LAUNCH.md "Behaviour checks"), so no dialog is needed.
 */
import { cli, cloneAs, git, json, publish, refuseExisting, scene as sceneOf, wipe, write, writeProfile } from './lib/seedKit.mjs'

const USAGE = 'usage: node tools/seedMergeDemoVault.mjs --vault <dir> [--profile <dir>] [--force]'
const args = cli(USAGE, { '--vault': 'dir', '--profile': 'dir' }, ['--vault'])
const VAULT = args.vault
const PROFILE = args.profile
const ORIGIN = `${VAULT} (origin).git`
const SAM = `${VAULT} (Sam)`
const targets = [VAULT, ORIGIN, SAM, PROFILE].filter(Boolean)
for (const dir of targets) refuseExisting(dir, USAGE, { force: args.force })
wipe(...targets)

// ---------------------------------------------------------------- elements, as the engine saves them
let serial = 0
const shape = (id, type, x, y, w, h, extra = {}) => ({
  id, type, x, y, width: w, height: h, angle: 0, strokeColor: '#1e1e1e', backgroundColor: 'transparent', fillStyle: 'solid',
  strokeWidth: 2, strokeStyle: 'solid', roughness: 1, opacity: 100, groupIds: [], frameId: null, index: `a${String(serial++).padStart(4, '0')}`,
  roundness: type === 'rectangle' ? { type: 3 } : null, seed: 1 + serial, version: 1, versionNonce: 1 + serial, isDeleted: false,
  boundElements: null, updated: 1_000, link: null, locked: false, ...extra,
})
const box = (id, x, y, bg, extra) => shape(id, 'rectangle', x, y, 200, 110, { backgroundColor: bg, ...extra })
const words = (id, x, y, str, extra = {}) => shape(id, 'text', x, y, Math.ceil(str.length * (extra.fontSize ?? 20) * 0.6), Math.ceil((extra.fontSize ?? 20) * 1.25), { text: str, originalText: str, fontSize: 20, fontFamily: 5, textAlign: 'left', verticalAlign: 'top', autoResize: true, lineHeight: 1.25, containerId: null, strokeWidth: 1, roughness: 0, ...extra })
const edit = (e, change, updated) => ({ ...e, ...change, version: e.version + 1, versionNonce: e.versionNonce + 100, updated })
const scene = (elements) => json(sceneOf('yaz-1897-demo', elements))

// ---------------------------------------------------------------- the common starting point
const title = (id, str) => words(id, 0, -70, str, { fontSize: 28 })
const b1 = [title('t1', 'Both added a shape'), box('plan', 0, 0, '#a5d8ff')]
const b2 = [title('t2', 'Same box moved on both computers'), box('moved', 0, 0, '#ffec99'), box('still', 300, 0, '#b2f2bb')]
const container = box('card', 0, 0, '#d0bfff', { boundElements: [{ id: 'cardText', type: 'text' }] })
const inside = words('cardText', 20, 40, 'Card text', { containerId: 'card', textAlign: 'center', verticalAlign: 'middle' })
const b3 = [title('t3', 'Sam deleted the card, you edited its text'), container, inside]
const readme = [
  words('r', 0, 0, [
    'YAZ-1897 merge demo — this vault is "you"; Sam pushed from another computer.',
    '',
    '1. The first sync (on open) merges: a notice says "Merged Sam\'s changes…" — click See changes.',
    '2. Version history opens on "Your version before the merge": green = Sam added, amber = changed,',
    '   faded red = removed. Flip to "As it was". Use ↑ / ↓ through the list.',
    '3. Restore "Your version before the merge" on board 02 → the board goes back; the chip syncs it.',
    '4. Right-click any board › Version history works the same way.',
    '5. Notes.md → a "Notes (conflict, <date>).md" copy sits beside it with your text.',
  ].join('\n'), { height: 220, width: 900 }),
]

write(VAULT, '00 READ ME — what to try.excalidraw', scene(readme))
write(VAULT, '01 Both added a shape.excalidraw', scene(b1))
write(VAULT, '02 Same box moved on both.excalidraw', scene(b2))
write(VAULT, '03 Card deleted vs text edited.excalidraw', scene(b3))
write(VAULT, 'Notes.md', '# Notes\n\nThe plan for Monday.\n')
write(VAULT, '.yaseendraw/github.json', { enabled: true })
publish(VAULT, ORIGIN, 'Start the demo')

// ---------------------------------------------------------------- Sam, on the other computer
cloneAs(ORIGIN, SAM, 'Sam')
write(SAM, '01 Both added a shape.excalidraw', scene([...b1, box('sams', 260, 160, '#ffc9c9'), words('samsLabel', 280, 200, "Sam's idea")]))
write(SAM, '02 Same box moved on both.excalidraw', scene([b2[0], edit(b2[1], { x: 0, y: 220 }, 3_000), b2[2]]))
write(SAM, '03 Card deleted vs text edited.excalidraw', scene([b3[0], edit(container, { isDeleted: true }, 3_000), edit(inside, { isDeleted: true }, 3_000)]))
write(SAM, 'Notes.md', '# Notes\n\nThe plan for Monday — Sam: move it to Tuesday.\n')
git(SAM, ['add', '-A'])
git(SAM, ['commit', '-m', 'sync: Sam edits'])
git(SAM, ['push'])

// ---------------------------------------------------------------- your edits, not yet synced
write(VAULT, '01 Both added a shape.excalidraw', scene([...b1, box('yours', -260, 160, '#b2f2bb'), words('yoursLabel', -240, 200, 'Your idea')]))
write(VAULT, '02 Same box moved on both.excalidraw', scene([b2[0], edit(b2[1], { x: 520, y: 0 }, 2_000), b2[2]]))
write(VAULT, '03 Card deleted vs text edited.excalidraw', scene([b3[0], container, edit(inside, { text: 'Card text — edited by you', originalText: 'Card text — edited by you', width: 300 }, 2_000)]))
write(VAULT, 'Notes.md', '# Notes\n\nThe plan for Monday — me: keep Monday, add a demo.\n')

if (PROFILE) writeProfile(PROFILE, VAULT, { sidebarWidth: 280, lastOpened: 0, bounds: { x: 80, y: 80, width: 1280, height: 820 } })

console.log(`vault:  ${VAULT}\norigin: ${ORIGIN}\nSam:    ${SAM}`)
if (PROFILE) console.log(`launch: cd desktop && YASEEN_DRAW_USER_DATA_DIR="${PROFILE}" npx electron-vite dev`)

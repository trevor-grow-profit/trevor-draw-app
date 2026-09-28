#!/usr/bin/env node
/**
 * USAGE: node tools/seedSortDemoVault.mjs --vault <dir> [--force]
 *
 * The vault the sidebar SORT and INFO checks run against (YAZ-1835, proved by 1835F = YAZ-1852; the demo Yasin
 * approved on 2026-09-22): 44 boards whose three orders all disagree, ties, legacy boards with no
 * block, the backfill shape with a `cloudId`, a "clone" whose block and mtime disagree, corrupt /
 * empty / misplaced-block / bad-block / future / epoch boards, unicode and case, nested folders,
 * a 15-board folder, two non-boards and one chmod-000 board. Every file name says what it tests.
 * Boards only — nothing this vault holds is about any other feature.
 *
 * `--vault` IS REQUIRED AND THE PATH IS WIPED (the `seedDemoVault.mjs` rule): no default, and an
 * existing target is refused unless `--force` says otherwise. It writes no app profile: open it
 * with ⌘O, or seed it from `sortVault.integration.test.ts`, which is what proves it.
 */
import fs from 'node:fs'
import path from 'node:path'
import { cli, json as pretty, refuseExisting, scene as sceneOf, wipe, write } from './lib/seedKit.mjs'

const USAGE = 'usage: node tools/seedSortDemoVault.mjs --vault <dir> [--force]'
const args = cli(USAGE, { '--vault': 'dir' }, ['--vault'])
const VAULT = args.vault
refuseExisting(VAULT, USAGE, { what: 'vault', force: args.force })
wipe(VAULT)
fs.mkdirSync(VAULT, { recursive: true })

const DAY = 86_400_000
const now = Date.now()
const ago = (d) => now - d * DAY
const el = (id, x, y, text) => [
  { id: `r-${id}`, type: 'rectangle', x, y, width: 260, height: 90, strokeColor: '#1e1e1e', backgroundColor: '#ffec99', fillStyle: 'solid', strokeWidth: 2, roughness: 0, opacity: 100, angle: 0, seed: 1, version: 1, versionNonce: 1, isDeleted: false, groupIds: [], frameId: null, roundness: { type: 3 }, boundElements: [{ id: `t-${id}`, type: 'text' }], updated: 1, link: null, locked: false, index: 'a0' },
  { id: `t-${id}`, type: 'text', x: x + 12, y: y + 30, width: 236, height: 25, strokeColor: '#1e1e1e', backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 2, roughness: 0, opacity: 100, angle: 0, seed: 2, version: 1, versionNonce: 2, isDeleted: false, groupIds: [], frameId: null, roundness: null, boundElements: null, updated: 1, link: null, locked: false, index: 'a1', text, fontSize: 20, fontFamily: 5, textAlign: 'center', verticalAlign: 'middle', containerId: `r-${id}`, originalText: text, autoResize: true, lineHeight: 1.25 },
]
const scene = (label) => sceneOf('yaz-1835-demo', el(label.replace(/\W+/g, '-'), 100, 100, label))

/** Any file, with its mtime set. */
function raw(rel, text, mtime = now) {
  const t = new Date(mtime)
  fs.utimesSync(write(VAULT, rel, text), t, t)
}
/** A stamped board: the block FIRST. mtime is set separately so the three dates can disagree on purpose. */
const stamped = (rel, { created, updated, mtime, extra = {} }) => raw(rel, pretty({ yaseendraw: { createdAt: created, updatedAt: updated, ...extra }, ...scene(path.basename(rel, '.excalidraw')) }), mtime ?? updated)
/** A legacy board: no block; only mtime carries its age. */
const legacy = (rel, mtime) => raw(rel, pretty(scene(path.basename(rel, '.excalidraw'))), mtime)

// ---- Root: the three orders must all disagree. Names are chosen so alphabetical ≠ updated ≠ created.
stamped('Apple — old, edited yesterday.excalidraw', { created: ago(400), updated: ago(1) })
stamped('Banana — newest board, never edited.excalidraw', { created: ago(0.02), updated: ago(0.02) })
stamped('Cherry — created last year, edited last week.excalidraw', { created: ago(370), updated: ago(7) })
stamped('Date — created 2 days ago, edited an hour ago.excalidraw', { created: ago(2), updated: now - 3_600_000 })
stamped('Elder — the oldest board of all.excalidraw', { created: ago(1200), updated: ago(1100) })

// ---- Ties: same updatedAt → name breaks the tie.
stamped('Tie 1 — same updated as Tie 2.excalidraw', { created: ago(30), updated: ago(3) })
stamped('Tie 2 — same updated as Tie 1.excalidraw', { created: ago(31), updated: ago(3) })

// ---- Backfill shape (YAZ-1832): cloud dates + cloudId in the block. Info shows the dates; the extra key survives saves.
stamped('From the cloud — 2021 board with cloudId.excalidraw', { created: Date.UTC(2021, 2, 4, 15, 6), updated: Date.UTC(2023, 10, 11, 9, 30), extra: { cloudId: 'k97abc12' } })

// ---- Legacy (no block): sorts by mtime; Info says "not stamped yet"; the FIRST save stamps it — watch Info change.
legacy('Legacy — no block, mtime 90 days ago.excalidraw', ago(90))
legacy('Legacy — no block, mtime 5 minutes ago.excalidraw', now - 5 * 60_000)

// ---- The block vs mtime disagree: which wins? (block does — a clone resets mtimes)
stamped('Cloned — block says 2022, mtime says today.excalidraw', { created: Date.UTC(2022, 0, 15), updated: Date.UTC(2022, 5, 1), mtime: now })

// ---- Junk that must still list, without meta, and never break the sort or Info
raw('Corrupt — not JSON.excalidraw', '{ not json at all', ago(10))
raw('Empty — zero bytes.excalidraw', '', ago(20))
raw('Misplaced — block is LAST, so it is ignored.excalidraw', pretty({ ...scene('Misplaced'), yaseendraw: { createdAt: ago(999), updatedAt: ago(999) } }), ago(4))
raw('Bad block — createdAt is a string.excalidraw', pretty({ yaseendraw: { createdAt: 'yesterday', updatedAt: 5 }, ...scene('Bad block') }), ago(6))
raw('Future — updated next year.excalidraw', pretty({ yaseendraw: { createdAt: ago(5), updatedAt: now + 365 * DAY }, ...scene('Future') }), ago(5))
raw('Epoch — created in 1970.excalidraw', pretty({ yaseendraw: { createdAt: 0, updatedAt: ago(50) }, ...scene('Epoch') }), ago(50))

// ---- Unicode and case: name sort must be case-insensitive and locale-aware
stamped('zebra lowercase.excalidraw', { created: ago(8), updated: ago(8) })
stamped('Éclair — accented, sorts near E.excalidraw', { created: ago(9), updated: ago(9) })
stamped('日本語 — non-latin name.excalidraw', { created: ago(3.5), updated: ago(3.5) })
stamped('big Big BIG — three cases.excalidraw', { created: ago(12), updated: ago(12) })

// ---- Folders: always first, by name; contents sorted by the same order; nested
stamped('Zed folder — sorts by name, not by date/New in Zed.excalidraw', { created: ago(0.5), updated: ago(0.5) })
stamped('Zed folder — sorts by name, not by date/Old in Zed.excalidraw', { created: ago(300), updated: ago(200) })
stamped('Alpha folder/Deep/Deeper/Deepest board.excalidraw', { created: ago(60), updated: ago(0.1) })
stamped('Alpha folder/Deep/Middle board.excalidraw', { created: ago(61), updated: ago(15) })
stamped('Alpha folder/Top of alpha.excalidraw', { created: ago(62), updated: ago(30) })
legacy('Alpha folder/Legacy inside alpha.excalidraw', ago(45))
fs.mkdirSync(path.join(VAULT, 'Empty folder'), { recursive: true })
stamped('mixed Case Folder/only board here.excalidraw', { created: ago(2.5), updated: ago(2.5) })

// ---- Many boards in one folder: a save must visibly jump to the top under "Last updated"
for (let i = 1; i <= 15; i++) stamped(`Fifteen boards/Board ${String(i).padStart(2, '0')}.excalidraw`, { created: ago(100 - i), updated: ago(50 + i) })

// ---- Not a board: must be listed, sort by name only among files, no Info item
raw('notes.txt', 'not a board\n', ago(1))
raw('photo.png', 'png', ago(1))

// ---- Unreadable: still listed, no meta (chmod 000)
stamped('Locked — chmod 000, still listed.excalidraw', { created: ago(3), updated: ago(3) })
fs.chmodSync(path.join(VAULT, 'Locked — chmod 000, still listed.excalidraw'), 0o000)

console.log(`seeded ${VAULT}`)

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readdir, readFile, stat, truncate, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { VaultStorageStats } from '@shared/types'
import { shrinkVault } from '../fs/shrink'
import { git } from './exec'
import { makeBareRemote, makeGitRepo, REAL_GIT_TIMEOUT_MS, requireGit, wireOrigin, type BareRemote, type GitRepo } from './gitFixture'
import { vaultStorage } from './storage'
import { syncPass } from './sync'

/**
 * 1801G — the Storage feature's whole chain on real files, real git and a local bare "GitHub":
 * `vaultStorage` → `syncPass` → `shrinkVault` → `syncPass` → `vaultStorage`, over a compact
 * version of the vault `tools/seedStorageDemoVault.mjs` builds (📋 YAZ-1801). The two files over
 * the 95 MiB line are the real size: the `.mov` is sparse, and the board's pictures are runs of
 * one byte, so writing, parsing and committing them stays cheap. No Playwright, no app.
 *
 * The `it`s are ORDERED STEPS over one vault (each builds on the last), so run the file, not one test.
 */

const MiB = 1024 * 1024
const BLOCK = { createdAt: Date.UTC(2026, 0, 15, 10), updatedAt: Date.UTC(2026, 0, 15, 12) }
const TOO_BIG = 'Too big for GitHub.excalidraw'
const VIDEO = 'Big video.mov'
const LEGACY = ['Legacy - few pictures.excalidraw', 'Shared picture A.excalidraw', 'Shared picture B.excalidraw', 'Folder/Nested legacy.excalidraw', 'Unreferenced embedded.excalidraw', 'Malformed picture data.excalidraw', TOO_BIG]

interface Pic {
  id: string
  bytes: Buffer
}
const pic = (bytes: Buffer): Pic => ({ id: createHash('sha1').update(bytes).digest('hex'), bytes })
const embed = (...pics: Pic[]) => Object.fromEntries(pics.map((p) => [p.id, { mimeType: 'image/png', id: p.id, dataURL: `data:image/png;base64,${p.bytes.toString('base64')}` }]))
/** A board in the seed's shape: the `yaseendraw` block first, one image element per used id. */
const board = (uses: string[], files: Record<string, unknown>) =>
  `${JSON.stringify({ yaseendraw: BLOCK, type: 'excalidraw', version: 2, elements: uses.map((fileId) => ({ id: `i-${fileId}`, type: 'image', fileId })), appState: {}, files }, null, 2)}\n`
/** The board's text up to the scene proper — the block, byte for byte. */
const blockText = (json: string) => json.slice(0, json.indexOf('\n  "type"'))

const clean = pic(randomBytes(2048))
const few = [pic(randomBytes(2048)), pic(randomBytes(2048))]
const shared = pic(randomBytes(2048))
const nested = pic(randomBytes(2048))
const good = pic(randomBytes(2048))
const orphan = pic(randomBytes(2048))
// Two pictures whose base64 alone puts the board past 95 MiB, each under the 50 MiB warning once in assets/.
const huge = [pic(Buffer.alloc(36 * MiB, 0)), pic(Buffer.alloc(36 * MiB, 0xff))]
const moved = [...few, shared, nested, good, ...huge]

let bin: string
let repo: GitRepo
let remote: BareRemote
let before: VaultStorageStats
let bytesMoved = 0
const blocks = new Map<string, string>()
const history: number[] = []

const put = async (rel: string, data: string | Buffer) => {
  const file = path.join(repo.root, rel)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, data)
}
const remoteRun = async (args: string[]) => (await git(bin, remote.url, args)).stdout.trim()
/** What is left uncommitted, `-z` so a path with a space is not quoted. */
const status = async () => (await repo.run(['status', '--porcelain', '-z', '--untracked-files=all'])).split('\0').filter((l) => l !== '')
const historyNow = async () => (await vaultStorage(repo.root)).git!.historyBytes
const everCommitted = () => repo.run(['log', '--all', '--format=', '--name-only'])
/** The biggest object `.git` holds, reachable or not — a staged-then-reset file would still be here. */
const biggestObject = async () => Math.max(...(await repo.run(['cat-file', '--batch-all-objects', '--batch-check=%(objectsize)'])).split('\n').map(Number))
const assets = async () => (await readdir(path.join(repo.root, 'assets'))).sort()
const mtimes = async () => Promise.all([...LEGACY, 'Corrupt board.excalidraw'].map(async (rel) => (await stat(path.join(repo.root, rel))).mtimeMs))

beforeAll(async () => {
  bin = await requireGit()
  repo = await makeGitRepo()
  remote = await makeBareRemote()
  await wireOrigin(repo, remote)
  // Committed and pushed at seed, with a replaced version so "old versions" is not zero.
  await put(`assets/${clean.id}.png`, clean.bytes)
  await put('Small clean board.excalidraw', board([clean.id], {}))
  await put(LEGACY[0], board([], embed(pic(randomBytes(4096)))))
  await put('Corrupt board.excalidraw', '{ "yaseendraw": {}, "elements": [ this is not json\n')
  await repo.run(['add', '-A'])
  await repo.run(['commit', '-qm', 'seed v1'])
  await put(LEGACY[0], board(few.map((p) => p.id), embed(...few)))
  await repo.run(['commit', '-qam', 'seed v2'])
  await repo.run(['push', '-q', '-u', 'origin', 'main'])
  // Left dirty for the first pass: ordinary legacy boards, and the two files it must hold back.
  await put(LEGACY[1], board([shared.id], embed(shared)))
  await put(LEGACY[2], board([shared.id], embed(shared)))
  await put(LEGACY[3], board([nested.id], embed(nested)))
  await put(LEGACY[4], board([], embed(orphan)))
  await put(LEGACY[5], board([good.id, 'broken'], { ...embed(good), broken: { mimeType: 'image/png', id: 'broken', dataURL: 'data:image/png;base64,@@not-base64@@' } }))
  await put(TOO_BIG, board(huge.map((p) => p.id), embed(...huge)))
  await put(VIDEO, '')
  await truncate(path.join(repo.root, VIDEO), 120 * MiB)
  for (const rel of LEGACY) blocks.set(rel, blockText(await readFile(path.join(repo.root, rel), 'utf8')))
}, 60_000)
afterAll(async () => {
  await repo?.cleanup()
  await remote?.cleanup()
})

describe('1801G — stats, sync, shrink, sync, stats on the seeded storage vault', { timeout: REAL_GIT_TIMEOUT_MS }, () => {
  it('before: every legacy board counts as embedded, both oversize files are large, old versions > 0', async () => {
    before = await vaultStorage(repo.root)
    expect(before.embedded.boards).toBe(LEGACY.length)
    expect(before.embedded.bytes).toBeGreaterThan(95 * MiB)
    expect(before.large.map((f) => f.path)).toEqual([VIDEO, TOO_BIG])
    expect((await stat(path.join(repo.root, TOO_BIG))).size).toBeGreaterThan(95 * MiB)
    expect(before.git!.oldVersionsBytes).toBeGreaterThan(0)
    history.push(before.git!.historyBytes)
  })

  it('Y1 + Y6: the first pass pushes everything but the two oversize files, and .git never sees them', async () => {
    const pass = await syncPass(repo.root)
    // ACT-370: the .mov is outside the sync scope, so only the oversize BOARD is held back and named.
    expect(pass).toMatchObject({ state: 'attention', attention: 'too-large', tooLarge: [TOO_BIG] })
    expect(await status()).toEqual([`?? ${VIDEO}`, `?? ${TOO_BIG}`])
    expect(await remoteRun(['rev-parse', 'main'])).toBe(await repo.run(['rev-parse', 'HEAD']))
    expect(await everCommitted()).not.toMatch(/Too big|Big video/)
    expect(await biggestObject()).toBeLessThan(MiB)
    history.push(await historyNow())
    // Five small boards went in. (The oversize files are runs of one byte, so a leaked blob would
    // compress small: `biggestObject` is the check that bites; this one pins the number the page shows.)
    expect(history[1] - history[0]).toBeLessThan(MiB)
  })

  it('Y5 + Y7: a pass whose only dirty files are oversize commits nothing, writes nothing and answers the same', async () => {
    const head = await repo.run(['rev-parse', 'HEAD'])
    const again = await syncPass(repo.root)
    expect(again).toMatchObject({ state: 'attention', attention: 'too-large', tooLarge: [TOO_BIG] }) // ACT-370: the .mov is outside the scope
    // `attention`, not `pending`: the manager arms a retry only for `pending`.
    expect(await syncPass(repo.root)).toEqual(again)
    expect(await repo.run(['rev-parse', 'HEAD'])).toBe(head)
    expect(await historyNow()).toBe(history[1])
  })

  it('M1 + M2: every legacy board shrinks, the corrupt one is skipped, pictures land once, blocks stay byte-identical', async () => {
    const res = await shrinkVault(repo.root)
    expect(res).toMatchObject({ shrunk: LEGACY.length, skipped: 1 })
    bytesMoved = res.bytesMoved
    // Shared A/B store one file; the orphan and the malformed entry are dropped, not moved.
    expect(await assets()).toEqual([clean, ...moved].map((p) => `${p.id}.png`).sort())
    for (const rel of LEGACY) {
      const json = await readFile(path.join(repo.root, rel), 'utf8')
      expect(blockText(json), rel).toBe(blocks.get(rel))
      expect(JSON.parse(json).files, rel).toEqual({})
    }
    expect((await stat(path.join(repo.root, TOO_BIG))).size).toBeLessThan(MiB)
  })

  it('M4: a second run changes nothing', async () => {
    const [times, stored] = [await mtimes(), await assets()]
    expect(await shrinkVault(repo.root)).toEqual({ shrunk: 0, skipped: 1, bytesMoved: 0 })
    expect(await mtimes()).toEqual(times)
    expect(await assets()).toEqual(stored)
  })

  it('Y8: the next pass syncs the shrunk board and its pictures; the .mov stays behind, and is not sync\'s to name (ACT-370)', async () => {
    const pass = await syncPass(repo.root)
    // A video is outside the sync scope: not committed, and not a "too large" banner either.
    expect(pass).toMatchObject({ state: 'synced' })
    expect(pass.tooLarge).toBeUndefined()
    expect(await status()).toEqual([`?? ${VIDEO}`])
    expect(await remoteRun(['rev-parse', 'main'])).toBe(await repo.run(['rev-parse', 'HEAD']))
    const onRemote = (await remoteRun(['ls-tree', '-r', '--name-only', 'main'])).split('\n')
    expect(onRemote).toEqual(expect.arrayContaining([TOO_BIG, ...huge.map((p) => `assets/${p.id}.png`)]))
    expect(onRemote).not.toContain(VIDEO)
    expect(await biggestObject()).toBeLessThan(95 * MiB)
  })

  it('after: embedded is 0, the large list is the .mov alone, and every number moved by what shrink moved', async () => {
    const after = await vaultStorage(repo.root)
    expect(after.embedded).toEqual({ bytes: 0, boards: 0 })
    expect(after.large).toEqual([{ path: VIDEO, bytes: 120 * MiB }])
    expect(after.boards).toEqual({ count: before.boards.count, bytes: before.boards.bytes - bytesMoved })
    expect(after.pictures).toEqual({ count: before.pictures.count + moved.length, bytes: before.pictures.bytes + moved.reduce((n, p) => n + p.bytes.length, 0) })
    expect(after.other).toEqual(before.other)
    // 72 MiB of pictures went into history, compressed; the held-back .mov never did.
    expect(after.git!.historyBytes - history[1]).toBeLessThan(5 * MiB)
  })
})

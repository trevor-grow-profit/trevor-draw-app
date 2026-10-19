import { readFile, lstat, rm, symlink } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { makeGitRepo, requireGit, REAL_GIT_TIMEOUT_MS, type GitRepo } from './gitFixture'
import { assertNoPendingShelf, shelfOutsideScope } from './shelf'

let repo: GitRepo
const specs = ['.', ':(exclude)*.drawio']
afterEach(async () => { await repo?.cleanup() })
async function setup() {
  repo = await makeGitRepo()
  await repo.write('note.md', 'base')
  await repo.run(['add', '.'])
  await repo.run(['commit', '-m', 'base'])
  return repo
}
describe('durable sync shelf', { timeout: REAL_GIT_TIMEOUT_MS }, () => {
  it('preserves tracked edits, deletions, and untracked collisions over an incoming commit', async () => {
    const r = await setup()
    await r.write('note.md', 'local draft')
    await r.write('new.md', 'untracked local')
    const shelf = await shelfOutsideScope(await requireGit(), r.root, specs)
    expect(await readFile(path.join(r.root, 'note.md'), 'utf8')).toBe('base')
    await expect(lstat(path.join(r.root, 'new.md'))).rejects.toThrow()
    await r.write('note.md', 'remote edit')
    await r.write('new.md', 'remote addition')
    await r.run(['add', '.'])
    await r.run(['commit', '-m', 'incoming'])
    await shelf?.restore()
    expect(await readFile(path.join(r.root, 'note.md'), 'utf8')).toBe('local draft')
    expect(await readFile(path.join(r.root, 'new.md'), 'utf8')).toBe('untracked local')
    expect(await r.run(['show', 'HEAD:new.md'])).toBe('remote addition')
    await assertNoPendingShelf(await requireGit(), r.root)
  })
  it('refuses another pass after interruption without touching original recovery copies', async () => {
    const r = await setup()
    await r.write('note.md', 'draft')
    await shelfOutsideScope(await requireGit(), r.root, specs)
    await expect(assertNoPendingShelf(await requireGit(), r.root)).rejects.toThrow('interrupted sync')
    expect(await readFile(path.join(r.root, '.git/trevor-draw-recovery/0'), 'utf8')).toBe('draft')
  })
  it('keeps recovery and concurrent edits when another editor writes during sync', async () => {
    const r = await setup()
    await r.write('note.md', 'draft')
    const shelf = await shelfOutsideScope(await requireGit(), r.root, specs)
    await r.write('note.md', 'newer edit')
    await expect(shelf?.restore()).rejects.toThrow('File changed during sync')
    expect(await readFile(path.join(r.root, 'note.md'), 'utf8')).toBe('newer edit')
    expect(await readFile(path.join(r.root, '.git/trevor-draw-recovery/0'), 'utf8')).toBe('draft')
  })
  it('never follows an incoming symlink when restoring', async () => {
    const r = await setup()
    await r.write('note.md', 'draft')
    const shelf = await shelfOutsideScope(await requireGit(), r.root, specs)
    await r.write('target.md', 'target stays')
    await rm(path.join(r.root, 'note.md'))
    await symlink('target.md', path.join(r.root, 'note.md'))
    await expect(shelf?.restore()).rejects.toThrow('symlink')
    expect(await readFile(path.join(r.root, 'target.md'), 'utf8')).toBe('target stays')
  })
  it('never restores through a parent directory replaced by a symlink', async () => {
    const r = await setup()
    await r.write('notes/draft.md', 'draft')
    const shelf = await shelfOutsideScope(await requireGit(), r.root, specs)
    await r.write('elsewhere/draft.md', 'leave this alone')
    await rm(path.join(r.root, 'notes'), { recursive: true })
    await symlink('elsewhere', path.join(r.root, 'notes'))
    await expect(shelf?.restore()).rejects.toThrow('symlink')
    expect(await readFile(path.join(r.root, 'elsewhere/draft.md'), 'utf8')).toBe('leave this alone')
  })
  it('fails before changing files if an unsupported path cannot be backed up', async () => {
    const r = await setup()
    await r.write('note.md', 'draft')
    await symlink('note.md', path.join(r.root, 'link.md'))
    await expect(shelfOutsideScope(await requireGit(), r.root, specs)).rejects.toThrow('expected a regular file')
    expect(await readFile(path.join(r.root, 'note.md'), 'utf8')).toBe('draft')
    await assertNoPendingShelf(await requireGit(), r.root)
  })
})

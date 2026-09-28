import { describe, expect, it, vi } from 'vitest'
import { getFavorites, removePath, renamePath, setFavorites } from './favorites'

// YAZ-2073 2D: favorites.ts as it runs on Windows — `node:path` IS `path.win32` there, so this file
// swaps it in, fakes the one stat and keeps favorites.json in memory. Before `isWithin`, every
// Windows favorite was refused as "outside the vault" by a hard-coded `${root}/` check.

vi.mock('node:path', async () => {
  const { win32 } = await vi.importActual<typeof import('node:path')>('node:path')
  return { ...win32, default: win32 }
})
vi.mock('node:fs/promises', async (importOriginal) => ({ ...(await importOriginal<typeof import('node:fs/promises')>()), stat: async () => ({}) }))
const files = vi.hoisted(() => new Map<string, unknown>())
vi.mock('./vaultConfig', () => ({
  readConfigDetailed: async (root: string, name: string) => (files.has(`${root}|${name}`) ? { state: 'ok', value: files.get(`${root}|${name}`) } : { state: 'absent' }),
  writeConfig: async (root: string, name: string, value: unknown) => void files.set(`${root}|${name}`, value),
  subscribeConfig: () => () => undefined,
}))

const V = 'C:\\Users\\me\\Vault'
const stored = () => files.get(`${V}|favorites.json`)

describe('favorites on Windows paths (YAZ-2073 2D)', () => {
  it('Add favorite: a board inside the vault is kept, stored POSIX-relative, read back native', async () => {
    await setFavorites(V, [`${V}\\a.excalidraw`, `${V}\\sub\\b.drawio`])
    expect(stored()).toEqual({ version: 1, favorites: ['a.excalidraw', 'sub/b.drawio'] })
    expect(await getFavorites(V)).toEqual([`${V}\\a.excalidraw`, `${V}\\sub\\b.drawio`])
  })

  it('a board in a sibling folder that shares the prefix is still refused', async () => {
    await expect(setFavorites(V, [`${V}2\\x.excalidraw`])).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('a renamed folder carries its favorites; a deleted one drops them', async () => {
    await setFavorites(V, [`${V}\\a.excalidraw`, `${V}\\sub\\b.drawio`])
    await renamePath([V], `${V}\\sub`, `${V}\\moved`)
    expect(stored()).toEqual({ version: 1, favorites: ['a.excalidraw', 'moved/b.drawio'] })
    await removePath([V], `${V}\\moved`)
    expect(stored()).toEqual({ version: 1, favorites: ['a.excalidraw'] })
  })
})

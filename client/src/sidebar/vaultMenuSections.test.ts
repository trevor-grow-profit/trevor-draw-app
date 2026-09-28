/**
 * The vault right-click menu's items (YAZ-1798 D7), tested pure: which items a vault gets, in
 * which groups, and what each hands its handler. `ContextMenu.test.tsx` owns the drawing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MenuAction, MenuSection } from './menuSections'
import { buildVaultMenuSections, type VaultMenuHandlers, type VaultMenuTarget } from './vaultMenuSections'

const OTHER = '/v/Émojis 🚀 & spaces'
/** A target as the switcher builds it: the folder name, no display name set. */
const target = (over: Partial<VaultMenuTarget> = {}): VaultMenuTarget => ({ path: OTHER, name: 'Émojis 🚀 & spaces', isCurrent: false, renamed: false, ...over })

function handlers(): VaultMenuHandlers {
  return { onOpenHere: vi.fn(), onRename: vi.fn(), onResetName: vi.fn(), onReveal: vi.fn(), onOpenVsCode: vi.fn(), onRemove: vi.fn(), onNotice: vi.fn() }
}

/** The non-empty groups' labels — what `ContextMenu` draws, a hairline between each. */
const groupsOf = (sections: MenuSection[]) => sections.filter((s) => s.length > 0).map((s) => s.map((i) => i.label))
const item = (sections: MenuSection[], id: string) => sections.flat().find((i) => i.id === id) as MenuAction

function installClipboard(fail?: Error) {
  const writeText = vi.fn(async () => {
    if (fail !== undefined) throw fail
  })
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  return writeText
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('buildVaultMenuSections (YAZ-1798 D7)', () => {
  it('another vault: Open in this window · Set display name · the two copies · Reveal and VS Code · Remove — five groups in that order', () => {
    expect(groupsOf(buildVaultMenuSections(target(), handlers()))).toEqual([
      ['Open in this window'],
      ['Set display name'],
      ['Copy vault name', 'Copy path'],
      ['Reveal in Finder', 'Open in VS Code'],
      ['Remove from recent vaults'],
    ])
  })

  it('Open in this window names its hotkey, ⇧⏎ (Docs YAZ-1974 D8)', () => {
    expect(buildVaultMenuSections(target(), handlers())[0][0].hint).toBe('⇧⏎')
  })

  it('a renamed vault also offers Reset to folder name, beside Set display name (Docs YAZ-1974 D5)', () => {
    expect(groupsOf(buildVaultMenuSections(target({ name: 'Launch', renamed: true }), handlers()))).toEqual([
      ['Open in this window'],
      ['Set display name', 'Reset to folder name'],
      ['Copy vault name', 'Copy path'],
      ['Reveal in Finder', 'Open in VS Code'],
      ['Remove from recent vaults'],
    ])
  })

  it('the current vault: no Open in this window (you are there) and no Remove (it would come straight back, D3) — the display name items stay', () => {
    expect(groupsOf(buildVaultMenuSections(target({ isCurrent: true }), handlers()))).toEqual([
      ['Set display name'],
      ['Copy vault name', 'Copy path'],
      ['Reveal in Finder', 'Open in VS Code'],
    ])
    expect(groupsOf(buildVaultMenuSections(target({ isCurrent: true, renamed: true }), handlers()))).toEqual([
      ['Set display name', 'Reset to folder name'],
      ['Copy vault name', 'Copy path'],
      ['Reveal in Finder', 'Open in VS Code'],
    ])
  })

  it('nothing is danger-styled and nothing is disabled — Remove only forgets an MRU entry', () => {
    const all = buildVaultMenuSections(target({ renamed: true }), handlers()).flat()
    expect(all.some((i) => i.danger === true || (i as MenuAction).disabled === true)).toBe(false)
  })

  it('each verb hands its handler the vault path', () => {
    const h = handlers()
    const sections = buildVaultMenuSections(target({ renamed: true }), h)
    for (const [id, fn] of [
      ['open-here', h.onOpenHere],
      ['rename', h.onRename],
      ['reset-name', h.onResetName],
      ['reveal', h.onReveal],
      ['open-vscode', h.onOpenVsCode],
      ['remove', h.onRemove],
    ] as const) {
      item(sections, id).onSelect()
      expect(fn).toHaveBeenCalledWith(OTHER)
    }
  })

  it('Copy vault name writes the display name verbatim and confirms (Docs YAZ-1974 D4)', async () => {
    const writeText = installClipboard()
    const h = handlers()
    item(buildVaultMenuSections(target({ name: '🚀 Launch', renamed: true }), h), 'copy-name').onSelect()
    await vi.waitFor(() => expect(h.onNotice).toHaveBeenCalledWith('Copied vault name'))
    expect(writeText).toHaveBeenCalledWith('🚀 Launch')
  })

  it('Copy path writes the absolute path and confirms', async () => {
    const writeText = installClipboard()
    const h = handlers()
    item(buildVaultMenuSections(target({ isCurrent: true, name: 'Launch', renamed: true }), h), 'copy-path').onSelect()
    await vi.waitFor(() => expect(h.onNotice).toHaveBeenCalledWith('Copied path'))
    expect(writeText).toHaveBeenCalledWith(OTHER)
  })

  it('a clipboard the OS refused is reported, never silent', async () => {
    installClipboard(new Error('denied'))
    const h = handlers()
    item(buildVaultMenuSections(target(), h), 'copy-path').onSelect()
    await vi.waitFor(() => expect(h.onNotice).toHaveBeenCalledWith("Can't copy path: denied"))
  })
})

/**
 * Settings › Sharing (YAZ-1799 D7, YAZ-1889): one test per state the page can show — not set up,
 * setting up (and each way it fails), the account picker, ready, the shared-boards list's lines,
 * the custom domain and its refusals, both turn-off confirms — and search reaching its rows.
 * Driven through the real dialog and App's real `useSharing`, with main's API mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { DEFAULT_SETTINGS, SHARE_SETUP_STEPS, type ShareListEntry, type ShareSetupProgress, type ShareSetupStep, type ShareStatus } from '@shared/types'

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  api: {
    secrets: { has: vi.fn(async () => false) },
    share: {
      status: vi.fn(),
      accounts: vi.fn(),
      setup: vi.fn(),
      onSetupProgress: vi.fn(),
      openCloudflare: vi.fn(async () => undefined),
      list: vi.fn(),
      stop: vi.fn(async () => undefined),
      setDomain: vi.fn(),
      disconnect: vi.fn(),
      onChanged: vi.fn(() => () => {}),
    },
  },
}))

import { api, BridgeRequestError } from '../api'
import { storage } from '../lib/storage'
import { SettingsDialog } from '../settings/SettingsDialog'
import { resetLiveShareForTests } from './liveShare'
import { useSharing } from './useSharing'

const share = vi.mocked(api.share)
const ROOT = '/v'
const OFF: ShareStatus = { state: 'off', url: null, workersDevUrl: null, customDomain: null, accountName: null, workerName: null, bucketName: null, readyAt: null, demo: false }
const READY: ShareStatus = { ...OFF, state: 'ready', url: 'https://yaseen-draw-share.me.workers.dev', workersDevUrl: 'https://yaseen-draw-share.me.workers.dev', accountName: 'Me', workerName: 'yaseen-draw-share', bucketName: 'yaseen-draw-shares', readyAt: 1 }
const NOW = Date.now()
const board = (name: string, over: Partial<ShareListEntry> = {}): ShareListEntry => ({
  path: `/v/${name}.excalidraw`,
  id: name,
  url: `${READY.url}/b/${name}`,
  allowDownload: true,
  sharedAt: NOW - 86_400_000,
  updatedAt: NOW - 5 * 60_000,
  sync: { state: 'ok' },
  stale: false,
  fileExists: true,
  ...over,
})

let progress: ((p: ShareSetupProgress) => void) | null = null
const writeText = vi.fn(async () => {})
let reactRoot: Root | null = null
let host: HTMLElement

beforeEach(() => {
  share.status.mockReset().mockResolvedValue(OFF)
  share.list.mockReset().mockResolvedValue([])
  share.accounts.mockReset().mockResolvedValue([{ id: 'acc-1', name: 'Me' }])
  share.setup.mockReset().mockImplementation(async () => {
    for (const step of SHARE_SETUP_STEPS) progress?.({ step, state: 'done' })
    share.status.mockResolvedValue(READY)
    return READY
  })
  share.onSetupProgress.mockReset().mockImplementation((listener) => {
    progress = listener
    return () => {
      progress = null
    }
  })
  share.stop.mockClear()
  share.setDomain.mockReset()
  share.disconnect.mockReset().mockResolvedValue(OFF)
  writeText.mockClear()
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
})
afterEach(() => {
  act(() => reactRoot?.unmount())
  reactRoot = null
  host.remove()
  resetLiveShareForTests()
})

const flush = () =>
  act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve()
  })

/** App's wiring: the real hook, the real dialog, opened on the Sharing page. */
function Harness({ root, page }: { root: string | null; page?: 'sharing' }) {
  const sharing = useSharing(root, true)
  return <SettingsDialog ctx={{ settings: { ...DEFAULT_SETTINGS }, onChange: vi.fn(), sharing }} onClose={vi.fn()} initialPage={page} />
}

async function mount(root: string | null = ROOT, page: 'sharing' | undefined = 'sharing') {
  Element.prototype.scrollIntoView = vi.fn()
  host = document.createElement('div')
  document.body.appendChild(host)
  reactRoot = createRoot(host)
  act(() => reactRoot?.render(<Harness root={root} page={page} />))
  await flush()
  return host
}

const $ = (sel: string) => host.querySelector<HTMLElement>(sel)
const byTest = (id: string) => $(`[data-testid="${id}"]`) as HTMLButtonElement
const row = (id: string) => $(`[data-setting="${id}"]`)!
const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === label)!
const click = async (el: Element) => {
  act(() => (el as HTMLElement).click())
  await flush()
}
const type = (el: HTMLInputElement, value: string) =>
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
const keyInput = () => $('input[aria-label="Cloudflare API key"]') as HTMLInputElement
const domainInput = () => $('input[aria-label="Custom domain"]') as HTMLInputElement
const alertText = () => $('[role="alert"]')?.textContent ?? null
const stepState = (step: ShareSetupStep) => $(`[data-step="${step}"]`)?.dataset.state
const boardLines = () => [...host.querySelectorAll('[data-testid="sharing-board-status"]')].map((el) => el.textContent)

describe('Settings › Sharing (YAZ-1889)', () => {
  it('lays the page out top to bottom as approved, as ordinary settings groups', async () => {
    await mount()
    expect([...host.querySelectorAll('.settings-group__title')].map((h) => h.textContent)).toEqual(['Set up sharing', 'Your shared boards', 'Custom domain', 'How sharing works', 'Turn off sharing'])
    expect([...host.querySelectorAll('[data-setting]')].map((r) => (r as HTMLElement).dataset.setting)).toEqual(['sharingStatus', 'sharingSetup', 'sharingBoards', 'sharingDomain', 'sharingHelp', 'sharingTurnOff'])
  })

  it('no button label trails off with "…"', async () => {
    share.list.mockResolvedValue([board('Roadmap')])
    share.status.mockResolvedValue(READY)
    await mount()
    for (const b of host.querySelectorAll('button')) expect(b.textContent).not.toMatch(/…$/)
  })

  it('not set up: says so, and nothing that needs sharing can be pressed', async () => {
    share.list.mockResolvedValue([board('Roadmap')])
    await mount()
    expect(byTest('sharing-status').textContent).toBe('Not set up')
    expect(row('sharingStatus').textContent).toContain('Sharing uses your own free Cloudflare account')
    expect(byTest('sharing-setup').disabled).toBe(true)
    expect(domainInput().disabled).toBe(true)
    expect(row('sharingDomain').textContent).toContain('Set up sharing first.')
    expect(button('Stop sharing').disabled).toBe(true)
    expect(boardLines()).toEqual([])
    expect(byTest('sharing-forget').disabled).toBe(true)
    expect(byTest('sharing-delete-all').disabled).toBe(true)
  })

  it('Open Cloudflare opens the pre-filled token page (main owns the address)', async () => {
    await mount()
    await click(button('Open Cloudflare'))
    expect(share.openCloudflare).toHaveBeenCalledOnce()
  })

  it('setting up with a one-account key: straight into the live step list, then ready', async () => {
    await mount()
    type(keyInput(), ' my-key ')
    await click(byTest('sharing-setup'))
    expect(share.accounts).toHaveBeenCalledWith(' my-key ')
    expect(share.setup).toHaveBeenCalledWith(' my-key ', undefined)
    expect($('[data-testid="sharing-accounts"]')).toBeNull()
    expect(SHARE_SETUP_STEPS.map(stepState)).toEqual(SHARE_SETUP_STEPS.map(() => 'done'))
    expect(keyInput().value).toBe('')
    expect(byTest('sharing-status').textContent).toBe('✅ Sharing ready')
    expect(alertText()).toBeNull()
  })

  it('the step list shows each step as it runs', async () => {
    let finish: () => void = () => {}
    share.setup.mockImplementation(
      () =>
        new Promise((resolve) => {
          progress?.({ step: 'verify', state: 'done', message: 'Key accepted' })
          progress?.({ step: 'account', state: 'running' })
          finish = () => resolve(READY)
        }),
    )
    await mount()
    type(keyInput(), 'k')
    await click(byTest('sharing-setup'))
    expect(stepState('verify')).toBe('done')
    expect($('[data-step="verify"]')?.textContent).toContain('Key accepted')
    expect(stepState('account')).toBe('running')
    expect(stepState('bucket')).toBe('pending')
    expect(byTest('sharing-setup').textContent).toBe('Setting up')
    await act(async () => finish())
  })

  // Main's own words (sharing.ts `explainCloudflareFailure`, `claimSubdomain`, cloudflare.ts `offline`).
  it.each([
    ['an invalid key', "Cloudflare didn't accept this key. Check you copied all of it — or press Open Cloudflare and make a new one."],
    ['no connection', "Can't reach Cloudflare. Check your internet connection and try again."],
  ])('%s: refused before any step runs, said once as an alert', async (_, message) => {
    share.accounts.mockRejectedValue(new BridgeRequestError('PROVIDER_FAILED', message))
    await mount()
    type(keyInput(), 'bad')
    await click(byTest('sharing-setup'))
    expect(alertText()).toBe(message)
    expect($('[data-testid="sharing-steps"]')).toBeNull()
    expect(share.setup).not.toHaveBeenCalled()
    expect(byTest('sharing-status').textContent).toBe('Not set up')
  })

  it.each<[string, ShareSetupStep, string]>([
    ['a missing permission', 'bucket', 'This key is missing the “Workers R2 Storage: Edit” permission. Press Open Cloudflare to make a new key (the page pre-fills every permission sharing needs) and paste that one.'],
    ['R2 not switched on (card on file)', 'bucket', "R2 (Cloudflare's file storage) isn't switched on for this account yet. Cloudflare asks for a payment card on file before it turns R2 on — sharing still stays inside the free tier ($0)."],
    ['no workers.dev subdomain claimed', 'subdomain', "This Cloudflare account has no workers.dev address yet, and Cloudflare didn't let the app make one. Please claim a workers.dev subdomain in the Cloudflare dashboard (Workers & Pages), then run setup again."],
    ['going offline mid-setup', 'worker', "Can't reach Cloudflare. Check your internet connection and try again."],
  ])('%s: the failed step carries the explanation, and it is not said twice', async (_, failedAt, message) => {
    share.setup.mockImplementation(async () => {
      for (const step of SHARE_SETUP_STEPS) {
        if (step === failedAt) {
          progress?.({ step, state: 'failed', message })
          throw new BridgeRequestError('PROVIDER_FAILED', message)
        }
        progress?.({ step, state: 'done' })
      }
      return READY
    })
    await mount()
    type(keyInput(), 'k')
    await click(byTest('sharing-setup'))
    expect(stepState(failedAt)).toBe('failed')
    expect($(`[data-step="${failedAt}"]`)?.textContent).toContain(message)
    expect(alertText()).toBeNull()
    expect(host.textContent?.split(message)).toHaveLength(2)
    expect(byTest('sharing-status').textContent).toBe('Not set up')
    expect(keyInput().value).toBe('k')
  })

  it('a key that sees several accounts: the picker first (D12), then setup on the one picked', async () => {
    share.accounts.mockResolvedValue([
      { id: 'acc-1', name: 'Personal' },
      { id: 'acc-2', name: 'Studio' },
    ])
    await mount()
    type(keyInput(), 'k')
    await click(byTest('sharing-setup'))
    const picker = byTest('sharing-accounts')
    expect(picker.textContent).toContain('This key can see 2 Cloudflare accounts')
    expect(share.setup).not.toHaveBeenCalled()
    expect(byTest('sharing-setup').disabled).toBe(true)
    await click(picker.querySelectorAll('input[type="radio"]')[1])
    await click(byTest('sharing-account-continue'))
    expect(share.setup).toHaveBeenCalledWith('k', 'acc-2')
    expect($('[data-testid="sharing-accounts"]')).toBeNull()
    expect(byTest('sharing-status').textContent).toBe('✅ Sharing ready')
  })

  it('the picker can be cancelled', async () => {
    share.accounts.mockResolvedValue([
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B' },
    ])
    await mount()
    type(keyInput(), 'k')
    await click(byTest('sharing-setup'))
    await click(button('Cancel'))
    expect($('[data-testid="sharing-accounts"]')).toBeNull()
    expect(byTest('sharing-setup').disabled).toBe(false)
  })

  it('ready: the status, the link address and the account; the demo note only in the demo', async () => {
    share.status.mockResolvedValue(READY)
    await mount()
    expect(byTest('sharing-status').textContent).toBe('✅ Sharing ready')
    expect(row('sharingStatus').textContent).toContain('https://yaseen-draw-share.me.workers.dev · Cloudflare account: Me')
    expect(host.textContent).not.toContain('Demo')
    expect(row('sharingSetup').textContent).toContain('Sharing is set up. Paste a key again')
    act(() => reactRoot?.unmount())
    host.remove()
    share.status.mockResolvedValue({ ...READY, demo: true })
    await mount()
    expect(row('sharingStatus').textContent).toContain('Demo: a local stand-in for Cloudflare')
  })

  it('shared boards: name, permission and the one status line per board, including stale and missing', async () => {
    share.status.mockResolvedValue(READY)
    share.list.mockResolvedValue([
      board('Up to date'),
      board('View only', { allowDownload: false }),
      board('Uploading', { sync: { state: 'uploading' } }),
      board('Failed', { sync: { state: 'failed', message: 'The upload failed (HTTP 500). Try again in a moment.' } }),
      board('Stale', { stale: true }),
      board('Gone', { fileExists: false }),
    ])
    await mount()
    const names = [...host.querySelectorAll('.sharing__board-name')].map((n) => n.textContent)
    expect(names).toEqual(['Up to date', 'View only', 'Uploading', 'Failed', 'Stale', 'Gone'])
    const access = [...host.querySelectorAll('.sharing__board')].map((b) => b.children[1].textContent)
    expect(access).toEqual(['View and download', 'View only', 'View and download', 'View and download', 'View and download', 'View and download'])
    const lines = boardLines()
    expect(lines[0]).toMatch(/^Up to date · /)
    expect(lines[2]).toBe('Uploading…')
    expect(lines[3]).toBe("Couldn't update: The upload failed (HTTP 500). Try again in a moment.")
    expect(lines[4]).toMatch(/^Couldn't update: the shared copy is gone from Cloudflare/)
    expect(lines[5]).toMatch(/^No board at this path any more/)
  })

  it('Copy link copies the link; Stop sharing stops it and reads the list again', async () => {
    share.status.mockResolvedValue(READY)
    share.list.mockResolvedValue([board('Roadmap')])
    await mount()
    await click(button('Copy link'))
    expect(writeText).toHaveBeenCalledWith(`${READY.url}/b/Roadmap`)
    expect(button('Copied')).toBeDefined()
    share.list.mockResolvedValue([])
    await click(button('Stop sharing'))
    expect(share.stop).toHaveBeenCalledWith({ root: ROOT, path: '/v/Roadmap.excalidraw' })
    expect(host.querySelector('.sharing__board')).toBeNull()
    expect(row('sharingBoards').textContent).toContain('Nothing in v is shared')
  })

  it('an empty list names the vault by its display name (YAZ-2056 D4)', async () => {
    const vaultName = vi.spyOn(storage, 'vaultName').mockReturnValue('Draw Vault')
    try {
      share.status.mockResolvedValue(READY)
      await mount()
      expect(vaultName).toHaveBeenCalledWith(ROOT)
      expect(row('sharingBoards').textContent).toContain('Nothing in Draw Vault is shared')
    } finally {
      vaultName.mockRestore() // restored even when an expectation fails, so no later test sees the spy
    }
  })

  it('no vault open: the list says to open one', async () => {
    await mount(null)
    expect(share.list).not.toHaveBeenCalled()
    expect(row('sharingBoards').textContent).toBe('Open a vault to see its shared boards.')
  })

  it('custom domain: Attach sends the address, then shows it with Remove', async () => {
    share.status.mockResolvedValue(READY)
    share.setDomain.mockImplementation(async (hostname) => {
      const next = { ...READY, customDomain: hostname, url: hostname === null ? READY.url : `https://${hostname}` }
      share.status.mockResolvedValue(next)
      return next
    })
    await mount()
    type(domainInput(), 'share.example.com')
    await click(byTest('sharing-attach'))
    expect(share.setDomain).toHaveBeenCalledWith('share.example.com')
    expect(byTest('sharing-domain').textContent).toBe('https://share.example.com')
    expect(row('sharingDomain').textContent).toContain('Every link uses this address.')
    await click(button('Remove'))
    expect(share.setDomain).toHaveBeenLastCalledWith(null)
    expect(domainInput().value).toBe('')
  })

  // Main's own words (sharing.ts `setDomain`, `explainCloudflareFailure` 100117).
  it.each([
    ['not on the account', "share.example.com isn't under any domain on your Cloudflare account yet. Add the domain to Cloudflare first (the steps are below), wait until Cloudflare says it is Active, then try again."],
    ['a pending zone', "example.com is on your Cloudflare account but isn't active yet — Cloudflare is still waiting for its nameservers to change at your registrar. Once the Cloudflare dashboard says it is Active (it can take a few hours), try again."],
    ['an existing DNS record', 'That address already has a DNS record (for example a CNAME) in Cloudflare. Delete that record in the Cloudflare dashboard (your domain › DNS › Records) or pick another name, then try again.'],
  ])('custom domain refused (%s): the reason, and the box keeps the address', async (_, message) => {
    share.status.mockResolvedValue(READY)
    share.setDomain.mockRejectedValue(new BridgeRequestError('PROVIDER_FAILED', message))
    await mount()
    type(domainInput(), 'share.example.com')
    await click(byTest('sharing-attach'))
    expect(alertText()).toBe(message)
    expect(domainInput().value).toBe('share.example.com')
    expect($('[data-testid="sharing-domain"]')).toBeNull()
  })

  it('Forget key: a confirm box with the longer explanation, Cancel backs out, confirming forgets and keeps the links', async () => {
    share.status.mockResolvedValue(READY)
    await mount()
    await click(byTest('sharing-forget'))
    expect(byTest('sharing-confirm').textContent).toContain('Links you already shared keep working')
    expect(byTest('sharing-forget').disabled).toBe(true)
    await click(button('Cancel'))
    expect($('[data-testid="sharing-confirm"]')).toBeNull()
    expect(share.disconnect).not.toHaveBeenCalled()
    await click(byTest('sharing-forget'))
    share.status.mockResolvedValue(OFF)
    await click(byTest('sharing-confirm-go'))
    expect(byTest('sharing-confirm-go')).toBeNull()
    expect(share.disconnect).toHaveBeenCalledWith(ROOT, false)
    expect($('[role="status"]')?.textContent).toMatch(/^Key forgotten/)
    expect(byTest('sharing-status').textContent).toBe('Not set up')
  })

  it('Delete all shared links: its own confirm, then everything goes', async () => {
    share.status.mockResolvedValue(READY)
    await mount()
    await click(byTest('sharing-delete-all'))
    expect(byTest('sharing-confirm').textContent).toContain('Every link stops working at once')
    expect(byTest('sharing-confirm-go').textContent).toBe('Delete all shared links')
    await click(byTest('sharing-confirm-go'))
    expect(share.disconnect).toHaveBeenCalledWith(ROOT, true)
    expect($('[role="status"]')?.textContent).toBe('Every shared link was deleted from Cloudflare, and this Mac forgot the key.')
  })

  it('a failed turn-off says why and leaves the confirm box up', async () => {
    share.status.mockResolvedValue(READY)
    share.disconnect.mockRejectedValue(new BridgeRequestError('PROVIDER_FAILED', 'Could not delete the shared boards (HTTP 500); nothing was disconnected. Try again.'))
    await mount()
    await click(byTest('sharing-delete-all'))
    await click(byTest('sharing-confirm-go'))
    expect(alertText()).toMatch(/^Could not delete the shared boards/)
    expect(byTest('sharing-confirm')).not.toBeNull()
  })

  it.each([
    ['cloudflare', 'sharingStatus'],
    ['api key', 'sharingSetup'],
    ['stop sharing', 'sharingBoards'],
    ['custom domain', 'sharingDomain'],
    ['worker', 'sharingHelp'],
    ['forget key', 'sharingTurnOff'],
  ])('search for "%s" reaches the Sharing page', async (query, id) => {
    await mount(ROOT, undefined)
    type($('input[aria-label="Search settings"]') as HTMLInputElement, query)
    expect([...host.querySelectorAll('.settings-section__title')].some((h) => /^Sharing( › |$)/.test(h.textContent ?? ''))).toBe(true)
    expect($(`[data-setting="${id}"]`)).not.toBeNull()
  })
})

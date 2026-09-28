/**
 * SETTINGS › SHARING (YAZ-1799 D7, YAZ-1889): its own page (standalone, like Hotkeys and Storage),
 * built from ordinary settings groups and rows, top to bottom:
 *
 *   Status                 Not set up | ✅ Sharing ready     (hint: link address · account)
 *   Set up sharing         [Open Cloudflare] [paste key] [Set up]
 *                          → account picker, only when the key sees more than one account (D12)
 *                          → the live step list; a failed step carries main's plain-English reason
 *   Your shared boards     name · permission · [Copy link] [Stop sharing] · the one status line
 *   Custom domain          [share.yourdomain.com] [Attach]   |   https://… [Remove]
 *   How sharing works      the plain-English write-up
 *   Turn off sharing       [Forget key on this Mac (links keep working)] [Delete all shared links from Cloudflare]
 *                          each behind a confirm box that carries the longer explanation
 *
 * The data is App's `useSharing` (`ctx.sharing`), so every row reads one status and one list. The
 * key typed here goes to main once (`share:setup`) and is never shown or read back. Every refusal's
 * wording is main's (`explainCloudflareFailure` and friends), shown as it comes.
 */
import { useEffect, useState } from 'react'
import { SHARE_SETUP_LABELS, SHARE_SETUP_STEPS, type ShareListEntry, type ShareSetupProgress, type ShareSetupStep } from '@shared/types'
import { api } from '../api'
import { basename, stripExt } from '../lib/paths'
import { useVaultName } from '../lib/useVaultName'
import type { SettingsCtx, SettingsSection } from '../settings/registry'
import { isPending } from './liveShare'
import { errorText, liveLine, type Line } from './shareText'
import type { SharingState } from './useSharing'
import './share.css'

const isReady = (sharing: SharingState | undefined): boolean => sharing?.status?.state === 'ready'

function ErrorLine({ text }: { text: string | null }) {
  return text === null ? null : (
    <p className="sharing__error" role="alert">
      {text}
    </p>
  )
}

function statusHint({ sharing }: SettingsCtx): string {
  const status = sharing?.status
  if (status == null || status.state !== 'ready') return 'Sharing uses your own free Cloudflare account. Set it up once, below.'
  const parts = [status.url, status.accountName === null ? null : `Cloudflare account: ${status.accountName}`, status.demo ? 'Demo: a local stand-in for Cloudflare' : null]
  return parts.filter((part) => part !== null).join(' · ')
}

function Status({ sharing }: SettingsCtx) {
  if (sharing?.status == null) return null
  return (
    <span data-testid="sharing-status">
      {isReady(sharing) ? '✅ Sharing ready' : 'Not set up'}
    </span>
  )
}

const setupHint = ({ sharing }: SettingsCtx): string =>
  isReady(sharing)
    ? 'Sharing is set up. Paste a key again to repair it or to use another account; your links are kept.'
    : 'Press Open Cloudflare and log in (or make a free account). Every permission sharing needs is already ticked: press Continue to summary, then Create Token, and paste the key here.'

type Steps = Partial<Record<ShareSetupStep, ShareSetupProgress>>
const STEP_ICON = { pending: '○', running: '⏳', done: '✅', failed: '❌' } as const

function SetupSharing({ sharing }: SettingsCtx) {
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** Several accounts behind the key: the picker (D12), and which one is picked. */
  const [accounts, setAccounts] = useState<{ id: string; name: string }[] | null>(null)
  const [picked, setPicked] = useState<string | null>(null)
  const [steps, setSteps] = useState<Steps | null>(null)

  useEffect(() => api.share.onSetupProgress((p) => setSteps((prev) => ({ ...prev, [p.step]: p }))), [])

  /** Without an account: ask which accounts the key sees — one goes straight on, several show the picker, whose Continue comes back here with the pick. */
  const setUp = async (accountId?: string) => {
    setBusy(true)
    setError(null)
    try {
      if (accountId === undefined) {
        setSteps(null)
        const list = await api.share.accounts(token)
        if (list.length > 1) {
          setAccounts(list)
          setPicked(list[0].id)
          return
        }
      }
      setAccounts(null)
      setSteps({})
      await api.share.setup(token, accountId)
      setToken('')
      sharing?.refresh()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const canSetUp = !busy && token.trim() !== '' && accounts === null
  // A failed step already shows the reason; the alert is for a refusal before any step ran.
  const stepFailed = steps !== null && Object.values(steps).some((p) => p.state === 'failed')
  return (
    <>
      <div className="settings__options" role="group" aria-label="Set up sharing">
        <button type="button" className="settings__option" onClick={() => void api.share.openCloudflare()}>
          Open Cloudflare
        </button>
        <input
          type="password"
          className="settings__input settings__input--fill"
          aria-label="Cloudflare API key"
          placeholder="Paste your Cloudflare API key"
          autoComplete="off"
          spellCheck={false}
          value={token}
          disabled={busy}
          onChange={(e) => {
            setToken(e.target.value)
            setAccounts(null)
          }}
          onKeyDown={(e) => e.key === 'Enter' && canSetUp && void setUp()}
        />
        <button type="button" className="settings__option" disabled={!canSetUp} onClick={() => void setUp()} data-testid="sharing-setup">
          {busy ? 'Setting up' : 'Set up'}
        </button>
      </div>
      {accounts !== null && (
        <fieldset className="confirm sharing__inline" data-testid="sharing-accounts">
          <legend>This key can see {accounts.length} Cloudflare accounts. Which one should hold your shared boards?</legend>
          {accounts.map((a) => (
            <label key={a.id}>
              <input type="radio" name="sharing-account" checked={picked === a.id} onChange={() => setPicked(a.id)} />
              {a.name}
            </label>
          ))}
          <div className="settings__options">
            <button type="button" className="settings__option" onClick={() => setAccounts(null)}>
              Cancel
            </button>
            <button type="button" className="settings__option" onClick={() => picked !== null && void setUp(picked)} data-testid="sharing-account-continue">
              Continue
            </button>
          </div>
        </fieldset>
      )}
      {steps !== null && (
        <ul className="sharing__steps" aria-label="Setup progress" data-testid="sharing-steps">
          {SHARE_SETUP_STEPS.map((step) => {
            const state = steps[step]?.state ?? 'pending'
            return (
              <li key={step} data-step={step} data-state={state}>
                <span aria-hidden="true">{STEP_ICON[state]}</span>
                <span>{SHARE_SETUP_LABELS[step]}</span>
                {steps[step]?.message !== undefined && <span className="sharing__step-detail">{steps[step]?.message}</span>}
              </li>
            )
          })}
        </ul>
      )}
      <ErrorLine text={stepFailed ? null : error} />
    </>
  )
}

/** A row's one status line: a board that is gone says so first; otherwise the Share dialog's own line. */
function boardLine(row: ShareListEntry, ready: boolean, now: number): Line | null {
  if (!row.fileExists) return { tone: 'error', text: 'No board at this path any more (renamed, moved or deleted?). The link keeps showing the last version uploaded.' }
  if (!ready) return null
  return liveLine(row, isPending(row.path), now)
}

function SharedBoards({ sharing }: SettingsCtx) {
  const [copied, setCopied] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  // Live (Docs YAZ-1974 D4): another window's rename lands here too. Called before any early return.
  const vaultName = useVaultName(sharing?.root ?? null)
  if (sharing === undefined) return null
  const { root, rows, now } = sharing
  if (root === null) return <p className="sharing__muted">Open a vault to see its shared boards.</p>
  if (rows === null) return null
  const ready = isReady(sharing)

  const copy = async (row: ShareListEntry) => {
    await navigator.clipboard.writeText(row.url)
    setCopied(row.id)
    setTimeout(() => setCopied((id) => (id === row.id ? null : id)), 1500)
  }
  const stop = async (row: ShareListEntry) => {
    setProblem(null)
    try {
      await api.share.stop({ root, path: row.path })
    } catch (err) {
      setProblem(errorText(err))
    }
    sharing.refresh()
  }

  return (
    <>
      {rows.length === 0 ? (
        <p className="sharing__muted">Nothing in {vaultName} is shared. Right-click a board › Share, or File › Share Link (⌘⇧L).</p>
      ) : (
        <ul className="sharing__boards">
          {rows.map((row) => {
            const line = boardLine(row, ready, now)
            return (
              <li key={row.id} className="sharing__board">
                <span className="sharing__board-name" title={row.path}>
                  {stripExt(basename(row.path))}
                </span>
                <span className="sharing__muted">{row.allowDownload ? 'View and download' : 'View only'}</span>
                <span className="settings__options">
                  <button type="button" className="settings__option" onClick={() => void copy(row)} disabled={row.url === ''}>
                    {copied === row.id ? 'Copied' : 'Copy link'}
                  </button>
                  <button type="button" className="settings__option sharing__danger" onClick={() => void stop(row)} disabled={!ready}>
                    Stop sharing
                  </button>
                </span>
                {line !== null && (
                  <span className={`share-status share-status--${line.tone}`} data-testid="sharing-board-status">
                    <span className="share-status__dot" aria-hidden="true" />
                    {line.text}
                  </span>
                )}
              </li>
            )
          })}
        </ul>
      )}
      <ErrorLine text={problem ?? sharing.listError} />
    </>
  )
}

const domainHint = ({ sharing }: SettingsCtx): string =>
  !isReady(sharing) ? 'Set up sharing first.' : sharing?.status?.customDomain != null ? 'Every link uses this address.' : 'Optional: put your links on your own address. The steps are under How sharing works.'

function CustomDomain({ sharing }: SettingsCtx) {
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ready = isReady(sharing)
  const attached = sharing?.status?.customDomain ?? null

  const apply = async (hostname: string | null) => {
    setBusy(true)
    setError(null)
    try {
      await api.share.setDomain(hostname)
      setDraft('')
      sharing?.refresh()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="settings__options" role="group" aria-label="Custom domain">
        {attached !== null ? (
          <>
            <span className="sharing__domain" data-testid="sharing-domain">
              https://{attached}
            </span>
            <button type="button" className="settings__option" onClick={() => void apply(null)} disabled={busy}>
              Remove
            </button>
          </>
        ) : (
          <>
            <input className="settings__input settings__input--fill" aria-label="Custom domain" placeholder="share.yourdomain.com" spellCheck={false} value={draft} onChange={(e) => setDraft(e.target.value)} disabled={!ready || busy} />
            <button type="button" className="settings__option" onClick={() => void apply(draft)} disabled={!ready || busy || draft.trim() === ''} data-testid="sharing-attach">
              {busy ? 'Attaching' : 'Attach'}
            </button>
          </>
        )}
      </div>
      <ErrorLine text={error} />
    </>
  )
}

function HowSharingWorks() {
  return (
    <div className="sharing__help">
      <h4>What sharing does</h4>
      <p>
        Share a board (right-click › Share, or File › Share Link) and it gets one link. Anyone with the link can <strong>view and download</strong> it, or <strong>view only</strong>: you pick in the Share
        dialog and can switch any time, and the link stays the same. Nobody can edit it, and nobody needs an account.
      </p>
      <p>
        The link is <strong>always live</strong>: every save updates it, about ten seconds after you stop drawing, and people just refresh the page. If an upload fails (say you're offline) the link keeps
        the last good version and the next save tries again.
      </p>
      <h4>What a Worker is</h4>
      <p>
        A tiny free program on your Cloudflare account that shows the board to whoever opens the link. The app sets it up and keeps it updated, next to a storage bucket (Cloudflare calls it R2) that holds
        the shared copies. Nothing goes through anyone else's server.
      </p>
      <h4>What it costs</h4>
      <p>
        <strong>$0.</strong> Cloudflare's free tier covers hundreds of shared boards and thousands of views a day. Cloudflare does ask for a payment card on file before it turns R2 on, even on the free tier.
      </p>
      <h4>Turning it off</h4>
      <p>
        Stop sharing (above, or Not shared in the Share dialog) deletes that board's copy, and its link stops at once. Below, you can forget the key on this Mac (links keep their last version) or delete
        every shared link from Cloudflare.
      </p>
      <h4>Using your own domain</h4>
      <ol>
        <li>Add the domain to Cloudflare (Add a domain, in the dashboard) and switch its nameservers, at the company you bought it from, to the two Cloudflare gives you.</li>
        <li>Wait until Cloudflare shows the domain as Active: minutes, or up to a day.</li>
        <li>If Cloudflare already has a DNS record for the address you want, remove it (your domain › DNS › Records).</li>
        <li>
          Type the address, for example <code>share.yourdomain.com</code>, into Custom domain above and press Attach.
        </li>
      </ol>
    </div>
  )
}

const TURN_OFF = {
  forget: {
    ask: "Forget the Cloudflare key on this Mac? Links you already shared keep working and keep showing their last uploaded version, but saving a board no longer updates its link, and this app can't stop a link until you set sharing up again. Setting up again on the same account brings every link back.",
    go: 'Forget key',
    done: 'Key forgotten. Your links keep showing their last version; set sharing up again to update or stop them.',
  },
  delete: {
    ask: "Delete every shared board, the Worker and the storage bucket from your Cloudflare account, and forget the key on this Mac? Every link stops working at once, for good. Your boards on this Mac are not touched. Only the open vault's list of shared boards is cleared: another vault still lists its old links until you stop them there.",
    go: 'Delete all shared links',
    done: 'Every shared link was deleted from Cloudflare, and this Mac forgot the key.',
  },
} as const

function TurnOff({ sharing }: SettingsCtx) {
  const [confirm, setConfirm] = useState<keyof typeof TURN_OFF | null>(null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const ready = isReady(sharing)

  const go = async (kind: keyof typeof TURN_OFF) => {
    setBusy(true)
    setError(null)
    try {
      await api.share.disconnect(sharing?.root ?? null, kind === 'delete')
      setConfirm(null)
      setDone(TURN_OFF[kind].done)
      sharing?.refresh()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="settings__options">
        <button type="button" className="settings__option" onClick={() => setConfirm('forget')} disabled={!ready || confirm !== null} data-testid="sharing-forget">
          Forget key on this Mac (links keep working)
        </button>
        <button type="button" className="settings__option sharing__danger" onClick={() => setConfirm('delete')} disabled={!ready || confirm !== null} data-testid="sharing-delete-all">
          Delete all shared links from Cloudflare
        </button>
      </div>
      {confirm !== null && (
        <div className="confirm sharing__inline" data-testid="sharing-confirm">
          <p className="confirm__text">{TURN_OFF[confirm].ask}</p>
          <div className="settings__options">
            <button type="button" className="settings__option" onClick={() => setConfirm(null)} disabled={busy}>
              Cancel
            </button>
            <button type="button" className="settings__option sharing__danger" onClick={() => void go(confirm)} disabled={busy} data-testid="sharing-confirm-go">
              {busy ? 'Working' : TURN_OFF[confirm].go}
            </button>
          </div>
        </div>
      )}
      {done !== null && (
        <p className="sharing__muted" role="status">
          {done}
        </p>
      )}
      <ErrorLine text={error} />
    </>
  )
}

export const SHARING_SECTION: SettingsSection = {
  id: 'sharing',
  title: 'Sharing',
  standalone: true,
  available: (ctx) => ctx.sharing !== undefined,
  groups: [
    {
      items: [{ id: 'sharingStatus', label: 'Status', hint: statusHint, keywords: ['share', 'link', 'cloudflare', 'account'], render: (ctx) => <Status {...ctx} /> }],
    },
    {
      title: 'Set up sharing',
      items: [{ id: 'sharingSetup', label: 'Cloudflare API key', hint: setupHint, keywords: ['set up', 'token', 'api key'], wide: true, render: (ctx) => <SetupSharing {...ctx} /> }],
    },
    {
      title: 'Your shared boards',
      items: [{ id: 'sharingBoards', label: 'Shared boards', keywords: ['copy link', 'stop sharing', 'view only', 'download', 'stale'], bare: true, render: (ctx) => <SharedBoards {...ctx} /> }],
    },
    {
      title: 'Custom domain',
      items: [{ id: 'sharingDomain', label: 'Domain', hint: domainHint, keywords: ['dns', 'address', 'attach'], wide: true, render: (ctx) => <CustomDomain {...ctx} /> }],
    },
    {
      title: 'How sharing works',
      items: [{ id: 'sharingHelp', label: 'How sharing works', keywords: ['worker', 'r2', 'cost', 'free', 'price', 'card', 'live', 'nameservers'], bare: true, render: () => <HowSharingWorks /> }],
    },
    {
      title: 'Turn off sharing',
      items: [{ id: 'sharingTurnOff', label: 'Turn off sharing', keywords: ['disconnect', 'forget key', 'delete all shared links'], bare: true, render: (ctx) => <TurnOff {...ctx} /> }],
    },
  ],
}

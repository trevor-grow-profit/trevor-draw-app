/**
 * The one way a spec starts the app: the BUILT app (`desktop/out`, from `npm run build`) under
 * Playwright's Electron launcher, with a throwaway profile (`YASEEN_DRAW_USER_DATA_DIR`) and
 * vaults inside the test's own temp sandbox. Nothing here can reach the real profile or a real
 * vault: every path a test hands the app is under `sandbox.dir`.
 */
import { test as base, expect, _electron, type ElectronApplication, type Page } from '@playwright/test'
import type { ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REPO, writeProfile, writeVault, type ProfileSpec, type VaultFiles } from './vault'

const APP_DIR = join(REPO, 'desktop')
/**
 * `E2E_PACKAGED=1` runs the suite against the packaged bundle from `npm run desktop:build` instead of
 * `desktop/out` — the build a user installs (its own draw.io and share-viewer paths, `isPackaged`).
 */
export const PACKAGED = process.env.E2E_PACKAGED === '1'
const PACKAGED_BIN = join(REPO, 'desktop/dist-app/mac-arm64/Yaseen Draw.app/Contents/MacOS/Yaseen Draw')
/** In node, the `electron` package's export is the path of its binary. */
const DEV_BIN = createRequire(__filename)('electron') as string

/** The app's own command line — what a second launch or a double-click would run — plus `extra`. */
export function appCommand(extra: string[] = []): { command: string; args: string[] } {
  return PACKAGED ? { command: PACKAGED_BIN, args: ['-r', MAIN_HOOK, ...extra] } : { command: DEV_BIN, args: ['-r', MAIN_HOOK, APP_DIR, ...extra] }
}
const MAIN_HOOK = join(__dirname, 'mainHook.cjs')
/** A quit is renderers-flush (5 s cap each) + exit; past this the sequence is stuck, not slow. */
const QUIT_TIMEOUT_MS = 30_000
const EXIT_GRACE_MS = 3_000
const ACTION_TIMEOUT_MS = 15_000

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
/** Resolves when `check()` holds, or after `timeoutMs` either way. */
async function until(check: () => boolean, timeoutMs: number): Promise<void> {
  const end = Date.now() + timeoutMs
  while (!check() && Date.now() < end) await sleep(50)
}

export class Sandbox {
  readonly profile: string
  constructor(readonly dir: string) {
    this.profile = join(dir, 'profile')
  }
  path(...parts: string[]): string {
    return join(this.dir, ...parts)
  }
  /** A vault folder `<sandbox>/<name>` holding `files`. */
  vault(name: string, files: VaultFiles = {}): string {
    return writeVault(this.path(name), files)
  }
  writeProfile(spec: ProfileSpec): void {
    writeProfile(this.profile, spec)
  }
  /** The OS hand-offs the app made (support/mainHook.cjs), oldest first. */
  osCalls(): { call: string; arg: string }[] {
    const log = this.path('os-calls.jsonl')
    if (!existsSync(log)) return []
    return readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  }
  /** Names in the sandbox's stand-in Trash, without the timestamp prefix mainHook adds. */
  trashed(): string[] {
    const trash = this.path('Trash')
    return existsSync(trash) ? readdirSync(trash).map((name) => name.replace(/^\d+-/, '')) : []
  }
}

export interface LaunchOptions {
  /** Extra argv after the app dir — e.g. a board path, as a Finder double-click on Windows would pass. */
  args?: string[]
  env?: Record<string, string>
}

/** A running app: its Electron handle plus the helpers every spec needs. */
export class DrawApp {
  private readonly proc: ChildProcess

  private constructor(
    readonly electron: ElectronApplication,
    private readonly sandbox: Sandbox,
  ) {
    this.proc = electron.process()
  }

  static async launch(sandbox: Sandbox, { args = [], env = {} }: LaunchOptions = {}): Promise<DrawApp> {
    mkdirSync(sandbox.profile, { recursive: true })
    const { command, args: argv } = appCommand(args)
    const electron = await _electron.launch({
      // Unpackaged, Playwright finds the dev binary itself (and preloads its own loader first).
      ...(PACKAGED ? { executablePath: command } : {}),
      args: argv,
      env: { ...process.env, ...env, YASEEN_DRAW_USER_DATA_DIR: sandbox.profile, E2E_SANDBOX: sandbox.dir },
      cwd: REPO,
      // Playwright emulates a light `prefers-color-scheme` by default; the app must see the OS's
      // (i.e. `nativeTheme.themeSource`, which the Theme setting drives).
      colorScheme: null,
    })
    if (PACKAGED) await electron.evaluate((_electron, hook) => void process.mainModule?.require(hook), MAIN_HOOK)
    // Config `use` options only reach contexts Playwright creates; this one Electron made.
    electron.context().setDefaultTimeout(ACTION_TIMEOUT_MS)
    return new DrawApp(electron, sandbox)
  }

  /** The first window, loaded. */
  async window(): Promise<Page> {
    const page = await this.electron.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    return page
  }

  /** Waits until exactly `n` windows are open and returns them in creation order. */
  async windows(n: number): Promise<Page[]> {
    await expect.poll(() => this.electron.windows().length, { message: `expected ${n} windows` }).toBe(n)
    const pages = this.electron.windows()
    await Promise.all(pages.map((p) => p.waitForLoadState('domcontentloaded')))
    return pages
  }

  /**
   * Clicks an application-menu item by its stable id (desktop/src/main/menu.ts), aimed at `page`'s
   * window. Main rebuilds the menu when focus or the front tab moves, so an item that depends on
   * the front board is waited for — the same moment a user would see it enabled.
   */
  async menu(id: string, page?: Page): Promise<void> {
    if (page !== undefined) await this.focus(page)
    await expect.poll(() => this.menuEnabled(id), { message: `menu item ${id} enabled` }).toBe(true)
    await this.electron.evaluate(({ Menu }, itemId) => Menu.getApplicationMenu()?.getMenuItemById(itemId)?.click(), id)
  }

  /** Whether a menu item is enabled right now (🔒 YAZ-1775 D10 enablement by the active board's kind). */
  menuEnabled(id: string): Promise<boolean | null> {
    return this.electron.evaluate(({ Menu }, itemId) => Menu.getApplicationMenu()?.getMenuItemById(itemId)?.enabled ?? null, id)
  }

  /**
   * Every request any window makes to somewhere other than the app itself (`app:`, `data:`, `blob:`):
   * `attempted` (whatever the page tried) and `reached` (what actually got an answer — a request the
   * CSP blocks is attempted, not reached). Start it before the page acts.
   */
  outsideRequests(): { attempted: string[]; reached: string[] } {
    const log = { attempted: [] as string[], reached: [] as string[] }
    const outside = (url: string) => !/^(app|data|blob):/.test(url)
    this.electron.context().on('request', (req) => void (outside(req.url()) && log.attempted.push(req.url())))
    this.electron.context().on('requestfinished', (req) => void (outside(req.url()) && log.reached.push(req.url())))
    return log
  }

  /**
   * Brings `page`'s window to the front the way a click on it does: the app is activated first —
   * with several test apps running side by side, a window focused inside an inactive app gets no
   * `focus` event, and main rebuilds the menu's enablement on that event.
   */
  async focus(page: Page): Promise<void> {
    await this.electron.evaluate(({ app }) => app.focus({ steal: true }))
    const win = await this.electron.browserWindow(page)
    await win.evaluate((w) => w.focus())
  }

  /**
   * ⌘Q: the app's own quit sequence (renderers flush, then `app.exit`). Resolves once the process
   * is gone. Electron's own teardown after `app.exit` can stall for many seconds on a busy Mac, so
   * once the sequence has provably finished (support/mainHook.cjs's marker) a process still
   * lingering after EXIT_GRACE_MS is killed — everything the app writes on quit is written by then.
   */
  quit(): Promise<void> {
    return this.endBy(() => void this.electron.close().catch(() => {}))
  }

  /**
   * A shutdown signal — SIGTERM from a logout or `kill`, SIGINT from a terminal's ⌃C. Electron turns
   * it into `app.quit()`, so it runs the same quit sequence as ⌘Q (YAZ-2073 2G); resolves as `quit`.
   */
  terminate(signal: 'SIGTERM' | 'SIGINT' = 'SIGTERM'): Promise<void> {
    return this.endBy(() => void this.proc.kill(signal))
  }

  private async endBy(start: () => void): Promise<void> {
    const { proc } = this
    if (proc.exitCode !== null || proc.signalCode !== null) return
    const marker = join(this.sandbox.dir, 'quit.marker')
    rmSync(marker, { force: true })
    const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()))
    start()
    const gone = await Promise.race([exited.then(() => true), until(() => existsSync(marker), QUIT_TIMEOUT_MS).then(() => false)])
    if (gone) return
    if (!existsSync(marker)) {
      this.kill()
      throw new Error(`the app's quit sequence did not finish within ${QUIT_TIMEOUT_MS} ms`)
    }
    const late = await Promise.race([exited.then(() => false), sleep(EXIT_GRACE_MS).then(() => true)])
    if (late) {
      this.kill()
      await exited
    }
  }

  /**
   * Last resort: SIGKILL the app's whole process group. Killing main alone orphans its helpers
   * (the network service keeps the stdio pipes open and the worker never finishes).
   */
  kill(): void {
    const { proc } = this
    if (proc.exitCode !== null || proc.signalCode !== null || proc.pid === undefined) return
    try {
      process.kill(-proc.pid, 'SIGKILL')
    } catch {
      proc.kill('SIGKILL')
    }
  }
}

export interface Fixtures {
  sandbox: Sandbox
  /** Launches the app on `sandbox.profile`; every app launched this way is quit (or killed) after the test. */
  launch: (options?: LaunchOptions) => Promise<DrawApp>
}

/** macOS's tmpdir is a symlink (/var → /private/var); the real path is what the app reports back. */
const RUN_DIR = join(realpathSync(tmpdir()), 'yaseen-draw-e2e')

export const test = base.extend<Fixtures>({
  // eslint-disable-next-line no-empty-pattern
  sandbox: async ({}, use, testInfo) => {
    mkdirSync(RUN_DIR, { recursive: true })
    const dir = mkdtempSync(join(RUN_DIR, `${testInfo.workerIndex}-`))
    await use(new Sandbox(dir))
    if (testInfo.status === testInfo.expectedStatus && process.env.E2E_KEEP !== '1') rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
  },
  launch: async ({ sandbox }, use) => {
    const apps: DrawApp[] = []
    await use(async (options) => {
      const app = await DrawApp.launch(sandbox, options)
      apps.push(app)
      return app
    })
    for (const app of apps) {
      await app.quit().catch(() => app.kill())
    }
  },
})

export { expect }

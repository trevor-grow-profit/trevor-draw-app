/**
 * Builders for what a test puts on disk: vault files, Excalidraw scenes, draw.io XML and the app's
 * `yaseendraw.json` profile. No app code is imported, so a test states the on-disk shape it expects
 * in its own words, the way a user's older file would look. The PNG encoder, scene, git and profile
 * writers are the seed scripts' own (tools/lib/seedKit.mjs); the elements are this suite's, with the
 * ids a test names them by.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileIdFor } from '../../tools/lib/seedDemoVault.mjs'
import { GIT_ENV, git, json, profileWindow, publish, scene as sceneOf, writeState } from '../../tools/lib/seedKit.mjs'

export { fileIdFor }
export { embedded, solidPNG } from '../../tools/lib/seedKit.mjs'

export const REPO = resolve(__dirname, '../..')

// ---------------------------------------------------------------- scenes

let seq = 0
const base = (id: string, extra: Record<string, unknown>) => ({
  id,
  angle: 0,
  strokeColor: '#1e1e1e',
  backgroundColor: '#a5d8ff',
  fillStyle: 'solid',
  strokeWidth: 2,
  strokeStyle: 'solid',
  roughness: 0,
  opacity: 100,
  groupIds: [],
  frameId: null,
  roundness: null,
  seed: ++seq,
  version: 1,
  versionNonce: seq,
  isDeleted: false,
  boundElements: null,
  updated: 1,
  link: null,
  locked: false,
  ...extra,
})

export const rect = (id: string, x = 0, y = 0, width = 200, height = 120, extra: Record<string, unknown> = {}) =>
  base(id, { type: 'rectangle', x, y, width, height, ...extra })

export const text = (id: string, value: string, x = 0, y = 0) =>
  base(id, { type: 'text', x, y, width: value.length * 11, height: 25, text: value, originalText: value, fontSize: 20, fontFamily: 5, textAlign: 'left', verticalAlign: 'top', containerId: null, autoResize: true, lineHeight: 1.25, backgroundColor: 'transparent' })

export const frame = (id: string, name: string, x: number, y: number, width = 400, height = 300) =>
  base(id, { type: 'frame', x, y, width, height, name, backgroundColor: 'transparent' })

export interface SceneOptions {
  background?: string
  files?: Record<string, unknown>
}

export const scene = (elements: unknown[] = [], { background = '#ffffff', files = {} }: SceneOptions = {}): string => json(sceneOf('yaseen-draw-e2e', elements, { bg: background, files }))

/** `scene` with the app's own dates block as its first key (🔒 YAZ-1834), as main writes it. */
export const stampedScene = (elements: unknown[], createdAt: number, updatedAt: number): string =>
  json(sceneOf('yaseen-draw-e2e', elements, { block: { createdAt, updatedAt } }))

/** A one-page draw.io file holding `cells` (mxCell XML) under the default parent. */
export const diagram = (cells = '') =>
  `<mxfile><diagram id="p1" name="Page-1"><mxGraphModel grid="0" page="0"><root><mxCell id="0" /><mxCell id="1" parent="0" />${cells}</root></mxGraphModel></diagram></mxfile>\n`

export const diagramBox = (id: string, label: string, x = 40, y = 40) =>
  `<mxCell id="${id}" value="${label}" style="rounded=0;whiteSpace=wrap;html=1;" vertex="1" parent="1"><mxGeometry x="${x}" y="${y}" width="120" height="60" as="geometry" /></mxCell>`

// ---------------------------------------------------------------- images

export const imageElement = (id: string, fileId: string, x = 0, y = 0, width = 160, height = 120) =>
  base(id, { type: 'image', x, y, width, height, fileId, status: 'saved', scale: [1, 1], crop: null, backgroundColor: 'transparent' })

// ---------------------------------------------------------------- reading boards back

export interface SceneFile {
  yaseendraw?: { createdAt: number; updatedAt: number }
  elements: { id: string; type: string; isDeleted?: boolean; fileId?: string; [key: string]: unknown }[]
  appState?: Record<string, unknown>
  files?: Record<string, unknown>
}

export const readScene = (path: string): SceneFile => JSON.parse(readFileSync(path, 'utf8')) as SceneFile

/** `readScene` for a poll: a half-written or missing file reads as null, and the poll asks again. */
export function sceneOr(path: string): SceneFile | null {
  try {
    return readScene(path)
  } catch {
    return null
  }
}

/** Live (not deleted) elements of a board on disk; a half-written or missing file reads as null. */
export const liveElements = (path: string): SceneFile['elements'] | null => sceneOr(path)?.elements.filter((el) => el.isDeleted !== true) ?? null

/** `path`'s text, or `fallback` while it is missing (not written yet, or mid-rename). */
export function readOr(path: string, fallback = ''): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return fallback
  }
}

/** `path`'s mtime, or null while it is missing (a rename in flight). */
const mtimeOf = (path: string): number | null => statSync(path, { throwIfNoEntry: false })?.mtimeMs ?? null

/**
 * Resolves once `path` has not been written for `quietMs`. One gesture can autosave more than once
 * (the stroke, then the engine's own follow-up update ~500 ms later), so "the file has my edit" is
 * not yet "the editor is done writing".
 */
export async function writesSettled(path: string, quietMs = 1_200, timeoutMs = 20_000): Promise<void> {
  const end = Date.now() + timeoutMs
  let last = mtimeOf(path)
  let since = Date.now()
  while (Date.now() - since < quietMs) {
    if (Date.now() > end) throw new Error(`${path} kept changing for ${timeoutMs} ms`)
    await new Promise((resolve) => setTimeout(resolve, 50))
    const now = mtimeOf(path)
    if (now !== last) {
      last = now
      since = Date.now()
    }
  }
}

/**
 * Asserts `read()` answers the same for all of `ms` — "nothing happens", checked throughout rather
 * than once after a fixed wait. `read` is re-asked every 50 ms; the first different answer fails.
 */
export async function unchangedFor<T>(ms: number, read: () => T | Promise<T>): Promise<void> {
  const first = await read()
  for (const end = Date.now() + ms; Date.now() < end; ) {
    await new Promise((resolve) => setTimeout(resolve, 50))
    const now = await read()
    if (now !== first) throw new Error(`expected no change for ${ms} ms, but ${String(first)} became ${String(now)}`)
  }
}

/**
 * Another program's save, done the way editors and sync tools do it: a temp file renamed over the
 * target. (The suite also covers a plain in-place `writeFileSync`, which truncates then writes — see
 * autosave.spec.ts.)
 */
export function writeOutside(path: string, content: string): void {
  writeFileSync(`${path}.outside-tmp`, content)
  renameSync(`${path}.outside-tmp`, path)
}

// ---------------------------------------------------------------- vaults

/** Files by vault-relative path; a string is written as-is, `null` makes a folder. */
export type VaultFiles = Record<string, string | Buffer | null>

export function writeVault(root: string, files: VaultFiles): string {
  mkdirSync(root, { recursive: true })
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel)
    if (content === null) {
      mkdirSync(abs, { recursive: true })
      continue
    }
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
  return root
}

/** A vault committed and pushed to a bare origin beside it (the seed kit's `publish`), sync switched on (YAZ-1081). */
export function gitVault(root: string, { sync = true }: { sync?: boolean } = {}): { root: string; origin: string } {
  const origin = `${root}.origin.git`
  if (sync) writeVault(root, { '.yaseendraw/github.json': `${JSON.stringify({ enabled: true })}\n` })
  publish(root, origin, 'seed')
  return { root, origin }
}

/** `git` in `cwd` (none of this machine's git config), its output trimmed. */
export const gitIn = (cwd: string, ...args: string[]): string => git(cwd, args)

/** Runs one of `tools/seed*.mjs` with the same node that runs the tests. */
export function runSeed(script: string, args: string[]): string {
  return execFileSync(process.execPath, [join(REPO, 'tools', script), ...args], { cwd: REPO, stdio: 'pipe', env: GIT_ENV }).toString()
}

// ---------------------------------------------------------------- the app profile

export interface WindowSpec {
  id?: string
  root: string | null
  file?: string | null
  tabs?: string[]
  sidebarCollapsed?: boolean
  sidebarLens?: 'files' | 'favorites'
  bounds?: { x: number; y: number; width: number; height: number }
}

export interface ProfileSpec {
  windows?: WindowSpec[]
  settings?: Record<string, unknown>
  recents?: string[]
  folders?: Record<string, unknown>
  sidebarWidth?: number
}

/**
 * Writes `<profile>/yaseendraw.json` in the schema of docs/CONTRACTS.md "App state schema": light
 * theme, each window staggered on screen, recents = the windows' vaults unless given.
 */
export function writeProfile(profile: string, spec: ProfileSpec = {}): void {
  const windows = (spec.windows ?? []).map((w, i) => {
    const tabs = w.tabs ?? (w.file ? [w.file] : [])
    const file = w.file ?? tabs[tabs.length - 1]
    return profileWindow({ ...w, id: w.id ?? `w${i + 1}`, file, tabs, bounds: w.bounds ?? { x: 40 + i * 40, y: 40 + i * 40, width: 1280, height: 820 } })
  })
  const roots = (spec.windows ?? []).map((w) => w.root).filter((r): r is string => r !== null)
  const recents = (spec.recents ?? [...new Set(roots)]).map((path, i) => ({ path, lastOpened: 1_700_000_000_000 - i }))
  writeState(profile, { theme: 'light', settings: spec.settings, sidebarWidth: spec.sidebarWidth ?? 280, recents, windows, folders: spec.folders })
}

export const readProfile = (profile: string): { windows: Required<WindowSpec>[]; settings: Record<string, unknown>; recents: { path: string }[]; [k: string]: unknown } =>
  JSON.parse(readFileSync(join(profile, 'yaseendraw.json'), 'utf8'))

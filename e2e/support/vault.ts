/**
 * Builders for what a test puts on disk: vault files, Excalidraw scenes, draw.io XML and the app's
 * `yaseendraw.json` profile. Plain node — no app code is imported, so a test states the on-disk
 * shape it expects in its own words, the way a user's older file would look.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'
import { createHash } from 'node:crypto'

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

export const scene = (elements: unknown[] = [], { background = '#ffffff', files = {} }: SceneOptions = {}) =>
  `${JSON.stringify({ type: 'excalidraw', version: 2, source: 'yaseen-draw-e2e', elements, appState: { viewBackgroundColor: background, gridSize: 20 }, files }, null, 2)}\n`

/** `scene` with the app's own dates block as its first key (🔒 YAZ-1834), as main writes it. */
export const stampedScene = (elements: unknown[], createdAt: number, updatedAt: number) =>
  `${JSON.stringify({ yaseendraw: { createdAt, updatedAt }, ...JSON.parse(scene(elements)) }, null, 2)}\n`

/** A one-page draw.io file holding `cells` (mxCell XML) under the default parent. */
export const diagram = (cells = '') =>
  `<mxfile><diagram id="p1" name="Page-1"><mxGraphModel grid="0" page="0"><root><mxCell id="0" /><mxCell id="1" parent="0" />${cells}</root></mxGraphModel></diagram></mxfile>\n`

export const diagramBox = (id: string, label: string, x = 40, y = 40) =>
  `<mxCell id="${id}" value="${label}" style="rounded=0;whiteSpace=wrap;html=1;" vertex="1" parent="1"><mxGeometry x="${x}" y="${y}" width="120" height="60" as="geometry" /></mxCell>`

// ---------------------------------------------------------------- images

const chunk = (type: string, data: Buffer) => {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const out = Buffer.alloc(8 + data.length + 4)
  out.writeUInt32BE(data.length, 0)
  body.copy(out, 4)
  out.writeUInt32BE(crc32(body), 8 + data.length)
  return out
}

/** A solid-colour RGB PNG — distinct colours are distinct bytes, so distinct content ids. */
export function png(width: number, height: number, [r, g, b]: [number, number, number]): Buffer {
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3).map((_, i) => [r, g, b][i % 3])])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr.set([8, 2, 0, 0, 0], 8)
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(Array(height).fill(row)))), chunk('IEND', Buffer.alloc(0))])
}

/** Excalidraw's own image id: the SHA-1 of the bytes (🔒 YAZ-1775 D3) — also the asset's file name. */
export const fileIdOf = (bytes: Buffer): string => createHash('sha1').update(bytes).digest('hex')

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

/** Live (not deleted) elements of a board on disk; a half-written or missing file reads as null. */
export function liveElements(path: string): SceneFile['elements'] | null {
  try {
    return readScene(path).elements.filter((el) => el.isDeleted !== true)
  } catch {
    return null
  }
}

/**
 * Resolves once `path` has not been written for `quietMs`. One gesture can autosave more than once
 * (the stroke, then the engine's own follow-up update ~500 ms later), so "the file has my edit" is
 * not yet "the editor is done writing".
 */
export async function writesSettled(path: string, quietMs = 1_200, timeoutMs = 20_000): Promise<void> {
  const end = Date.now() + timeoutMs
  let last = statSync(path).mtimeMs
  let since = Date.now()
  while (Date.now() - since < quietMs) {
    if (Date.now() > end) throw new Error(`${path} kept changing for ${timeoutMs} ms`)
    await new Promise((resolve) => setTimeout(resolve, 50))
    const now = statSync(path).mtimeMs
    if (now !== last) {
      last = now
      since = Date.now()
    }
  }
}

/**
 * Another program's save, done the way editors and sync tools do it: a temp file renamed over the
 * target. (A plain in-place `writeFileSync` truncates then writes, and the watcher can report that
 * as two changes — see the note in autosave.spec.ts.)
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

/** `git init` a vault with one commit and a bare origin beside it, sync switched on (YAZ-1081). */
export function gitVault(root: string, { sync = true }: { sync?: boolean } = {}): { root: string; origin: string } {
  const origin = `${root}.origin.git`
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe', env: gitEnv() }).toString()
  mkdirSync(origin, { recursive: true })
  git(origin, 'init', '--bare', '-b', 'main')
  if (sync) writeVault(root, { '.yaseendraw/github.json': `${JSON.stringify({ enabled: true })}\n` })
  git(root, 'init', '-b', 'main')
  git(root, 'config', 'user.name', 'E2E')
  git(root, 'config', 'user.email', 'e2e@example.invalid')
  git(root, 'config', 'commit.gpgsign', 'false')
  git(root, 'add', '-A')
  git(root, 'commit', '-m', 'seed')
  git(root, 'remote', 'add', 'origin', origin)
  git(root, 'push', '-u', 'origin', 'main')
  return { root, origin }
}

/** Git with no user/system config leaking in (signing, hooks, templates). */
export const gitEnv = (): NodeJS.ProcessEnv => ({ ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' })

export const gitIn = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, stdio: 'pipe', env: gitEnv() }).toString()

/** Runs one of `tools/seed*.mjs` with the same node that runs the tests. */
export function runSeed(script: string, args: string[]): string {
  return execFileSync(process.execPath, [join(REPO, 'tools', script), ...args], { cwd: REPO, stdio: 'pipe', env: gitEnv() }).toString()
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

/** Writes `<profile>/yaseendraw.json` in the schema of docs/CONTRACTS.md "App state schema". */
export function writeProfile(profile: string, spec: ProfileSpec = {}): void {
  const windows = (spec.windows ?? []).map((w, i) => {
    const tabs = w.tabs ?? (w.file ? [w.file] : [])
    return {
      id: w.id ?? `w${i + 1}`,
      root: w.root,
      file: w.file ?? tabs[tabs.length - 1] ?? null,
      tabs,
      sidebarCollapsed: w.sidebarCollapsed ?? false,
      sidebarLens: w.sidebarLens ?? 'files',
      focusDirs: [],
      focusFavorites: [],
      bounds: w.bounds ?? { x: 40 + i * 40, y: 40 + i * 40, width: 1280, height: 820 },
    }
  })
  const roots = windows.map((w) => w.root).filter((r): r is string => r !== null)
  const recents = (spec.recents ?? [...new Set(roots)]).map((path, i) => ({ path, lastOpened: 1_700_000_000_000 - i }))
  const state = {
    version: 1,
    settings: { theme: 'light', confirmDelete: true, ...spec.settings },
    sidebarWidth: spec.sidebarWidth ?? 280,
    recents,
    windows,
    folders: spec.folders ?? {},
  }
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, 'yaseendraw.json'), `${JSON.stringify(state, null, 2)}\n`)
}

export const readProfile = (profile: string): { windows: Required<WindowSpec>[]; settings: Record<string, unknown>; recents: { path: string }[]; [k: string]: unknown } =>
  JSON.parse(readFileSync(join(profile, 'yaseendraw.json'), 'utf8'))

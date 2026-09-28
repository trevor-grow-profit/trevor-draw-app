import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The engine-owned class names this app reaches into (🔒 YAZ-2073 D16): the fork renders them, our
 * CSS and code depend on them, and a rename in an engine bump would fail silently — a panel restyled
 * back, presenting chrome left showing, a focus handoff going nowhere. This pins both ends: the
 * vendored engine still renders every one, and every engine class our CSS selects is listed here.
 * Each pin names the ONE file of ours that depends on it, and the no-stale-pin check reads only that
 * file: `.sidebar` and `.sidebar__header` are the app's own sidebar classes too, so a check across
 * every file would always pass (YAZ-2073 8B).
 * `tools/packEngine.mjs` is the bump; a red test here is the re-check its header asks for.
 */
const ENGINE_CLASSES: Record<string, [file: string, why: string]> = {
  excalidraw: ['drawings/drawingEditor.css', 'scopes every in-engine rule (the rail, the docked panel) under it'],
  'theme--dark': ['drawings/drawingEditor.css', 'the dark-mode parity rule'],
  'main-menu-trigger': ['drawings/drawingEditor.css', 'the hamburger beside the rail'],
  'default-sidebar': ['drawings/drawingEditor.css', 'the docked canvas panel'],
  sidebar__header: ['drawings/drawingEditor.css', 'the docked panel header'],
  'sidebar-triggers': ['drawings/drawingEditor.css', 'the panel tab triggers'],
  sidebar__header__buttons: ['drawings/drawingEditor.css', 'the panel header buttons'],
  sidebar: ['drawings/presentation/presentation.css', 'hides the canvas panel while presenting'],
  'layer-ui__wrapper': ['drawings/presentation/presentation.css', 'hides the toolbar, properties and footer while presenting'],
  'App-top-bar': ['drawings/presentation/presentation.css', 'hides the top bar while presenting'],
  'App-bottom-bar': ['drawings/presentation/presentation.css', 'hides the bottom bar while presenting'],
  'excalidraw-container': ['drawings/ExcalidrawSurface.tsx', 'focuses it when a tab is revealed (focusHandoff)'],
}

const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]))
const read = (files: string[]) => files.map((f) => readFileSync(f, 'utf8')).join('\n')
/** A class name as the engine or our TSX writes it: a whole token inside a string. */
const writes = (src: string, cls: string) => new RegExp(`["'\`\\s]${cls}["'\`\\s]`).test(src)

const engineJs = read(walk(dirname(createRequire(import.meta.url).resolve('@excalidraw/excalidraw'))).filter((f) => f.endsWith('.js')))
const src = join(__dirname, '..')
const ours = walk(src).filter((f) => !f.includes('.test.'))
const ourCss = ours.filter((f) => f.endsWith('.css'))
const ourCode = read(ours.filter((f) => /\.tsx?$/.test(f)))

/** Every class a stylesheet's selectors name (comments and at-rule preludes skipped). */
function selectedClasses(css: string): Set<string> {
  const out = new Set<string>()
  for (const [, selector] of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{};]+)\{/g)) {
    if (selector.trim().startsWith('@')) continue
    for (const [, cls] of selector.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) out.add(cls)
  }
  return out
}

describe('engine-owned selectors (🔒 YAZ-2073 D16)', () => {
  it.each(Object.keys(ENGINE_CLASSES))('the vendored engine still renders .%s', (cls) => {
    expect(writes(engineJs, cls)).toBe(true)
  })

  it.each(Object.entries(ENGINE_CLASSES))('the app still depends on .%s (no stale pin)', (cls, [file]) => {
    const text = readFileSync(join(src, file), 'utf8')
    expect(file.endsWith('.css') ? selectedClasses(text).has(cls) : text.includes(`.${cls}`)).toBe(true)
  })

  it('pins every class our CSS selects that only the engine renders', () => {
    const unpinned = ourCss.flatMap((f) => [...selectedClasses(readFileSync(f, 'utf8'))].filter((cls) => writes(engineJs, cls) && !writes(ourCode, cls) && !(cls in ENGINE_CLASSES)))
    expect(unpinned).toEqual([])
  })
})

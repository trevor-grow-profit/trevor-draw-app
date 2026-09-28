/**
 * The perf scenarios (YAZ-2073 1B). Each has a `setup(dir)` that writes its fixture once, and a
 * `run(app, fx)` that launches the app ONCE on the fixture's profile and returns flat metrics
 * (ms / MB / s / %). The runner repeats `run`, drops the warm-up and summarizes. The profile
 * persists across runs (Chromium's caches warm like a real relaunch); the window list and any
 * board a run edits are rewritten first, so every run starts from the same state.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { cpuSeconds, footprintMb, helpers, launch, sleep } from './lib/app.mjs'
import { FRAME_SAMPLER } from './lib/stats.mjs'
import { flowDiagram, imageBoard, legacyBoard, shapesBoard, writeBoardVault, writeProfile } from './lib/fixtures.mjs'

/** The tab in front: every visited tab stays mounted (🔒 D8), the others are hidden layers. */
const ACTIVE = '.tabstack__layer:not(.tabstack__layer--hidden)'
const CANVAS = `(() => { const c = document.querySelector('${ACTIVE} .excalidraw canvas.excalidraw__canvas'); return !!c && c.width > 0 })()`
const row = (name) => `[...document.querySelectorAll('[role=treeitem]')].find((r) => r.textContent.trim().startsWith(${JSON.stringify(name)}))`
const center = (selector) => `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2] })()`
const click = (selector) => `document.querySelector(${JSON.stringify(selector)}).click()`
/** The engine's API, found through React's fiber tree — read-only introspection, so a scenario can check what it did. */
const API = `(() => { const el = document.querySelector('${ACTIVE} .drawing-surface'); const k = el && Object.keys(el).find((k) => k.startsWith('__reactFiber')); const q = k ? [el[k]] : []; while (q.length) { const f = q.shift(); if (f.memoizedProps?.excalidrawAPI) return f.memoizedProps.excalidrawAPI; if (f.child) q.push(f.child); if (f.sibling) q.push(f.sibling) } return null })()`

const LIGHT = 'Light.excalidraw'

/** A vault holding the light board the window opens on, plus whatever `extra` writes; and its profile. */
function vaultWith(dir, extra = () => {}) {
  const vault = path.join(dir, 'vault')
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(vault, { recursive: true })
  fs.writeFileSync(path.join(vault, LIGHT), shapesBoard(20, 1))
  return { vault, profile: path.join(dir, 'profile'), ...extra(vault) }
}

/** Launch on the light board, wait for its canvas, run `act`, and always quit. */
async function session(app, fx, act, { theme } = {}) {
  writeProfile(fx.profile, fx.vault, path.join(fx.vault, LIGHT), { theme })
  const proc = await launch({ ...app, profile: fx.profile })
  const page = await proc.page()
  try {
    await page.waitFor(CANVAS)
    return await act({ proc, page, canvasAt: performance.now() })
  } finally {
    page.close()
    await proc.quit()
  }
}

/** Frame and long-task stats while `act` runs, prefixed with `name`. */
async function sampled(page, name, act) {
  await page.ev(FRAME_SAMPLER)
  await page.ev('__perf.start()')
  await act()
  const f = await page.ev('__perf.stop()')
  return { [`${name}FrameP50Ms`]: f.p50, [`${name}FrameP95Ms`]: f.p95, [`${name}FrameMaxMs`]: f.max, [`${name}LongTaskMaxMs`]: f.longTaskMax }
}

/** Click a board in the tree; resolves once its canvas is the one in front. */
async function openBoard(page, name) {
  await page.ev(`${row(name)}.querySelector('button').click()`)
  await page.waitFor(`document.title.includes(${JSON.stringify(name)}) && ${CANVAS}`)
}

/** Open a board from the tree, then pan, zoom, select all and drag everything, sampling frames through each. */
function canvasScenario(file, write, { theme } = {}) {
  const name = file.replace(/\.excalidraw$/, '')
  return {
    setup: (dir) => vaultWith(dir, (vault) => ({ board: write(vault) })),
    run: (app, fx) => {
      fs.writeFileSync(path.join(fx.vault, file), fx.board)
      return session(
        app,
        fx,
        async ({ page }) => {
          await sleep(1000)
          let openMs
          const opened = await sampled(page, 'open', async () => {
            const t = performance.now()
            await openBoard(page, name)
            openMs = performance.now() - t
            await sleep(2500)
          })
          const [x, y] = await page.ev(center(`${ACTIVE} .excalidraw`))
          await page.mouse('mouseMoved', x, y)
          const wheel = (n, deltaY, modifiers = 0) => async () => {
            for (let i = 0; i < n; i++) {
              await page.mouse('mouseWheel', x, y, { deltaX: 0, deltaY: i < n / 2 ? deltaY : -deltaY, modifiers })
              await sleep(16)
            }
            await sleep(300)
          }
          const pan = await sampled(page, 'pan', wheel(60, 40))
          const zoom = await sampled(page, 'zoom', wheel(40, 30, 2)) // ctrl + wheel
          const select = await sampled(page, 'select', async () => {
            await page.key('a', 'KeyA', 65, 4) // ⌘A
            await sleep(300)
          })
          const selected = await page.ev(`Object.keys(${API}?.getAppState().selectedElementIds ?? {}).length`)
          const drag = await sampled(page, 'drag', async () => {
            await page.mouse('mousePressed', x, y, { button: 'left', buttons: 1, clickCount: 1 })
            for (let i = 1; i <= 60; i++) {
              await page.mouse('mouseMoved', x + i * 4, y + i * 2, { button: 'left', buttons: 1 })
              await sleep(16)
            }
            await page.mouse('mouseReleased', x + 240, y + 120, { button: 'left', buttons: 0, clickCount: 1 })
            await sleep(300)
          })
          return { openMs, ...opened, ...pan, ...zoom, ...select, dragSelected: selected, ...drag }
        },
        { theme },
      )
    },
  }
}

/** The three boards `hover` rests on: assets-backed 121 and 90 images, and a legacy board with its images inline. */
const HOVERED = [
  ['hover121', 'Images 121', (vault) => imageBoard(vault, 121, 121)],
  ['hover90', 'Images 90', (vault) => imageBoard(vault, 90, 90)],
  ['hoverLegacy', 'Legacy 32 MB', () => legacyBoard(15, 32)],
]

/** A git vault syncing to a bare origin beside it (`seedDemoVault`'s shape), rebuilt for every run. */
function syncedVault(dir) {
  const fx = vaultWith(dir, (vault) => fs.writeFileSync(path.join(vault, 'Notes.excalidraw'), shapesBoard(10, 2)))
  const origin = path.join(dir, 'origin.git')
  const git = (...args) => execFileSync('git', args, { cwd: fx.vault, stdio: 'pipe' }).toString().trim()
  fs.mkdirSync(path.join(fx.vault, '.yaseendraw'))
  fs.writeFileSync(path.join(fx.vault, '.yaseendraw', 'github.json'), '{ "enabled": true }\n')
  git('init', '-q', '-b', 'main')
  git('config', 'user.name', 'perf')
  git('config', 'user.email', 'perf@example.com')
  git('add', '-A')
  git('commit', '-q', '-m', 'seed')
  git('init', '-q', '--bare', '-b', 'main', origin)
  git('remote', 'add', 'origin', origin)
  git('push', '-q', '-u', 'origin', 'main')
  return { ...fx, git, origin }
}

export const SCENARIOS = {
  /** Spawn → navigation → first paint → the restored board's canvas (the scope measured ~580 ms spawn → canvas). */
  launch: {
    setup: (dir) => vaultWith(dir),
    run: (app, fx) =>
      session(app, fx, async ({ proc, page, canvasAt }) => {
        const r = await page.ev(`({ now: performance.now(), origin: performance.timeOrigin, fcp: performance.getEntriesByName('first-contentful-paint')[0]?.startTime, heap: performance.memory.usedJSHeapSize })`)
        return { spawnToCanvasMs: canvasAt - proc.spawnedAt, spawnToNavMs: r.origin - (performance.timeOrigin + proc.spawnedAt), navToFirstPaintMs: r.fcp, navToCanvasMs: r.now, jsHeapMb: r.heap / 1e6 }
      }),
  },

  /** Click a `.drawio` in the tree → draw.io's `load` answer, i.e. the diagram is on screen in the real app. */
  drawio: {
    setup: (dir) => vaultWith(dir, (vault) => fs.writeFileSync(path.join(vault, 'Flow.drawio'), flowDiagram(30))),
    run: (app, fx) =>
      session(app, fx, async ({ page }) => {
        await sleep(1000)
        await page.ev(`window.addEventListener('message', (e) => { if (typeof e.data === 'string' && e.data.includes('"event":"load"')) window.__drawioLoad ??= performance.now() })`)
        const clickedAt = await page.ev(`(() => { const t = performance.now(); ${row('Flow')}.querySelector('button').click(); return t })()`)
        await page.waitFor('window.__drawioLoad')
        return { drawioOpenMs: (await page.ev('window.__drawioLoad')) - clickedAt }
      }),
  },

  'canvas-1k': canvasScenario('Shapes 1k.excalidraw', () => shapesBoard(1000, 1000)),
  'canvas-4k': canvasScenario('Shapes 4k.excalidraw', () => shapesBoard(4000, 4000)),
  'canvas-1k-dark': canvasScenario('Shapes 1k.excalidraw', () => shapesBoard(1000, 1000), { theme: 'dark' }),
  'canvas-4k-dark': canvasScenario('Shapes 4k.excalidraw', () => shapesBoard(4000, 4000), { theme: 'dark' }),
  'canvas-images': canvasScenario('Images 121.excalidraw', (vault) => imageBoard(vault, 121, 121)),
  'canvas-legacy': canvasScenario('Legacy 32 MB.excalidraw', () => legacyBoard(15, 32)),

  /** Rest the pointer on each HOVERED row in turn: time to its picture and the worst frame meanwhile (the 400 ms dwell included). */
  hover: {
    setup: (dir) => vaultWith(dir, (vault) => HOVERED.forEach(([, name, write]) => fs.writeFileSync(path.join(vault, `${name}.excalidraw`), write(vault)))),
    run: (app, fx) =>
      session(app, fx, async ({ page }) => {
        await sleep(1500)
        const [cx, cy] = await page.ev(center(`${ACTIVE} .excalidraw`))
        const out = {}
        for (const [key, name] of HOVERED) {
          await page.mouse('mouseMoved', cx, cy)
          await page.waitFor(`!document.querySelector('.board-preview__img')`)
          await sleep(500)
          const [x, y] = await page.ev(`(() => { const r = ${row(name)}.querySelector('button').getBoundingClientRect(); return [r.left + 40, r.top + r.height / 2] })()`)
          const frames = await sampled(page, key, async () => {
            const t = performance.now()
            await page.mouse('mouseMoved', x, y)
            const msg = `([...document.querySelectorAll('.board-preview__msg')].map((m) => m.textContent).find((m) => m !== 'Loading preview…') ?? null)`
            await page.waitFor(`!!document.querySelector('.board-preview__img--loaded') || ${msg} !== null`, 60_000)
            // A preview that ends in a message ("Preview unavailable") has no picture time: logged, not counted.
            const said = await page.ev(msg)
            if (said === null) out[`${key}PreviewMs`] = performance.now() - t
            else console.error(`${name}: preview said "${said}"`)
            await sleep(500)
          })
          Object.assign(out, frames)
        }
        return out
      }),
  },

  /** The drawers and panels (🔒 D4 keeps them exactly as they are): each opened and closed twice. */
  drawers: {
    setup: (dir) => vaultWith(dir),
    run: (app, fx) =>
      session(app, fx, async ({ page }) => {
        await sleep(1500)
        const rail = click('.app-sidebar-launchers button[aria-label$="workspace panel"]')
        const steps = (...exprs) => async () => {
          for (const expr of exprs) {
            await page.ev(expr)
            await sleep(800)
          }
        }
        const tabs = ['Image Studio', 'Components', 'Presentation'].map((t) => click(`.default-sidebar button[aria-label="${t}"]`))
        const hide = click('button[aria-label="Hide sidebar"]')
        const show = click('button[aria-label="Show sidebar"]')
        const switcher = click('.sidebar__root')
        return {
          ...(await sampled(page, 'panel', steps(rail, rail, rail, rail))),
          ...(await sampled(page, 'panelTabs', steps(rail, ...tabs, ...tabs, rail))),
          ...(await sampled(page, 'sidebar', steps(hide, show, hide, show))),
          ...(await sampled(page, 'switcher', steps(switcher, switcher, switcher, switcher))),
        }
      }),
  },

  /** 230 boards of a 2 000-board vault rewritten at once (a sync pull): main-process CPU, peak memory, IPC stalls. */
  storm: {
    setup: (dir) => vaultWith(dir, (vault) => ({ boards: writeBoardVault(vault, 100, 20, 75).slice(0, 230) })),
    run: (app, fx) =>
      session(app, fx, async ({ proc, page }) => {
        await sleep(3000)
        await page.ev(`window.__ipc = { max: 0, sum: 0, n: 0 }; window.__ipcTimer = setInterval(async () => { const t = performance.now(); await window.yaseenDraw.state.get(); const d = performance.now() - t; __ipc.max = Math.max(__ipc.max, d); __ipc.sum += d; __ipc.n++ }, 50)`)
        const cpu0 = cpuSeconds(proc.pid)
        const t0 = performance.now()
        for (const f of fx.boards) fs.appendFileSync(f, ' ')
        // Settled: two quiet seconds in a row (main under 0.1 s of CPU each), after at least two.
        let quiet = 0
        let last = cpu0
        while (quiet < 2 && performance.now() - t0 < 60_000) {
          await sleep(1000)
          const now = cpuSeconds(proc.pid)
          quiet = performance.now() - t0 >= 2000 && now - last < 0.1 ? quiet + 1 : 0
          last = now
        }
        const ipc = await page.ev('(() => { clearInterval(__ipcTimer); return __ipc })()')
        return { mainCpuSec: last - cpu0, settleMs: performance.now() - t0 - 2000, mainPeakMb: footprintMb(proc.pid).peak, ipcMaxMs: ipc.max, ipcAvgMs: ipc.sum / ipc.n }
      }),
  },

  /** 20 s after launch, then 120 s untouched: CPU per process type, and the footprint each holds. */
  idle: {
    setup: (dir) => vaultWith(dir),
    run: (app, fx) =>
      session(app, fx, async ({ proc }) => {
        await sleep(20_000)
        const procs = [{ pid: proc.pid, type: 'main' }, ...helpers(proc.pid)]
        const cpu0 = procs.map((p) => cpuSeconds(p.pid))
        await sleep(120_000)
        const out = {}
        procs.forEach((p, i) => {
          const k = p.type.replace(/-process$/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase())
          out[`${k}CpuPct`] = (out[`${k}CpuPct`] ?? 0) + ((cpuSeconds(p.pid) - cpu0[i]) / 120) * 100
          out[`${k}FootprintMb`] = (out[`${k}FootprintMb`] ?? 0) + footprintMb(p.pid).now
        })
        return out
      }),
  },

  /** Three 121-image boards open in three tabs: what the renderer and GPU hold (the 🔒 D5 +25 % guard's baseline). */
  'heavy-tabs': {
    setup: (dir) =>
      vaultWith(dir, (vault) => {
        const board = imageBoard(vault, 121, 121)
        for (const n of [1, 2, 3]) fs.writeFileSync(path.join(vault, `Heavy ${n}.excalidraw`), board)
      }),
    run: (app, fx) =>
      session(app, fx, async ({ proc, page }) => {
        for (const n of [1, 2, 3]) {
          await openBoard(page, `Heavy ${n}`)
          await sleep(3000)
        }
        const held = (type) => helpers(proc.pid).filter((p) => p.type === type).reduce((mb, p) => mb + footprintMb(p.pid).now, 0)
        return { rendererFootprintMb: held('renderer'), gpuFootprintMb: held('gpu-process'), mainFootprintMb: footprintMb(proc.pid).now }
      }),
  },

  /** A board edited from outside, then ⌘Q 2.5 s later: did the edit reach the origin? 1 = pushed (v0.1.11 loses it; 2A restores it). */
  'quit-flush': {
    setup: (dir) => ({ dir }),
    async run(app, { dir }) {
      const fx = syncedVault(dir)
      const board = path.join(fx.vault, 'Notes.excalidraw')
      await session(app, fx, async () => {
        await sleep(4000)
        fs.appendFileSync(board, '\n')
        await sleep(2500)
      })
      return { quitFlushPushed: fx.git('--git-dir', fx.origin, 'rev-parse', 'main:Notes.excalidraw') === fx.git('hash-object', board) ? 1 : 0 }
    },
  },
}

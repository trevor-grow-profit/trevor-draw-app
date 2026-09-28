/**
 * The perf scenarios (YAZ-2073 1B). Each has a `setup(dir)` that writes its fixture once, and a
 * `run(app, fx)` that launches the app ONCE on the fixture's profile and returns flat metrics
 * (ms / MB / s). The runner repeats `run`, drops the warm-up and summarizes. The profile persists
 * across runs (Chromium's caches warm like a real relaunch); the window list and any board a run
 * edits are rewritten first, so every run starts from the same state.
 */
import fs from 'node:fs'
import path from 'node:path'
import { cpuSeconds, footprintMb, helpers, launch, sleep } from './lib/app.mjs'
import { FRAME_SAMPLER } from './lib/stats.mjs'
import { flowDiagram, imageBoard, shapesBoard, writeBoardVault, writeProfile } from './lib/fixtures.mjs'

/** The tab in front: every visited tab stays mounted (🔒 D8), the others are hidden layers. */
const ACTIVE = '.tabstack__layer:not(.tabstack__layer--hidden)'
const CANVAS = `(() => { const c = document.querySelector('${ACTIVE} .excalidraw canvas.excalidraw__canvas'); return !!c && c.width > 0 })()`
const row = (name) => `[...document.querySelectorAll('[role=treeitem]')].find((r) => r.textContent.trim().startsWith(${JSON.stringify(name)}))`
const center = (selector) => `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2] })()`
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

/** Launch on the light board and wait for its canvas. */
async function open(app, fx) {
  writeProfile(fx.profile, fx.vault, path.join(fx.vault, LIGHT))
  const proc = await launch({ ...app, profile: fx.profile })
  const page = await proc.page()
  await page.waitFor(CANVAS)
  return { proc, page, canvasAt: performance.now() }
}

/** Frame and long-task stats while `act` runs, prefixed with `name`. */
async function sampled(page, name, act) {
  await page.ev(FRAME_SAMPLER)
  await page.ev('__perf.start()')
  await act()
  const f = await page.ev('__perf.stop()')
  return { [`${name}FrameP50Ms`]: f.p50, [`${name}FrameP95Ms`]: f.p95, [`${name}FrameMaxMs`]: f.max, [`${name}LongTaskMaxMs`]: f.longTaskMax }
}

/** 1k / 4k shapes and the 121-image board: open it from the tree, then pan, zoom and drag everything. */
function canvasScenario(file, write) {
  return {
    setup: (dir) => vaultWith(dir, (vault) => ({ board: write(vault) })),
    async run(app, fx) {
      fs.writeFileSync(path.join(fx.vault, file), fx.board)
      const { proc, page } = await open(app, fx)
      try {
        await sleep(1000)
        const name = file.replace(/\.excalidraw$/, '')
        let openMs
        const opened = await sampled(page, 'open', async () => {
          const t = performance.now()
          await page.ev(`${row(name)}.querySelector('button').click()`)
          await page.waitFor(`document.title.includes(${JSON.stringify(name)}) && ${CANVAS}`)
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
        await page.key('a', 'KeyA', 65, 4) // ⌘A
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
        return { openMs, ...opened, ...pan, ...zoom, dragSelected: selected, ...drag }
      } finally {
        page.close()
        await proc.quit()
      }
    },
  }
}

export const SCENARIOS = {
  /** Spawn → the restored board's canvas: the launch the scope measured at ~580 ms. */
  launch: {
    setup: (dir) => vaultWith(dir),
    async run(app, fx) {
      const { proc, page, canvasAt } = await open(app, fx)
      const navToCanvasMs = await page.ev('performance.now()')
      page.close()
      await proc.quit()
      return { spawnToCanvasMs: canvasAt - proc.spawnedAt, navToCanvasMs }
    },
  },

  /** Click a `.drawio` in the tree → draw.io's `load` answer (the diagram is on screen). */
  drawio: {
    setup: (dir) => vaultWith(dir, (vault) => fs.writeFileSync(path.join(vault, 'Flow.drawio'), flowDiagram(30))),
    async run(app, fx) {
      const { proc, page } = await open(app, fx)
      try {
        await sleep(1000)
        await page.ev(`window.addEventListener('message', (e) => { if (typeof e.data === 'string' && e.data.includes('"event":"load"')) window.__drawioLoad ??= performance.now() })`)
        const clickedAt = await page.ev(`(() => { const t = performance.now(); ${row('Flow')}.querySelector('button').click(); return t })()`)
        await page.waitFor('window.__drawioLoad')
        return { drawioOpenMs: (await page.ev('window.__drawioLoad')) - clickedAt }
      } finally {
        page.close()
        await proc.quit()
      }
    },
  },

  'canvas-1k': canvasScenario('Shapes 1k.excalidraw', () => shapesBoard(1000, 1000)),
  'canvas-4k': canvasScenario('Shapes 4k.excalidraw', () => shapesBoard(4000, 4000)),
  'canvas-images': canvasScenario('Images 121.excalidraw', (vault) => imageBoard(vault, 121, 121)),

  /** Rest the pointer on the 121-image board's row: time to the preview picture, and the worst frame meanwhile (includes the 400 ms dwell). */
  hover: {
    setup: (dir) => vaultWith(dir, (vault) => fs.writeFileSync(path.join(vault, 'Images 121.excalidraw'), imageBoard(vault, 121, 121))),
    async run(app, fx) {
      const { proc, page } = await open(app, fx)
      try {
        await sleep(1500)
        const [cx, cy] = await page.ev(center(`${ACTIVE} .excalidraw`))
        await page.mouse('mouseMoved', cx, cy)
        const [x, y] = await page.ev(`(() => { const r = ${row('Images 121')}.querySelector('button').getBoundingClientRect(); return [r.left + 40, r.top + r.height / 2] })()`)
        let hoverPreviewMs
        const frames = await sampled(page, 'hover', async () => {
          const t = performance.now()
          await page.mouse('mouseMoved', x, y)
          await page.waitFor(`!!document.querySelector('.board-preview__img--loaded')`)
          hoverPreviewMs = performance.now() - t
          await sleep(500)
        })
        return { hoverPreviewMs, ...frames }
      } finally {
        page.close()
        await proc.quit()
      }
    },
  },

  /** 230 boards of a 2 000-board vault rewritten at once (a sync pull): main-process CPU, peak memory, IPC stalls. */
  storm: {
    setup: (dir) => vaultWith(dir, (vault) => ({ boards: writeBoardVault(vault, 100, 20, 75).slice(0, 230) })),
    async run(app, fx) {
      const { proc, page } = await open(app, fx)
      try {
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
      } finally {
        page.close()
        await proc.quit()
      }
    },
  },

  /** 20 s after launch, then 30 s untouched: CPU per process type, and the footprint each holds. */
  idle: {
    setup: (dir) => vaultWith(dir),
    async run(app, fx) {
      const { proc, page } = await open(app, fx)
      page.close()
      try {
        await sleep(20_000)
        const procs = [{ pid: proc.pid, type: 'main' }, ...helpers(proc.pid)]
        const cpu0 = procs.map((p) => cpuSeconds(p.pid))
        await sleep(30_000)
        const out = {}
        procs.forEach((p, i) => {
          const k = p.type.replace(/-process$/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase())
          out[`${k}CpuPct`] = (out[`${k}CpuPct`] ?? 0) + ((cpuSeconds(p.pid) - cpu0[i]) / 30) * 100
          out[`${k}FootprintMb`] = (out[`${k}FootprintMb`] ?? 0) + footprintMb(p.pid).now
        })
        return out
      } finally {
        await proc.quit()
      }
    },
  },
}

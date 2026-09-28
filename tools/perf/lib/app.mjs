/**
 * Launch the app for a measurement and drive its window over the DevTools protocol (YAZ-2073 1B).
 * The profile is always an isolated `YASEEN_DRAW_USER_DATA_DIR`, read before the single-instance
 * lock, so a run coexists with the installed app and never sees the real profile or vaults.
 * Zero dependencies: node's global fetch + WebSocket.
 */
import { execFileSync, spawn } from 'node:child_process'
import { createServer } from 'node:net'

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const freePort = () =>
  new Promise((resolve, reject) => {
    const srv = createServer().once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })

/** A CDP session on one target: `ev` an expression (awaited, by value), wait for one, send input or any command. */
async function attach(wsUrl) {
  const ws = new WebSocket(wsUrl)
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = reject
  })
  let id = 0
  const pending = new Map()
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data)
    pending.get(d.id)?.(d)
    pending.delete(d.id)
  }
  // A window that closes (or an app that dies) under a command fails it rather than hanging the run.
  ws.onclose = () => {
    for (const settle of pending.values()) settle({ error: { message: 'the DevTools socket closed' } })
    pending.clear()
  }
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      pending.set(++id, (d) => (d.error ? reject(new Error(`${method}: ${d.error.message}`)) : resolve(d.result)))
      ws.send(JSON.stringify({ id, method, params }))
    })
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
    if (r.exceptionDetails) throw new Error(`page threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`)
    return r.result.value
  }
  /** Polls `expression` until truthy; resolves to the harness clock at that moment. */
  const waitFor = async (expression, timeoutMs = 30_000) => {
    const end = performance.now() + timeoutMs
    while (performance.now() < end) {
      if (await ev(expression)) return performance.now()
      await sleep(10)
    }
    throw new Error(`timed out waiting for ${expression}`)
  }
  const mouse = (type, x, y, extra = {}) => send('Input.dispatchMouseEvent', { type, x, y, button: 'none', ...extra })
  const key = async (key, code, keyCode, modifiers = 0) => {
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: keyCode, modifiers })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode, modifiers })
  }
  return { send, ev, waitFor, mouse, key, close: () => ws.close() }
}

/**
 * Starts `bin` on `profile`; `spawnedAt` is the harness clock at spawn. The two Chromium switches
 * keep frames and timers running when another window covers ours — a measurement, not a feature.
 */
export async function launch({ bin, args = [], profile }) {
  const port = await freePort()
  const spawnedAt = performance.now()
  const child = spawn(bin, [...args, `--remote-debugging-port=${port}`, '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'], {
    env: { ...process.env, YASEEN_DRAW_USER_DATA_DIR: profile },
    stdio: 'ignore',
  })
  const exited = new Promise((r) => child.once('exit', r))
  /** The app window's page target (the renderer at `app://yaseen/…?win=`), once it exists. */
  const page = async (timeoutMs = 30_000) => {
    const end = performance.now() + timeoutMs
    while (performance.now() < end) {
      try {
        const t = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page' && t.url.startsWith('app://yaseen/'))
        if (t) return await attach(t.webSocketDebuggerUrl)
      } catch {
        // the DevTools endpoint is not listening yet
      }
      await sleep(10)
    }
    throw new Error('no app window appeared')
  }
  /**
   * Quits like ⌘Q would (SIGTERM → before-quit → flush); a hung quit is killed after 10 s, and so
   * are the helpers a killed main leaves behind (they carry the profile path on their command line).
   */
  const quit = async () => {
    child.kill('SIGTERM')
    if ((await Promise.race([exited.then(() => true), sleep(10_000)])) !== true) {
      child.kill('SIGKILL')
      await exited
      try {
        execFileSync('pkill', ['-f', profile])
      } catch {
        // none left
      }
    }
  }
  return { pid: child.pid, spawnedAt, page, quit }
}

/** CPU seconds a process has used (`ps` TIME is `[h:]m:ss.cc`). */
export function cpuSeconds(pid) {
  return execFileSync('ps', ['-o', 'time=', '-p', String(pid)]).toString().trim().split(':').reduce((acc, part) => acc * 60 + Number(part), 0)
}

/** macOS `footprint` in MB: what the process holds now, and the most it ever held. */
export function footprintMb(pid) {
  const out = execFileSync('footprint', ['-f', 'bytes', '--noCategories', '-p', String(pid)]).toString()
  const mb = (name) => Math.round(Number(out.match(new RegExp(`${name}: (\\d+) B`))[1]) / 1e5) / 10
  return { now: mb('phys_footprint'), peak: mb('phys_footprint_peak') }
}

/** The app's helper processes by Chromium `--type` (renderer, gpu-process, utility), from the main pid. */
export function helpers(pid) {
  const out = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,command=']).toString().trim().split('\n')
  return out.map((l) => l.trim().split(/\s+/)).filter(([, ppid]) => ppid === String(pid)).map(([p, , ...cmd]) => ({ pid: Number(p), type: cmd.join(' ').match(/--type=([a-z-]+)/)?.[1] ?? 'other' }))
}

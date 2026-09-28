#!/usr/bin/env node
/**
 * USAGE: npm run perf -- <scenario…|all> [--runs 5] [--app <.app> | --dev] [--work <dir>]
 *        (`--scenario <name>` works too)
 *
 * The perf harness (YAZ-2073 1B, 🔒 D17): launches the app on generated fixtures in an isolated
 * profile, runs each scenario `--runs` times after one discarded warm-up, and prints JSON — per
 * metric the median, p95, min, max, cv (noise) and every run — with each median checked against
 * the `perf` ceilings in budget.json (exit 1 when one is over). Local only: it opens real windows.
 *   --app   a packaged bundle (default: desktop/dist-app/mac-arm64/Yaseen Draw.app)
 *   --dev   `desktop/out` under the workspace's Electron instead (after `npm run build`, no packaging)
 *   --work  where fixtures and profiles go (default: <tmpdir>/yaseen-draw-perf); refused unless
 *           empty or made by this harness, since each scenario's folder in it is wiped
 * Scenarios: see scenarios.mjs. Compare builds on the same machine, idle, with the same --runs.
 */
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import { SCENARIOS } from './scenarios.mjs'
import { claimWorkDir } from './lib/fixtures.mjs'
import { summarizeRuns } from './lib/stats.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '../..')
const argv = process.argv.slice(2)
const opt = (name, dflt) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : dflt)
const names = argv.filter((a, i) => !a.startsWith('--') && !argv[i - 1]?.match(/^--(runs|app|work)$/))
const todo = names.includes('all') ? Object.keys(SCENARIOS) : names
const unknown = todo.filter((n) => !SCENARIOS[n])
if (todo.length === 0 || unknown.length > 0) {
  console.error(`usage: npm run perf -- <${Object.keys(SCENARIOS).join('|')}|all> [--runs 5] [--app <.app> | --dev] [--work <dir>]${unknown.length ? `\nunknown: ${unknown.join(', ')}` : ''}`)
  process.exit(2)
}
const runs = Number(opt('runs', '5'))
const work = claimWorkDir(path.resolve(opt('work', path.join(os.tmpdir(), 'yaseen-draw-perf'))))
const bundle = path.resolve(opt('app', path.join(repo, 'desktop/dist-app/mac-arm64/Yaseen Draw.app')))
const app = argv.includes('--dev')
  ? { bin: createRequire(path.join(repo, 'desktop/package.json'))('electron'), args: [path.join(repo, 'desktop')] }
  : { bin: path.join(bundle, 'Contents/MacOS/Yaseen Draw') }
if (!fs.existsSync(app.bin)) {
  console.error(`no app binary at ${app.bin} — run \`npm run desktop:build\`, or pass --app / --dev`)
  process.exit(2)
}
const { perf: ceilings = {}, perfTolerance = 0 } = JSON.parse(fs.readFileSync(path.join(here, 'budget.json'), 'utf8'))

const report = { app: argv.includes('--dev') ? 'dev (desktop/out)' : bundle, machine: { cpu: os.cpus()[0].model, cores: os.cpus().length, os: `${os.type()} ${os.release()}` }, runs, warmupDiscarded: 1, scenarios: {} }
let failed = false
for (const name of todo) {
  const scenario = SCENARIOS[name]
  const fx = scenario.setup(work.dirFor(name))
  const loadBefore = os.loadavg()[0]
  const results = []
  for (let i = 0; i <= runs; i++) {
    const r = await scenario.run(app, fx)
    if (i > 0) results.push(r) // run 0 warms the OS file cache and Chromium's caches
  }
  const metrics = summarizeRuns(results)
  const over = Object.entries(ceilings)
    .filter(([k, { max }]) => k.startsWith(`${name}.`) && max != null && metrics[k.slice(name.length + 1)])
    .filter(([k, { max }]) => metrics[k.slice(name.length + 1)].median - max > max * perfTolerance)
    .map(([k, { max }]) => `${k} median ${metrics[k.slice(name.length + 1)].median} > ceiling ${max}`)
  failed ||= over.length > 0
  report.scenarios[name] = { loadAvg: [Math.round(loadBefore * 10) / 10, Math.round(os.loadavg()[0] * 10) / 10], metrics, over }
}
console.log(JSON.stringify(report, null, 2))
process.exit(failed ? 1 : 0)

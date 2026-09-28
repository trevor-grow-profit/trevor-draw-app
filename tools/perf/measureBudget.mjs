#!/usr/bin/env node
/**
 * USAGE: npm run perf:budget [-- [--json] [--app <.app> --dmg <.dmg> --out <desktop/out>]]
 *        npm run perf:budget:ci   (= --out-only)
 *
 * The size and integrity gate (YAZ-2073 1A, 🔒 D17). Measures the build against `budget.json` and
 * checks what no unit test sees; exits 1 on an integrity failure or a metric over its ceiling.
 *   default     — after `npm run desktop:build`: desktop/out + the packaged .app and .dmg (macOS)
 *   --out-only  — after `npm run build`: desktop/out alone (CI, `perf:budget:ci`; no packaging needed)
 * THE RATCHET: a change that shrinks a metric lowers its ceiling in budget.json in the same PR;
 * raising a ceiling needs Yasin's OK in the PR description. Read-only: never writes anywhere.
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkApp, checkOut, measure, overBudget } from './lib/bundle.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../..')
const argv = process.argv.slice(2)
const arg = (name, dflt) => (argv.includes(`--${name}`) ? resolve(argv[argv.indexOf(`--${name}`) + 1]) : dflt)
const outOnly = argv.includes('--out-only')
const { version } = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))
const out = arg('out', join(repo, 'desktop/out'))
const app = outOnly ? null : arg('app', join(repo, 'desktop/dist-app/mac-arm64/Yaseen Draw.app'))
const dmg = outOnly ? null : arg('dmg', join(repo, `desktop/dist-app/Yaseen Draw-${version}-arm64.dmg`))
const budget = JSON.parse(readFileSync(join(here, 'budget.json'), 'utf8'))

const fails = [...checkOut(out), ...(app ? checkApp(app) : [])]
const metrics = measure({ out, app, dmg })
const over = overBudget(metrics, budget.size, budget.sizeTolerance)

if (argv.includes('--json')) console.log(JSON.stringify({ version, mode: outOnly ? 'out-only' : 'packaged', metrics, over, fails }, null, 2))
else {
  const fmt = (n) => (n == null ? '—' : n >= 1e5 ? `${(n / 1e6).toFixed(2)} MB` : String(n))
  for (const [k, v] of Object.entries(metrics)) console.log(`${k.padEnd(24)} ${fmt(v).padStart(10)}   ceiling ${fmt(budget.size[k]?.max)}`)
  for (const f of fails) console.log('INTEGRITY FAIL:', f)
  for (const o of over) console.log('OVER BUDGET:', o)
  console.log(fails.length || over.length ? 'GATE: FAIL' : 'GATE: PASS')
}
process.exit(fails.length || over.length ? 1 : 0)

import { defineConfig } from '@playwright/test'

/**
 * The E2E suite (YAZ-2073 1C, 🔒 D17): Playwright's Electron launcher against the BUILT app —
 * `npm run e2e` builds first. Every test gets its own temp profile and vaults (support/fixtures.ts).
 * Each test is one or more app launches, so parallelism is by worker and kept modest: every worker
 * is a full Electron app with its renderers.
 */
export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  outputDir: './test-results',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  workers: Number(process.env.E2E_WORKERS ?? 3),
  forbidOnly: !!process.env.CI,
  reporter: [['list']],
})

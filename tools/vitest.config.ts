import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * The `tools/` project. Both scripts are plain ESM run straight by node, so their suites are
 * `.mjs` too and drive the real code against real temp dirs — no jsdom, nothing mocked. `@shared`
 * resolves for the renderer module the overlay suite imports (`drawioProtocol.ts`).
 */
export default defineConfig({
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('../shared', import.meta.url)),
    },
  },
  test: {
    name: 'tools',
    environment: 'node',
    include: ['*.test.mjs', 'perf/*.test.mjs'],
    testTimeout: 60_000,
  },
})

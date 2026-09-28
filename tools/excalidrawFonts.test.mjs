import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { excalidrawPackageFonts } from '@shared/excalidrawFonts'
import { excalidrawFontsDir } from './lib/excalidrawFonts.mjs'

it("finds the fonts where the app's build and main's share upload find them (shared/excalidrawFonts.ts)", () => {
  const repo = fileURLToPath(new URL('..', import.meta.url))
  expect(excalidrawFontsDir()).toBe(excalidrawPackageFonts(repo).find((dir) => existsSync(dir)))
})

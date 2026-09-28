import { describe, expect, it } from 'vitest'
import { excalidrawPackageFonts } from './excalidrawFonts'

describe('excalidrawPackageFonts', () => {
  it('names the root install first, then client/, in the repo path’s own separator', () => {
    expect(excalidrawPackageFonts('/repo/')).toEqual(['/repo/node_modules/@excalidraw/excalidraw/dist/prod/fonts', '/repo/client/node_modules/@excalidraw/excalidraw/dist/prod/fonts'])
    expect(excalidrawPackageFonts('C:\\repo')).toEqual(['C:\\repo\\node_modules\\@excalidraw\\excalidraw\\dist\\prod\\fonts', 'C:\\repo\\client\\node_modules\\@excalidraw\\excalidraw\\dist\\prod\\fonts'])
  })
})

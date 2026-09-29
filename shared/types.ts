/**
 * Shared renderer/main contracts for Trevor Draw (locked in GRO-1961, bridge in GRO-2153) —
 * see docs/CONTRACTS.md "Bridge API" and "App state schema" for the prose version.
 *
 * All paths are ABSOLUTE and in the platform's own form — `/Users/...` on macOS, `C:\...` on Windows
 * (compare them with `shared/paths.ts`, never a hand-built `/` prefix). The main process imposes no
 * jail: any absolute path on the machine may be read or written.
 */

// The contracts are grouped by domain in `shared/types/`; this file is the one door to them,
// so every consumer keeps importing from `@shared/types` and nothing depends on the grouping.
export * from './types/errors'
export * from './types/files'
export * from './types/drawing'
export * from './types/diagram'
export * from './types/canvas'
export * from './types/appState'
export * from './types/vault'
export * from './types/library'
export * from './types/share'
export * from './types/bridge'

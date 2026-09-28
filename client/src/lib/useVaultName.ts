import { useSyncExternalStore } from 'react'
import { storage } from './storage'

/** The vault's display name, live (Docs YAZ-1974 D4): a rename in ANY window lands through `storage.subscribe`. Null with no vault. */
export function useVaultName(root: string): string
export function useVaultName(root: string | null): string | null
export function useVaultName(root: string | null): string | null {
  return useSyncExternalStore(storage.subscribe, () => (root === null ? null : storage.vaultName(root)))
}

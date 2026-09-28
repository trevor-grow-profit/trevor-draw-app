/** The Files lens's order (🔒 YAZ-1835 D3): per vault, read off the store and re-read when another window changes it. */
import { useCallback, useEffect, useState } from 'react'
import type { SortOrder } from '@shared/types'
import { storage } from '../../lib/storage'

export function useSortOrder(root: string) {
  const [sortOrder, setSortOrderState] = useState<SortOrder>(() => storage.getSortOrder(root))
  // Another window's sort change lands in the store cache; follow it (🔒 YAZ-1835 D3).
  useEffect(() => storage.subscribe(() => setSortOrderState(storage.getSortOrder(root))), [root])
  const setSortOrder = useCallback(
    (order: SortOrder) => {
      setSortOrderState(order)
      storage.setSortOrder(root, order)
    },
    [root],
  )
  return [sortOrder, setSortOrder] as const
}

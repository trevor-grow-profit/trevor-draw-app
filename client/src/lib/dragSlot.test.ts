/**
 * The tab strip's reorder arithmetic (GRO-2235): which slot a pointer means, and where the dragged
 * tab lands — the off-by-one past the grab point is the whole reason this is one shared spelling.
 */
import { describe, expect, it } from 'vitest'
import type { DragEvent } from 'react'
import { dropIndex, insertionSlot } from './dragSlot'

/** A drag over a tab spanning x 100…200. */
const over = (clientX: number) => ({ clientX, currentTarget: { getBoundingClientRect: () => ({ left: 100, width: 100 }) } }) as unknown as DragEvent

describe('insertionSlot', () => {
  it('is before the tab left of its midpoint and after it from the midpoint on', () => {
    expect([insertionSlot(over(101), 3), insertionSlot(over(149), 3)]).toEqual([3, 3])
    expect([insertionSlot(over(150), 3), insertionSlot(over(199), 3)]).toEqual([4, 4])
  })
})

describe('dropIndex', () => {
  it('keeps a slot at or before the grab point, and shifts one left past it', () => {
    // [A B C D], dragging B (from 1)
    expect(dropIndex(1, 0)).toBe(0) // before A
    expect(dropIndex(1, 1)).toBe(1) // where it was
    expect(dropIndex(1, 2)).toBe(1) // just after itself: no move
    expect(dropIndex(1, 3)).toBe(2) // after C
    expect(dropIndex(1, 4)).toBe(3) // the end
  })
})

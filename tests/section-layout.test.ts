import { describe, expect, it } from 'vitest'
import {
  BASE_RADIUS,
  RISER_STEP_DEPTH,
  computeGroupLayout,
  computeRowRadii,
  riserExtraDepth,
  rowBaseRadius,
} from '../src/section-layout'
import type { Chair, Row } from '../src/types'

function makeChair(overrides: Partial<Chair> = {}): Chair {
  return {
    id: Math.random().toString(36),
    enabled: true,
    color: '#fff',
    label: '',
    hasStand: true,
    ...overrides,
  }
}

function makeRow(chairCount: number, overrides: Partial<Row> = {}): Row {
  return {
    id: Math.random().toString(36),
    chairs: Array.from({ length: chairCount }, () => makeChair()),
    label: '1',
    fontSize: 13,
    ...overrides,
  }
}

describe('computeRowRadii', () => {
  it('with no gapBefore/riser, radii are exactly BASE_RADIUS + i * rowSpacing', () => {
    const rowSpacing = 70
    const rows = [makeRow(4), makeRow(4), makeRow(4), makeRow(4)]
    const radii = computeRowRadii(rows, rowSpacing)
    radii.forEach((r, i) => {
      expect(r).toBeCloseTo(BASE_RADIUS + i * rowSpacing)
    })
  })

  it('gapBefore on a row pushes it and every row behind it out by the same amount', () => {
    const rowSpacing = 70
    const rows = [makeRow(4), makeRow(4), makeRow(4, { gapBefore: 25 }), makeRow(4)]
    const base = computeRowRadii([makeRow(4), makeRow(4), makeRow(4), makeRow(4)], rowSpacing)
    const withGap = computeRowRadii(rows, rowSpacing)

    // Rows before the gap are unaffected.
    expect(withGap[0]).toBeCloseTo(base[0])
    expect(withGap[1]).toBeCloseTo(base[1])
    // Row with the gap, and everything behind it, is pushed out by exactly 25,
    // preserving the inter-row gaps.
    expect(withGap[2]).toBeCloseTo(base[2] + 25)
    expect(withGap[3]).toBeCloseTo(base[3] + 25)
    expect(withGap[3] - withGap[2]).toBeCloseTo(base[3] - base[2])
  })

  it('a riser tier increase between consecutive rows adds RISER_STEP_DEPTH per level step', () => {
    const rowSpacing = 70
    const rows = [makeRow(4), makeRow(4, { riser: 1 }), makeRow(4, { riser: 3 })]
    const radii = computeRowRadii(rows, rowSpacing)
    // Row 0 -> row 1: rise of 1 level.
    expect(radii[1]).toBeCloseTo(radii[0] + rowSpacing + RISER_STEP_DEPTH)
    // Row 1 -> row 2: rise of 2 levels.
    expect(radii[2]).toBeCloseTo(radii[1] + rowSpacing + 2 * RISER_STEP_DEPTH)
  })

  it('consecutive rows on the same riser tier add no extra depth', () => {
    const rowSpacing = 70
    const rows = [makeRow(4, { riser: 2 }), makeRow(4, { riser: 2 }), makeRow(4, { riser: 2 })]
    const radii = computeRowRadii(rows, rowSpacing)
    expect(radii[1]).toBeCloseTo(radii[0] + rowSpacing)
    expect(radii[2]).toBeCloseTo(radii[1] + rowSpacing)
  })

  it('a decrease in riser tier adds no extra depth', () => {
    const rowSpacing = 70
    const rows = [makeRow(4, { riser: 3 }), makeRow(4, { riser: 1 })]
    const radii = computeRowRadii(rows, rowSpacing)
    expect(radii[1]).toBeCloseTo(radii[0] + rowSpacing)
  })

  it('rowBaseRadius consistency: radii[i] - gapBefore === rowBaseRadius(...)', () => {
    const rowSpacing = 70
    const rows = [
      makeRow(4),
      makeRow(4, { gapBefore: 10 }),
      makeRow(4, { riser: 1 }),
      makeRow(4, { riser: 1, gapBefore: 5 }),
    ]
    const radii = computeRowRadii(rows, rowSpacing)
    for (let i = 0; i < rows.length; i++) {
      const gap = rows[i].gapBefore ?? 0
      expect(radii[i] - gap).toBeCloseTo(rowBaseRadius(rows, i, radii, rowSpacing))
    }
  })
})

describe('riserExtraDepth', () => {
  it('is 0 for the first row regardless of its riser value', () => {
    const rows = [makeRow(4, { riser: 5 }), makeRow(4)]
    expect(riserExtraDepth(rows, 0)).toBe(0)
  })

  it('is proportional to the positive rise', () => {
    const rows = [makeRow(4, { riser: 0 }), makeRow(4, { riser: 4 })]
    expect(riserExtraDepth(rows, 1)).toBe(4 * RISER_STEP_DEPTH)
  })

  it('is 0 when the tier does not rise', () => {
    const rows = [makeRow(4, { riser: 4 }), makeRow(4, { riser: 4 }), makeRow(4, { riser: 1 })]
    expect(riserExtraDepth(rows, 1)).toBe(0)
    expect(riserExtraDepth(rows, 2)).toBe(0)
  })
})

describe('computeGroupLayout', () => {
  it('returns null when no chair carries a group', () => {
    const rows = [makeRow(4), makeRow(4)]
    expect(computeGroupLayout(rows)).toBeNull()
  })

  it('finds distinct groups in first-seen order and their per-row max population', () => {
    const rows: Row[] = [
      makeRow(0, {
        chairs: [
          makeChair({ group: 'v1' }),
          makeChair({ group: 'v1' }),
          makeChair({ group: 'v2' }),
        ],
      }),
      makeRow(0, {
        chairs: [
          makeChair({ group: 'v1' }),
          makeChair({ group: 'v2' }),
          makeChair({ group: 'v2' }),
          makeChair({ group: 'v2' }),
        ],
      }),
    ]
    const layout = computeGroupLayout(rows)
    expect(layout).not.toBeNull()
    expect(layout!.order).toEqual(['v1', 'v2'])
    expect(layout!.maxCount.get('v1')).toBe(2)
    expect(layout!.maxCount.get('v2')).toBe(3)
  })

  it('excludes rows for which isStraightRow returns true', () => {
    const rows: Row[] = [
      makeRow(0, { chairs: [makeChair({ group: 'v1' }), makeChair({ group: 'v1' })] }),
    ]
    expect(computeGroupLayout(rows, () => true)).toBeNull()
  })
})

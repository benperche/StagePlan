import type { Row } from './types'

// Shared between the renderer (drawing) and the orchestra generator (which
// needs to predict row radii to keep grouped section wedges legible at the
// front of the stage — see computeGroupLayout below). A separate module so
// neither renderer.ts nor presets.ts has to import the other.

// Default distance of the front (closest) arc row from the conductor.
export const BASE_RADIUS = 130
// Default distance between adjacent arc rows. Configurable per chart via
// ChartConfig.rowSpacing. Sized so the seat number drawn behind one row
// doesn't clash with the shared stand drawn in front of the row behind it
// (stand reaches ~35px forward of its chair, number ~28px behind, so 65px
// is the floor — 70px gives a small breathing gap).
export const ROW_SPACING_DEFAULT = 70

export interface GroupLayout {
  order: string[]
  maxCount: Map<string, number>
}

// Across the given rows, find each distinct chair `group` in first-seen
// order and its largest single-row population. Returns null if no chair
// carries a group, so ungrouped charts pay zero cost. `isStraightRow` lets
// callers exclude rows that won't use grouped arc placement (defaults to
// "every row is an arc row", which is what the generator wants when it
// passes just the string-section rows it built).
export function computeGroupLayout(
  rows: Row[],
  isStraightRow: (rowIndex: number) => boolean = () => false,
): GroupLayout | null {
  const order: string[] = []
  const maxCount = new Map<string, number>()
  rows.forEach((row, rowIndex) => {
    if (isStraightRow(rowIndex)) return
    const countsInRow = new Map<string, number>()
    row.chairs.forEach(c => {
      if (!c.group) return
      countsInRow.set(c.group, (countsInRow.get(c.group) ?? 0) + 1)
    })
    countsInRow.forEach((count, g) => {
      if (!maxCount.has(g)) order.push(g)
      maxCount.set(g, Math.max(maxCount.get(g) ?? 0, count))
    })
  })
  return order.length > 0 ? { order, maxCount } : null
}

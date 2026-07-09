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

// Extra radial depth (px) a row is pushed back for each riser tier it steps UP
// onto (see Row.riser). Fixed rather than user-configurable — the Layout-tab
// "Dist" handle already lets any individual row be fine-tuned on top.
export const RISER_STEP_DEPTH = 34
// Fallback physical height per riser step (cm) for the "+Ncm" tier labels when
// ChartConfig.riserStepHeight is unset.
export const RISER_STEP_HEIGHT_DEFAULT = 20
// Clamp for Row.riserPad, the user-draggable "make this platform bigger" handle.
export const RISER_PAD_MAX = 200

// Minimum arc length a single chair-slot must occupy in a grouped wedge row —
// set to the centre-to-centre spacing of the two chairs of a desk, so adjacent
// chairs never crowd closer than a desk looks. Used by applyGroupedRowRadii to
// decide when to push a cramped front row outward.
export const MIN_SLOT_PX = 56

// Angular gap between adjacent sections, in chair-slot units. Kept in one place
// so the renderer's wedge placement and the radius fit-up stay consistent.
// Below 1 so sections read as distinct blocks without a wide empty channel
// between them (a full slot's gap left a big void at the apex).
export const GAP_UNITS = 0.5

// Extra radial depth a row is pushed back for stepping UP onto a higher riser
// tier than the row in front. Only a level INCREASE costs depth, so
// consecutive same-tier rows share a step and a lower tier behind a higher one
// (unusual) costs nothing. Shared by rowBaseRadius (in turn by
// computeRowRadii and the renderer's renderLayoutHandles) so the `base`
// computation can never drift (which would make the Layout "Dist" control
// fight risers).
export function riserExtraDepth(rows: Row[], i: number): number {
  if (i === 0) return 0
  const rise = (rows[i].riser ?? 0) - (rows[i - 1].riser ?? 0)
  return Math.max(0, rise) * RISER_STEP_DEPTH
}

// Base radial distance for row `i` before its own `gapBefore` is applied:
// the previous row's radius plus the (already fitted) row spacing, plus any
// riser step-back. `radii` holds the already-computed radii for rows
// 0..i-1. The single source of truth for this formula — the renderer's
// computeRowRadii and renderLayoutHandles both call this so their `base`
// computations can never drift (drift would corrupt the Layout "Dist"
// control's gapBefore = newR - base calculation).
export function rowBaseRadius(rows: Row[], i: number, radii: number[], rowSpacing: number): number {
  return (i === 0 ? BASE_RADIUS : radii[i - 1] + rowSpacing) + riserExtraDepth(rows, i)
}

// Cumulative per-row radius from the conductor. Base step is the (already
// fitted) row spacing plus any riser step-back; each row adds its optional
// `gapBefore`. Because it's cumulative, bumping one row's gap (or riser tier)
// pushes every row behind it out by the same amount — the "push rows behind"
// distance behaviour. With all gaps/risers 0 this is exactly
// BASE_RADIUS + i * rowSpacing.
export function computeRowRadii(rows: Row[], rowSpacing: number): number[] {
  const radii: number[] = []
  for (let i = 0; i < rows.length; i++) {
    const base = rowBaseRadius(rows, i, radii, rowSpacing)
    radii[i] = base + (rows[i].gapBefore ?? 0)
  }
  return radii
}

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

// A grouped arc row spreads its chairs across the semicircle by angle, but the
// same angular budget is far less physical space on a small-radius (front) row
// than a big one — so a crowded front row can crush desks on top of each other.
// This pushes the front row(s) outward (via `gapBefore`, which cascades to every
// row behind it in computeRowRadii) until every chair-slot gets at least
// `minSlotPx` of arc length — i.e. adjacent chairs never sit closer than a desk.
// Clears existing gapBefore on the arc rows first, so the result is deterministic
// and re-runnable. Mutates the rows in place.
export function applyGroupedRowRadii(
  arcRows: Row[],
  rowSpacing: number,
  minSlotPx: number,
): void {
  const groupLayout = computeGroupLayout(arcRows)
  if (!groupLayout) return
  const { order, maxCount } = groupLayout
  const totalSpan = Math.PI    // assumes the default full semicircle

  // Total chair-slots the widest possible row occupies (global section maxima),
  // matching the renderer's global-position layout.
  let totalUnits = 0
  order.forEach((g, gi) => {
    totalUnits += Math.max(1, maxCount.get(g) ?? 1)
    if (gi < order.length - 1) totalUnits += GAP_UNITS
  })
  // Radius at which `totalSpan` of arc gives `minSlotPx` per slot gap.
  const requiredRadius = totalUnits > 1 ? minSlotPx * (totalUnits - 1) / totalSpan : 0

  let prevRadius = 0
  arcRows.forEach((row, i) => {
    delete row.gapBefore
    const defaultRadius = i === 0 ? BASE_RADIUS : prevRadius + rowSpacing
    if (row.chairs.some(c => !!c.group) && requiredRadius > defaultRadius) {
      row.gapBefore = requiredRadius - defaultRadius
      prevRadius = requiredRadius
    } else {
      prevRadius = defaultRadius
    }
  })
}

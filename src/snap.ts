// Snapping for fixed-instrument drags. Pure geometry — no DOM, no renderer —
// so it's unit-testable. main.ts gathers the targets (other instruments, the
// stage centre line, row lines/arcs) in chart coords, calls snapPoint on every
// drag move, and hands the returned guides to the renderer to draw.

export interface Point { x: number; y: number }

export interface SnapTargets {
  // Conductor position: the centre of every arc, and where the centre line runs.
  origin: Point
  // Vertical alignment lines. `mirrorOf` marks a line at an instrument's
  // reflection across the centre line (the symmetric spot on the other side
  // of the stage) and holds that instrument's centre, for the connector guide.
  xs: Array<{ x: number; mirrorOf?: Point }>
  // Horizontal alignment lines (other instruments' centres, straight rows).
  ys: Array<{ y: number }>
  // Arcs around the origin (arc rows, and the "next row" behind the back one).
  arcs: number[]
}

export type SnapGuide =
  | { kind: 'v'; x: number }
  | { kind: 'h'; y: number }
  | { kind: 'arc'; r: number }
  // A mirrored placement: the connector between the dragged instrument and the
  // one it mirrors (the centre line itself comes as a separate 'v' guide).
  // x1/y1 is the mirrored instrument, x2/y2 the dragged one.
  | { kind: 'mirror'; x1: number; y1: number; x2: number; y2: number }

export interface SnapResult { x: number; y: number; guides: SnapGuide[] }

function nearest<T>(items: T[], value: (t: T) => number, target: number, threshold: number): T | null {
  let best: T | null = null
  let bestD = threshold
  for (const it of items) {
    const d = Math.abs(value(it) - target)
    if (d <= bestD) { best = it; bestD = d }
  }
  return best
}

// Snap `p` (chart coords) to the targets within `threshold` (chart units).
// x and y lines snap independently; if only one of them caught, an arc can
// still pin the other coordinate (the line / arc intersection). With no line
// caught, the point is pulled radially onto the nearest arc.
export function snapPoint(p: Point, t: SnapTargets, threshold: number): SnapResult {
  const guides: SnapGuide[] = []
  const sx = nearest(t.xs, s => s.x, p.x, threshold)
  const sy = nearest(t.ys, s => s.y, p.y, threshold)
  let x = sx ? sx.x : p.x
  let y = sy ? sy.y : p.y

  if (sx && sy) {
    // Both caught — no room for an arc as well.
  } else if (sx || sy) {
    // One line caught: see whether an arc crosses it close to the pointer.
    let best: { x: number; y: number; r: number } | null = null
    let bestD = threshold
    for (const r of t.arcs) {
      if (sx) {
        const dx = x - t.origin.x
        if (Math.abs(dx) > r) continue
        const h = Math.sqrt(r * r - dx * dx)
        for (const cy of [t.origin.y - h, t.origin.y + h]) {
          const d = Math.abs(cy - p.y)
          if (d <= bestD) { best = { x, y: cy, r }; bestD = d }
        }
      } else {
        const dy = y - t.origin.y
        if (Math.abs(dy) > r) continue
        const w = Math.sqrt(r * r - dy * dy)
        for (const cx of [t.origin.x - w, t.origin.x + w]) {
          const d = Math.abs(cx - p.x)
          if (d <= bestD) { best = { x: cx, y, r }; bestD = d }
        }
      }
    }
    if (best) {
      x = best.x
      y = best.y
      guides.push({ kind: 'arc', r: best.r })
    }
  } else {
    // No line: pull radially onto the nearest arc.
    const dist = Math.hypot(p.x - t.origin.x, p.y - t.origin.y)
    const r = nearest(t.arcs, a => a, dist, threshold)
    if (r !== null && dist > 0) {
      const k = r / dist
      x = t.origin.x + (p.x - t.origin.x) * k
      y = t.origin.y + (p.y - t.origin.y) * k
      guides.push({ kind: 'arc', r })
    }
  }

  // A mirror snap shows the centre line it mirrors across plus a connector
  // back to the partner, rather than a line through empty stage.
  if (sx?.mirrorOf) {
    guides.push({ kind: 'v', x: t.origin.x })
    guides.push({ kind: 'mirror', x1: sx.mirrorOf.x, y1: sx.mirrorOf.y, x2: x, y2: y })
  } else if (sx) {
    guides.push({ kind: 'v', x: sx.x })
  }
  if (sy) guides.push({ kind: 'h', y: sy.y })
  return { x, y, guides }
}

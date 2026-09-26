import { describe, expect, it } from 'vitest'
import { snapPoint, type SnapTargets } from '../src/snap'

const origin = { x: 500, y: 600 }
const empty: SnapTargets = { origin, xs: [], ys: [], arcs: [] }

describe('snapPoint', () => {
  it('leaves the point alone when nothing is within the threshold', () => {
    const t: SnapTargets = { ...empty, xs: [{ x: 100 }], ys: [{ y: 100 }], arcs: [300] }
    expect(snapPoint({ x: 200, y: 200 }, t, 6)).toEqual({ x: 200, y: 200, guides: [] })
  })

  it('snaps x and y lines independently', () => {
    const t: SnapTargets = { ...empty, xs: [{ x: 204 }], ys: [{ y: 197 }] }
    const r = snapPoint({ x: 200, y: 200 }, t, 6)
    expect([r.x, r.y]).toEqual([204, 197])
    expect(r.guides).toEqual([{ kind: 'v', x: 204 }, { kind: 'h', y: 197 }])
  })

  it('picks the nearest line when several are in range', () => {
    const t: SnapTargets = { ...empty, xs: [{ x: 195 }, { x: 202 }] }
    expect(snapPoint({ x: 200, y: 0 }, t, 6).x).toBe(202)
  })

  it('pulls the point radially onto an arc when no line catches', () => {
    // 297px from the origin, straight up — onto the 300px arc.
    const r = snapPoint({ x: 500, y: 303 }, { ...empty, arcs: [300] }, 6)
    expect(r.x).toBeCloseTo(500)
    expect(r.y).toBeCloseTo(300)
    expect(r.guides).toEqual([{ kind: 'arc', r: 300 }])
  })

  it('lands on a line/arc intersection when both are close', () => {
    // Centre line (x = 500) crosses the 300px arc at y = 300.
    const t: SnapTargets = { ...empty, xs: [{ x: 500 }], arcs: [300] }
    const r = snapPoint({ x: 503, y: 304 }, t, 6)
    expect([r.x, r.y]).toEqual([500, 300])
    expect(r.guides.map(g => g.kind).sort()).toEqual(['arc', 'v'])
  })

  it('does not jump to the far intersection of a line and arc', () => {
    // A horizontal line crosses the arc twice; only the near side is in range.
    const t: SnapTargets = { ...empty, ys: [{ y: 600 }], arcs: [300] }
    const r = snapPoint({ x: 205, y: 602 }, t, 6)
    expect([r.x, r.y]).toEqual([200, 600])
  })

  it('draws the centre line and a connector for a mirror snap', () => {
    const partner = { x: 350, y: 250 }
    const t: SnapTargets = {
      ...empty,
      xs: [{ x: 2 * origin.x - partner.x, mirrorOf: partner }],
      ys: [{ y: partner.y }],
    }
    const r = snapPoint({ x: 648, y: 253 }, t, 6)
    expect([r.x, r.y]).toEqual([650, 250])
    expect(r.guides).toContainEqual({ kind: 'v', x: origin.x })
    expect(r.guides).toContainEqual({ kind: 'mirror', x1: 350, y1: 250, x2: 650, y2: 250 })
  })
})

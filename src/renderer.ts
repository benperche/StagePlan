import type {
  ChartConfig, Row, Chair, FixedInstrument,
  HitTarget, ConductorHit, InstrumentHit, RotateHandleHit, ConductorOrigin,
  LayoutHandleHit, RowGeometry,
} from './types'
import {
  drawDrumkit, drawPiano, drawAmp, drawTimpani, drawMallet, drawHarp,
  drawMicrophone, drawGong, drawSingleChair, drawSingleStand, drawStool, drawGenericRect,
} from './instrument-glyphs'

const CHAIR_SIZE = 30
const CHAIR_HALF = CHAIR_SIZE / 2
const STAND_GAP = 6
const STAND_SIZE = 7   // half-arm of the ×
// Default distance between adjacent arc rows. Configurable per chart via
// ChartConfig.rowSpacing. Sized so the seat number drawn behind one row
// doesn't clash with the shared stand drawn in front of the row behind it
// (stand reaches ~35px forward of its chair, number ~28px behind, so 65px
// is the floor — 70px gives a small breathing gap).
const ROW_SPACING_DEFAULT = 70
const BASE_RADIUS = 130
const STRAIGHT_CHAIR_SPACING = 40
// Centre-to-centre distance between the two chairs of a desk pair when the
// renderer compresses them into a single arc slot. Chair size is 30, so 56
// gives a ~26px visual gap — enough that the stand × sits comfortably
// between the chairs instead of looking glued to either one.
const DESK_PAIR_SPACING = 56
const CONDUCTOR_EXTENT = 56
const COND_W = 52
const COND_H = 36

export interface RenderOptions {
  scale?: number
  // When true (the Layout tab is active), arc guides are forced on and the
  // canvas shows the geometry-editing handles.
  layoutMode?: boolean
}

export class Renderer {
  private hitTargets: HitTarget[] = []
  private instrumentHits: InstrumentHit[] = []
  conductorHit: ConductorHit | null = null
  conductorOrigin: ConductorOrigin = { ox: 0, oy: 0, yDir: -1, flipped: false }
  selectedInstrumentId: string | null = null
  rotateHandleHit: RotateHandleHit | null = null
  // Same-shape hit-test target for the red ✕ delete button drawn next to
  // the selected instrument.
  deleteHandleHit: RotateHandleHit | null = null

  // Background image cache + async-load callback so main.ts can trigger
  // a re-render once a newly-uploaded image is decoded.
  private backgroundImage: HTMLImageElement | null = null
  private backgroundImageSrc: string | null = null
  onBackgroundLoaded: (() => void) | null = null

  // Set per-render from RenderOptions.layoutMode. When true the chart shows
  // arc guides + geometry handles regardless of config.showArc.
  private layoutMode = false
  // Populated each render in layout mode: the draggable handles + the per-row
  // geometry main.ts needs to drive the drags. Empty otherwise.
  private layoutHandles: LayoutHandleHit[] = []
  layoutRows: RowGeometry[] = []

  render(canvas: HTMLCanvasElement, config: ChartConfig, opts: RenderOptions = {}): void {
    const scale = opts.scale ?? 1
    this.layoutMode = opts.layoutMode ?? false
    const ctx = canvas.getContext('2d')!
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.save()
    ctx.scale(scale, scale)

    this.hitTargets = []
    this.instrumentHits = []
    this.layoutHandles = []
    this.layoutRows = []
    this.conductorHit = null
    this.rotateHandleHit = null
    this.deleteHandleHit = null

    const w = canvas.width / scale
    const h = canvas.height / scale

    // Background image (fit to canvas) drawn first, beneath everything.
    this.drawBackground(ctx, config, w, h)

    // Title / notes / stage-direction labels stay at canvas scale so they
    // don't shrink with chartScale and remain readable.
    this.drawTitle(ctx, config.title, w)
    this.drawNotes(ctx, config.notes, h, config.showCredit ?? true)
    if (config.showStageDirections) this.drawStageDirections(ctx, w, h)

    // The seating chart itself is wrapped in a uniform scale transform
    // centred on the conductor. Hit targets are stored in chart coords
    // (unscaled) so main.ts must inverse-transform pointer coordinates
    // before calling the hit-test methods.
    const numRows = config.rows.length
    const rowSpacing = this.effectiveRowSpacing(h, numRows, config.rowSpacing ?? ROW_SPACING_DEFAULT)
    const ox = w / 2 + (config.conductor.offsetX ?? 0)
    const oy = this.computeOy(h, numRows, config.flipped, rowSpacing) + (config.conductor.offsetY ?? 0)
    const chartScale = config.chartScale ?? 1
    const scaling = chartScale !== 1
    if (scaling) {
      ctx.save()
      ctx.translate(ox, oy)
      ctx.scale(chartScale, chartScale)
      ctx.translate(-ox, -oy)
    }

    if (config.layout === 'semicircle') {
      this.renderSemicircle(ctx, config, w, h)
    } else {
      this.renderStraight(ctx, config, w, h)
    }

    // Instruments draw on top so they're always visible & selectable
    this.renderInstruments(ctx, config)

    if (scaling) ctx.restore()

    this.drawRowSummary(ctx, config, w, h)
    if (config.showCredit ?? true) this.drawCredit(ctx, h)
    ctx.restore()
  }

  private drawBackground(ctx: CanvasRenderingContext2D, config: ChartConfig, w: number, h: number) {
    const src = config.backgroundImage ?? null
    if (src !== this.backgroundImageSrc) {
      // New (or removed) source — invalidate cache and start loading.
      this.backgroundImageSrc = src
      this.backgroundImage = null
      if (src) {
        const img = new Image()
        img.onload = () => {
          if (this.backgroundImageSrc === src) {
            this.backgroundImage = img
            if (this.onBackgroundLoaded) this.onBackgroundLoaded()
          }
        }
        img.src = src
      }
    }
    const img = this.backgroundImage
    if (!img) return

    const fit = config.backgroundFit ?? 'contain'
    const imgRatio = img.width / img.height
    const canvasRatio = w / h
    let drawW: number, drawH: number, drawX: number, drawY: number

    if (fit === 'stretch') {
      drawW = w; drawH = h; drawX = 0; drawY = 0
    } else if (fit === 'cover') {
      // Fill the canvas, preserving aspect — overflow is cropped.
      if (imgRatio > canvasRatio) {
        drawH = h
        drawW = h * imgRatio
        drawX = (w - drawW) / 2
        drawY = 0
      } else {
        drawW = w
        drawH = w / imgRatio
        drawX = 0
        drawY = (h - drawH) / 2
      }
    } else {
      // Contain: preserve aspect, letterbox the remainder.
      if (imgRatio > canvasRatio) {
        drawW = w
        drawH = w / imgRatio
        drawX = 0
        drawY = (h - drawH) / 2
      } else {
        drawH = h
        drawW = h * imgRatio
        drawX = (w - drawW) / 2
        drawY = 0
      }
    }
    ctx.drawImage(img, drawX, drawY, drawW, drawH)
  }

  instrumentHitTest(x: number, y: number): InstrumentHit | null {
    // Iterate in reverse so top-drawn instruments win when overlapping
    for (let i = this.instrumentHits.length - 1; i >= 0; i--) {
      const h = this.instrumentHits[i]
      const dx = x - h.cx
      const dy = y - h.cy
      // Rotate point into the instrument's local frame
      const cos = Math.cos(-h.rotation)
      const sin = Math.sin(-h.rotation)
      const lx = dx * cos - dy * sin
      const ly = dx * sin + dy * cos
      if (Math.abs(lx) <= h.hw && Math.abs(ly) <= h.hh) return h
    }
    return null
  }

  rotateHandleHitTest(x: number, y: number): RotateHandleHit | null {
    const h = this.rotateHandleHit
    if (!h) return null
    if (Math.hypot(x - h.cx, y - h.cy) <= h.radius) return h
    return null
  }

  deleteHandleHitTest(x: number, y: number): RotateHandleHit | null {
    const h = this.deleteHandleHit
    if (!h) return null
    if (Math.hypot(x - h.cx, y - h.cy) <= h.radius) return h
    return null
  }

  hitTest(x: number, y: number): HitTarget | null {
    for (const target of this.hitTargets) {
      const dx = x - target.x
      const dy = y - target.y
      if (dx * dx + dy * dy <= target.radius * target.radius) return target
    }
    return null
  }

  conductorHitTest(x: number, y: number): boolean {
    if (!this.conductorHit) return false
    const { x: cx, y: cy, w, h } = this.conductorHit
    return x >= cx && x <= cx + w && y >= cy && y <= cy + h
  }

  // ---------------------------------------------------------------------------
  // Vertical centering
  // ---------------------------------------------------------------------------

  // Use the user's preferred row spacing as the upper bound. If the chart
  // would overflow at that spacing, shrink to whatever fits. Floored at 40
  // so extremely tall charts still render legibly. The user is in charge
  // when their value is feasible; we only step in when it isn't.
  private effectiveRowSpacing(h: number, numRows: number, userRowSpacing: number): number {
    if (numRows <= 1) return userRowSpacing
    const titlePad = 50
    const farPad = 30
    const available = h - titlePad - farPad - CONDUCTOR_EXTENT - BASE_RADIUS - CHAIR_HALF
    const fitting = available / (numRows - 1)
    return Math.max(40, Math.min(userRowSpacing, fitting))
  }

  // Cumulative per-row radius from the conductor. Base step is the (already
  // fitted) row spacing; each row adds its optional `gapBefore`. Because it's
  // cumulative, bumping one row's gap pushes every row behind it out by the
  // same amount — the "push rows behind" distance behaviour. With all gaps 0
  // this is exactly BASE_RADIUS + i * rowSpacing.
  private computeRowRadii(rows: Row[], rowSpacing: number): number[] {
    const radii: number[] = []
    for (let i = 0; i < rows.length; i++) {
      const base = i === 0 ? BASE_RADIUS : radii[i - 1] + rowSpacing
      radii[i] = base + (rows[i].gapBefore ?? 0)
    }
    return radii
  }

  // A row's arc span as [startAngle, endAngle] in canvas radians. Per-row
  // arcStart/arcEnd win; otherwise derived symmetrically from the global
  // arcRange around the apex (π/2).
  private rowArcAngles(row: Row, config: ChartConfig): [number, number] {
    const range = config.arcRange ?? Math.PI
    const start = row.arcStart ?? (Math.PI / 2 + range / 2)
    const end = row.arcEnd ?? (Math.PI / 2 - range / 2)
    return [start, end]
  }

  private computeOy(h: number, numRows: number, flipped: boolean, rowSpacing: number): number {
    // Default conductor position sits in the lower (or upper, when flipped)
    // third of the canvas — the conductor is at the FRONT of the stage, with
    // chairs working backwards from there. Falls back to clamping when the
    // chart is too tall to fit at the preferred position.
    const chartHeight = BASE_RADIUS + Math.max(0, numRows - 1) * rowSpacing + CHAIR_HALF
    // The chart-title side needs extra padding so the title (drawn at y≈14,
    // text ~18px tall) doesn't get tangled with the back-row seat numbers
    // (drawn ~12px above the back chair top). 50px covers both with a
    // small gap. The opposite side just needs a normal margin.
    const titleSidePadding = 50
    const farSidePadding = 30
    if (flipped) {
      // Conductor near the top — title is above the conductor, chairs and
      // their seat numbers extend down toward the bottom of the canvas.
      const target = h / 3
      const minOy = titleSidePadding + CONDUCTOR_EXTENT
      const maxOy = h - farSidePadding - chartHeight
      return Math.max(minOy, Math.min(target, maxOy))
    } else {
      // Conductor near the bottom — chairs and their seat numbers extend
      // up toward the title at the top of the canvas.
      const target = (h * 2) / 3
      const minOy = chartHeight + titleSidePadding
      const maxOy = h - farSidePadding - CONDUCTOR_EXTENT
      return Math.min(maxOy, Math.max(target, minOy))
    }
  }

  // ---------------------------------------------------------------------------
  // Semicircle layout
  // ---------------------------------------------------------------------------

  private renderSemicircle(ctx: CanvasRenderingContext2D, config: ChartConfig, w: number, h: number) {
    const numRows = config.rows.length
    const rowSpacing = this.effectiveRowSpacing(h, numRows, config.rowSpacing ?? ROW_SPACING_DEFAULT)
    const offX = config.conductor.offsetX ?? 0
    const offY = config.conductor.offsetY ?? 0
    const ox = w / 2 + offX
    const oy = this.computeOy(h, numRows, config.flipped, rowSpacing) + offY
    const yDir = config.flipped ? 1 : -1
    this.conductorOrigin = { ox, oy, yDir, flipped: config.flipped }
    const radii = this.computeRowRadii(config.rows, rowSpacing)

    // Draw arcs first (behind chairs). Each guide spans the row's own arc
    // range so the guide tracks any per-row span override. Always shown in
    // the Layout tab so you can see what you're adjusting against.
    if (config.showArc || this.layoutMode) {
      config.rows.forEach((row, rowIndex) => {
        const isStraight = config.rows[rowIndex].isStraight ?? (rowIndex >= numRows - config.straightRows)
        if (isStraight) return
        const [arcStart, arcEnd] = this.rowArcAngles(row, config)
        const r = radii[rowIndex]
        ctx.save()
        ctx.beginPath()
        ctx.arc(ox, oy, r, arcStart, arcEnd, yDir > 0)
        ctx.strokeStyle = '#ccc'
        ctx.lineWidth = 1
        ctx.setLineDash([4, 4])
        ctx.stroke()
        ctx.setLineDash([])
        ctx.restore()
      })
    }

    this.drawConductor(ctx, ox, oy, yDir, config)

    // Consistent label x for every row that's rendered as straight (whether
    // via the per-row override or the "last N from back" global default).
    const isStraightRow = (rowIndex: number) =>
      config.rows[rowIndex].isStraight ?? (rowIndex >= numRows - config.straightRows)
    const maxStraightWidth = config.rows.reduce((mx, r, i) =>
      isStraightRow(i) ? Math.max(mx, (r.chairs.length - 1) * (r.straightSpacing ?? STRAIGHT_CHAIR_SPACING)) : mx, 0)
    // Mirror the label x with the rest of the chart when flipped (row label
    // sits past the conductor's centre on the chair side).
    const straightLabelX = ox + (config.flipped ? 1 : -1) * (maxStraightWidth / 2 + CHAIR_HALF + 18)

    let seatNumber = 1
    config.rows.forEach((row, rowIndex) => {
      const r = radii[rowIndex]
      if (isStraightRow(rowIndex)) {
        seatNumber = this.renderStraightRow(ctx, row, rowIndex, oy + yDir * r, ox, oy, config, seatNumber, straightLabelX)
      } else {
        seatNumber = this.renderArcRow(ctx, row, rowIndex, r, ox, oy, yDir, config, seatNumber)
      }
    })

    if (this.layoutMode) {
      this.renderLayoutHandles(ctx, config, ox, oy, yDir, radii, rowSpacing, isStraightRow)
    }
  }

  private renderArcRow(
    ctx: CanvasRenderingContext2D,
    row: Row,
    rowIndex: number,
    r: number,
    ox: number, oy: number, yDir: number,
    config: ChartConfig,
    seatNumber: number,
  ): number {
    const chairs = row.chairs
    const N = chairs.length
    if (N === 0) return seatNumber

    // Arc span — global default (full semicircle) unless this row carries its
    // own start/end override from the Layout tab.
    const [startAngle, endAngle] = this.rowArcAngles(row, config)
    // Every chair gets its own evenly-spread slot — toggling a shared stand
    // on a single chair never reshuffles the rest of the row. The natural
    // step is the angle between adjacent chair slots.
    const naturalStep = N > 1 ? (startAngle - endAngle) / (N - 1) : 0
    // Per-chair sideways nudge (px tangential → angle). Positive moves the
    // chair toward the end of the row (decreasing angle). Default 0.
    const place = (angle: number, chair: Chair) => {
      const a = angle - (chair.offset ?? 0) / r
      return { cx: ox + xDir * r * Math.cos(a), cy: oy + yDir * r * Math.sin(a) }
    }
    // When two chairs share a desk (standAfter, or two adjacent disabled
    // placeholders), the pair pulls toward the midpoint of their natural
    // slots until the chairs sit DESK_PAIR_SPACING centre-to-centre apart.
    // If their natural separation is already tighter than that, they stay
    // put — we never push chairs apart.
    const desiredHalfOffset = DESK_PAIR_SPACING / 2 / r
    // When the chart is flipped, mirror chairs left↔right as well as the
    // existing top↔bottom flip — flipping is a 180° rotation around the
    // conductor, not just a vertical reflection. Chair 0 (leftmost in the
    // unflipped view) ends up rightmost so the layout looks identical from
    // the conductor's perspective regardless of which side you're viewing.
    const xDir = -yDir

    const positions: Array<{ cx: number; cy: number }> = new Array(N)
    let i = 0
    while (i < N) {
      const c = chairs[i]
      const next = i + 1 < N ? chairs[i + 1] : null
      const isPair = !!next && (c.standAfter || (!c.enabled && !next.enabled))
      if (isPair) {
        const a0 = startAngle - i * naturalStep
        const a1 = startAngle - (i + 1) * naturalStep
        const midpoint = (a0 + a1) / 2
        const halfSep = Math.min(naturalStep / 2, desiredHalfOffset)
        const angleA = midpoint + halfSep
        const angleB = midpoint - halfSep
        positions[i]     = place(angleA, c)
        positions[i + 1] = place(angleB, chairs[i + 1]!)
        i += 2
      } else {
        const angle = startAngle - i * naturalStep
        positions[i] = place(angle, c)
        i += 1
      }
    }

    chairs.forEach((chair, chairIndex) => {
      const { cx, cy } = positions[chairIndex]
      if (chair.enabled) {
        this.drawChair(ctx, chair, cx, cy, ox, oy, row.fontSize, this.isNudged(chair))
        if (chair.hasStand) this.drawStandX(ctx, cx, cy, ox, oy)
        if (config.showNumbers) {
          const num = config.numberRestartPerRow
            ? chairs.slice(0, chairIndex).filter(c => c.enabled).length + 1
            : seatNumber
          this.drawSeatNumber(ctx, cx, cy, ox, oy, String(num), row.fontSize)
        }
        seatNumber++
      } else {
        this.drawGhostChair(ctx, cx, cy, ox, oy)
      }
      this.hitTargets.push({ rowIndex, chairIndex, x: cx, y: cy, radius: CHAIR_HALF * 1.1 })
    })

    // Shared stand between desk-paired chairs (only when at least one is
    // enabled — pure placeholder pairs don't need a stand).
    chairs.forEach((chair, chairIndex) => {
      if (!chair.standAfter || chairIndex + 1 >= positions.length) return
      const next = chairs[chairIndex + 1]
      if (!chair.enabled && !next.enabled) return
      const a = positions[chairIndex]
      const b = positions[chairIndex + 1]
      this.drawStandX(ctx, (a.cx + b.cx) / 2, (a.cy + b.cy) / 2, ox, oy)
    })

    if (config.showRowLabels) {
      // Label to the left of the leftmost chair (or right of the rightmost
      // when flipped, since "leftmost" mirrors across), pushed past the
      // conductor line so it sits "behind" the row rather than beside it.
      const lx = ox + xDir * (-r - CHAIR_HALF - 6)
      const ly = oy - yDir * (CHAIR_HALF + 8)
      this.drawRowLabel(ctx, row.label, lx, ly)
    }

    return seatNumber
  }

  /**
   * Draw one row's worth of chairs in a horizontal line at y = rowY,
   * centred on `ox`. Used both by the "straight rows from back" feature in
   * semicircle layouts and by the pure straight layout. Mutates seatNumber
   * via the return value; pushes hit targets as a side effect.
   */
  private renderStraightRow(
    ctx: CanvasRenderingContext2D,
    row: Row,
    rowIndex: number,
    rowY: number,
    ox: number, oy: number,
    config: ChartConfig,
    seatNumber: number,
    labelX: number,
  ): number {
    const total = row.chairs.length
    if (total === 0) return seatNumber

    const spacing = row.straightSpacing ?? STRAIGHT_CHAIR_SPACING
    const centerOffset = row.straightOffset ?? 0
    const rowWidth = (total - 1) * spacing
    // Flip mirrors left↔right around the conductor (the renderer's whole
    // notion of "flipped" is a 180° rotation around the conductor, not just
    // a vertical flip). xDir is the x-axis equivalent of the existing yDir.
    const xDir = config.flipped ? -1 : 1
    const positions: Array<{ cx: number; cy: number }> = []

    row.chairs.forEach((chair, chairIndex) => {
      // Chair distance from ox, with mirror baked in. straightOffset shifts
      // the whole row sideways; chair.offset nudges this one chair along it.
      const cx = ox + xDir * (chairIndex * spacing - rowWidth / 2 + centerOffset + (chair.offset ?? 0))
      positions.push({ cx, cy: rowY })

      if (chair.enabled) {
        this.drawChair(ctx, chair, cx, rowY, cx, oy, row.fontSize, this.isNudged(chair))
        if (chair.hasStand) this.drawStandX(ctx, cx, rowY, cx, oy)
        if (config.showNumbers) {
          const num = config.numberRestartPerRow
            ? row.chairs.slice(0, chairIndex).filter(c => c.enabled).length + 1
            : seatNumber
          this.drawSeatNumber(ctx, cx, rowY, cx, oy, String(num), row.fontSize)
        }
        seatNumber++
      } else {
        this.drawGhostChair(ctx, cx, rowY, cx, oy)
      }

      this.hitTargets.push({ rowIndex, chairIndex, x: cx, y: rowY, radius: CHAIR_HALF * 1.1 })
    })

    // Shared stands between desk-paired chairs
    row.chairs.forEach((chair, chairIndex) => {
      if (chair.standAfter && chairIndex + 1 < positions.length) {
        const a = positions[chairIndex]
        const b = positions[chairIndex + 1]
        this.drawStandX(ctx, (a.cx + b.cx) / 2, (a.cy + b.cy) / 2, a.cx, oy)
      }
    })

    if (config.showRowLabels) this.drawRowLabel(ctx, row.label, labelX, rowY)
    return seatNumber
  }

  // ---------------------------------------------------------------------------
  // Pure straight layout
  // ---------------------------------------------------------------------------

  private renderStraight(ctx: CanvasRenderingContext2D, config: ChartConfig, w: number, h: number) {
    const numRows = config.rows.length
    const rowSpacing = this.effectiveRowSpacing(h, numRows, config.rowSpacing ?? ROW_SPACING_DEFAULT)
    const offX = config.conductor.offsetX ?? 0
    const offY = config.conductor.offsetY ?? 0
    const ox = w / 2 + offX
    const oy = this.computeOy(h, numRows, config.flipped, rowSpacing) + offY
    const yDir = config.flipped ? 1 : -1
    this.conductorOrigin = { ox, oy, yDir, flipped: config.flipped }

    this.drawConductor(ctx, ox, oy, yDir, config)

    // Consistent label x: align all labels to the left edge of the widest
    // row (or right edge when flipped, mirrored around the conductor).
    const maxRowWidth = config.rows.reduce((mx, r) =>
      Math.max(mx, (r.chairs.length - 1) * (r.straightSpacing ?? STRAIGHT_CHAIR_SPACING)), 0)
    const labelX = ox + (config.flipped ? 1 : -1) * (maxRowWidth / 2 + CHAIR_HALF + 18)

    const radii = this.computeRowRadii(config.rows, rowSpacing)
    let seatNumber = 1
    config.rows.forEach((row, rowIndex) => {
      const rowY = oy + yDir * radii[rowIndex]
      seatNumber = this.renderStraightRow(ctx, row, rowIndex, rowY, ox, oy, config, seatNumber, labelX)
    })

    if (this.layoutMode) {
      this.renderLayoutHandles(ctx, config, ox, oy, yDir, radii, rowSpacing, () => true)
    }
  }

  // ---------------------------------------------------------------------------
  // Layout-tab handles
  // ---------------------------------------------------------------------------

  // Draws each row's distance handle (radial diamond at the apex) and span
  // handles (tangential circles at the ends), and records both the hit
  // targets and the per-row geometry main.ts uses to drive the drags.
  private renderLayoutHandles(
    ctx: CanvasRenderingContext2D,
    config: ChartConfig,
    ox: number, oy: number, yDir: number,
    radii: number[],
    rowSpacing: number,
    isStraightRow: (i: number) => boolean,
  ) {
    const xDir = -yDir
    const HANDLE_GAP = 24
    const endPad = CHAIR_HALF + 12

    config.rows.forEach((row, i) => {
      const r = radii[i]
      const base = i === 0 ? BASE_RADIUS : radii[i - 1] + rowSpacing
      const prevR = i === 0 ? 0 : radii[i - 1]
      const N = row.chairs.length
      const straight = isStraightRow(i)
      const geom: RowGeometry = {
        rowIndex: i, isStraight: straight, r, base, prevR,
        arcStart: 0, arcEnd: 0, rowY: 0, spacing: 0, centerOffset: 0,
      }

      let distPt: { x: number; y: number }
      let startPt: { x: number; y: number } | null = null
      let endPt: { x: number; y: number } | null = null

      if (straight) {
        const spacing = row.straightSpacing ?? STRAIGHT_CHAIR_SPACING
        const centerOffset = row.straightOffset ?? 0
        const rowY = oy + yDir * r
        const rowWidth = (N - 1) * spacing
        geom.rowY = rowY; geom.spacing = spacing; geom.centerOffset = centerOffset
        distPt = { x: ox + xDir * centerOffset, y: oy + yDir * (r + HANDLE_GAP) }
        if (N > 1) {
          startPt = { x: ox + xDir * (centerOffset - rowWidth / 2 - endPad), y: rowY }
          endPt   = { x: ox + xDir * (centerOffset + rowWidth / 2 + endPad), y: rowY }
        }
      } else {
        const [arcStart, arcEnd] = this.rowArcAngles(row, config)
        geom.arcStart = arcStart; geom.arcEnd = arcEnd
        distPt = { x: ox, y: oy + yDir * (r + HANDLE_GAP) }   // apex (angle π/2) is vertical
        if (N > 1) {
          const da = endPad / r
          const aS = arcStart + da, aE = arcEnd - da
          startPt = { x: ox + xDir * r * Math.cos(aS), y: oy + yDir * r * Math.sin(aS) }
          endPt   = { x: ox + xDir * r * Math.cos(aE), y: oy + yDir * r * Math.sin(aE) }
        }
      }

      this.layoutRows[i] = geom
      this.drawLayoutDiamond(ctx, distPt.x, distPt.y)
      this.layoutHandles.push({ rowIndex: i, kind: 'distance', cx: distPt.x, cy: distPt.y, radius: 13 })
      if (startPt) {
        this.drawLayoutDot(ctx, startPt.x, startPt.y)
        this.layoutHandles.push({ rowIndex: i, kind: 'span-start', cx: startPt.x, cy: startPt.y, radius: 11 })
      }
      if (endPt) {
        this.drawLayoutDot(ctx, endPt.x, endPt.y)
        this.layoutHandles.push({ rowIndex: i, kind: 'span-end', cx: endPt.x, cy: endPt.y, radius: 11 })
      }
    })
  }

  private drawLayoutDiamond(ctx: CanvasRenderingContext2D, cx: number, cy: number) {
    const s = 7
    ctx.save()
    ctx.beginPath()
    ctx.moveTo(cx, cy - s); ctx.lineTo(cx + s, cy); ctx.lineTo(cx, cy + s); ctx.lineTo(cx - s, cy)
    ctx.closePath()
    ctx.fillStyle = '#2563eb'; ctx.fill()
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke()
    ctx.restore()
  }

  private drawLayoutDot(ctx: CanvasRenderingContext2D, cx: number, cy: number) {
    ctx.save()
    ctx.beginPath(); ctx.arc(cx, cy, 5.5, 0, Math.PI * 2)
    ctx.fillStyle = '#2563eb'; ctx.fill()
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke()
    ctx.restore()
  }

  layoutHandleHitTest(x: number, y: number): LayoutHandleHit | null {
    for (let i = this.layoutHandles.length - 1; i >= 0; i--) {
      const h = this.layoutHandles[i]
      if (Math.hypot(x - h.cx, y - h.cy) <= h.radius) return h
    }
    return null
  }

  // The drawn centre of a specific chair (for clamping a per-chair nudge
  // against its neighbours). Reads this frame's hit targets.
  chairCenter(rowIndex: number, chairIndex: number): { x: number; y: number } | null {
    for (const t of this.hitTargets) {
      if (t.rowIndex === rowIndex && t.chairIndex === chairIndex) return { x: t.x, y: t.y }
    }
    return null
  }

  // ---------------------------------------------------------------------------
  // Fixed instruments (rhythm section, timpani, mallets, etc.)
  // ---------------------------------------------------------------------------

  private renderInstruments(ctx: CanvasRenderingContext2D, config: ChartConfig) {
    const instruments = config.instruments ?? []
    if (instruments.length === 0) return
    const { ox, oy, flipped } = this.conductorOrigin
    // Flipped chart is a 180° rotation around the conductor. For fixed
    // instruments, both the position (dx, dy from conductor) and the
    // glyph's local rotation rotate by π — except for visually-symmetric
    // hardware (drum kit, amps) where flipping the rotation just makes
    // them look upside-down without communicating anything useful.
    const mirror = flipped ? -1 : 1

    instruments.forEach(inst => {
      const cx = ox + mirror * inst.distance * Math.cos(inst.angle)
      const cy = oy + mirror * inst.distance * Math.sin(inst.angle)
      // Symmetric / orientation-neutral glyphs stay upright in canvas
      // coords when the chart is flipped — rotating them just looks
      // upside-down for no benefit.
      const keepUpright = inst.type === 'drumkit' || inst.type === 'guitar-amp'
        || inst.type === 'bass-amp' || inst.type === 'stand'
        || inst.type === 'stool' || inst.type === 'microphone'
        || inst.type === 'gong'
      const worldRotation = inst.rotation + (flipped && !keepUpright ? Math.PI : 0)
      const isSelected = inst.id === this.selectedInstrumentId

      // 1) Draw the glyph in the rotated frame (no label!)
      ctx.save()
      ctx.translate(cx, cy)
      ctx.rotate(worldRotation)

      let hw = 0, hh = 0, labelInside = false
      switch (inst.type) {
        case 'drumkit':    ({ hw, hh, labelInside } = drawDrumkit(ctx)); break
        case 'piano':      ({ hw, hh, labelInside } = drawPiano(ctx)); break
        case 'guitar-amp': ({ hw, hh, labelInside } = drawAmp(ctx, 32, 34)); break
        case 'bass-amp':   ({ hw, hh, labelInside } = drawAmp(ctx, 40, 42)); break
        case 'timpani':    ({ hw, hh, labelInside } = drawTimpani(ctx, inst)); break
        case 'mallet':     ({ hw, hh, labelInside } = drawMallet(ctx)); break
        case 'harp':       ({ hw, hh, labelInside } = drawHarp(ctx)); break
        case 'microphone': ({ hw, hh, labelInside } = drawMicrophone(ctx, inst)); break
        case 'gong':       ({ hw, hh, labelInside } = drawGong(ctx)); break
        case 'chair':      ({ hw, hh, labelInside } = drawSingleChair(ctx)); break
        case 'stand':      ({ hw, hh, labelInside } = drawSingleStand(ctx)); break
        case 'stool':      ({ hw, hh, labelInside } = drawStool(ctx)); break
        case 'square':     ({ hw, hh, labelInside } = drawGenericRect(ctx, 28, 28)); break
        case 'rectangle':  ({ hw, hh, labelInside } = drawGenericRect(ctx, 42, 26)); break
      }

      // Selection highlight (still in rotated frame so it tracks the glyph)
      if (isSelected) {
        const pad = 6
        ctx.strokeStyle = '#2563eb'
        ctx.lineWidth = 1.5
        ctx.setLineDash([4, 3])
        ctx.strokeRect(-hw - pad, -hh - pad, (hw + pad) * 2, (hh + pad) * 2)
        ctx.setLineDash([])
      }

      ctx.restore()

      // 2) Draw the label OUTSIDE the rotation so it stays horizontal
      const text = this.instrumentLabel(inst)
      if (labelInside) {
        // Centred over the instrument's centre, white on dark fill
        ctx.save()
        ctx.fillStyle = '#fff'
        ctx.font = 'bold 11px sans-serif'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(text, cx, cy)
        ctx.restore()
      } else {
        // Below the rotated bounding box's lowest point
        const drop = Math.abs(hw * Math.sin(worldRotation)) + Math.abs(hh * Math.cos(worldRotation))
        ctx.save()
        ctx.fillStyle = '#222'
        ctx.font = 'bold 11px sans-serif'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'top'
        ctx.fillText(text, cx, cy + drop + 4)
        ctx.restore()
      }

      // 3) Optional music stand attached to this instrument — drawn
      // between the instrument body and the conductor regardless of
      // the glyph's own rotation. Sized so it sits just outside the
      // instrument's bounding-circle radius so it never overlaps the
      // glyph itself.
      if (inst.hasStand) {
        const standDist = Math.max(hw, hh) + STAND_GAP + STAND_SIZE
        this.drawStandX(ctx, cx, cy, ox, oy, standDist)
      }

      // 4) Selection adornments (only on the selected instrument)
      if (isSelected) {
        this.drawRotateHandle(ctx, cx, cy, hh, worldRotation, inst.id)
        this.drawDeleteHandle(ctx, cx, cy, hw, hh, worldRotation, inst.id)
      }

      // 4) Hit target for the body — uses the rendered (post-flip) position
      // and rotation, so click hit-tests match what the user actually sees.
      this.instrumentHits.push({
        id: inst.id,
        cx, cy, hw, hh,
        rotation: worldRotation,
      })
    })
  }

  private instrumentLabel(inst: FixedInstrument): string {
    if (inst.label) return inst.label
    switch (inst.type) {
      case 'drumkit':    return 'Drum Kit'
      case 'piano':      return 'Piano'
      case 'guitar-amp': return 'Gtr'
      case 'bass-amp':   return 'Bass'
      case 'timpani':    return `Timpani (${inst.count ?? 4})`
      case 'mallet':     return 'Mallets'
      case 'harp':       return 'Harp'
      case 'microphone': return 'Mic'
      case 'gong':       return 'Gong'
      // Single chair / single stand default to no label — they're often
      // used as decorations rather than annotated items. Users can still
      // type a label in the inspector if they want one.
      case 'chair':      return ''
      case 'stand':      return ''
      case 'stool':      return ''
      case 'square':     return 'Square'
      case 'rectangle':  return 'Rectangle'
    }
  }

  // MS-Office style rotate handle: a small green disc above the instrument,
  // connected by a thin line to the top of its (rotated) bounding box.
  private drawRotateHandle(
    ctx: CanvasRenderingContext2D,
    cx: number, cy: number,
    hh: number, rotation: number,
    instId: string,
  ) {
    const stem = 22
    const handleR = 6

    // Local "above" point (0, -hh) rotates to:
    const topX = cx + hh * Math.sin(rotation)
    const topY = cy - hh * Math.cos(rotation)
    // Local handle anchor (0, -hh - stem) rotates to:
    const hx = cx + (hh + stem) * Math.sin(rotation)
    const hy = cy - (hh + stem) * Math.cos(rotation)

    ctx.save()
    // Connecting stem
    ctx.strokeStyle = '#34a853'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.moveTo(topX, topY)
    ctx.lineTo(hx, hy)
    ctx.stroke()
    // Handle disc with white outline so it pops against any background
    ctx.fillStyle = '#34a853'
    ctx.strokeStyle = '#fff'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.arc(hx, hy, handleR, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
    ctx.restore()

    this.rotateHandleHit = { id: instId, cx: hx, cy: hy, radius: handleR + 4 }
  }

  // Red ✕ disc sitting at the top-right corner of the selected instrument's
  // rotated bounding box. Click to delete — same as the inspector's Delete
  // button or pressing Backspace, but discoverable straight from the canvas.
  private drawDeleteHandle(
    ctx: CanvasRenderingContext2D,
    cx: number, cy: number,
    hw: number, hh: number, rotation: number,
    instId: string,
  ) {
    const handleR = 9
    const margin = 6
    // Local top-right corner (hw, -hh) rotated into world coords
    const dx = cx + hw * Math.cos(rotation) - (-hh) * Math.sin(rotation)
    const dy = cy + hw * Math.sin(rotation) + (-hh) * Math.cos(rotation)
    // Nudge a little further out along the (hw, -hh) diagonal so the button
    // sits just outside the bounding box rather than overlapping the glyph
    const len = Math.hypot(hw, hh)
    const nx = (hw / len) * Math.cos(rotation) - (-hh / len) * Math.sin(rotation)
    const ny = (hw / len) * Math.sin(rotation) + (-hh / len) * Math.cos(rotation)
    const px = dx + nx * margin
    const py = dy + ny * margin

    ctx.save()
    ctx.fillStyle = '#dc2626'         // red-600
    ctx.strokeStyle = '#fff'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.arc(px, py, handleR, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
    // White × inside the disc
    ctx.strokeStyle = '#fff'
    ctx.lineWidth = 2
    ctx.lineCap = 'round'
    const s = handleR * 0.45
    ctx.beginPath()
    ctx.moveTo(px - s, py - s); ctx.lineTo(px + s, py + s)
    ctx.moveTo(px + s, py - s); ctx.lineTo(px - s, py + s)
    ctx.stroke()
    ctx.restore()

    this.deleteHandleHit = { id: instId, cx: px, cy: py, radius: handleR + 3 }
  }

  // Each glyph returns its half-width / half-height for the hit box.
  // Glyphs draw centred at (0,0) in the current (already rotated) frame.

  // All instrument glyphs are drawn in monochrome (black silhouettes with
  // optional white inner detail) so the chart stays a clean black & white
  // diagram.  Chair colours remain user-controlled.

  // ---------------------------------------------------------------------------
  // Title + Notes — always rendered, WYSIWYG
  // ---------------------------------------------------------------------------

  private drawTitle(ctx: CanvasRenderingContext2D, title: string, w: number) {
    if (!title) return
    ctx.save()
    ctx.fillStyle = '#111'
    ctx.font = 'bold 18px sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    ctx.fillText(title, w / 2, 14)
    ctx.restore()
  }

  private drawNotes(ctx: CanvasRenderingContext2D, notes: string, h: number, creditShown: boolean) {
    if (!notes) return
    const lines = notes.split('\n').filter(l => l.trim())
    if (lines.length === 0) return

    const lineHeight = 14
    const x = 12
    // Sit above the "Created with StagePlan" credit when it's drawn, so
    // the two never overlap. Credit line is ~14px tall (10px font + 4px
    // breathing room) and itself anchored at the bottom-text baseline.
    const creditReserve = creditShown ? 16 : 0
    const bottomY = h - 24 - creditReserve

    ctx.save()
    ctx.fillStyle = '#888'
    ctx.font = '11px sans-serif'
    ctx.textAlign = 'left'
    ctx.textBaseline = 'bottom'
    lines.forEach((line, i) => {
      ctx.fillText(line, x, bottomY - (lines.length - 1 - i) * lineHeight)
    })
    ctx.restore()
  }

  // Light-grey vertical "STAGE RIGHT" / "STAGE LEFT" labels on the canvas
  // edges, from the performer's perspective. Stage right = audience left
  // = canvas left; stage left = canvas right. Both rotated so they read
  // bottom-to-top (the spine-text convention).
  private drawStageDirections(ctx: CanvasRenderingContext2D, w: number, h: number) {
    ctx.save()
    ctx.fillStyle = '#ddd'
    ctx.font = 'bold 26px sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'

    // Left edge — Stage Right
    ctx.save()
    ctx.translate(26, h / 2)
    ctx.rotate(-Math.PI / 2)
    ctx.fillText('STAGE RIGHT', 0, 0)
    ctx.restore()

    // Right edge — Stage Left
    ctx.save()
    ctx.translate(w - 26, h / 2)
    ctx.rotate(-Math.PI / 2)
    ctx.fillText('STAGE LEFT', 0, 0)
    ctx.restore()

    ctx.restore()
  }

  // ---------------------------------------------------------------------------
  // Row summary — always rendered in bottom-right corner
  // ---------------------------------------------------------------------------

  private drawRowSummary(ctx: CanvasRenderingContext2D, config: ChartConfig, w: number, h: number) {
    const lines = config.rows.map((row, i) => {
      const count = row.chairs.filter(c => c.enabled).length
      const label = config.showRowLabels ? `Row ${row.label}` : `Row ${i + 1}`
      return `${label}: ${count} chair${count !== 1 ? 's' : ''}`
    })

    let totalChairs = 0
    let totalStools = 0
    let totalStands = 0
    for (const row of config.rows) {
      for (const chair of row.chairs) {
        if (!chair.enabled) continue
        if (chair.isStool) totalStools++
        else totalChairs++
        if (chair.hasStand) totalStands++
        if (chair.standAfter) totalStands++
      }
    }
    if (config.rows.length > 1) {
      const plural = (n: number, word: string) => `${n} ${word}${n !== 1 ? 's' : ''}`
      const parts: string[] = []
      // Always show a chair count unless the chart is purely stools.
      if (totalChairs > 0 || totalStools === 0) parts.push(plural(totalChairs, 'chair'))
      if (totalStools > 0) parts.push(plural(totalStools, 'stool'))
      if (totalStands > 0) parts.push(plural(totalStands, 'stand'))
      lines.push(`Total: ${parts.join(' · ')}`)
    }
    if (totalStands > 0) lines.push('× = music stand')

    const lineHeight = 15
    const x = w - 12
    const bottomY = h - 24

    ctx.save()
    ctx.fillStyle = '#888'
    ctx.font = '11px sans-serif'
    ctx.textAlign = 'right'
    ctx.textBaseline = 'bottom'

    lines.forEach((line, i) => {
      ctx.fillText(line, x, bottomY - (lines.length - 1 - i) * lineHeight)
    })
    ctx.restore()
  }

  private drawCredit(ctx: CanvasRenderingContext2D, h: number) {
    ctx.save()
    ctx.fillStyle = '#aaa'
    ctx.font = '10px sans-serif'
    ctx.textAlign = 'left'
    ctx.textBaseline = 'bottom'
    ctx.fillText('Created with StagePlan  https://benperche.github.io/StagePlan/', 12, h - 12)
    ctx.restore()
  }

  // ---------------------------------------------------------------------------
  // Drawing primitives
  // ---------------------------------------------------------------------------

  // A chair counts as "nudged" (worth the Layout-tab blue outline) only in
  // layout mode and only when it actually carries a non-trivial offset.
  private isNudged(chair: Chair): boolean {
    return this.layoutMode && chair.offset !== undefined && Math.abs(chair.offset) > 0.5
  }

  private drawChair(
    ctx: CanvasRenderingContext2D,
    chair: Chair,
    cx: number, cy: number,
    condX: number, condY: number,
    fontSize: number,
    highlight = false,
  ) {
    const faceAngle = Math.atan2(condY - cy, condX - cx)

    ctx.save()
    ctx.translate(cx, cy)
    ctx.rotate(faceAngle + Math.PI / 2)

    if (chair.isStool) {
      // Round seat with four small legs poking out at the diagonals —
      // a double-bass stool. Keeps the chair's colour so colour-coding
      // (e.g. principals) still applies.
      const r = CHAIR_HALF - 2
      const legLen = 5
      const legW = 3
      ctx.fillStyle = '#333'
      for (let i = 0; i < 4; i++) {
        const a = Math.PI / 4 + i * Math.PI / 2
        const lx = Math.cos(a) * (r - 1)
        const ly = Math.sin(a) * (r - 1)
        ctx.save()
        ctx.translate(lx, ly)
        ctx.rotate(a)
        ctx.fillRect(0, -legW / 2, legLen, legW)
        ctx.restore()
      }
      ctx.beginPath()
      ctx.arc(0, 0, r, 0, Math.PI * 2)
      ctx.fillStyle = chair.color
      ctx.fill()
      ctx.strokeStyle = '#555'
      ctx.lineWidth = 1.5
      ctx.stroke()
    } else {
      ctx.beginPath()
      ctx.rect(-CHAIR_HALF, -CHAIR_HALF, CHAIR_SIZE, CHAIR_SIZE)
      ctx.fillStyle = chair.color
      ctx.fill()
      ctx.strokeStyle = '#555'
      ctx.lineWidth = 1.5
      ctx.stroke()

      // Back rail on the outer edge (away from conductor)
      ctx.beginPath()
      ctx.moveTo(-CHAIR_HALF, CHAIR_HALF)
      ctx.lineTo(CHAIR_HALF, CHAIR_HALF)
      ctx.strokeStyle = '#333'
      ctx.lineWidth = 4
      ctx.stroke()
    }

    // Layout tab: a nudged chair gets a blue outline so it's obvious which
    // ones have been moved off their default slot.
    if (highlight) {
      ctx.strokeStyle = '#2563eb'
      ctx.lineWidth = 2.5
      if (chair.isStool) {
        ctx.beginPath()
        ctx.arc(0, 0, CHAIR_HALF, 0, Math.PI * 2)
        ctx.stroke()
      } else {
        ctx.strokeRect(-CHAIR_HALF - 1.5, -CHAIR_HALF - 1.5, CHAIR_SIZE + 3, CHAIR_SIZE + 3)
      }
    }

    ctx.restore()

    // Label drawn upright, supports % as a line-break within the label
    if (chair.label) {
      const fs = Math.max(8, fontSize - 2)
      const lh = fs + 3
      const lines = chair.label.split('%')
      const totalH = lines.length * lh
      ctx.save()
      ctx.fillStyle = '#222'
      ctx.font = `bold ${fs}px sans-serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      lines.forEach((line, i) => {
        const ly = cy - totalH / 2 + i * lh + lh / 2
        ctx.fillText(line, cx, ly, CHAIR_SIZE - 4)
      })
      ctx.restore()
    }
  }

  private drawGhostChair(
    ctx: CanvasRenderingContext2D,
    cx: number, cy: number,
    condX: number, condY: number,
  ) {
    const faceAngle = Math.atan2(condY - cy, condX - cx)
    ctx.save()
    ctx.translate(cx, cy)
    ctx.rotate(faceAngle + Math.PI / 2)
    ctx.beginPath()
    ctx.rect(-CHAIR_HALF, -CHAIR_HALF, CHAIR_SIZE, CHAIR_SIZE)
    ctx.setLineDash([3, 3])
    ctx.strokeStyle = '#ccc'
    ctx.lineWidth = 1
    ctx.stroke()
    ctx.setLineDash([])
    ctx.restore()
  }

  /**
   * Draw a music stand as an × symbol, positioned between the chair origin
   * and the conductor.  For shared stands, pass the midpoint of the two chairs
   * as (cx, cy).
   */
  private drawStandX(
    ctx: CanvasRenderingContext2D,
    cx: number, cy: number,
    condX: number, condY: number,
    distOverride?: number,
  ) {
    const dx = condX - cx
    const dy = condY - cy
    const len = Math.sqrt(dx * dx + dy * dy)
    if (len === 0) return
    const nx = dx / len
    const ny = dy / len

    const dist = distOverride ?? (CHAIR_HALF + STAND_GAP + STAND_SIZE)
    const sx = cx + nx * dist
    const sy = cy + ny * dist

    const angle = Math.atan2(ny, nx)

    ctx.save()
    ctx.translate(sx, sy)
    // Rotate so the diagonals stay as diagonals relative to the chair —
    // the stand reads as × not +. (Adding π/4 here would align an arm
    // with the chair→conductor radial line and make the symbol look
    // like + when the chair sits at the front of an arc.)
    ctx.rotate(angle)
    ctx.strokeStyle = '#555'
    ctx.lineWidth = 2
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.moveTo(-STAND_SIZE, -STAND_SIZE)
    ctx.lineTo(STAND_SIZE, STAND_SIZE)
    ctx.moveTo(STAND_SIZE, -STAND_SIZE)
    ctx.lineTo(-STAND_SIZE, STAND_SIZE)
    ctx.stroke()
    ctx.restore()
  }

  private drawSeatNumber(
    ctx: CanvasRenderingContext2D,
    cx: number, cy: number,
    condX: number, condY: number,
    num: string,
    fontSize: number,
  ) {
    const dx = condX - cx
    const dy = condY - cy
    const len = Math.sqrt(dx * dx + dy * dy)
    if (len === 0) return
    const nx = -dx / len
    const ny = -dy / len
    const offset = CHAIR_HALF + 9

    ctx.save()
    ctx.fillStyle = '#444'
    ctx.font = `${Math.max(9, fontSize - 3)}px sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(num, cx + nx * offset, cy + ny * offset)
    ctx.restore()
  }

  private drawRowLabel(ctx: CanvasRenderingContext2D, label: string, x: number, y: number) {
    ctx.save()
    ctx.fillStyle = '#333'
    ctx.font = 'bold 13px sans-serif'
    ctx.textAlign = 'right'
    ctx.textBaseline = 'middle'
    ctx.fillText(label, x, y)
    ctx.restore()
  }

  private drawConductor(
    ctx: CanvasRenderingContext2D,
    ox: number, oy: number,
    yDir: number,
    config: ChartConfig,
  ) {
    const rx = ox - COND_W / 2
    const ry = oy - COND_H / 2
    const label = config.conductor.label ?? 'COND'

    // Always store hit rect so clicking works whether shown or not
    this.conductorHit = { x: rx, y: ry, w: COND_W, h: COND_H }

    if (!config.conductor.show) {
      ctx.save()
      ctx.strokeStyle = '#bbb'
      ctx.lineWidth = 1.5
      ctx.setLineDash([3, 3])
      ctx.strokeRect(rx, ry, COND_W, COND_H)
      ctx.fillStyle = '#bbb'
      ctx.font = '9px sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(label, ox, oy, COND_W - 6)
      ctx.setLineDash([])
      ctx.restore()
      return
    }

    ctx.save()
    ctx.fillStyle = '#555'
    ctx.fillRect(rx, ry, COND_W, COND_H)
    ctx.strokeStyle = '#333'
    ctx.lineWidth = 2
    ctx.strokeRect(rx, ry, COND_W, COND_H)
    ctx.fillStyle = '#fff'
    ctx.font = 'bold 11px sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(label, ox, oy, COND_W - 6)
    ctx.restore()

    if (config.conductor.hasStand) {
      const sw = 32, sh = 16
      const sy = oy + yDir * (COND_H / 2 + 4)
      ctx.save()
      ctx.fillStyle = '#aaa'
      ctx.fillRect(ox - sw / 2, sy, sw, yDir * sh)
      ctx.strokeStyle = '#777'
      ctx.lineWidth = 1
      ctx.strokeRect(ox - sw / 2, sy, sw, yDir * sh)
      ctx.restore()
    }
  }
}

import type {
  ChartConfig, Row, Chair, FixedInstrument,
  HitTarget, ConductorHit, InstrumentHit, RotateHandleHit, ConductorOrigin,
} from './types'
import {
  drawDrumkit, drawPiano, drawAmp, drawTimpani, drawMallet, drawGenericRect,
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
}

export class Renderer {
  private hitTargets: HitTarget[] = []
  private instrumentHits: InstrumentHit[] = []
  conductorHit: ConductorHit | null = null
  conductorOrigin: ConductorOrigin = { ox: 0, oy: 0, yDir: -1 }
  selectedInstrumentId: string | null = null
  rotateHandleHit: RotateHandleHit | null = null

  // Background image cache + async-load callback so main.ts can trigger
  // a re-render once a newly-uploaded image is decoded.
  private backgroundImage: HTMLImageElement | null = null
  private backgroundImageSrc: string | null = null
  onBackgroundLoaded: (() => void) | null = null

  render(canvas: HTMLCanvasElement, config: ChartConfig, opts: RenderOptions = {}): void {
    const scale = opts.scale ?? 1
    const ctx = canvas.getContext('2d')!
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.save()
    ctx.scale(scale, scale)

    this.hitTargets = []
    this.instrumentHits = []
    this.conductorHit = null
    this.rotateHandleHit = null

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
    this.conductorOrigin = { ox, oy, yDir }

    // Draw arcs first (behind chairs)
    if (config.showArc) {
      const arcRange = config.arcRange ?? Math.PI
      const arcStart = Math.PI / 2 + arcRange / 2
      const arcEnd = Math.PI / 2 - arcRange / 2
      config.rows.forEach((_row, rowIndex) => {
        const isStraight = rowIndex >= numRows - config.straightRows
        if (isStraight) return
        const r = BASE_RADIUS + rowIndex * rowSpacing
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

    // Consistent label x for straight-in-arc rows
    const straightStart = numRows - config.straightRows
    const maxStraightWidth = config.rows.slice(straightStart).reduce((mx, r) =>
      Math.max(mx, (r.chairs.length - 1) * STRAIGHT_CHAIR_SPACING), 0)
    const straightLabelX = ox - maxStraightWidth / 2 - CHAIR_HALF - 18

    let seatNumber = 1
    config.rows.forEach((row, rowIndex) => {
      const r = BASE_RADIUS + rowIndex * rowSpacing
      const isStraight = rowIndex >= numRows - config.straightRows
      if (isStraight) {
        seatNumber = this.renderStraightRow(ctx, row, rowIndex, oy + yDir * r, ox, oy, config, seatNumber, straightLabelX)
      } else {
        seatNumber = this.renderArcRow(ctx, row, rowIndex, r, ox, oy, yDir, config, seatNumber)
      }
    })
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

    // Arc range — by default the full 180° semicircle, but configurable so
    // tighter ensembles can be drawn with a narrower spread.
    const arcRange = config.arcRange ?? Math.PI
    const startAngle = Math.PI / 2 + arcRange / 2
    const endAngle = Math.PI / 2 - arcRange / 2
    // Every chair gets its own evenly-spread slot — toggling a shared stand
    // on a single chair never reshuffles the rest of the row. The natural
    // step is the angle between adjacent chair slots.
    const naturalStep = N > 1 ? (startAngle - endAngle) / (N - 1) : 0
    // When two chairs share a desk (standAfter, or two adjacent disabled
    // placeholders), the pair pulls toward the midpoint of their natural
    // slots until the chairs sit DESK_PAIR_SPACING centre-to-centre apart.
    // If their natural separation is already tighter than that, they stay
    // put — we never push chairs apart.
    const desiredHalfOffset = DESK_PAIR_SPACING / 2 / r

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
        positions[i]     = { cx: ox + r * Math.cos(angleA), cy: oy + yDir * r * Math.sin(angleA) }
        positions[i + 1] = { cx: ox + r * Math.cos(angleB), cy: oy + yDir * r * Math.sin(angleB) }
        i += 2
      } else {
        const angle = startAngle - i * naturalStep
        positions[i] = { cx: ox + r * Math.cos(angle), cy: oy + yDir * r * Math.sin(angle) }
        i += 1
      }
    }

    chairs.forEach((chair, chairIndex) => {
      const { cx, cy } = positions[chairIndex]
      if (chair.enabled) {
        this.drawChair(ctx, chair, cx, cy, ox, oy, row.fontSize)
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
      // Label to the left of the leftmost chair position, pushed past the
      // conductor line so it sits "behind" the row rather than beside it.
      const lx = ox - r - CHAIR_HALF - 6
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

    const rowWidth = (total - 1) * STRAIGHT_CHAIR_SPACING
    const startX = ox - rowWidth / 2
    const positions: Array<{ cx: number; cy: number }> = []

    row.chairs.forEach((chair, chairIndex) => {
      const cx = startX + chairIndex * STRAIGHT_CHAIR_SPACING
      positions.push({ cx, cy: rowY })

      if (chair.enabled) {
        this.drawChair(ctx, chair, cx, rowY, cx, oy, row.fontSize)
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
    this.conductorOrigin = { ox, oy, yDir }

    this.drawConductor(ctx, ox, oy, yDir, config)

    // Consistent label x: align all labels to left edge of widest row
    const maxRowWidth = config.rows.reduce((mx, r) =>
      Math.max(mx, (r.chairs.length - 1) * STRAIGHT_CHAIR_SPACING), 0)
    const labelX = ox - maxRowWidth / 2 - CHAIR_HALF - 18

    let seatNumber = 1
    config.rows.forEach((row, rowIndex) => {
      const rowY = oy + yDir * (BASE_RADIUS + rowIndex * rowSpacing)
      seatNumber = this.renderStraightRow(ctx, row, rowIndex, rowY, ox, oy, config, seatNumber, labelX)
    })
  }

  // ---------------------------------------------------------------------------
  // Fixed instruments (rhythm section, timpani, mallets, etc.)
  // ---------------------------------------------------------------------------

  private renderInstruments(ctx: CanvasRenderingContext2D, config: ChartConfig) {
    const instruments = config.instruments ?? []
    if (instruments.length === 0) return
    const { ox, oy } = this.conductorOrigin

    instruments.forEach(inst => {
      const cx = ox + inst.distance * Math.cos(inst.angle)
      const cy = oy + inst.distance * Math.sin(inst.angle)
      const isSelected = inst.id === this.selectedInstrumentId

      // 1) Draw the glyph in the rotated frame (no label!)
      ctx.save()
      ctx.translate(cx, cy)
      ctx.rotate(inst.rotation)

      let hw = 0, hh = 0, labelInside = false
      switch (inst.type) {
        case 'drumkit':    ({ hw, hh, labelInside } = drawDrumkit(ctx)); break
        case 'piano':      ({ hw, hh, labelInside } = drawPiano(ctx)); break
        case 'guitar-amp': ({ hw, hh, labelInside } = drawAmp(ctx, 32, 34)); break
        case 'bass-amp':   ({ hw, hh, labelInside } = drawAmp(ctx, 40, 42)); break
        case 'timpani':    ({ hw, hh, labelInside } = drawTimpani(ctx, inst)); break
        case 'mallet':     ({ hw, hh, labelInside } = drawMallet(ctx)); break
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
        const drop = Math.abs(hw * Math.sin(inst.rotation)) + Math.abs(hh * Math.cos(inst.rotation))
        ctx.save()
        ctx.fillStyle = '#222'
        ctx.font = 'bold 11px sans-serif'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'top'
        ctx.fillText(text, cx, cy + drop + 4)
        ctx.restore()
      }

      // 3) Rotate handle (selected instruments only) — also outside rotated frame
      if (isSelected) {
        this.drawRotateHandle(ctx, cx, cy, hh, inst.rotation, inst.id)
      }

      // 4) Hit target for the body
      this.instrumentHits.push({
        id: inst.id,
        cx, cy, hw, hh,
        rotation: inst.rotation,
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
    // breathing room) and itself anchored at h-12.
    const creditReserve = creditShown ? 16 : 0
    const bottomY = h - 12 - creditReserve

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
    let totalStands = 0
    for (const row of config.rows) {
      for (const chair of row.chairs) {
        if (!chair.enabled) continue
        totalChairs++
        if (chair.hasStand) totalStands++
        if (chair.standAfter) totalStands++
      }
    }
    if (config.rows.length > 1) {
      lines.push(totalStands > 0
        ? `Total: ${totalChairs} chairs · ${totalStands} stands`
        : `Total: ${totalChairs} chairs`)
    }
    if (totalStands > 0) lines.push('× = music stand')

    const lineHeight = 15
    const x = w - 12
    const bottomY = h - 12

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

  private drawChair(
    ctx: CanvasRenderingContext2D,
    chair: Chair,
    cx: number, cy: number,
    condX: number, condY: number,
    fontSize: number,
  ) {
    const faceAngle = Math.atan2(condY - cy, condX - cx)

    ctx.save()
    ctx.translate(cx, cy)
    ctx.rotate(faceAngle + Math.PI / 2)

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
  ) {
    const dx = condX - cx
    const dy = condY - cy
    const len = Math.sqrt(dx * dx + dy * dy)
    if (len === 0) return
    const nx = dx / len
    const ny = dy / len

    const dist = CHAIR_HALF + STAND_GAP + STAND_SIZE
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
      ctx.fillText('COND', ox, oy)
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
    ctx.fillText('COND', ox, oy)
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
